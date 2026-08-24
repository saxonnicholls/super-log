#!/usr/bin/env node
//
//  superlog-vitals - disk, memory, CPU and load, per host.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A full disk is the classic outage: everything works until nothing does,
//  and the log that would have told you stopped being writable at exactly
//  the moment it mattered. Memory pressure and load are the same story
//  told slower. This samples them on an interval and puts them on the
//  bench beside the logs from the same machine.
//
//    superlog-vitals                      # this machine
//    superlog-vitals --ssh web1           # a server, nothing installed there
//    superlog-vitals --once               # one reading, then exit
//
//  Publishes to host.<name>.vitals. Readings ride as `metric` events at
//  DEBUG - they are continuous measures, so they are always there for a
//  chart but filtered out of a default INFO view. Threshold crossings are
//  WARN and ERROR, and they are EDGE-triggered: crossing 85% says so once,
//  not every thirty seconds until someone fixes it. Recovery says so too,
//  because "it cleared" is as worth knowing as "it broke".
//
//  macOS, Linux and Windows. The Windows path is written but NOT verified -
//  there is no Windows machine on this bench.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-vitals - disk, memory, CPU and load

  superlog-vitals [--once] [--ssh DEST] [--interval SECONDS] [--url HUB]
                  [--disk-warn 85] [--disk-crit 95] [--mem-warn 90]

Publishes to host.<name>.vitals. Readings are DEBUG metric events;
threshold crossings are WARN/ERROR and fire once per crossing, not per poll.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const intervalMs = Number(opt('interval', env.SUPER_LOG_VITALS_INTERVAL ?? '60')) * 1000;
const once = args.includes('--once');
const dest = opt('ssh');
const diskWarn = Number(opt('disk-warn', '85'));
const diskCrit = Number(opt('disk-crit', '95'));
const memWarn = Number(opt('mem-warn', '90'));

const sanitize = (s) => s.split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const host = dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest) : sanitize(hostname());
const topic = opt('topic', `host.${host}.vitals`);

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
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

// ---------------------------------------------------------------- reading
//
// One shell round trip per host per tick, not one per metric: over ssh each
// extra command is another connection's worth of latency, and these numbers
// are only meaningful together anyway.
//
// df -Pk everywhere: POSIX output is one line per filesystem with 1K blocks,
// which parses the same on macOS and Linux. -h would be friendlier to read
// and much worse to parse ("1.8Ti").

const UNIX_PROBE = `
uname -s
echo '---DF---'
df -Pk 2>/dev/null | tail -n +2
echo '---MOUNT---'
mount 2>/dev/null
echo '---MEM---'
if [ -r /proc/meminfo ]; then head -5 /proc/meminfo; else vm_stat; sysctl -n hw.memsize; fi
echo '---CPU---'
if [ -r /proc/loadavg ]; then cat /proc/loadavg; nproc; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2;
else sysctl -n vm.loadavg hw.ncpu machdep.cpu.brand_string; fi
`;

function section(text, name) {
  const m = new RegExp(`---${name}---\\n([\\s\\S]*?)(?=\\n---|$)`).exec(text);
  return m ? m[1].trim() : '';
}

/** Mount points that are read-only, from `mount` output on either OS.
 *  A read-only filesystem cannot be freed, so its fullness is never
 *  actionable - and macOS is full of them: every CoreSimulator runtime and
 *  every mounted DMG sits at ~98% by design. Alerting on those produced 25
 *  ERRORs on the first run of this tool, which is how a monitor teaches
 *  you to ignore it on day one. */
function readOnlyMounts(text) {
  const ro = new Set();
  for (const line of text.split('\n')) {
    // macOS: /dev/disk3s5 on / (apfs, sealed, read-only, journaled)
    // Linux: /dev/sda1 on /boot type ext4 (ro,relatime)
    const m = /^\S+ on (.+?) (?:type \S+ )?\(([^)]*)\)/.exec(line.trim());
    if (!m) continue;
    const opts = m[2].split(',').map((s) => s.trim());
    if (opts.includes('read-only') || opts.includes('ro')) ro.add(m[1]);
  }
  return ro;
}

