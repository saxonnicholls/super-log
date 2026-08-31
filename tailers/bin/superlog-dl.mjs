#!/usr/bin/env node
//
//  superlog-dl - a download in flight, on the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A 100GB model fetch is hours of silence in a terminal somewhere, and the
//  two facts that matter - is it still moving, and when will it land - are
//  drawn as a \r-rewritten progress bar that exists only on that terminal.
//  superlog-tee cannot help: tee is line-oriented, progress bars are
//  carriage-return-oriented, and curl, wget and tqdm all mute or reshape
//  themselves the moment their output is a pipe. So this wraps instead:
//
//    superlog-dl -- curl -LO https://host/model.safetensors
//    superlog-dl -- wget https://host/dataset.tar
//    superlog-dl --label llama -- hf download meta-llama/Llama-3.1-8B
//    superlog-dl --watch ~/models/llama --size 140GB -- hf download ...
//    superlog-dl --watch /data/corpus --size 100GB     # no command: watch a
//                                                      # fetch owned elsewhere
//
//  The wrapper is transparent, superlog-build's rule: output passes through
//  byte for byte, stdin stays attached, the exit status is the command's
//  own. On top of that it reads the bar - tqdm/hf, curl's meter, wget, or a
//  bare NN% - and publishes percent, bytes and rate as metric events.
//
//  --watch is the answer when the bar is not: it sums the target file or
//  directory on every tick, so progress is measured at the filesystem
//  rather than parsed from anyone's stderr. For a Hugging Face pull of
//  many shards - where each shard gets its own bar and the numbers reset
//  per file - watching the destination directory is the honest aggregate.
//  With --size it becomes a percentage; alone (no command) it will follow
//  a download some other machine's process is writing.
//
//  Publishes to dl.<host>.<label>. Readings are DEBUG `metric` events; a
//  STALL is the edge-triggered WARN - no movement for --stall seconds is
//  the failure worth waking for, hours before the tool itself gives up -
//  and recovery says so too. The ending is one event: INFO with size,
//  duration and average rate, or ERROR with the exit status.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { loadEnv } from './env.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flags = sep >= 0 ? argv.slice(0, sep) : argv;
const command = sep >= 0 ? argv.slice(sep + 1) : [];
const opt = (name, dflt) => {
  const i = flags.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = flags[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (flags.includes('--help') || flags.includes('-h') || (!command.length && !opt('watch'))) {
  console.error(`superlog-dl - progress of a big download, as metric events

  superlog-dl [--label NAME] [--watch PATH] [--size N[KMGT]] [--interval SECONDS]
              [--stall SECONDS] [--topic NAME] [--url HUB] -- <command...>
  superlog-dl --watch PATH [--size N[KMGT]]        # no command: just watch

  superlog-dl -- curl -LO https://host/model.safetensors
  superlog-dl --watch ~/models --size 140GB -- hf download org/model

Transparent wrapper: output, stdin and exit status are untouched. Progress
comes from the tool's own bar (tqdm/hf, curl, wget, bare NN%) and, with
--watch, from the size of the destination itself - which is the reliable
number when a tool downloads many files or goes quiet in a pipe.

Publishes to dl.<host>.<label>. A stall (no movement for --stall seconds,
default 30) is an edge-triggered WARN, an ERROR at three times that - a
download at 0.0MB/s that long is dead, not slow - and recovery says so.`);
  process.exit(command.length || opt('watch') ? 0 : 2);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const intervalMs = Math.max(500, Number(opt('interval', '5')) * 1000);
const stallMs = Math.max(0, Number(opt('stall', '30')) * 1000);
const watch = opt('watch');

// Sizes as humans type them and tools print them. Suffixed values are
// treated as 1024-based - curl, wget and tqdm all are, near enough, and
// this is telemetry for a chart, not accounting.
const UNIT = { '': 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 };
const toBytes = (n, u) => Number(String(n).replace(/,/g, '')) * (UNIT[(u || '').toLowerCase()] ?? 1);
const sizeArg = (s) => {
  const m = /^([\d.,]+)\s*([kKmMgGtT])?i?[bB]?$/.exec(String(s ?? '').trim());
  return m ? toBytes(m[1], m[2]) : undefined;
};
const totalSize = opt('size') ? sizeArg(opt('size')) : undefined;
if (opt('size') && totalSize === undefined) {
  console.error(`superlog-dl: cannot read --size ${opt('size')} (want e.g. 140GB, 500M, 1234567)`);
  process.exit(2);
}

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 48) || 'download';
const host = sanitize(hostname().split('.')[0]);

// A label someone can read on the bench: the URL's basename when there is
// one, else the watched path's, else the tool's name.
function deriveLabel() {
  const url = command.find((a) => /^[a-z]+:\/\//i.test(a));
  if (url) {
    try {
      const p = new URL(url).pathname.split('/').filter(Boolean).pop();
      if (p) return p;
    } catch { /* not a URL after all */ }
  }
  if (watch) return basename(watch);
  return command.length ? basename(command[0]) : 'download';
}
const label = sanitize(opt('label', deriveLabel()));
const topic = opt('topic', `dl.${host}.${label}`);

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;

function publish(level, msg, fields, metric) {
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: label, platform: 'host', device: host },
    tag: 'dl', msg,
    ...(metric ? { metric } : {}),
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

// ---------------------------------------------------------------- parsing
//
// Fragments, not lines: a progress bar is rewritten with \r, so the stream
// is split on both. Each parser leaves absent facts absent - a bar that
// shows no total must not invent one.

function parseFragment(s) {
  const out = {};
  // tqdm / hf: "model-00001: 42%|████     | 2.31G/5.53G [01:12<01:38, 32.1MB/s]"
  let m = /(\d{1,3})%\|[^|]*\|\s*([\d.]+)([kKMGT]?)i?B?\/([\d.]+)([kKMGT]?)i?B?/.exec(s);
  if (m) {
    out.pct = Number(m[1]);
    out.bytes = toBytes(m[2], m[3]);
    out.total = toBytes(m[4], m[5]);
  }
  // curl's meter data row:
  //  " 42 5300M   42 2229M    0     0  31.2M      0  0:02:49 ..." - columns
  //  are %total, Total, %received, Received; the header row has no leading
  //  digits and cannot match.
  if (out.pct === undefined) {
    m = /^\s*(\d{1,3})\s+([\d.]+[kKMGT]?)\s+(\d{1,3})\s+([\d.]+[kKMGT]?)\s/.exec(s);
    if (m) {
      out.pct = Number(m[3]) || Number(m[1]);
      const size = /^([\d.]+)([kKMGT]?)$/.exec(m[4]);
      const tot = /^([\d.]+)([kKMGT]?)$/.exec(m[2]);
      if (size) out.bytes = toBytes(size[1], size[2]);
      if (tot) out.total = toBytes(tot[1], tot[2]);
    }
  }
  // wget, and any tool that at least says NN%.
  if (out.pct === undefined) {
    m = /(?:^|\s)(\d{1,3})(?:\.\d+)?%(?:$|[^\d])/.exec(s);
    if (m && Number(m[1]) <= 100) out.pct = Number(m[1]);
  }
  m = /([\d.]+)\s*([kKMGT]?)i?B\/s/.exec(s);
  if (m) out.rate = toBytes(m[1], m[2]);
  return out;
}

// --------------------------------------------------------------- watching
//
// The destination's own size: parsed bars lie by omission (per-shard resets,
// muted pipes); the filesystem does not. Symlinks are skipped so a Hugging
// Face cache - blobs plus a snapshot tree of links to them - counts each
// byte once.

function sizeOf(path, depth = 0, budget = { entries: 50000 }) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;                                   // not created yet - zero so far
  }
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory() || depth > 12) return 0;
  let sum = 0;
  let names;
  try {
    names = readdirSync(path);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (--budget.entries < 0) return sum;       // a cache this big is not one download
    sum += sizeOf(join(path, n), depth + 1, budget);
  }
  return sum;
}

