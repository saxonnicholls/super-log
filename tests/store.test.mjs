//
//  tests/store.test.mjs - superlog-store into SQLite.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A hermetic journal directory, one hand-written frame file (whose second
//  frame carries two events), and the real tool run against a throwaway SQLite
//  file - which proves the whole path: journal follower -> row expansion ->
//  escaping -> the sqlite3 CLI -> rows. The cursor is redirected to a temp HOME
//  so the run is hermetic, and re-running with the cursor removed proves the
//  primary key makes replay idempotent. Postgres shares the row expansion and
//  escaping; only its schema types + ON CONFLICT differ (a live PG test needs a
//  server, so it lives outside the suite).
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { removeDir, run, tempDir } from './harness.mjs';

const hasSqlite = spawnSync('sh', ['-c', 'command -v sqlite3'], { stdio: 'ignore' }).status === 0;

let work, journal, dbfile, home;

function sqlite(sql) {
  return spawnSync('sqlite3', [dbfile, sql], { encoding: 'utf8' }).stdout.trim();
}

before(() => {
  work = tempDir('superlog-store-');
  journal = join(work, 'journal');
  home = join(work, 'home');
  mkdirSync(journal, { recursive: true });
  mkdirSync(home, { recursive: true });
  dbfile = join(work, 'bench.db');

  const ev = (o) => JSON.stringify(o);
  const f1 = { epoch: 13899864464518476000, seq: 1, ts_ms: 1790000000000, topic: 'build.mymac.cmake',
    payload: ev({ v: 1, level: 'ERROR', origin: { app: 'cmake', device: 'mymac' }, tag: 'build',
      msg: "it's a bad one", fields: { file: 'main.cpp' } }) };
  const f2 = { epoch: 13899864464518476000, seq: 2, ts_ms: 1790000001000, topic: 'alert.x',
    payload: ev({ v: 1, level: 'WARN', msg: 'high', origin: { app: 'sys' }, trace: 'deadbeef' }) + '\n' +
             ev({ v: 1, level: 'INFO', msg: 'recovered', origin: { app: 'sys' } }) };
  writeFileSync(join(journal, 'superlog-20260927-000000.ndjson'),
                `${JSON.stringify(f1)}\n${JSON.stringify(f2)}\n`);
});

after(() => removeDir(work));

describe('superlog-store (sqlite)', { skip: hasSqlite ? false : 'sqlite3 CLI not present' }, () => {
  it('persists journal frames as rows, escaping and JSON intact', async () => {
    const r = await run('superlog-store.mjs',
      ['--store', 'sqlite', '--sqlite', dbfile, '--dir', journal, '--from-start', '--once'],
      { env: { HOME: home } });
    assert.equal(r.code, 0, r.stderr);

    assert.equal(sqlite('SELECT count(*) FROM superlog_events;'), '3', 'two frames, three events');
    // The multi-event frame expanded into idx 0 and 1.
    assert.equal(sqlite("SELECT count(*) FROM superlog_events WHERE hub_seq=2;"), '2');
    // The apostrophe in the message survived escaping.
    assert.equal(sqlite("SELECT msg FROM superlog_events WHERE topic='build.mymac.cmake';"),
                 "it's a bad one");
    assert.equal(sqlite("SELECT level FROM superlog_events WHERE topic='build.mymac.cmake';"), 'ERROR');
    // fields is JSON.
    assert.equal(sqlite("SELECT json_extract(fields,'$.file') FROM superlog_events WHERE topic='build.mymac.cmake';"),
                 'main.cpp');
    assert.equal(sqlite("SELECT trace FROM superlog_events WHERE msg='high';"), 'deadbeef');
  });

  it('is idempotent - replaying the same journal never double-writes', async () => {
    rmSync(join(home, '.superlog', 'store-sqlite.cursor'), { force: true });
    const r = await run('superlog-store.mjs',
      ['--store', 'sqlite', '--sqlite', dbfile, '--dir', journal, '--from-start', '--once'],
      { env: { HOME: home } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sqlite('SELECT count(*) FROM superlog_events;'), '3',
                 'the primary key deduped the replayed rows');
  });
});
