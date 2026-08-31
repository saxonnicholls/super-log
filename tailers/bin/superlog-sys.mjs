#!/usr/bin/env node
//
//  superlog-sys - the machine's own life events. macOS.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  This bench crashed four times before anything was watching, and the
//  evidence was sitting in ~/Library/Logs/DiagnosticReports the whole time
//  - crash reports nobody opens, a shutdown cause nobody queries. And the
//  100GB corpus build that died mid-write was killed by a VOLUME RENAME,
//  which no application log anywhere records. The machine journals its own
//  life; this puts that journal on the bench beside the work it interrupts.
//
//    superlog-sys                        # watch: crashes, volumes, sleep/wake
//    superlog-sys --once                 # last shutdown cause + recent reports
//
//  Publishes to sys.<host>. Four sources, none needing root:
//
//    - DiagnosticReports (yours and /Library's when readable): each new
//      .ips or .panic is ONE parsed event - process, exception, signal,
//      termination indicator - ERROR for a crash, CRITICAL for a panic.
//      Reports newer than --backfill (default 1h) are published at startup,
//      because a crash usually lands the report BEFORE the reboot that
//      restarts this tailer.
//    - The previous shutdown cause, once per boot, from the unified log:
//      5 is clean and INFO; anything else - power loss, watchdog, hard
//      button - is ERROR, because an unclean shutdown is the fact the next
//      investigation starts from.
//    - `diskutil activity`, one long-lived child (killed on the way out):
//      mounts INFO, unmounts/ejects WARN, and RENAMES WARN - a rename
//      moves every path on the volume, which is how builds die mid-write.
//    - Sleep/wake via kern.sleeptime/kern.waketime, polled: a machine that
//      slept explains every gap in every other stream.
//
//  Level discipline as everywhere here: events are facts said once, not
//  readings repeated; there is nothing to chart, so nothing is DEBUG.
//
//  Node >= 18.
//

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};
const optAll = (name) =>
  args.reduce((acc, a, i) => (a === `--${name}` && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-sys - crashes, panics, shutdown causes, volumes, sleep/wake (macOS)

  superlog-sys [--once] [--interval SECONDS] [--backfill 1h|30m|0]
               [--reports DIR]... [--topic NAME] [--url HUB]

Publishes to sys.<host>. A crash report is ERROR, a kernel panic CRITICAL,
an unclean previous shutdown ERROR (said once per boot), a volume unmount
or RENAME is WARN - a rename moves every path on the volume, which is how
long writes die - and sleep/wake are INFO. Nothing repeats.

--reports adds report directories (default: your DiagnosticReports and the
system one when readable). --backfill publishes reports newer than this at
startup, because the crash usually predates the reboot that starts us.`);
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.error('superlog-sys: DiagnosticReports, diskutil and pmset are macOS; nothing to watch here.');
  process.exit(2);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const once = args.includes('--once');
const intervalMs = Math.max(5000, Number(opt('interval', '30')) * 1000);
const backfillMs = (() => {
  const m = /^(\d+)\s*([hms]?)$/.exec(String(opt('backfill', '1h')).trim());
  if (!m) return 3600000;
  return Number(m[1]) * ({ h: 3600000, m: 60000, s: 1000, '': 1000 }[m[2]]);
})();

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'mac';
const host = sanitize(hostname().split('.')[0]);
const topic = opt('topic', `sys.${host}`);

const reportDirs = optAll('reports').length ? optAll('reports') : [
  join(homedir(), 'Library/Logs/DiagnosticReports'),
  '/Library/Logs/DiagnosticReports',            // readable for admins; skipped quietly if not
];

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;

function publish(level, msg, fields) {
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'sys', platform: 'host', device: host },
    tag: 'sys', msg,
    ...(fields ? { fields: Object.fromEntries(Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)])) } : {}),
  }));
}

async function flush() {
  if (!buf.length) return;
  const body = buf.join('\n');
  buf = [];
  try {
    await fetch(`${hubUrl}/ingest/${topic}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch {
    /* hub down; the next batch counts again */
  }
}

// ---------------------------------------------------------- crash reports
//
// Modern reports are .ips: line one is a JSON summary (app_name, bug_type),
// the rest a JSON body carrying exception and termination. Parsed
// defensively - a report we cannot parse is still a crash worth an event,
// named by its filename, because the report EXISTING is the fact.

const PANIC_TYPES = new Set(['210', '288']);    // kernel panic, bridgeOS

function parseReport(path) {
  const name = basename(path);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;                                // counted once, not spammed per file
  }
  // Legacy text formats; a modern panic is an .ips and parses below.
  if (name.endsWith('.panic') || name.endsWith('.crash')) {
    return { level: name.endsWith('.panic') ? 'CRITICAL' : 'ERROR',
             msg: `${name.endsWith('.panic') ? 'kernel panic' : 'crash report'}: ${name}`,
             fields: { report: name, kind: name.endsWith('.panic') ? 'panic' : 'crash',
                       detail: raw.slice(0, 300).replace(/\s+/g, ' ') } };
  }
  const nl = raw.indexOf('\n');
  let head = {};
  let body = {};
  try { head = JSON.parse(raw.slice(0, nl)); } catch { /* older text format */ }
  try { body = JSON.parse(raw.slice(nl + 1)); } catch { /* body is optional */ }
  const proc = head.app_name ?? head.name ?? name.split(/[-.]/)[0];
  const panic = PANIC_TYPES.has(String(head.bug_type));
  // Resource diagnostics (.diag: a process over its CPU or disk budget) are
  // the machine complaining, not dying - WARN, not ERROR.
  const diag = name.endsWith('.diag');
  const exc = body.exception ?? {};
  const term = body.termination ?? {};
  const what = [exc.type, exc.signal && `(${exc.signal})`, term.indicator]
    .filter(Boolean).join(' ');
  return {
    level: panic ? 'CRITICAL' : diag ? 'WARN' : 'ERROR',
    msg: `${panic ? 'panic' : diag ? 'resource diagnostic' : 'crash'}: ${proc}${what ? ` - ${what}` : ''}`,
    fields: { report: name, process: proc, bug_type: head.bug_type,
              os_version: head.os_version, exception: exc.type, signal: exc.signal,
              indicator: term.indicator, kind: panic ? 'panic' : diag ? 'diag' : 'crash' },
  };
}