// ------------------------------------------------------------------ state

const startedAt = Date.now();
const fmt = (b) => b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)}G`
  : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)}M`
  : `${Math.round(b / 2 ** 10)}K`;

let pct;                    // best known, from bar or watch+size
let bytes;                  // best known, watch beats bar
let parsedBytes;
let parsedTotal;
let rate;                   // B/s, parsed; watch delta when there is none
let lastWatch;              // { at, bytes } for the measured rate
let lastMoveAt = Date.now();
let stalled = 0;            // 0 moving, 1 warned, 2 declared dead

function absorb(p) {
  let moved = false;
  if (p.pct !== undefined && p.pct !== pct) { pct = p.pct; moved = true; }
  if (p.bytes !== undefined && p.bytes !== parsedBytes) { parsedBytes = p.bytes; moved = true; }
  if (p.total !== undefined) parsedTotal = p.total;
  if (p.rate !== undefined) rate = p.rate;
  if (moved) lastMoveAt = Date.now();
}

function tick() {
  if (watch) {
    const b = sizeOf(watch);
    if (lastWatch && b > lastWatch.bytes) {
      rate = ((b - lastWatch.bytes) / (Date.now() - lastWatch.at)) * 1000;
      lastMoveAt = Date.now();
    }
    lastWatch = { at: Date.now(), bytes: b };
    bytes = b;
    if (totalSize) pct = Math.min(100, Math.round((b / totalSize) * 100));
  } else {
    bytes = parsedBytes;
  }
  const total = totalSize ?? parsedTotal;

  const bits = [];
  if (pct !== undefined) bits.push(`${pct}%`);
  if (bytes !== undefined) bits.push(total ? `${fmt(bytes)}/${fmt(total)}` : fmt(bytes));
  if (rate !== undefined) bits.push(`${(rate / 2 ** 20).toFixed(1)}MB/s`);
  if (!bits.length) return;                     // nothing known yet is nothing to say

  const f = { label, ...(watch ? { watch } : {}) };
  publish('DEBUG', bits.join(' '), f,
          pct !== undefined ? { name: 'dl.pct', value: pct } : undefined);
  if (bytes !== undefined)
    publish('DEBUG', `dl.mb ${fmt(bytes)}`, f,
            { name: 'dl.mb', value: Number((bytes / 2 ** 20).toFixed(1)) });
  if (rate !== undefined)
    publish('DEBUG', `dl.rate_mbs ${(rate / 2 ** 20).toFixed(1)}`, f,
            { name: 'dl.rate_mbs', value: Number((rate / 2 ** 20).toFixed(2)) });

  // The stall is the event this tool exists for: a fetch that dies at hour
  // three fails silently until the tool's own (often infinite) patience
  // runs out. Edge-triggered both ways, and it ESCALATES: quiet for --stall
  // is a WARN (shard gaps and slow mirrors happen), quiet for three times
  // that is an ERROR - a download at 0.0MB/s that long is not slow, it is
  // dead, and a dead transfer must not sit at WARN all night.
  if (stallMs > 0) {
    const quiet = Date.now() - lastMoveAt;
    const stage = quiet >= stallMs * 3 ? 2 : quiet >= stallMs ? 1 : 0;
    if (stage > stalled) {
      publish(stage === 2 ? 'ERROR' : 'WARN',
              `stalled: no progress in ${Math.round(quiet / 1000)}s` +
              (stage === 2 ? ' - treating as dead' : '') +
              (bits.length ? ` (at ${bits.join(' ')})` : ''), { ...f, change: 'stall' });
      stalled = stage;
    } else if (stalled && stage === 0) {
      stalled = 0;
      publish('INFO', `recovered: moving again at ${bits.join(' ')}`, { ...f, change: 'recovered' });
    }
  }

  // Watch-only mode with a known size has a finish line of its own.
  if (!command.length && totalSize && bytes !== undefined && bytes >= totalSize)
    void done(0, 'reached --size');
}

