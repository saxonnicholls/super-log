#!/usr/bin/env node
//
//  superlog-power - watts, thermals, and who is drawing them. macOS.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  This machine sat at 1258% aggregate CPU - eleven saturated cores, one
//  VS Code extension - and nobody knew until the fans got loud and
//  kernel_task began thermally throttling. It has crashed four times under
//  runaway draw. Aggregate CPU plus package watts over time, with the top
//  energy consumers attached to each sample, catches that in minutes; this
//  samples exactly those and puts them on the bench beside the logs of the
//  processes responsible.
//
//    superlog-power                       # this machine, every 10s
//    superlog-power --once                # one reading, then exit
//    superlog-power --out ./power-log     # ...also straight to disk, rotated
//
//  Publishes to power.<host>. Readings are DEBUG `metric` events - always
//  there for a chart, out of a default INFO view - and threshold crossings
//  are edge-triggered WARN/ERROR that announce recovery too, like the other
//  watchers here. "Too much power" has no universal number, so three
//  detectors, weakest claim first: absolute watts caps when you know your
//  machine's envelope (--watts-warn/--watts-crit); sustained draw at a
//  multiple of this machine's own learned baseline; and the machine's own
//  verdict - thermal pressure and the kernel's CPU speed limit - which is
//  the OS saying "too much" in so many words and needs no configuration.
//
//  powermetrics requires root, and this NEVER asks for a password. Already
//  root: powermetrics runs directly. Otherwise `sudo -n` on the pinned
//  wrapper that scripts/install-power-tailer.sh installs - a sudoers entry
//  scoped to one root-owned script (see the installer for why the entry is
//  not on powermetrics itself). Neither configured: it degrades and says
//  so. Thermal pressure, aggregate CPU and the top processes still flow,
//  and each reading carries power_unavailable explaining the missing watts
//  - silence and "not measured" must never look alike.
//
//  powermetrics runs ONCE as a long-lived child at the sample interval;
//  respawning it per sample would spend real power measuring power. It is
//  killed on the way out for the same reason. Output is plist (-f plist,
//  NUL-separated documents) rather than scraped text, because the text
//  rearranges between macOS releases; Intel and Apple Silicon name and
//  scale the fields differently (watts vs milliwatts), so the shape is
//  chosen by `uname -m` and parsed defensively either way.
//
//  Node >= 18.
//

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { cpus, hostname } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-power - CPU package watts, thermal pressure, and the top energy consumers (macOS)

  superlog-power [--once] [--interval SECONDS] [--top N] [--url HUB] [--topic NAME]
                 [--cpu-warn PCT] [--cpu-crit PCT] [--proc-warn PCT]
                 [--watts-warn W] [--watts-crit W] [--watts-factor N]
                 [--wrapper PATH] [--out DIR] [--rotate-mb 64] [--max-files N] [--max-days N]

Publishes to power.<host>. Readings are DEBUG metric events; threshold
crossings are edge-triggered WARN/ERROR and recovery says so too.

powermetrics needs root and this never prompts: run
  sudo scripts/install-power-tailer.sh
once, or run this tailer as root. Without either it still publishes thermal
pressure, aggregate CPU and the top processes, marked power_unavailable.

