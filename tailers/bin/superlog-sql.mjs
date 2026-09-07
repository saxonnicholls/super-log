#!/usr/bin/env node
//
//  superlog-sql - SQL on the bench: Postgres NOTIFY and SQLite, watched.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  SQL runs inside an engine, so it cannot POST - but engines can talk.
//  Two engines, two honest mechanisms:
//
//  POSTGRES - the NOTIFY bridge. This tailer holds LISTEN <channel> open,
//  and then ANY trigger, stored procedure or batch job logs to the bench
//  with one built-in statement, no extensions, no privileges beyond
//  NOTIFY:
//
//      NOTIFY superlog, '{"level":"ERROR","msg":"reconciliation drift"}';
//      -- or from a procedure, payload built at runtime:
//      PERFORM pg_notify('superlog',
//        json_build_object('level','WARN','msg','queue depth '||n)::text);
//
//  A JSON payload's level/msg/fields are honored; a plain-text payload
//  becomes an INFO event verbatim. The wire is psql itself - the same
//  bargain the shell SDK makes with curl: this file stays dependency-free
//  and psql speaks the protocol, auth included. psql only surfaces
//  notifications when a command completes, so a heartbeat SELECT ticks
//  every --interval seconds; that interval bounds delivery latency.
//
//  SQLITE - the outside observer. SQLite is in-process, so the app's own
//  language SDK covers code that links it; what THIS watches is what an
//  outside process can honestly see: the database file's own change
//  counter (byte offset 24 of the header - no library, no lock taken),
//  page count, and the -wal file, whose growth is writes that have not
//  checkpointed yet. Changes are edge-triggered INFO; sizes are DEBUG
//  metric readings.
//
//  Both engines accept --query "name=SELECT ..." polled on a slower
//  clock: a numeric result becomes a DEBUG metric (failed jobs, queue
//  depth, dead tuples), a failing query is ONE WARN until it recovers.
//
//    superlog-sql --pg "postgres:///mydb"            # LISTEN superlog
//    superlog-sql --pg "service=prod" --channel audit --name prod
//    superlog-sql --sqlite var/app.db --name app
//    superlog-sql --sqlite var/app.db --query "jobs_failed=SELECT count(*) FROM jobs WHERE status='failed'"
//
//  Node >= 18, zero dependencies; psql / sqlite3 CLIs carry the wire.
//

import { spawn, spawnSync } from 'node:child_process';
import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};
const optAll = (name) => {
  const out = [];
  for (let i = 0; i < args.length - 1; i++)
    if (args[i] === `--${name}`) out.push(args[i + 1]);
  return out;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-sql - Postgres NOTIFY and SQLite, on the bench

  superlog-sql --pg <conninfo>  [--channel superlog] [--name <label>]
  superlog-sql --sqlite <file>  [--name <label>]
  common: [--query "name=SELECT ..."]... [--query-interval 30]
          [--interval seconds] [--url HUB] [--once]

Postgres: NOTIFY <channel>, '<payload>' from any trigger/procedure lands
as an event on sql.<label> - JSON payloads ({"level","msg","fields"}) are
honored, plain text is INFO. SQLite: the db file's change counter, page
count and -wal growth, watched from outside the process, no lock taken.
--once polls each engine once and exits (for scripts and tests).`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const pgConn = opt('pg', null);
const sqlitePath = opt('sqlite', null);
if ((pgConn === null) === (sqlitePath === null)) {
  console.error('superlog-sql: exactly one of --pg or --sqlite - deciding is the point');
  process.exit(2);
}
const channel = opt('channel', 'superlog');
const name = (opt('name', null) ??
  (sqlitePath ? sqlitePath.split('/').pop().replace(/\.(db|sqlite3?)$/, '') : 'pg'))
  .toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const topic = `sql.${name}`;
const intervalS = Number(opt('interval', pgConn ? 1 : 10)) || (pgConn ? 1 : 10);
const queryIntervalS = Number(opt('query-interval', 30)) || 30;
const once = args.includes('--once');
const queries = optAll('query').map((q) => {
  const eq = q.indexOf('=');
  if (eq < 1) {
    console.error(`superlog-sql: --query wants "name=SELECT ...", got: ${q}`);
    process.exit(2);
  }
  return { name: q.slice(0, eq).trim(), sql: q.slice(eq + 1).trim(), failing: false };
});

const device = hostname().split('.')[0].toLowerCase();
const session = Math.random().toString(16).slice(2, 10);
let seq = 0;
let lines = [];

function publish(level, msg, fields, metric) {
  lines.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'sql', platform: pgConn ? 'postgres' : 'sqlite', device },
    tag: name, msg,
    ...(metric ? { metric } : {}),
    ...(fields && Object.keys(fields).length
      ? { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])) }
      : {}),
  }));
}

async function flush() {
  if (!lines.length) return;
  const body = lines.join('\n');
  lines = [];
  try {
    await fetch(`${hubUrl}/ingest/${topic}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch { /* hub down; the next batch counts again */ }
}