const seen = new Set();
let firstScan = true;
let unreadable = 0;
let unreadableSaid = false;

function scanReports() {
  // Retired/ is where macOS moves reports after a while - and where THIS
  // bench's real panics turned out to be sitting. `seen` is by filename, so
  // a report being retired mid-watch is a move, not a second crash.
  for (const dir of reportDirs.flatMap((d) => [d, join(d, 'Retired')])) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;                                 // absent or not ours to read
    }
    for (const n of names) {
      // Dotfiles are DiagnosticReports' own bookkeeping (.contents.panic is
      // a pointer file, not a panic) - never reports.
      if (n.startsWith('.') || !/\.(ips|panic|crash|diag)$/.test(n) || seen.has(n)) continue;
      seen.add(n);
      const full = join(dir, n);
      let mtime = 0;
      try { mtime = statSync(full).mtimeMs; } catch { continue; }
      // The baseline is silent, except the recent past: a crash writes its
      // report BEFORE the reboot that restarts this tailer, so "new since
      // process start" would miss exactly the report that matters most.
      if (firstScan && Date.now() - mtime > backfillMs) continue;
      const r = parseReport(full);
      if (!r) { unreadable += 1; continue; }
      publish(r.level, r.msg, { ...r.fields, dir, at: new Date(mtime).toISOString() });
    }
  }
  // Said once: reports we can see but not read (the system directory is
  // root:_analyticsusers). Silence here would look like a healthy machine.
  if (unreadable && !unreadableSaid) {
    unreadableSaid = true;
    publish('WARN', `${unreadable} diagnostic report(s) exist but are not readable by this user - ` +
            'the system reports need membership of _analyticsusers (or run this via sudo)',
            { kind: 'unreadable', count: unreadable });
  }
  firstScan = false;
}

// ------------------------------------------------------- shutdown cause
//
// Once per boot, from the unified log. Cause 5 is a clean shutdown; the
// negative causes are the hardware's own words for what went wrong.

const SHUTDOWN_CAUSE = {
  '5': 'clean shutdown', '0': 'power loss', '3': 'hard shutdown (power button held)',
  '-60': 'dirty shutdown (bad master directory)', '-62': 'watchdog reset',
  '-75': 'power supply disconnected', '-103': 'battery critical',
  '-128': 'uncontrolled power loss',
};

