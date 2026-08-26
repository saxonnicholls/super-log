#!/usr/bin/env node
//
//  superlog-gpu - what the GPU is doing, here or on another machine.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A GPU is the one part of a box with no log. It is either idle or it is
//  the reason everything else is waiting, and the difference is invisible
//  until something times out. Worse, the interesting failures are slow:
//  memory creeping up over an hour, a card thermally throttling under
//  sustained load, a Pi browning out under a bad power supply. None of those
//  announce themselves - they just make everything gradually worse.
//
//    superlog-gpu                      # this machine, watched
//    superlog-gpu --once               # what is here now, then exit
//    superlog-gpu --ssh trainer1       # a box with the card in it
//    superlog-gpu --ssh pi4 --interval 30
//
//  Publishes to gpu.<host>.<index>. Readings are DEBUG `metric` events, so
//  they are always there for a chart but out of a default INFO view; a
//  threshold crossing is an edge-triggered WARN or ERROR, so 85C says so
//  once rather than every poll, and recovery says so too.
//
//  Zero dependency, and nothing is installed on the remote: it drives
//  whichever vendor tool is already there - nvidia-smi, rocm-smi,
//  intel_gpu_top, vcgencmd on a Pi, ioreg on macOS - and says which one it
//  found. A machine with no GPU tooling is reported once, not every poll.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-gpu - GPU utilisation, memory, temperature and power

  superlog-gpu [--once] [--ssh DEST] [--interval SECONDS] [--url HUB]
               [--temp-warn C] [--temp-err C] [--mem-warn PCT]
               [--identity KEY] [--ssh-port N]

Publishes to gpu.<host>.<index>. Readings are DEBUG metric events; threshold
crossings are edge-triggered WARN/ERROR. Uses whichever of nvidia-smi,
rocm-smi, intel_gpu_top, vcgencmd or ioreg is already on the machine.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const dest = opt('ssh');
const once = args.includes('--once');
const intervalMs = Number(opt('interval', env.SUPER_LOG_GPU_INTERVAL ?? '20')) * 1000;
// A GPU runs hot by design, so these are deliberately high: 80C is a card
// working, not a card in trouble.
const tempWarn = Number(opt('temp-warn', '85'));
const tempErr = Number(opt('temp-err', '95'));
const memWarn = Number(opt('mem-warn', '90'));

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'gpu';
const host = dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest)
                  : sanitize(hostname().split('.')[0]);

// ---------------------------------------------------------------- running

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];