// ------------------------------------------------------------- queries
//
// Shared by both engines: a numeric answer is a reading, a failure is an
// edge - said once, recovered once, never repeated every poll.

function runQuery(q, exec) {
  const got = exec(q.sql);
  if (got.ok) {
    const n = Number(String(got.out).trim().split('\n')[0]);
    if (Number.isFinite(n)) {
      publish('DEBUG', `${q.name} =${n}`, { query: q.name },
              { name: q.name, value: n });
    } else {
      publish('DEBUG', `${q.name} = ${String(got.out).trim().slice(0, 200)}`,
              { query: q.name, value: String(got.out).trim().slice(0, 200) });
    }
    if (q.failing) {
      q.failing = false;
      publish('INFO', `RECOVERED: query '${q.name}' answers again`, { query: q.name });
    }
  } else if (!q.failing) {
    q.failing = true;
    publish('WARN', `query '${q.name}' failed: ${got.err.slice(0, 300)}`, { query: q.name });
  }
}

// ------------------------------------------------------------- postgres

function pgExec(sql) {
  const r = spawnSync('psql', [pgConn, '-X', '-q', '-A', '-t', '-c', sql],
                      { encoding: 'utf8', timeout: 15000 });
  return r.status === 0
    ? { ok: true, out: r.stdout }
    : { ok: false, err: (r.stderr || `psql exit ${r.status}`).trim() };
}

function startPostgres() {
  let child = null;
  let down = false;
  let stopping = false;

  const connect = () => {
    child = spawn('psql', [pgConn, '-X', '-q', '-A', '-t'],
                  { stdio: ['pipe', 'pipe', 'pipe'] });
    let carry = '';
    let armed = false;
    child.stdout.on('data', (d) => {
      carry += d.toString();
      const rows = carry.split('\n');
      carry = rows.pop() ?? '';
      for (const line of rows) {
        // The sentinel row proves the LISTEN before it is executed - psql
        // runs commands in order, so when this answers, the subscription
        // is committed and a NOTIFY fired now will be heard. Claiming the
        // watch any earlier is a race: postgres does not queue
        // notifications for future listeners.
        if (!armed && line === 'superlog-listen-ready') {
          armed = true;
          console.error(`superlog-sql: LISTEN ${channel} armed`);
          continue;
        }
        const m = /^Asynchronous notification "([^"]+)"(?: with payload "([\s\S]*)")? received from server process with PID (\d+)\.$/
          .exec(line);
        if (!m) continue;
        const payload = m[2] ?? '';
        let ev = null;
        try { ev = JSON.parse(payload); } catch { /* plain text is fine */ }
        if (ev && typeof ev === 'object' && ev.msg) {
          const lvl = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL']
            .includes(ev.level) ? ev.level : 'INFO';
          publish(lvl, String(ev.msg),
                  { pid: m[3], channel: m[1],
                    ...(ev.fields && typeof ev.fields === 'object' ? ev.fields : {}) });
        } else {
          publish('INFO', payload || `notification on ${m[1]}`,
                  { pid: m[3], channel: m[1] });
        }
      }
      void flush();
    });
    child.stderr.on('data', () => { /* psql chatter; exit code is the verdict */ });
    child.on('close', () => {
      if (stopping) return;
      if (!down) {
        down = true;
        publish('WARN', `postgres connection lost - retrying every 5s`, { channel });
        void flush();
      }
      setTimeout(connect, 5000).unref?.();
    });
    child.stdin.write(`LISTEN ${channel.replace(/[^a-zA-Z0-9_]/g, '')};\n` +
                      `SELECT 'superlog-listen-ready';\n`);
    // The heartbeat: psql surfaces pending notifications when a command
    // completes, so this ticks the conversation along. SELECT 1 rows
    // ('1') fall through the notification regex untouched.
    const beat = setInterval(() => {
      if (down) return;
      try { child.stdin.write('SELECT 1;\n'); } catch { /* close handles it */ }
    }, intervalS * 1000);
    beat.unref?.();
    child.on('spawn', () => {
      if (down) {
        down = false;
        publish('INFO', 'RECOVERED: postgres connection is back', { channel });
      }
    });
    child.on('close', () => clearInterval(beat));
  };

  // Prove the connection before claiming the watch - fail loudly now
  // rather than pretending to listen to a database that refused us.
  const probe = pgExec('SELECT 1');
  if (!probe.ok) {
    console.error(`superlog-sql: cannot reach postgres: ${probe.err}`);
    process.exit(1);
  }
  publish('INFO', `listening on channel '${channel}' - ` +
    `NOTIFY ${channel}, '{"level":"INFO","msg":"..."}' from any trigger or procedure`,
    { channel });
  void flush();
  if (once) { process.exit(0); }
  connect();
  if (queries.length) {
    const qt = setInterval(() => {
      for (const q of queries) runQuery(q, pgExec);
      void flush();
    }, queryIntervalS * 1000);
    qt.unref?.();
    for (const q of queries) runQuery(q, pgExec);
    void flush();
  }
  process.on('SIGINT', () => { stopping = true; child?.kill(); process.exit(0); });
  process.on('SIGTERM', () => { stopping = true; child?.kill(); process.exit(0); });
  console.error(`superlog-sql: ${topic} <- LISTEN ${channel} (${intervalS}s heartbeat) -> ${hubUrl}`);
}