function shutdownCause() {
  return new Promise((resolve) => {
    const child = spawn('log', ['show', '--last', 'boot', '--style', 'compact',
      '--predicate', 'eventMessage CONTAINS[c] "previous shutdown cause"'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    // `log show` over a long uptime is slow; cap it rather than trust it.
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    timer.unref?.();
    child.on('error', () => resolve());
    child.on('close', () => {
      clearTimeout(timer);
      const m = /previous shutdown cause:?\s*(-?\d+)/i.exec(out);
      if (m) {
        const code = m[1];
        const said = SHUTDOWN_CAUSE[code] ?? 'unclean shutdown';
        publish(code === '5' ? 'INFO' : 'ERROR',
                `previous shutdown: ${said} (cause ${code})`,
                { cause: code, meaning: said, kind: 'shutdown' });
      }
      // No flush here: it would race the once-mode exit, which awaits ONE
      // flush after this resolves - a fetch in flight when process.exit
      // fires is an event that silently never arrives. The callers own
      // flushing; in watch mode the 1s timer delivers this within a beat.
      resolve();
    });
  });
}

// -------------------------------------------------------- volume activity
//
// diskutil activity streams DiskArbitration events for as long as it runs -
// one long-lived child, killed on the way out. A rename is levelled WARN
// with the unmounts because it moves every path on the volume at once.

let da = null;
let daStopping = false;

function startDiskWatch() {
  da = spawn('diskutil', ['activity'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let carry = '';
  const KIND = {
    DiskMounted: ['INFO', 'mounted'], DiskAppeared: ['INFO', 'appeared'],
    DiskUnmounted: ['WARN', 'unmounted'], DiskDisappeared: ['WARN', 'disappeared'],
    DiskRenamed: ['WARN', 'renamed'], DiskEjected: ['WARN', 'ejected'],
  };
  da.stdout.on('data', (d) => {
    carry += d.toString();
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const m = /^\*\*\*(\w+)\s*\(\s*'([^']+)'(.*)\)\s*$/.exec(line.trim());
      if (!m || !KIND[m[1]]) continue;
      const [level, verb] = KIND[m[1]];
      const volName = /DAVolumeName\s*=\s*'([^']*)'/.exec(m[3])?.[1];
      const volPath = /DAVolumePath\s*=\s*'([^']*)'/.exec(m[3])?.[1];
      publish(level,
              `volume ${verb}: ${volName ?? m[2]}${volPath ? ` (${volPath})` : ''}` +
              (verb === 'renamed' ? ' - every path on it just moved' : ''),
              { kind: 'volume', change: verb, disk: m[2], volume: volName, path: volPath });
    }
  });
  da.on('close', () => {
    da = null;
    if (!daStopping) setTimeout(startDiskWatch, 5000).unref?.();
  });
  da.on('error', () => { da = null; });
}

// ------------------------------------------------------------ sleep/wake

let lastSleep = null;
let lastWake = null;

function checkSleepWake() {
  const r = spawnSync('sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], { encoding: 'utf8' });
  const secs = [...(r.stdout ?? '').matchAll(/sec\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  if (secs.length < 2) return;
  const [sleepSec, wakeSec] = secs;
  if (lastSleep !== null && sleepSec !== lastSleep && sleepSec > 0)
    publish('INFO', `slept at ${new Date(sleepSec * 1000).toISOString()}`,
            { kind: 'sleep', at: new Date(sleepSec * 1000).toISOString() });
  if (lastWake !== null && wakeSec !== lastWake && wakeSec > 0)
    publish('INFO', `woke at ${new Date(wakeSec * 1000).toISOString()} - gaps in other streams end here`,
            { kind: 'wake', at: new Date(wakeSec * 1000).toISOString() });
  lastSleep = sleepSec;
  lastWake = wakeSec;
}

// ------------------------------------------------------------------- run

console.error(`superlog-sys: ${host} -> ${topic}` +
              (once ? ' (once)' : ` (reports, volumes, sleep/wake; every ${intervalMs / 1000}s)`));

scanReports();
checkSleepWake();
const causeDone = shutdownCause();

if (once) {
  // One reading means waiting for `log show`, which owns the only slow answer.
  causeDone.then(async () => {
    await flush();
    process.exit(0);
  });
} else {
  startDiskWatch();
  for (const dir of reportDirs) {
    try {
      watch(dir, () => scanReports());
    } catch {
      /* absent or unreadable - the interval rescan covers it if it appears */
    }
  }
  setInterval(() => {
    scanReports();
    checkSleepWake();
    void flush();
  }, intervalMs);
  setInterval(() => void flush(), 1000).unref?.();

  const stop = async (code) => {
    daStopping = true;
    try { da?.kill('SIGTERM'); } catch { /* already gone */ }
    await flush();
    process.exit(code);
  };
  process.on('SIGINT', () => void stop(130));
  process.on('SIGTERM', () => void stop(143));
}
