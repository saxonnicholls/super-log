#!/usr/bin/env node
//
//  superlog-store - persist the feed into an external database.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  An optional backing store beside the NDJSON journal: SQLite or Postgres (more
//  to come), so the bench's history is queryable in SQL. It carries NO
//  dependency of ours - it writes through the database's OWN CLI client
//  (`sqlite3`, `psql`), which you install, invoked as a subprocess exactly as
//  the other tailers shell out to git and docker. The empty-SBOM promise holds.
//
//  It tails the JOURNAL, not /ws: the journal is the COMPLETE on-disk record,
//  where /ws is dropped to slow subscribers, so this loses nothing to
//  backpressure and touches the hub not at all. It resumes from a persisted
//  cursor, so a restart neither re-writes (the primary key dedupes) nor skips.
//
//    SUPER_LOG_STORE=sqlite  SUPER_LOG_STORE_SQLITE=bench.db  superlog-store
//    SUPER_LOG_STORE=postgres SUPER_LOG_STORE_DSN=postgres://… superlog-store
//    superlog-store --store sqlite --sqlite bench.db --from-start   # ingest all history
//
//  Inactive unless SUPER_LOG_STORE is set and the backend's CLI is on PATH - it
//  says so once and exits. The free store has an honest ceiling (CLI throughput
//  x your DB x your disk); it REPORTS it on store.<host>.<backend> (rows written,
//  queue depth, lag) and WARNs when the journal rotates past it before the DB
//  drains - that drop is the honest upsell to super-log Cloud, which has no
//  ceiling. See docs/proposals/backing-store.md.
//
//  Zero dependency: the database's own CLI. Node >= 18.
//

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync,
  readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-store - persist the feed into SQLite or Postgres

  superlog-store [--store sqlite|postgres] [--sqlite FILE] [--dsn URL]
                 [--dir JOURNAL] [--table NAME] [--topics p.,q.] [--from-start]
                 [--once] [--url HUB]