function run(cmd) {
  return new Promise((resolve) => {
    const child = dest
      ? spawn('ssh', [...SSH_BASE, dest, cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ ok: false, out: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

// ---------------------------------------------------------------- parsing
//
// One shape out of five very different tools: { index, name, util, memUsed,
// memTotal, temp, power, extra }. Anything a vendor does not report is left
// undefined rather than zero - a missing reading and a reading of zero are
// different facts, and charting the second as the first is a lie.

const num = (v) => {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
};

/** nvidia-smi, the one with everything. CSV so there is nothing to parse. */
function parseNvidia(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 7) continue;
    out.push({ index: f[0], name: f[1], util: num(f[2]), memUsed: num(f[3]),
               memTotal: num(f[4]), temp: num(f[5]), power: num(f[6]), vendor: 'nvidia' });
  }
  return out;
}

/** rocm-smi --csv. Column names move between releases, so they are matched
 *  by heading rather than by position. */
function parseRocm(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = head.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iUtil = col('gpu use', 'gpu_use', 'utilization');
  const iTemp = col('temperature (sensor edge)', 'temp');
  const iPow = col('average graphics package power', 'power');
  const iUsed = col('vram total used memory', 'used memory');
  const iTot = col('vram total memory', 'total memory');
  const out = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',').map((s) => s.trim());
    if (!f[0] || /^card$/i.test(f[0])) continue;
    const mib = (i) => (i >= 0 && num(f[i]) !== undefined ? num(f[i]) / 1048576 : undefined);
    out.push({ index: f[0].replace(/^card/i, ''), name: 'AMD GPU', vendor: 'rocm',
               util: iUtil >= 0 ? num(f[iUtil]) : undefined,
               temp: iTemp >= 0 ? num(f[iTemp]) : undefined,
               power: iPow >= 0 ? num(f[iPow]) : undefined,
               memUsed: mib(iUsed), memTotal: mib(iTot) });
  }
  return out;
}

/** macOS: IOAccelerator's PerformanceStatistics. No sudo, every Mac. */
function parseIoreg(text) {
  const m = /"PerformanceStatistics"\s*=\s*\{(.*?)\}/s.exec(text);
  if (!m) return [];
  const d = Object.fromEntries([...m[1].matchAll(/"([^"]+)"=(\d+)/g)].map((x) => [x[1], Number(x[2])]));
  // IOGLBundleName is the driver bundle ("AMDRadeonX5000GLDriver"), not the
  // card. The model lives in system_profiler, which the probe asks for
  // separately - fall back to the bundle only when that is unavailable.
  const name = /@@model:(.+)/.exec(text)?.[1]?.trim()
            || /"model"\s*=\s*<"([^"]+)"/.exec(text)?.[1]
            || /"IOGLBundleName"\s*=\s*"([^"]+)"/.exec(text)?.[1] || 'GPU';
  const used = d.inUseVidMemoryBytes ?? d.allocatedVidMemoryBytes;
  // A running GPU is never at 0C. macOS reports 0 for cards that do not
  // expose a sensor, and charting that as a real reading is the lie this
  // file warns about two functions up - so absent it is.
  const temp = d['Temperature(C)'] > 0 ? d['Temperature(C)'] : undefined;
  return [{
    index: '0', name, vendor: 'macos',
    util: d['Device Utilization %'],
    memUsed: used !== undefined ? used / 1048576 : undefined,
    temp,
    extra: { alloc_mb: d.allocatedVidMemoryBytes !== undefined
      ? String(Math.round(d.allocatedVidMemoryBytes / 1048576)) : undefined },
  }];
}

/** A Raspberry Pi: no utilisation counter worth having, but the two things
 *  that actually go wrong on a Pi are temperature and power, and
 *  get_throttled reports both - including undervoltage, which is the single
 *  most common cause of a Pi behaving strangely. */
function parsePi(text) {
  const temp = num(/temp=([\d.]+)/.exec(text)?.[1]);
  const clock = num(/frequency\(\d+\)=(\d+)/.exec(text)?.[1]);
  const thr = /throttled=0x([0-9a-fA-F]+)/.exec(text)?.[1];
  const bits = thr ? parseInt(thr, 16) : 0;
  const flags = [];
  if (bits & 0x1) flags.push('under-voltage now');
  if (bits & 0x2) flags.push('arm frequency capped now');
  if (bits & 0x4) flags.push('currently throttled');
  if (bits & 0x8) flags.push('soft temperature limit');
  if (bits & 0x10000) flags.push('under-voltage has occurred');
  if (bits & 0x40000) flags.push('throttling has occurred');
  return [{ index: '0', name: 'Broadcom VideoCore', vendor: 'pi', temp,
            extra: { v3d_mhz: clock !== undefined ? String(Math.round(clock / 1e6)) : undefined },
            flags }];
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();
let seq = 0;

function publish(topic, level, msg, fields, metric) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'gpu-watcher', platform: 'gpu', device: host },
    tag: 'gpu', msg,
    ...(fields ? { fields: Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')) } : {}),
    ...(metric ? { metric } : {}),
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
    } catch {
      /* hub down; the next batch counts again */
    }
  }
}

// ------------------------------------------------------------------ probe
//
// One round trip per poll, whichever tool exists. Ordered by how much each
// one tells you, not alphabetically.