--cpu-warn/--cpu-crit are percent of total capacity (default 50/85).
--proc-warn is %cpu of a single process (default 400 = four cores; 0 off).
--watts-warn/--watts-crit are absolute package watts (default off);
--watts-factor flags sustained draw above N x this machine's own learned
baseline (default 3; 0 off).
--out writes every event to DIR as well, size-rotated like superlog-journal.`);
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.error('superlog-power: powermetrics and pmset are macOS; nothing to sample here.');
  process.exit(2);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const once = args.includes('--once');
const intervalMs = Math.max(1000, Number(opt('interval', env.SUPER_LOG_POWER_INTERVAL ?? '10')) * 1000);
const topN = Math.max(1, Number(opt('top', '5')));
const cpuWarn = Number(opt('cpu-warn', '50'));
const cpuCrit = Number(opt('cpu-crit', '85'));
const procWarn = Number(opt('proc-warn', '400'));
const wattsWarn = Number(opt('watts-warn', '0'));
const wattsCrit = Number(opt('watts-crit', '0'));
const wattsFactor = Number(opt('watts-factor', '3'));
const wrapper = opt('wrapper', env.SUPER_LOG_POWER_WRAPPER ?? '/usr/local/libexec/superlog-powermetrics');
const outDir = opt('out');
const rotateBytes = Number(opt('rotate-mb', '64')) * 1024 * 1024;
const maxFiles = Math.max(0, Number(opt('max-files', '0')) || 0);
const maxDays = Math.max(0, Number(opt('max-days', '0')) || 0);

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'mac';
const host = sanitize(hostname().split('.')[0]);
const topic = opt('topic', `power.${host}`);

// uname -m rather than process.arch: a Rosetta node reports x64 on a machine
// whose powermetrics speaks Apple Silicon.
const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout?.trim() || 'unknown';
const appleSilicon = arch === 'arm64';

// ------------------------------------------------------------ the sidecar
//
// --out writes every event to disk as well as to the hub, with
// superlog-journal's rotation and retention semantics. It exists because
// this tailer's whole reason is a machine that falls over - and a machine
// falling over takes the hub and the journal with it. The last few samples
// before a crash are exactly the ones worth having locally.

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
// Only files this writer made are ever candidates for deletion, same rule
// and same reasoning as superlog-journal.
const MINE = /^superlog-power-\d{8}-\d{6}\.ndjson$/;

let sidecar = null;
let written = 0;

function prune(current) {
  if (!maxFiles && !maxDays) return;
  let mine;
  try {
    mine = readdirSync(outDir).filter((n) => MINE.test(n)).sort()
      .map((n) => join(outDir, n)).filter((p) => p !== current);
  } catch {
    return;
  }
  const doomed = new Set();
  if (maxFiles > 0)
    for (const p of mine.slice(0, Math.max(0, mine.length - (maxFiles - 1)))) doomed.add(p);
  if (maxDays > 0) {
    const cutoff = Date.now() - maxDays * 86400000;
    for (const p of mine) {
      try {
        if (statSync(p).mtimeMs < cutoff) doomed.add(p);
      } catch {
        /* vanished under us - fine, that was the goal */
      }
    }
  }
  for (const p of doomed) {
    try {
      unlinkSync(p);
      console.error(`superlog-power: pruned ${p}`);
    } catch (e) {
      console.error(`superlog-power: could not prune ${p}: ${e.message}`);
    }
  }
}

function openSidecar() {
  const path = join(outDir, `superlog-power-${stamp()}.ndjson`);
  sidecar = createWriteStream(path, { flags: 'a' });
  written = 0;
  console.error(`superlog-power: writing ${path}`);
  prune(path);
}
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  openSidecar();
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;

function publish(level, msg, fields, metric) {
  const line = JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'power', platform: 'host', device: host },
    tag: 'power', msg,
    ...(metric ? { metric } : {}),
    ...(fields ? { fields: Object.fromEntries(Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)])) } : {}),
  });
  buf.push(line);
  if (sidecar) {
    sidecar.write(line + '\n');
    written += line.length + 1;
    if (written >= rotateBytes) {
      sidecar.end();
      openSidecar();
    }
  }
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

function run(cmd, argv) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

// ---------------------------------------------------------- plist parsing
//
// A tiny plist reader because this repo ships no dependencies. It reads the
// node kinds powermetrics actually emits - dict, array, string, integer,
// real, true/false, date, data - and treats anything else as an opaque
// scalar rather than failing the document.

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos);|&#(\d+);|&#x([0-9a-fA-F]+);/g,
  (_, name, dec, hex) => (name ? ENT[name] : String.fromCodePoint(parseInt(dec ?? hex, dec ? 10 : 16))));

const TAG = /<(\/?)([a-zA-Z][\w.-]*)(?:\s[^>]*?)?(\/?)>/g;

function nextTag(xml, i) {
  TAG.lastIndex = i;
  const m = TAG.exec(xml);
  if (!m) throw new Error('no tag');
  return { close: m[1] === '/', name: m[2], self: m[3] === '/', start: m.index, end: TAG.lastIndex };
}

function scalarText(xml, from, name) {
  const end = xml.indexOf(`</${name}>`, from);
  if (end < 0) throw new Error(`unterminated <${name}>`);
  return [xml.slice(from, end), end + name.length + 3];
}

function value(xml, i) {
  const t = nextTag(xml, i);
  if (t.close) throw new Error(`unexpected </${t.name}>`);
  switch (t.name) {
    case 'dict': {
      const d = {};
      if (t.self) return [d, t.end];
      let j = t.end;
      for (;;) {
        const k = nextTag(xml, j);
        if (k.close && k.name === 'dict') return [d, k.end];
        if (k.name !== 'key') throw new Error(`expected <key>, got <${k.name}>`);
        const [key, after] = scalarText(xml, k.end, 'key');
        const [v, done] = value(xml, after);
        d[decode(key)] = v;
        j = done;
      }
    }
    case 'array': {
      const a = [];
      if (t.self) return [a, t.end];
      let j = t.end;
      for (;;) {
        const n = nextTag(xml, j);
        if (n.close && n.name === 'array') return [a, n.end];
        const [v, done] = value(xml, n.start);
        a.push(v);
        j = done;
      }
    }
    case 'true': return [true, t.end];
    case 'false': return [false, t.end];
    case 'integer': case 'real': {
      if (t.self) return [0, t.end];
      const [s, j] = scalarText(xml, t.end, t.name);
      return [Number(s), j];
    }
    default: {
      // string, date, data, and whatever a future release invents: text.
      if (t.self) return ['', t.end];
      const [s, j] = scalarText(xml, t.end, t.name);
      return [decode(s), j];
    }
  }
}

function parsePlist(xml) {
  const at = xml.indexOf('<plist');
  if (at < 0) return undefined;
  const from = xml.indexOf('>', at);
  if (from < 0) return undefined;
  try {
    return value(xml, from + 1)[0];
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------- extraction
//
// Two machines, two dialects. Apple Silicon: processor.{cpu_power,
// gpu_power, ane_power, combined_power} in MILLIWATTS, thermal_pressure as
// a word. Intel: keys with "watt" in them, in watts, wherever this release
// put them. The key names drift less than the paths, so unknown shapes get
// a bounded depth-first hunt by name. Anything not found stays undefined -
// a missing reading and a reading of zero are different facts, and charting
// the second as the first is a lie.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function dig(node, rx, want = 'number', depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  for (const [k, v] of Object.entries(node))
    if (rx.test(k) && typeof v === want) return v;
  for (const v of Object.values(node)) {
    const hit = dig(v, rx, want, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function extract(doc) {
  const p = doc.processor && typeof doc.processor === 'object' ? doc.processor : undefined;
  const s = {};

  if (appleSilicon) {
    const mw = (v) => (num(v) !== undefined ? v / 1000 : undefined);
    s.packageW = mw(p?.combined_power) ?? mw(dig(doc, /^combined_power$/));
    s.cpuW = mw(p?.cpu_power);
    s.gpuW = mw(p?.gpu_power);
    s.aneW = mw(p?.ane_power);
  } else {
    s.packageW = num(p?.package_watts) ??
      dig(p ?? doc, /package.*watt|^package_power$|^average_power$/i);
    s.cpuW = dig(p ?? {}, /^cores?_watts?$|cpu.*watt/i);
    s.gpuW = dig(p ?? {}, /gt.*watt|gpu.*watt/i);
  }

  s.pressure = typeof doc.thermal_pressure === 'string'
    ? doc.thermal_pressure : dig(doc, /^thermal_pressure$/, 'string');

  const smc = doc.smc && typeof doc.smc === 'object' ? doc.smc : undefined;
  if (smc) {
    const fans = [];
    const huntFans = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 3) return;
      for (const [k, v] of Object.entries(node)) {
        // cpu_die_fan_target and the simulated_* keys are setpoints, not
        // readings: a 0 rpm "fan" from either would chart as a dead fan.
        if (/target|simulated/i.test(k)) continue;
        if (/fan/i.test(k)) {
          const rpm = num(v) ?? dig(v, /rpm|speed|actual/i);
          if (rpm !== undefined) fans.push(rpm);
        } else if (typeof v === 'object') {
          huntFans(v, depth + 1);
        }
      }
    };
    huntFans(smc);
    s.fans = fans;
    // Two die temperatures, kept apart: "gpu_die" also contains "die", so
    // the CPU hunt must name the CPU rather than grab the first die it sees.
    s.dieC = num(smc.cpu_die) ?? dig(smc, /cpu.*die|cpu.*temp/i);
    s.gpuDieC = num(smc.gpu_die) ?? dig(smc, /gpu.*die|gpu.*temp/i);
  }

  if (Array.isArray(doc.tasks)) {
    // Negative pids are aggregate rows (ALL_TASKS), not processes.
    s.top = doc.tasks
      .filter((t) => t && num(t.pid) !== undefined && t.pid >= 0)
      .map((t) => ({
        pid: t.pid, name: String(t.name ?? '?'),
        energy: num(t.energy_impact),
        cpuPct: num(t.cputime_ms_per_s) !== undefined ? t.cputime_ms_per_s / 10 : undefined,
      }))
      .sort((a, b) => (b.energy ?? b.cpuPct ?? 0) - (a.energy ?? a.cpuPct ?? 0))
      .slice(0, topN);
  }
  return s;
}

// -------------------------------------------------- the powermetrics child
//
// Spawned once and kept, killed on the way out: a leaked powermetrics is
// itself a power cost, which for this tool in particular would be
// embarrassing. A child that dies before its first sample died of missing
// privilege, and retrying into the same wall every second would be its own
// runaway - so that case degrades instead. A child that dies after working
// hit something transient and is restarted with capped backoff.

let pm = null;
let pmStderr = '';
let latest = null;          // { at, sample } - the newest parsed document
let unavailable = null;     // why watts are missing, once that is known
let stopping = false;
let backoffMs = 0;

function pmArgv(ms) {
  // Direct-spawn path only; the unprivileged path goes through the wrapper,
  // which pins its own arguments (and must, for the sudoers entry to mean
  // anything). smc and thermal exist on some macOS releases and not others;
  // the help is printable without root, so ask it.
  let samplers = 'cpu_power,tasks';
  const r = spawnSync('powermetrics', ['-h'], { encoding: 'utf8' });
  const help = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (const extra of ['smc', 'thermal'])
    if (new RegExp(`^\\s{4}${extra}\\s`, 'm').test(help)) samplers += `,${extra}`;
  return ['--samplers', samplers, '--show-process-energy', '-f', 'plist', '-i', String(ms), '-b', '1'];
}

function startPowermetrics() {
  if (stopping || unavailable) return;
  // --once should not sit out a full interval waiting for its one sample.
  const ms = once ? 1000 : intervalMs;
  const spawnedAt = Date.now();
  pmStderr = '';

  const [cmd, argv] =
    process.getuid?.() === 0 ? ['powermetrics', pmArgv(ms)]
    : existsSync(wrapper)    ? ['sudo', ['-n', wrapper, String(ms)]]
                             : ['sudo', ['-n', 'powermetrics', ...pmArgv(ms)]];
  pm = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Documents are NUL-separated (the help says so), but the reliable frame
  // is the closing tag: split on that and any separator is just noise
  // between frames.
  let carry = '';
  pm.stdout.on('data', (d) => {
    carry += d.toString();
    for (;;) {
      const end = carry.indexOf('</plist>');
      if (end < 0) break;
      const doc = parsePlist(carry.slice(0, end + 8));
      carry = carry.slice(end + 8).replace(/^[\s\0 ]+/, '');
      if (doc) latest = { at: Date.now(), sample: extract(doc) };
    }
    if (carry.length > 8 * 1024 * 1024) carry = ''; // that is not a document
  });
  pm.stderr.on('data', (d) => (pmStderr = (pmStderr + d.toString()).slice(-2000)));

  let done = false;
  const finish = (code) => {
    if (done || stopping) return;
    done = true;
    pm = null;
    if (!latest && Date.now() - spawnedAt < 3000) {
      unavailable = /password|superuser|not permitted|sudo:/i.test(pmStderr)
        ? 'not root' : `exit ${code}`;
      publish('WARN',
        `powermetrics unavailable (${unavailable}) - package watts, fans and per-process ` +
        'energy are missing. sudo scripts/install-power-tailer.sh grants exactly this and nothing else.',
        { power_unavailable: unavailable, detail: pmStderr.split('\n')[0] });
      return;
    }
    backoffMs = Math.min((backoffMs || 1000) * 2, 30000);
    publish('WARN', `powermetrics exited (${code}); restarting in ${backoffMs / 1000}s`,
      { detail: pmStderr.split('\n')[0] });
    setTimeout(startPowermetrics, backoffMs).unref?.();
  };
  pm.on('error', () => finish(127));
  pm.on('close', (code) => finish(code));
}

// ---------------------------------------------------------------- reading

function parseTherm(text) {
  // pmset -g therm, no root needed:
  //   CPU_Speed_Limit = 100  <- the kernel's throttle, 100 means none
  //   CPU_Available_CPUs = 32
  const t = {};
  for (const m of text.matchAll(/(\w+)\s*=\s*(\d+)/g)) t[m[1]] = Number(m[2]);
  return t;
}

function parsePs(text) {
  let total = 0;
  const procs = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pct = Number(m[2]);
    total += pct;
    procs.push({ pid: Number(m[1]), cpuPct: pct, name: m[3].trim().split('/').pop() });
  }
  procs.sort((a, b) => b.cpuPct - a.cpuPct);
  return { total, top: procs.slice(0, topN) };
}

// Edge-triggered, exactly as superlog-vitals: a crossing is news, the same
// crossing thirty seconds later is not, and recovery is news too.
const state = new Map();
function threshold(key, level, msg, fields, metric) {
  const before = state.get(key) ?? 'ok';
  if (before === level) return;
  state.set(key, level);
  if (level === 'ok') {
    publish('INFO', `recovered: ${msg}`, { ...fields, change: 'recovered' }, metric);
  } else {
    publish(level === 'crit' ? 'ERROR' : 'WARN', msg, { ...fields, change: 'threshold' }, metric);
  }
}

// The baseline teaches "too much" per machine: a Mac Pro idles where a
// MacBook Air peaks, so an absolute default would be wrong on one of them.
// Learned slowly, and only after judging the sample against it, so a
// runaway does not teach us that the runaway is normal.
let baseW = 0;
let baseN = 0;

async function tick(first) {
  const [thermText, psText] = await Promise.all([
    run('pmset', ['-g', 'therm']),
    run('ps', ['-Axo', 'pid=,pcpu=,comm=']),
  ]);
  const therm = parseTherm(thermText);
  const ps = parsePs(psText);
  const ncpu = cpus().length || therm.CPU_Available_CPUs || 1;
  const capacity = ncpu * 100;
  const capPct = Math.round((ps.total / capacity) * 100);

  // Watts, only while they are fresh: a stalled powermetrics must read as
  // "not measured", never as "unchanged".
  const fresh = latest && Date.now() - latest.at <= intervalMs * 3 + 5000;
  const s = fresh ? latest.sample : {};

  // Aggregate CPU as ONE number, so 1258% reads as 1258 on a chart. This
  // comes from ps rather than powermetrics so it survives degraded mode.
  publish('DEBUG', `cpu ${ps.total.toFixed(0)}% aggregate (${capPct}% of ${ncpu} cores)`,
    { cores: ncpu, capacity_pct: capPct,
      ...(unavailable ? { power_unavailable: unavailable } : {}) },
    { name: 'power.cpu_pct', value: Math.round(ps.total) });

  if (s.packageW !== undefined)
    publish('DEBUG', `package ${s.packageW.toFixed(1)}W`, { host },
      { name: 'power.package_w', value: Number(s.packageW.toFixed(2)) });
  if (s.cpuW !== undefined)
    publish('DEBUG', `cpu ${s.cpuW.toFixed(1)}W`, { host },
      { name: 'power.cpu_w', value: Number(s.cpuW.toFixed(2)) });
  if (s.gpuW !== undefined)
    publish('DEBUG', `gpu ${s.gpuW.toFixed(1)}W`, { host },
      { name: 'power.gpu_w', value: Number(s.gpuW.toFixed(2)) });
  if (s.aneW !== undefined)
    publish('DEBUG', `ane ${s.aneW.toFixed(1)}W`, { host },
      { name: 'power.ane_w', value: Number(s.aneW.toFixed(2)) });
  if (s.dieC !== undefined)
    publish('DEBUG', `cpu die ${s.dieC.toFixed(0)}C`, { host },
      { name: 'power.cpu_die_c', value: Number(s.dieC.toFixed(1)) });
  if (s.gpuDieC !== undefined)
    publish('DEBUG', `gpu die ${s.gpuDieC.toFixed(0)}C`, { host },
      { name: 'power.gpu_die_c', value: Number(s.gpuDieC.toFixed(1)) });
  if (s.fans?.length)
    publish('DEBUG', `fan ${Math.round(Math.max(...s.fans))} rpm`,
      { host, fans: s.fans.map((f) => Math.round(f)).join(',') },
      { name: 'power.fan_rpm', value: Math.round(Math.max(...s.fans)) });
  if (therm.CPU_Speed_Limit !== undefined)
    publish('DEBUG', `cpu speed limit ${therm.CPU_Speed_Limit}%`,
      { host, ...(s.pressure ? { pressure: s.pressure } : {}) },
      { name: 'power.speed_limit_pct', value: therm.CPU_Speed_Limit });

  // The culprits, attached to every sample: a chart says when, this says
  // who. Energy impact when powermetrics is on (what Activity Monitor's
  // Energy tab ranks by); plain %cpu when degraded.
  const top = s.top?.length ? s.top : ps.top;
  const by = s.top?.length ? 'energy' : 'cpu';
  if (top.length) {
    const f = { by };
    top.forEach((t, i) => {
      f[`p${i + 1}_pid`] = t.pid;
      f[`p${i + 1}_cmd`] = t.name;
      if (t.cpuPct !== undefined) f[`p${i + 1}_cpu_pct`] = t.cpuPct.toFixed(1);
      if (t.energy !== undefined) f[`p${i + 1}_energy`] = t.energy.toFixed(1);
    });
    publish('DEBUG',
      `top by ${by}: ${top.map((t) => `${t.name} ${(t.energy ?? t.cpuPct ?? 0).toFixed(0)}`).join(', ')}`,
      f);
  }

  // ------------------------------------------------------------ verdicts

  threshold('cpu', capPct >= cpuCrit ? 'crit' : capPct >= cpuWarn ? 'warn' : 'ok',
    `cpu ${ps.total.toFixed(0)}% aggregate on ${ncpu} cores (${capPct}% of capacity)`,
    { cores: ncpu, capacity_pct: capPct },
    { name: 'power.cpu_pct', value: Math.round(ps.total) });

  // One process eating several cores is the incident this tool was written
  // after: 1258% aggregate was 39% of this machine's capacity and looked
  // fine, but eleven of those cores belonged to a single extension host.
  const hog = ps.top[0];
  if (procWarn > 0 && hog)
    threshold('proc', hog.cpuPct >= procWarn ? 'warn' : 'ok',
      `${hog.name} (pid ${hog.pid}) at ${hog.cpuPct.toFixed(0)}% cpu - ` +
      `${(hog.cpuPct / 100).toFixed(1)} cores in one process`,
      { pid: hog.pid, command: hog.name, cpu_pct: hog.cpuPct.toFixed(0) });

  // The machine's own verdict is the one detector that needs no tuning:
  // a CPU speed limit under 100 is macOS throttling because the draw or
  // the heat is already too much.
  const speed = therm.CPU_Speed_Limit;
  let tState = 'ok';
  if (speed !== undefined && speed < 100) tState = speed < 60 ? 'crit' : 'warn';
  if (s.pressure && s.pressure !== 'Nominal')
    tState = /heavy|trapping|critical|sleeping/i.test(s.pressure) ? 'crit'
           : tState === 'crit' ? 'crit' : 'warn';
  threshold('thermal', tState,
    `thermal throttling: cpu speed limited to ${speed ?? '?'}%` +
    `${s.pressure ? `, pressure ${s.pressure}` : ''} - the machine itself says the draw is too much`,
    { speed_limit: speed, pressure: s.pressure },
    speed !== undefined ? { name: 'power.speed_limit_pct', value: speed } : undefined);

  if (s.packageW !== undefined) {
    const learned = baseN >= 12;   // two minutes at the default interval
    let wState = 'ok';
    if (wattsCrit > 0 && s.packageW >= wattsCrit) wState = 'crit';
    else if (wattsWarn > 0 && s.packageW >= wattsWarn) wState = 'warn';
    else if (wattsFactor > 0 && learned &&
             s.packageW > baseW * wattsFactor && s.packageW > baseW + 5) wState = 'warn';
    threshold('watts', wState,
      `package ${s.packageW.toFixed(1)}W` +
      (learned && !(wattsWarn || wattsCrit)
        ? ` - ${(s.packageW / baseW).toFixed(1)}x this machine's ${baseW.toFixed(1)}W baseline`
        : ''),
      { package_w: s.packageW.toFixed(1),
        baseline_w: learned ? baseW.toFixed(1) : undefined },
      { name: 'power.package_w', value: Number(s.packageW.toFixed(2)) });
    baseW = baseN === 0 ? s.packageW : baseW + (s.packageW - baseW) * 0.05;
    baseN += 1;
  }

  // A powermetrics that was delivering and stopped is different from one
  // that never could: say so once, and say when it comes back.
  if (!unavailable && latest)
    threshold('pm', fresh ? 'ok' : 'warn',
      `powermetrics has gone quiet - no sample in ${Math.round((Date.now() - latest.at) / 1000)}s`,
      { host });

  if (first)
    publish('INFO',
      `watching power on ${host}: ${arch}, ${ncpu} cores, powermetrics ` +
      `${unavailable ? `unavailable (${unavailable})` : fresh ? 'sampling' : 'starting'}` +
      `${outDir ? `, sidecar in ${outDir}` : ''}`,
      { host, arch, cores: ncpu,
        power: unavailable ? 'unavailable' : 'on',
        ...(unavailable ? { power_unavailable: unavailable } : {}) });
}

// ------------------------------------------------------------------- loop

console.error(`superlog-power: ${host} (${arch}) -> ${topic}` +
              (once ? ' (once)' : ` every ${intervalMs / 1000}s`));

startPowermetrics();

// Give the child a moment to either produce a document or reveal that it
// never will; --once waits long enough for a real 1s sample window.
{
  const deadline = Date.now() + (once ? 15000 : 3000);
  while (Date.now() < deadline && !latest && !unavailable)
    await new Promise((r) => setTimeout(r, 50));
}

async function shutdown(code) {
  stopping = true;
  try {
    pm?.kill('SIGTERM');   // sudo relays it; a leaked powermetrics burns watts
  } catch {
    /* already gone */
  }
  await flush();
  if (sidecar) {
    sidecar.end(() => process.exit(code));
    return;
  }
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));
process.on('exit', () => {
  try {
    pm?.kill('SIGTERM');
  } catch {
    /* already gone */
  }
});

let first = true;
for (;;) {
  await tick(first);
  await flush();
  if (once) break;
  first = false;
  await new Promise((r) => setTimeout(r, intervalMs));
}
await shutdown(0);
