//
//  tests/sql.test.mjs - SQL on the bench, against real engines.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Nothing mocked, per the house rule: the SQLite half writes a real
//  database with the sqlite3 CLI and watches the real change counter move;
//  the Postgres half runs a REAL server (initdb + pg_ctl into a temp dir)
//  and delivers a real NOTIFY through psql. A missing toolchain SKIPS -
//  a contributor without postgres should still see green - but a present
//  toolchain that delivers nothing is a failure.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { assertValidEvent, removeDir, start, startHub, tempDir, waitFor } from './harness.mjs';

const have = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;

let hub, work;

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-sql-');
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

describe('superlog-sql', () => {
  it('sqlite: the change counter moves and the bench hears about it',
     { skip: !have('sqlite3') && 'no sqlite3 CLI' }, async () => {
    const db = join(work, 'app.db');
    const sql = (s) => {
      const r = spawnSync('sqlite3', [db, s], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    sql('CREATE TABLE jobs(id INTEGER PRIMARY KEY, status TEXT);');
    sql("INSERT INTO jobs(status) VALUES ('failed'), ('done');");

    const tail = start('superlog-sql.mjs',
      ['--sqlite', db, '--name', 'app', '--interval', '1',
       '--query', "jobs_failed=SELECT count(*) FROM jobs WHERE status='failed'",
       '--url', hub.url], {});
    await tail.waitForStderr(/sql\.app <- /);

    // The opening statement and the polled metric arrive without any write.
    const opening = await waitFor(hub.url,
      (rs) => rs.some((r) => /watching .*app\.db from outside/.test(r.event?.msg ?? '')) &&
              rs.some((r) => r.event?.metric?.name === 'jobs_failed'),
      { topic: 'sql.app', timeoutMs: 10000 });
    opening.forEach((r, i) => assertValidEvent(r.event, `sql[${i}]`));
    assert.equal(opening.map((r) => r.event)
      .find((e) => e.metric?.name === 'jobs_failed').metric.value, 1);

    // A real write from another process moves the real change counter.
    sql("INSERT INTO jobs(status) VALUES ('failed');");
    const changed = await waitFor(hub.url,
      (rs) => rs.some((r) => /database changed|writes in the WAL/.test(r.event?.msg ?? '')),
      { topic: 'sql.app', timeoutMs: 10000 });
    assert.ok(changed.length, 'an outside write must be seen');
    await tail.stop();
  });

  it('postgres: NOTIFY from SQL lands as an event, JSON payloads honored',
     { skip: (!have('initdb') || !have('pg_ctl') || !have('psql')) && 'no postgres binaries' },
     async () => {
    const pgdir = join(work, 'pg');
    const port = 7398;
    const conn = `postgres://127.0.0.1:${port}/postgres`;
    let r = spawnSync('initdb', ['-D', pgdir, '-A', 'trust', '-U', 'postgres'],
                      { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // TCP only: an empty unix_socket_directories sidesteps the ~104-char
    // socket-path limit that a deep temp dir can trip.
    r = spawnSync('pg_ctl', ['-D', pgdir, '-w', '-l', join(pgdir, 'log'), '-o',
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`,
      'start'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    try {
      const psql = (s) => spawnSync('psql',
        [`${conn}?user=postgres`, '-X', '-q', '-A', '-t', '-c', s], { encoding: 'utf8' });

      const tail = start('superlog-sql.mjs',
        ['--pg', `${conn}?user=postgres`, '--name', 'pg', '--interval', '1',
         '--url', hub.url], {});
      await tail.waitForStderr(/LISTEN superlog armed/);

      // One built-in statement from SQL - this is the whole point.
      const j = psql(`NOTIFY superlog, '{"level":"ERROR","msg":"reconciliation drift","fields":{"table":"ledger"}}'`);
      assert.equal(j.status, 0, j.stderr);
      const recs = await waitFor(hub.url,
        (rs) => rs.some((r2) => /reconciliation drift/.test(r2.event?.msg ?? '')),
        { topic: 'sql.pg', timeoutMs: 15000 });
      recs.forEach((r2, i) => assertValidEvent(r2.event, `pg[${i}]`));
      const ev = recs.map((r2) => r2.event).find((e) => /drift/.test(e.msg));
      assert.equal(ev.level, 'ERROR', 'the JSON payload level is honored');
      assert.equal(ev.fields.table, 'ledger');

      // Plain text is INFO, verbatim - no JSON required to be heard.
      psql(`NOTIFY superlog, 'nightly vacuum done'`);
      const plain = await waitFor(hub.url,
        (rs) => rs.some((r2) => /nightly vacuum done/.test(r2.event?.msg ?? '')),
        { topic: 'sql.pg', timeoutMs: 15000 });
      assert.equal(plain.map((r2) => r2.event)
        .find((e) => /vacuum/.test(e.msg)).level, 'INFO');
      await tail.stop();
    } finally {
      spawnSync('pg_ctl', ['-D', pgdir, '-m', 'immediate', 'stop'], { encoding: 'utf8' });
    }
  });
});