const PROBE =
  'if command -v nvidia-smi >/dev/null 2>&1; then echo "@@nvidia"; ' +
  'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw ' +
  '--format=csv,noheader,nounits 2>/dev/null; ' +
  'elif command -v rocm-smi >/dev/null 2>&1; then echo "@@rocm"; ' +
  'rocm-smi --showuse --showmemuse --showtemp --showpower --csv 2>/dev/null; ' +
  'elif command -v vcgencmd >/dev/null 2>&1; then echo "@@pi"; ' +
  'vcgencmd measure_temp; vcgencmd measure_clock v3d; vcgencmd get_throttled; ' +
  'elif command -v ioreg >/dev/null 2>&1; then echo "@@ioreg"; ' +
  'system_profiler SPDisplaysDataType 2>/dev/null | ' +
  "sed -n 's/.*Chipset Model: */@@model:/p' | head -1; " +
  'ioreg -r -d 1 -w 0 -c IOAccelerator 2>/dev/null; ' +
  'else echo "@@none"; fi';

async function probe() {
  const { out } = await run(PROBE);
  const kind = /@@(\w+)/.exec(out)?.[1] ?? 'none';
  // Non-greedy: the ioreg branch emits a second @@model: marker, and a
  // greedy strip would swallow it along with the kind line.
  const body = out.replace(/^.*?@@\w+\n?/s, '');
  switch (kind) {
    case 'nvidia': return { kind, cards: parseNvidia(body) };
    case 'rocm': return { kind, cards: parseRocm(body) };
    case 'pi': return { kind, cards: parsePi(body) };
    case 'ioreg': return { kind, cards: parseIoreg(body) };
    default: return { kind: 'none', cards: [] };
  }
}

// ------------------------------------------------------------------- loop

// Name the binary, not the vendor: "nvidia-smi is installed but reported no
// GPUs" tells you what to go and run yourself; "nvidia is installed" does not.
const TOOL_BINARY = { nvidia: 'nvidia-smi', rocm: 'rocm-smi', pi: 'vcgencmd', ioreg: 'ioreg' };

const state = new Map();   // index -> { temp: 'ok'|'warn'|'err', mem: bool, flags: string }
let toolReported = false;
let noneReported = false;
let emptyReported = false;

// Edge-triggered: say it when it crosses, say it when it recovers, and stay
// quiet in between. A watcher that repeats itself every poll is a watcher
// people mute.
function crossing(key, now, prev, topic, msgs) {
  if (now === prev) return;
  const [level, msg] = msgs[now];
  publish(topic, level, msg, { change: key, from: prev, to: now });
}