function parseDf(text, readOnly = new Set()) {
  const out = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [fs, blocks, used, avail, pct] = f;
    const mount = f.slice(5).join(' ');
    // Pseudo-filesystems are noise: they are always 100% full and nothing
    // is wrong with that.
    if (/^(devfs|map |tmpfs|overlay|udev|none)$/.test(fs) || /^\/(dev|proc|sys)/.test(mount)) continue;
    // Read-only, and the places macOS keeps immutable images. /System/Volumes/Data
    // is deliberately NOT excluded: it is where a Mac's user data actually
    // lives, so it is the one that matters.
    if (readOnly.has(mount)) continue;
    if (/^\/Library\/Developer\/CoreSimulator\//.test(mount)) continue;
    if (/^\/System\/Volumes\/(Preboot|VM|Update|xarts|iSCPreboot|Hardware)/.test(mount)) continue;
    if (/^\/(snap|var\/lib\/snapd)\//.test(mount) || /^\/dev\/loop/.test(fs)) continue;
    if (!/^\d+$/.test(blocks) || Number(blocks) === 0) continue;
    out.push({
      fs, mount,
      totalKb: Number(blocks), usedKb: Number(used), availKb: Number(avail),
      pct: Number(String(pct).replace('%', '')),
    });
  }
  return out;
}

function parseMem(text, isLinux) {
  if (isLinux) {
    const g = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
    const total = g('MemTotal');
    // MemAvailable is the honest number: MemFree ignores reclaimable cache
    // and makes a healthy machine look like it is out of memory.
    const avail = g('MemAvailable') || g('MemFree');
    return total ? { totalKb: total, availKb: avail, usedPct: Math.round(((total - avail) / total) * 100) } : null;
  }
  // macOS: vm_stat pages + hw.memsize bytes
  const pageSize = Number(/page size of (\d+)/.exec(text)?.[1] ?? 4096);
  const pages = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  const totalBytes = Number(text.trim().split('\n').pop());
  if (!totalBytes) return null;
  // Free plus what the OS can take back without anyone noticing.
  const availKb = ((pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable')) * pageSize) / 1024;
  const totalKb = totalBytes / 1024;
  return { totalKb, availKb, usedPct: Math.round(((totalKb - availKb) / totalKb) * 100) };
}

function parseCpu(text, isLinux) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  if (isLinux) {
    const load = (lines[0] ?? '').split(/\s+/).slice(0, 3).map(Number);
    return { load1: load[0] ?? 0, load5: load[1] ?? 0, cores: Number(lines[1] ?? 0), model: lines[2] ?? '' };
  }
  // sysctl vm.loadavg prints "{ 1.72 1.85 1.90 }"
  const nums = (lines[0] ?? '').replace(/[{}]/g, '').trim().split(/\s+/).map(Number);
  return { load1: nums[0] ?? 0, load5: nums[1] ?? 0, cores: Number(lines[1] ?? 0), model: lines.slice(2).join(' ') };
}

// Windows: one PowerShell round trip, shipped base64 so quoting survives
// every shell between here and there. WRITTEN, NOT VERIFIED.
const WIN_PROBE = `
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  @{ mount = $_.DeviceID; totalKb = [math]::Round($_.Size/1KB); availKb = [math]::Round($_.FreeSpace/1KB) } }
ConvertTo-Json -Compress -Depth 4 -InputObject @{
  disks = @($disks)
  memTotalKb = $os.TotalVisibleMemorySize
  memAvailKb = $os.FreePhysicalMemory
  cores = $cpu.NumberOfLogicalProcessors
  model = $cpu.Name
  load = $cpu.LoadPercentage }`;

async function readVitals() {
  if (dest) {
    const uname = (await run('uname -s')).trim();
    if (!uname) {
      const enc = Buffer.from(WIN_PROBE, 'utf16le').toString('base64');
      const out = await run(`powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`);
      try {
        const j = JSON.parse(out);
        return {
          os: 'windows',
          disks: (j.disks ?? []).map((d) => ({
            fs: d.mount, mount: d.mount, totalKb: d.totalKb, availKb: d.availKb,
            usedKb: d.totalKb - d.availKb,
            pct: d.totalKb ? Math.round(((d.totalKb - d.availKb) / d.totalKb) * 100) : 0,
          })),
          mem: j.memTotalKb ? { totalKb: j.memTotalKb, availKb: j.memAvailKb,
            usedPct: Math.round(((j.memTotalKb - j.memAvailKb) / j.memTotalKb) * 100) } : null,
          cpu: { load1: (j.load ?? 0) / 100 * (j.cores || 1), load5: 0, cores: j.cores ?? 0, model: j.model ?? '' },
        };
      } catch {
        return null;
      }
    }
  }
  const text = await run(UNIX_PROBE);
  if (!text.trim()) return null;
  const os = text.split('\n')[0].trim().toLowerCase();
  const isLinux = os === 'linux';
  return {
    os,
    disks: parseDf(section(text, 'DF'), readOnlyMounts(section(text, 'MOUNT'))),
    mem: parseMem(section(text, 'MEM'), isLinux),
    cpu: parseCpu(section(text, 'CPU'), isLinux),
  };
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;

function publish(level, msg, fields, metric) {
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'vitals', platform: 'host', device: host },
    tag: 'vitals', msg, ...(metric ? { metric } : {}), fields,
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
    /* the next batch counts again */
  }
}

const gb = (kb) => (kb / 1048576).toFixed(1);

// Edge-triggered: a threshold crossing is news, and the same threshold
// still being crossed thirty seconds later is not. Recovery is news too.
const state = new Map();
function threshold(key, level, msg, fields, metric) {
  const before = state.get(key) ?? 'ok';
  const now = level;
  if (before === now) return;
  state.set(key, now);
  if (now === 'ok') {
    publish('INFO', `recovered: ${msg}`, { ...fields, change: 'recovered' }, metric);
  } else {
    publish(now === 'crit' ? 'ERROR' : 'WARN', msg, { ...fields, change: 'threshold' }, metric);
  }
}

async function tick(first) {
  const v = await readVitals();
  if (!v) {
    publish('ERROR', `cannot read vitals${dest ? ` from ${dest}` : ''}`, { host });
    return;
  }

  for (const d of v.disks) {
    const f = { host, mount: d.mount, filesystem: d.fs,
                total_gb: gb(d.totalKb), avail_gb: gb(d.availKb), used_pct: String(d.pct) };
    publish('DEBUG', `disk ${d.mount} ${d.pct}% used, ${gb(d.availKb)}G free`, f,
            { name: `disk.used_pct${d.mount === '/' ? '' : d.mount.replace(/\W+/g, '_')}`, value: d.pct });
    threshold(`disk:${d.mount}`,
              d.pct >= diskCrit ? 'crit' : d.pct >= diskWarn ? 'warn' : 'ok',
              `disk ${d.mount} is ${d.pct}% full - ${gb(d.availKb)}G left of ${gb(d.totalKb)}G`, f,
              { name: 'disk.used_pct', value: d.pct });
  }

  if (v.mem) {
    const f = { host, total_gb: gb(v.mem.totalKb), avail_gb: gb(v.mem.availKb),
                used_pct: String(v.mem.usedPct) };
    publish('DEBUG', `memory ${v.mem.usedPct}% used, ${gb(v.mem.availKb)}G available`, f,
            { name: 'mem.used_pct', value: v.mem.usedPct });
    threshold('mem', v.mem.usedPct >= memWarn ? 'warn' : 'ok',
              `memory ${v.mem.usedPct}% used - only ${gb(v.mem.availKb)}G available`, f,
              { name: 'mem.used_pct', value: v.mem.usedPct });
  }

  if (v.cpu?.cores) {
    const per = v.cpu.load1 / v.cpu.cores;
    const f = { host, load1: v.cpu.load1.toFixed(2), load5: v.cpu.load5.toFixed(2),
                cores: String(v.cpu.cores), per_core: per.toFixed(2), model: v.cpu.model.trim() };
    publish('DEBUG', `load ${v.cpu.load1.toFixed(2)} across ${v.cpu.cores} cores`, f,
            { name: 'load.per_core', value: Number(per.toFixed(2)) });
    // Load is per-core to mean anything: 8 on an 8-core box is busy, on a
    // 2-core box it is drowning.
    threshold('load', per >= 2 ? 'crit' : per >= 1 ? 'warn' : 'ok',
              `load ${v.cpu.load1.toFixed(2)} on ${v.cpu.cores} cores (${per.toFixed(2)} per core)`, f,
              { name: 'load.per_core', value: Number(per.toFixed(2)) });
  }

  if (first) {
    const root = v.disks.find((d) => d.mount === '/') ?? v.disks[0];
    publish('INFO',
            `watching ${host}: ${v.os}, ${v.cpu?.cores ?? '?'} cores` +
            `${v.mem ? `, ${gb(v.mem.totalKb)}G RAM` : ''}` +
            `${root ? `, ${gb(root.availKb)}G free on ${root.mount}` : ''}`,
            { host, os: v.os, cores: String(v.cpu?.cores ?? ''), model: (v.cpu?.model ?? '').trim(),
              mem_total_gb: v.mem ? gb(v.mem.totalKb) : '', disks: String(v.disks.length) });
  }
}

console.error(`superlog-vitals: ${dest ?? 'this machine'} -> ${topic}` +
              (once ? ' (once)' : ` every ${intervalMs / 1000}s`));

let first = true;
for (;;) {
  await tick(first);
  await flush();
  if (once) break;
  first = false;
  await new Promise((r) => setTimeout(r, intervalMs));
}