Config also via .env: SUPER_LOG_STORE, SUPER_LOG_STORE_SQLITE, SUPER_LOG_STORE_DSN,
SUPER_LOG_STORE_TABLE, SUPER_LOG_STORE_TOPICS. Postgres creds via psql's own env
(PGHOST/PGUSER/PGPASSWORD/PGDATABASE) or --dsn. See docs/proposals/backing-store.md.`);
  process.exit(0);
}

const env = loadEnv();
const backend = String(opt('store', env.SUPER_LOG_STORE ?? '')).toLowerCase();
const journalDir = opt('dir', env.SUPER_LOG_JOURNAL ?? './superlog-journal');
const table = (opt('table', env.SUPER_LOG_STORE_TABLE ?? 'superlog_events')).replace(/[^a-zA-Z0-9_]/g, '');
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const fromStart = args.includes('--from-start');
const once = args.includes('--once');
const intervalMs = Number(opt('interval', '1')) * 1000;
const maxQueue = Number(opt('max-queue', env.SUPER_LOG_STORE_MAX_QUEUE ?? '20000'));
const topicsFilter = String(opt('topics', env.SUPER_LOG_STORE_TOPICS ?? ''))
  .split(',').map((s) => s.trim()).filter(Boolean);

const host = hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');

function die(msg) { console.error(`superlog-store: ${msg}`); process.exit(1); }
function inactive(msg) { console.error(`superlog-store: inactive - ${msg}`); process.exit(0); }
const have = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

// ---- the backend: which CLI, how it makes a table, how it inserts ----------

const COLS = ['epoch', 'hub_seq', 'idx', 'ts_ms', 'topic', 'level', 'session',
              'app', 'device', 'platform', 'runtime', 'tag', 'msg', 'trace', 'fields', 'event'];

const sq = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => {
  const n = Number(v);
  return (v == null || v === '' || Number.isNaN(n)) ? 'NULL' : String(n);
};

let db;
if (!backend) inactive('set SUPER_LOG_STORE=sqlite|postgres (see docs/proposals/backing-store.md)');

if (backend === 'sqlite') {
  const file = opt('sqlite', env.SUPER_LOG_STORE_SQLITE ?? '');
  if (!file) inactive('set SUPER_LOG_STORE_SQLITE=<file> for the sqlite backend');
  if (!have('sqlite3')) inactive('the sqlite3 CLI is not on PATH (install it, then re-run)');
  mkdirSync(dirname(file) || '.', { recursive: true });
  db = {
    name: 'sqlite',
    cli: 'sqlite3',
    connArgs: ['-bail', file],
    schema:
      `CREATE TABLE IF NOT EXISTS ${table} (` +
      `epoch TEXT, hub_seq INTEGER, idx INTEGER, ts_ms INTEGER, topic TEXT, level TEXT, ` +
      `session TEXT, app TEXT, device TEXT, platform TEXT, runtime TEXT, tag TEXT, msg TEXT, ` +
      `trace TEXT, fields TEXT, event TEXT, PRIMARY KEY(epoch,hub_seq,idx));` +
      `CREATE INDEX IF NOT EXISTS ${table}_topic_ts ON ${table}(topic, ts_ms);` +
      `CREATE INDEX IF NOT EXISTS ${table}_trace ON ${table}(trace);`,
    insert(rows) {
      const vals = rows.map((r) => rowValues(r, false)).join(',');
      return `BEGIN;\nINSERT OR IGNORE INTO ${table} (${COLS.join(',')}) VALUES ${vals};\nCOMMIT;\n`;
    },
  };
} else if (backend === 'postgres' || backend === 'postgresql' || backend === 'pg') {
  if (!have('psql')) inactive('the psql CLI is not on PATH (install it, then re-run)');
  const dsn = opt('dsn', env.SUPER_LOG_STORE_DSN ?? '');
  db = {
    name: 'postgres',
    cli: 'psql',
    connArgs: [...(dsn ? [dsn] : []), '-v', 'ON_ERROR_STOP=1', '-q'],
    schema:
      `CREATE TABLE IF NOT EXISTS ${table} (` +
      `epoch TEXT, hub_seq BIGINT, idx INT, ts_ms BIGINT, topic TEXT, level TEXT, ` +
      `session TEXT, app TEXT, device TEXT, platform TEXT, runtime TEXT, tag TEXT, msg TEXT, ` +
      `trace TEXT, fields JSONB, event JSONB, PRIMARY KEY(epoch,hub_seq,idx));` +
      `CREATE INDEX IF NOT EXISTS ${table}_topic_ts ON ${table}(topic, ts_ms);` +
      `CREATE INDEX IF NOT EXISTS ${table}_trace ON ${table}(trace);`,
    insert(rows) {
      const vals = rows.map((r) => rowValues(r, true)).join(',');
      return `INSERT INTO ${table} (${COLS.join(',')}) VALUES ${vals} ` +
             `ON CONFLICT (epoch,hub_seq,idx) DO NOTHING;\n`;
    },
  };
} else {
  die(`unknown backend '${backend}' - v1 supports sqlite and postgres`);
}

function rowValues(r, pg) {
  const j = (s) => (pg ? `${sq(s)}::jsonb` : sq(s));
  return `(${sq(r.epoch)},${num(r.hub_seq)},${num(r.idx)},${num(r.ts_ms)},${sq(r.topic)},` +
         `${sq(r.level)},${sq(r.session)},${sq(r.app)},${sq(r.device)},${sq(r.platform)},` +
         `${sq(r.runtime)},${sq(r.tag)},${sq(r.msg)},${sq(r.trace)},${j(r.fields)},${j(r.event)})`;
}

// Run the CLI with SQL on stdin; resolve {ok, err} from the exit code.
function runSql(sql) {
  return new Promise((resolve) => {
    const p = spawn(db.cli, db.connArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, err: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, err: err.trim() }));
    p.stdin.on('error', () => { /* the CLI may exit before we finish writing */ });
    p.stdin.end(sql);
  });
}

// ---- turning journal frames into rows --------------------------------------

const topicMatch = (t) => !topicsFilter.length || topicsFilter.some(
  (w) => w === t || w === '*' || (w.endsWith('.') && t.startsWith(w)));

function rowsFromLine(line) {
  let frame;
  try { frame = JSON.parse(line); } catch { return []; }
  if (!frame || typeof frame.payload !== 'string') return [];
  if (!topicMatch(frame.topic)) return [];
  // Keep epoch's full precision from the raw line (it exceeds 2^53).
  const epoch = (line.match(/"epoch":\s*(\d+)/) || [])[1] ?? String(frame.epoch ?? '');
  const rows = [];
  let idx = 0;
  for (const raw of frame.payload.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { ev = { msg: t }; }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) ev = { msg: String(t) };
    const o = ev.origin || {};
    rows.push({
      epoch, hub_seq: frame.seq, idx: idx++, ts_ms: frame.ts_ms, topic: frame.topic,
      level: ev.level ?? 'INFO', session: ev.session ?? '',
      app: o.app ?? '', device: o.device ?? '', platform: o.platform ?? '', runtime: o.runtime ?? '',
      tag: ev.tag ?? '', msg: ev.msg ?? '', trace: ev.trace ?? '',
      fields: JSON.stringify(ev.fields ?? {}), event: JSON.stringify(ev),
    });
  }
  return rows;
}

// ---- the journal follower (cursor across size-rotated files) ---------------

const ACTIVE = /^superlog-\d{8}-\d{6}\.ndjson$/;   // the un-gzipped, appendable files
const cursorPath = join(homedir(), '.superlog', `store-${db.name}.cursor`);

function activeFiles() {
  if (!existsSync(journalDir)) return [];
  try { return readdirSync(journalDir).filter((n) => ACTIVE.test(n)).sort(); }
  catch { return []; }
}

function loadCursor() {
  try { return JSON.parse(readFileSync(cursorPath, 'utf8')); } catch { return null; }
}
function saveCursor() {
  try {
    mkdirSync(dirname(cursorPath), { recursive: true });
    writeFileSync(cursorPath, JSON.stringify(cursor));
  } catch { /* a cursor we cannot persist just means more idempotent replay on restart */ }
}

let cursor = loadCursor();
let partial = '';
let dropped = 0;
let written = 0;
let lagBytes = 0;
const queue = [];

if (!cursor) {
  const files = activeFiles();
  if (fromStart && files.length) cursor = { file: files[0], offset: 0 };
  else if (files.length) {
    const last = files[files.length - 1];
    cursor = { file: last, offset: statSync(join(journalDir, last)).size };  // tail from the end
  } else cursor = { file: null, offset: 0 };
}

function sizeOf(name) {
  try { return statSync(join(journalDir, name)).size; } catch { return -1; }
}

// Read new bytes from the cursor file, advance across rotations; enqueue rows.
// Returns true if it made any progress (so --once can drain to the head).
function pumpOnce() {
  const files = activeFiles();
  if (!files.length) return false;

  if (!cursor.file || !files.includes(cursor.file)) {
    // First run with no file yet, or our file rotated+gzipped out from under us.
    const gap = !!cursor.file;   // we had one and lost it => a real gap
    cursor = { file: files[0], offset: 0 };   // pick up the oldest still-active file
    partial = '';
    if (gap) { dropped += 1; publishDrop('journal rotated past the store cursor'); }
  }

  const size = sizeOf(cursor.file);
  if (size < 0) return false;
  let progressed = false;

  if (size > cursor.offset) {
    const len = size - cursor.offset;
    const fd = openSync(join(journalDir, cursor.file), 'r');
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, cursor.offset);
    closeSync(fd);
    const text = partial + buf.toString('utf8');
    const lines = text.split('\n');
    partial = lines.pop();                     // trailing partial line, if any
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const r of rowsFromLine(line)) enqueue(r);
    }
    cursor.offset = size;
    progressed = true;
  }

  // Fully read a rotated file and a newer one exists? Move to it.
  const i = files.indexOf(cursor.file);
  if (i >= 0 && i < files.length - 1 && cursor.offset >= sizeOf(cursor.file)) {
    cursor = { file: files[i + 1], offset: 0 };
    partial = '';
    progressed = true;
  }

  // Lag: bytes still ahead of us across the current + newer files.
  lagBytes = 0;
  for (let k = Math.max(0, i); k < files.length; k++) {
    const s = sizeOf(files[k]);
    lagBytes += (files[k] === cursor.file) ? Math.max(0, s - cursor.offset) : Math.max(0, s);
  }
  return progressed;
}

function enqueue(row) {
  if (queue.length >= maxQueue) {
    queue.shift();               // drop OLDEST - keep the recent tail
    dropped += 1;
    if (dropped % 1000 === 1) publishDrop(`queue full (${maxQueue}) - the DB is not keeping up`);
  }
  queue.push(row);
}

// ---- flushing to the database ----------------------------------------------

const BATCH = Number(opt('batch', '1000'));
let flushing = false;

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length) {
      const rows = queue.slice(0, BATCH);
      const res = await runSql(db.insert(rows));
      if (!res.ok) {
        // Leave the rows queued and try again next tick; do NOT advance the
        // persisted cursor, so nothing is lost to a transient DB error.
        console.error(`superlog-store: ${db.name} write failed, will retry: ${res.err.slice(0, 200)}`);
        break;
      }
      queue.splice(0, rows.length);
      written += rows.length;
    }
  } finally {
    flushing = false;
  }
  if (queue.length === 0) saveCursor();   // everything read has been written
}

// ---- our own health, on the bench (the honest ceiling / upsell signal) -----

const session = Math.random().toString(16).slice(2, 10);
let seq = 0;
const metricTopic = `store.${host}.${db.name}`;

function post(level, msg, fields, metric) {
  const ev = {
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'store', platform: process.platform, device: host },
    tag: 'store', msg, fields,
  };
  if (metric) ev.metric = metric;
  fetch(`${hubUrl}/ingest/${metricTopic}`, {
    method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: JSON.stringify(ev),
  }).catch(() => { /* hub down; our metrics are best-effort */ });
}
let lastDropReport = 0;
function publishDrop(why) {
  const now = Date.now();
  if (now - lastDropReport < 10000) return;   // edge-ish: at most one WARN per 10s
  lastDropReport = now;
  post('WARN', `store dropping events (${dropped} total) - ${why}. Retain everything with super-log Cloud.`,
       { change: 'drop', dropped: String(dropped), backend: db.name });
}
let lastWritten = 0;
function publishHealth() {
  const rate = written - lastWritten; lastWritten = written;
  post('DEBUG', `store ${db.name}: ${written} rows written, ${queue.length} queued, ${lagBytes} bytes behind`,
       { backend: db.name, written: String(written), queued: String(queue.length),
         lag_bytes: String(lagBytes), dropped: String(dropped) },
       { name: 'store.rows_per_tick', value: rate });
}

// ---- run --------------------------------------------------------------------

const init = await runSql(db.schema);
if (!init.ok) die(`could not create/verify table ${table} in ${db.name}: ${init.err.slice(0, 300)}`);

console.error(`superlog-store: ${db.name} <- ${journalDir}` +
              `${fromStart ? ' (from start)' : ''} -> table ${table}; health on ${metricTopic}`);

async function loop() {
  let progressed = true;
  while (progressed) progressed = pumpOnce();   // catch up to the journal head
  await flush();
  if (once) { saveCursor(); return; }
  setTimeout(loop, intervalMs);
}

if (!once) setInterval(publishHealth, 5000).unref();
await loop();
