#!/usr/bin/env node
//
//  superlog-crash - every runtime crash on the bench, the moment it lands.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A process that segfaults says nothing to your logs - it is gone before it
//  can. The evidence lands somewhere else entirely: a macOS .ips in
//  ~/Library/Logs/DiagnosticReports, a Linux core caught by systemd-coredump, a
//  Windows .dmp under CrashDumps. This watches those, and the instant a new one
//  appears it publishes ONE event carrying the signal, the exception, and the
//  faulting thread's top frames - so a crash anywhere on the bench shows up
//  beside the build that produced it and the service that just went quiet,
//  instead of being read by hand out of a report nobody thought to open.
//
//    superlog-crash                       # watch this machine for new crashes
//    superlog-crash --backfill 5          # ...and emit the 5 most recent first
//    superlog-crash --once                # the recent crashes, then exit
//    superlog-crash --include myapp       # only processes whose name matches
//    superlog-crash --dir /path/to/reports  # a non-default report directory
//
//  Publishes to crash.<host>.<process>. Like the other watchers, the first poll
//  is a SILENT baseline - the reports already on disk are noted, not announced,
//  so startup is not a wall of old crashes - and only reports written AFTER it
//  are events. --backfill N replays the N newest existing ones once anyway.
//
//  A crash is ERROR: it is the worst thing a process can do, but it has already
//  happened, so it is not CRITICAL-in-progress. Everything it reads is a report
//  the OS already wrote; it captures nothing itself and needs no privileges.
//
//  Zero dependency: the OS's own crash reporter (and, on Linux, coredumpctl).
//  Node >= 18.
//

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-crash - new process crashes, as they land

  superlog-crash [--dir PATH] [--backfill N] [--include NAME] [--once]
                 [--interval SECONDS] [--url HUB]

Publishes crash.<host>.<process>. First poll is a silent baseline; only crashes
written after it are events. --backfill N replays the N newest existing reports;
--once emits the recent ones and exits. --include filters by process name.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const intervalMs = Number(opt('interval', env.SUPER_LOG_CRASH_INTERVAL ?? '5')) * 1000;
const once = args.includes('--once');
const backfill = Number(opt('backfill', once ? '25' : '0')) || 0;
const include = opt('include', '')?.toLowerCase();

const sanitize = (s) => String(s).split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const host = sanitize(hostname());

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let seq = 0;
const buf = new Map();   // topic -> lines (many crashes can share a poll)

function publish(topic, level, msg, fields) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'crash-watcher', platform: process.platform, device: host },
    tag: 'crash', msg, fields,
  }));
}

async function flush() {
  for (const [topic, lines] of buf) {
    if (!lines.length) continue;
    const body = lines.join('\n');
    buf.set(topic, []);
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
      });
    } catch { /* hub down; the next batch counts again */ }
  }
}

// A parsed crash, however it was found, reduces to this shape. Returns whether
// it was actually published (the --include filter can drop it), so backfill
// counts crashes it emitted, not crashes it merely looked at.
function emit(c) {
  if (include && !(`${c.process}`.toLowerCase().includes(include))) return false;
  const proc = sanitize(c.process || 'unknown');
  const topic = `crash.${host}.${proc}`;
  const sig = c.signal || c.exception || 'crash';
  const where = c.frames?.[0] ? ` in ${c.frames[0]}` : '';
  publish(topic, 'ERROR', `${c.process || 'a process'} crashed: ${sig}${c.exception && c.exception !== sig ? ` (${c.exception})` : ''}${where}`, {
    change: 'crash',
    process: c.process || '',
    signal: c.signal || '',
    exception: c.exception || '',
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.thread != null ? { thread: String(c.thread) } : {}),
    ...(c.frames?.length ? { frames: c.frames.slice(0, 8).join(' <- ') } : {}),
    ...(c.when ? { when: c.when } : {}),
    report: c.report || '',
  });
  return true;
}