function summary() {
  const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const dur = secs >= 3600 ? `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`
    : secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
  const got = bytes ?? parsedBytes;
  return got !== undefined
    ? `${fmt(got)} in ${dur} (avg ${(got / secs / 2 ** 20).toFixed(1)}MB/s)`
    : `finished in ${dur}`;
}

let finished = false;
async function done(code, why) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  if (code === 0) {
    publish('INFO', `done: ${label} ${summary()}${why ? ` - ${why}` : ''}`,
            { label, exit: '0' });
  } else {
    publish('ERROR', `failed: ${label} (exit ${code})` +
            (pct !== undefined ? ` at ${pct}%` : ''), { label, exit: String(code) });
  }
  await flush();
  process.exit(code);
}

// -------------------------------------------------------------------- run

publish('INFO', `downloading ${label}` +
        (command.length ? `: ${command.join(' ').slice(0, 200)}` : ` (watching ${watch})`),
        { label, watch, size: totalSize, command: command.join(' ').slice(0, 500) });

const timer = setInterval(() => { tick(); void flush(); }, intervalMs);

let child = null;
if (command.length) {
  // stdin stays attached - hf asks for tokens, curl for passwords - and
  // output passes through FIRST, untouched: superlog-tee's rule. What this
  // tool does afterwards must not change what the wrapped command does.
  child = spawn(command[0], command.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
  const pump = (from, to) => {
    let carry = '';
    from.on('data', (chunk) => {
      try { to.write(chunk); } catch { /* downstream closed */ }
      const parts = (carry + chunk.toString()).split(/[\r\n]/);
      carry = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) absorb(parseFragment(p));
    });
  };
  pump(child.stdout, process.stdout);
  pump(child.stderr, process.stderr);
  child.on('error', (e) => {
    publish('CRITICAL', `cannot run ${command[0]}: ${e.message}`, { label });
    void done(127);
  });
  child.on('close', (code) => {
    tick();                                     // the last watch reading, not the second-last
    void done(code ?? 1);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      child?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    void done(sig === 'SIGINT' ? 130 : 143);
  });
}

console.error(`superlog-dl: ${label} -> ${topic}` +
              (watch ? ` (watching ${watch}${totalSize ? `, ${fmt(totalSize)} expected` : ''})` : ''));