// -------------------------------------------------------------- sqlite

function sqliteHeader(path) {
  // The first 100 bytes of an SQLite file are the header: the file change
  // counter at offset 24 (bumped on every transaction that reaches the
  // main file) and the page count at 28, both big-endian. Reading them
  // takes no lock and never blocks a writer.
  try {
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(100);
    const n = readSync(fd, buf, 0, 100, 0);
    closeSync(fd);
    if (n < 100 || buf.toString('latin1', 0, 15) !== 'SQLite format 3') return null;
    let pageSize = buf.readUInt16BE(16);
    if (pageSize === 1) pageSize = 65536;
    return { counter: buf.readUInt32BE(24), pages: buf.readUInt32BE(28), pageSize };
  } catch {
    return null;
  }
}

function sqliteExec(sql) {
  const r = spawnSync('sqlite3', ['-readonly', sqlitePath, sql],
                      { encoding: 'utf8', timeout: 15000 });
  return r.status === 0
    ? { ok: true, out: r.stdout }
    : { ok: false, err: (r.stderr || `sqlite3 exit ${r.status}`).trim() };
}

function startSqlite() {
  if (!existsSync(sqlitePath)) {
    console.error(`superlog-sql: no such database: ${sqlitePath}`);
    process.exit(1);
  }
  if (queries.length && spawnSync('sqlite3', ['--version']).status !== 0) {
    console.error('superlog-sql: --query needs the sqlite3 CLI on PATH');
    process.exit(1);
  }
  const first = sqliteHeader(sqlitePath);
  if (!first) {
    console.error(`superlog-sql: ${sqlitePath} is not an SQLite database`);
    process.exit(1);
  }
  let last = first;
  let lastWal = 0;
  let missing = false;
  let sinceQueries = queryIntervalS; // fire the first query pass immediately

  publish('INFO', `watching ${sqlitePath} from outside the process - ` +
    `change counter ${first.counter}, ${first.pages} pages`, { path: sqlitePath });

  const poll = () => {
    const h = sqliteHeader(sqlitePath);
    if (!h) {
      if (!missing) {
        missing = true;
        publish('WARN', `${sqlitePath} vanished or is unreadable`, { path: sqlitePath });
      }
      return;
    }
    if (missing) {
      missing = false;
      publish('INFO', `RECOVERED: ${sqlitePath} is back (change counter ${h.counter})`,
              { path: sqlitePath });
    }
    let walBytes = 0;
    try { walBytes = statSync(`${sqlitePath}-wal`).size; } catch { /* not WAL mode */ }
    const dbBytes = h.pages * h.pageSize;

    if (h.counter !== last.counter) {
      publish('INFO', `database changed - ${h.counter - last.counter} ` +
        `transaction(s) reached the main file (counter ${last.counter} -> ${h.counter})`,
        { counter: h.counter, pages: h.pages });
    } else if (walBytes > lastWal) {
      publish('INFO', `writes in the WAL - ${walBytes - lastWal} bytes since last ` +
        'look, not yet checkpointed', { wal_bytes: walBytes });
    }
    publish('DEBUG', `db =${dbBytes}b wal =${walBytes}b`, undefined,
            { name: 'sqlite.db_bytes', value: dbBytes });
    if (walBytes) publish('DEBUG', `wal =${walBytes}b`, undefined,
                          { name: 'sqlite.wal_bytes', value: walBytes });
    last = h;
    lastWal = walBytes;

    sinceQueries += intervalS;
    if (queries.length && sinceQueries >= queryIntervalS) {
      sinceQueries = 0;
      for (const q of queries) runQuery(q, sqliteExec);
    }
  };

  poll();
  void flush();
  if (once) process.exit(0);
  const t = setInterval(() => { poll(); void flush(); }, intervalS * 1000);
  t.unref?.();
  setInterval(() => {}, 1 << 30); // hold the loop open
  console.error(`superlog-sql: ${topic} <- ${sqlitePath} every ${intervalS}s -> ${hubUrl}`);
}

if (pgConn) startPostgres();
else startSqlite();