// ------------------------------------------------------ macOS: DiagnosticReports
//
// Modern reports are .ips: a one-line JSON header, then a JSON payload with
// procName, exception {type,signal,subtype}, faultingThread, threads[].frames,
// and usedImages[]. Older ones are .crash: plain text. Parse both; a report we
// cannot make sense of still becomes an event, because "something crashed" is
// the news even when the details resist.

function macReportDir() {
  return opt('dir', join(homedir(), 'Library', 'Logs', 'DiagnosticReports'));
}

function parseIps(text, path) {
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  let head = {}, body = {};
  try { head = JSON.parse(text.slice(0, nl)); } catch { /* header optional */ }
  try { body = JSON.parse(text.slice(nl + 1)); } catch { return null; }
  const proc = body.procName || head.app_name || head.name || basename(path).split('-')[0];
  const ex = body.exception || {};
  const ft = body.faultingThread;
  const imgs = body.usedImages || [];
  const frames = [];
  const th = (body.threads || [])[ft];
  for (const f of (th?.frames || []).slice(0, 8)) {
    const img = typeof f.imageIndex === 'number' ? imgs[f.imageIndex] : null;
    const name = img?.name ? basename(String(img.name)) : '?';
    frames.push(`${name}:${f.symbol || ('0x' + Number(f.imageOffset || 0).toString(16))}`);
  }
  return {
    process: proc,
    signal: ex.signal || '',
    exception: ex.type || '',
    reason: body.termination?.indicator || ex.subtype || '',
    thread: ft,
    frames,
    when: head.timestamp || body.captureTime || '',
    report: path,
  };
}

function parseCrash(text, path) {
  const grab = (re) => (text.match(re)?.[1] || '').trim();
  const proc = grab(/^Process:\s+([^\[]+?)\s*\[/m) || basename(path).split('-')[0];
  const exType = grab(/^Exception Type:\s+(.+)$/m);
  const sig = exType.match(/\((SIG[A-Z]+)\)/)?.[1] || '';
  const crashed = grab(/^Crashed Thread:\s+(\d+)/m);
  const frames = [];
  // "Thread N Crashed:" ... numbered frames until a blank line.
  const sec = text.split(new RegExp(`^Thread ${crashed || '\\d+'} Crashed:.*$`, 'm'))[1] || '';
  for (const line of sec.split('\n')) {
    const m = line.match(/^\s*\d+\s+(\S+)\s+\S+\s+(.+)$/);
    if (!m) { if (frames.length) break; else continue; }
    frames.push(`${m[1]}:${m[2].trim()}`.slice(0, 80));
    if (frames.length >= 8) break;
  }
  return {
    process: proc,
    signal: sig,
    exception: exType.replace(/\s*\(SIG[A-Z]+\)/, ''),
    reason: grab(/^Termination Reason:\s+(.+)$/m),
    thread: crashed ? Number(crashed) : undefined,
    frames,
    report: path,
  };
}

function scanMac() {
  const dir = macReportDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/\.(ips|crash)$/.test(name)) continue;   // .diag/.hang/.spin are not crashes
    const path = join(dir, name);
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    out.push({ path, name, mtime });
  }
  return out;
}

function parseMac(entry) {
  let text;
  try { text = readFileSync(entry.path, 'utf8'); } catch { return null; }
  return entry.path.endsWith('.ips') ? parseIps(text, entry.path) : parseCrash(text, entry.path);
}

// ------------------------------------------------------ Linux: systemd-coredump

function coredumpctlAvailable() {
  return spawnSync('sh', ['-c', 'command -v coredumpctl'], { stdio: 'ignore' }).status === 0;
}