async function tick() {
  const { kind, cards } = await probe();

  if (kind === 'none') {
    if (!noneReported) {
      publish(opt('topic', `gpu.${host}.none`), 'WARN',
              `no GPU tooling found${dest ? ` on ${dest}` : ''} - looked for nvidia-smi, rocm-smi, vcgencmd and ioreg`,
              { change: 'no-tooling', host });
      noneReported = true;
    }
    return;
  }
  noneReported = false;

  // The tool is installed but told us about no cards at all. That is not the
  // same as having no tooling, and it is the more confusing case: the driver
  // is not loaded, the card fell off the bus, or the user cannot read it.
  // Reported once - silently publishing nothing would leave someone staring
  // at an empty stream wondering whether the GPU is idle or the watcher is.
  if (!cards.length) {
    if (!emptyReported) {
      publish(opt('topic', `gpu.${host}.none`), 'WARN',
              `${TOOL_BINARY[kind] ?? kind} is installed${dest ? ` on ${dest}` : ''} but reported no GPUs - ` +
              'driver not loaded, card not present, or not readable by this user',
              { change: 'no-cards', tool: kind, host });
      emptyReported = true;
    }
    return;
  }
  emptyReported = false;

  if (!toolReported) {
    publish(opt('topic', `gpu.${host}.${sanitize(cards[0]?.index ?? '0')}`), 'INFO',
            `${cards.length} GPU(s) via ${kind}${dest ? ` on ${dest}` : ''}` +
            `${cards[0]?.name ? `: ${cards[0].name}` : ''}`,
            { change: 'found', tool: kind, count: String(cards.length), host });
    toolReported = true;
  }

  for (const c of cards) {
    const topic = opt('topic', `gpu.${host}.${sanitize(c.index)}`);
    const st = state.get(c.index) ?? { temp: 'ok', mem: false, flags: '' };

    if (once) {
      const bits = [c.name];
      if (c.util !== undefined) bits.push(`${c.util}% used`);
      if (c.memUsed !== undefined)
        bits.push(`${Math.round(c.memUsed)}${c.memTotal ? `/${Math.round(c.memTotal)}` : ''} MiB`);
      if (c.temp !== undefined) bits.push(`${c.temp}C`);
      if (c.power !== undefined) bits.push(`${c.power}W`);
      if (c.flags?.length) bits.push(c.flags.join(', '));
      publish(topic, c.flags?.length ? 'WARN' : 'INFO', `gpu ${c.index}: ${bits.join(', ')}`,
              { host, tool: c.vendor, index: c.index, name: c.name,
                util: c.util !== undefined ? String(c.util) : undefined,
                temp: c.temp !== undefined ? String(c.temp) : undefined,
                ...(c.extra ?? {}) });
      continue;
    }

    // Readings first, always, so a chart has a point even when nothing is
    // wrong. DEBUG keeps them out of a default INFO view.
    const m = (name, value) => value !== undefined &&
      publish(topic, 'DEBUG', `${name} ${value}`, { host, index: c.index },
              { name, value });
    m('gpu.utilization_pct', c.util);
    m('gpu.memory_used_mb', c.memUsed !== undefined ? Math.round(c.memUsed) : undefined);
    m('gpu.temperature_c', c.temp);
    m('gpu.power_w', c.power);

    if (c.temp !== undefined) {
      const now = c.temp >= tempErr ? 'err' : c.temp >= tempWarn ? 'warn' : 'ok';
      crossing('temperature', now, st.temp, topic, {
        err: ['ERROR', `gpu ${c.index} at ${c.temp}C (over ${tempErr}C)`],
        warn: ['WARN', `gpu ${c.index} at ${c.temp}C (over ${tempWarn}C)`],
        ok: ['INFO', `gpu ${c.index} back under ${tempWarn}C at ${c.temp}C`],
      });
      st.temp = now;
    }

    if (c.memUsed !== undefined && c.memTotal) {
      const pct = (c.memUsed / c.memTotal) * 100;
      const now = pct >= memWarn;
      if (now !== st.mem) {
        publish(topic, now ? 'WARN' : 'INFO',
                now ? `gpu ${c.index} memory at ${pct.toFixed(0)}% (${Math.round(c.memUsed)}/${Math.round(c.memTotal)} MiB)`
                    : `gpu ${c.index} memory back under ${memWarn}%`,
                { host, index: c.index, change: 'memory' });
        st.mem = now;
      }
    }

    // A Pi that is throttling or browning out is the most useful thing this
    // tool can tell you, and it is the one the Pi will not tell you itself.
    const flags = (c.flags ?? []).join(', ');
    if (flags !== st.flags) {
      if (flags)
        publish(topic, /under-voltage now|currently throttled/.test(flags) ? 'ERROR' : 'WARN',
                `gpu ${c.index}: ${flags}`, { host, index: c.index, change: 'throttle' });
      else
        publish(topic, 'INFO', `gpu ${c.index}: throttling cleared`,
                { host, index: c.index, change: 'throttle' });
      st.flags = flags;
    }

    state.set(c.index, st);
  }
}

async function loop() {
  await tick();
  await flush();
  if (once) return;
  setTimeout(loop, intervalMs);
}

process.on('SIGINT', async () => { await flush(); process.exit(130); });
process.on('SIGTERM', async () => { await flush(); process.exit(143); });

console.error(`superlog-gpu: ${dest ? `${dest} ` : ''}${once ? 'once' : `every ${intervalMs / 1000}s`}` +
              ` -> gpu.${host}.<index>`);
await loop();