function scanLinux() {
  // One row per dump: TIME PID UID GID SIG COREFILE EXE (SIZE on newer).
  const r = spawnSync('coredumpctl', ['list', '--no-pager', '--no-legend', '--reverse'],
    { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7) continue;
    const pid = cols[4] && /^\d+$/.test(cols[4]) ? cols[4] : cols.find((c) => /^\d+$/.test(c));
    const sig = cols[7] || cols[6] || '';
    const exe = cols[cols.length - 1];
    // A stable id per dump: time + pid.
    out.push({ path: `${cols.slice(0, 3).join(' ')}#${pid}`, name: `${pid}`, mtime: Date.now(),
               _pid: pid, _sig: sig, _exe: exe });
  }
  return out;
}

function parseLinux(entry) {
  const c = { process: entry._exe ? basename(entry._exe) : `pid ${entry._pid}`,
              signal: entry._sig || '', exception: '', frames: [], report: `coredump ${entry._pid}` };
  // Best-effort backtrace (needs gdb); never fatal, never slow-blocking beyond a cap.
  const info = spawnSync('coredumpctl', ['info', String(entry._pid)],
    { encoding: 'utf8', timeout: 8000 });
  if (info.status === 0 && info.stdout) {
    const st = info.stdout.split(/Stack trace of thread \d+:/)[1] || '';
    for (const line of st.split('\n')) {
      const m = line.match(/#\d+\s+\S+\s+(.+)$/);
      if (m) c.frames.push(m[1].trim().slice(0, 80));
      if (c.frames.length >= 8) break;
    }
    if (!c.signal) c.signal = (info.stdout.match(/Signal:\s+\d+\s+\((\w+)\)/) || [])[1] || '';
  }
  return c;
}

// ------------------------------------------------------ Windows: WER CrashDumps

function scanWindows() {
  const dir = opt('dir', join(process.env.LOCALAPPDATA || homedir(), 'CrashDumps'));
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/\.dmp$/i.test(name)) continue;
    const path = join(dir, name);
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    out.push({ path, name, mtime });
  }
  return out;
}
function parseWindows(entry) {
  // No dependency-free minidump parser; the filename carries the process name
  // (App.exe.1234.dmp), which is the news. A richer parse is a later job.
  const proc = basename(entry.name).replace(/\.\d+\.dmp$/i, '').replace(/\.exe$/i, '');
  return { process: proc, signal: 'crash', exception: '', frames: [], report: entry.path };
}

// ------------------------------------------------------------------ loop

const platform = process.platform;
// An explicit --dir is a portable override: scan it for .ips/.crash reports and
// parse them the macOS way, on any platform (also how you point Linux at a
// directory of core-adjacent reports).
const explicitDir = args.includes('--dir');
const scan = (platform === 'darwin' || explicitDir) ? scanMac : platform === 'win32' ? scanWindows : scanLinux;
const parse = (platform === 'darwin' || explicitDir) ? parseMac : platform === 'win32' ? parseWindows : parseLinux;

if (platform === 'linux' && !explicitDir && !coredumpctlAvailable()) {
  console.error('superlog-crash: coredumpctl not found - install systemd-coredump, ' +
                'or point --dir at a directory of core files (basic parsing only).');
}

const seen = new Set();

async function tick(first) {
  let entries;
  try { entries = scan(); } catch { entries = []; }
  // Newest first, so --backfill takes the most recent.
  entries.sort((a, b) => b.mtime - a.mtime);

  let backfilled = 0;
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    // Baseline with no backfill: note it silently, don't even parse it.
    if (first && backfilled >= backfill) continue;
    const c = parse(e);
    if (!c) continue;
    if (first) {
      // Backfill the newest crashes that pass the filter, up to N.
      if (emit(c)) backfilled++;
    } else {
      emit(c);
    }
  }
}

async function loop() {
  await tick(seen.size === 0);
  await flush();
  if (once) return;
  setTimeout(loop, intervalMs);
}

console.error(`superlog-crash: watching ${platform} crash reports` +
              `${once ? '' : ` every ${intervalMs / 1000}s`} -> crash.${host}.<process>`);
await loop();
