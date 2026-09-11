#!/usr/bin/env node
//
//  superlog-firmware - the versions on the hardware, logged, and their changes.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  superlog-versions watches the versions you INSTALLED - the toolchains, the
//  OS, the databases. This watches the versions that RUN ON THE METAL, which
//  are the ones that hide best: a CPU's microcode, a USB device's firmware
//  revision, a flight controller's flashed firmware, and the bitstream an FPGA
//  actually booted - none of which any package manager knows about. A team
//  once lost three days to a board running a bitstream its current toolchain no
//  longer produced; the installed version and the deployed version had drifted
//  apart and nothing on the bench said so. This is the tailer that says so.
//
//  Same shape as superlog-versions: a silent baseline, then a version CHANGE is
//  the event, carried with before+after so an incident correlates against the
//  transition rather than reconstructing it from two snapshots.
//
//    superlog-firmware                        # this machine's hardware, watched
//    superlog-firmware --once                 # the inventory now, then exit
//    superlog-firmware --ssh trainer1         # a remote box's hardware
//    superlog-firmware --firmware             # + opt-in BIOS/UEFI/microcode
//    superlog-firmware --probes fpga.json     # + deployed bitstream/version probes
//    superlog-firmware --udp 14550            # + a drone's flashed firmware (MAVLink)
//    superlog-firmware --frame av.bin --once  # decode one captured AUTOPILOT_VERSION
//
//  TWO topics, because a device is not the same thing as the host that probes
//  it. The host's own silicon (CPU, RAM, GPU + driver, disk, and with
//  --firmware the BIOS/microcode) rides host.<name>.versions, exactly beside
//  superlog-versions' inventory - the host IS that device. But a USB gadget, a
//  flight controller or an FPGA is a device in its own right: one host may
//  probe three boards and the same board may be probed from two laptops, so a
//  board's firmware timeline must live in ONE place regardless of who read it.
//  Those go to firmware.<device>, keyed by the board/target/serial, the same
//  reasoning the proposal gives deps.<repo> (keyed by repo, not host). Every
//  firmware/deployed fact carries a `device` field either way, so a consumer
//  never has to parse the topic to tell the board from the prober.
//
//  Unprivileged by default and never gated on root: --firmware ADDS the
//  privileged probes (dmidecode, the boot ROM) and degrades in one honest line
//  when they need a password we will not ask for - the superlog-power model.
//
//  Zero dependency: it shells out to whichever tool is already there and says
//  which one answered. Node >= 18.
//

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import { hostname, platform, totalmem } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-firmware - hardware and firmware versions, and their changes

  superlog-firmware [--once] [--interval 300] [--name LABEL] [--url HUB]
                    [--ssh DEST] [--identity KEY] [--ssh-port N]
                    [--firmware] [--probes FILE]
                    [--udp PORT] [--frame FILE] [--device NAME]

The host's own silicon rides host.<name>.versions (category hardware, and with
--firmware also firmware). USB gadgets, drones and FPGA/deployed probes ride
firmware.<device>, keyed by the board so its timeline survives being probed
from a different host - each such fact carries a device field naming the board
and a host field naming the prober. Silent baseline; a version CHANGE is the
event, with before+after. --firmware adds BIOS/UEFI/microcode and never
prompts for a password. --probes runs your per-device version reads and diffs
them (the deployed-bitstream drift). --udp/--frame decode MAVLink
AUTOPILOT_VERSION - what firmware is actually flying.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const dest = opt('ssh');
const once = args.includes('--once');
const wantFirmware = args.includes('--firmware');
const intervalS = Number(opt('interval', 300)) || 300;   // versions change slowly
const probesFile = opt('probes');
const udpPort = opt('udp');
const frameFile = opt('frame');

const win = platform() === 'win32';
const mac = platform() === 'darwin';
const localPlatform = win ? 'windows' : mac ? 'macos' : 'linux';

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'host';
// The host label is the prober. --ssh makes the probed box the label so a
// remote inventory is filed under the box it describes, not the one running node.
const host = opt('name') ? sanitize(opt('name'))
  : dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest)
         : sanitize(hostname().split('.')[0]);
const hostTopic = `host.${host}.versions`;

// ------------------------------------------------------------- publishing

const session = randomBytes(4).toString('hex');
const buffers = new Map();      // topic -> lines
let seq = 0;

function publish(topic, level, msg, fields, metric) {
  if (!buffers.has(topic)) buffers.set(topic, []);
  buffers.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'firmware', platform: localPlatform, device: host },
    tag: 'firmware', msg,
    ...(fields && Object.keys(fields).length
      ? { fields: Object.fromEntries(Object.entries(fields)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, String(v).slice(0, 512)])) }
      : {}),
    ...(metric ? { metric } : {}),
  }));
}

async function flush() {
  for (const [topic, lines] of buffers) {
    if (!lines.length) continue;
    const body = lines.join('\n');
    buffers.set(topic, []);
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
      });
    } catch { /* hub down; the next batch counts again */ }
  }
}

// ---------------------------------------------------------------- running
//
// One round trip per probe, whichever tool exists - and it runs on a remote
// box over ssh when --ssh is given, nothing installed there, exactly the
// gpu/ports pattern. A probe that finds no tool prints @@none and is skipped,
// said once, never a crash.

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];

function run(cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = dest
      ? spawn('ssh', [...SSH_BASE, dest, cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// --------------------------------------------------------------- versions
//
// Version strings are gloriously inconsistent, so `raw` is kept verbatim and
// the first orderable token extracted - flagged unorderable rather than
// guessed when there is nothing to order (a version the advisor cannot compare
// is one it must refuse to judge, and it needs to be told). The advisor also
// needs to know WHICH comparator applies, so every version carries a scheme.

const parseVersion = (text) =>
  /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(text || '')?.[1] ?? '';

function classifyScheme(version) {
  if (!version) return 'opaque';
  const v = String(version);
  // A leading four-digit year is a calendar version - Vivado/Quartus name
  // releases this way (2023.2). It sorts like a number but the advisor dates
  // it rather than reading it as semver's major.minor, so say which it is.
  if (/^(19|20)\d{2}([._-]\d{1,2}){1,2}$/.test(v) || /^(19|20)\d{6}$/.test(v)) return 'calver';
  if (/^\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.]+)?$/.test(v)) return 'semver';
  return 'opaque';
}

// A host fact: the probing machine's own silicon. device == host, because for
// this tier the host is the device.
function hostFact({ category, tool, raw, version, provenance, purl, extra }) {
  const f = {
    category, tool, state: 'present', raw: String(raw ?? '').trim().slice(0, 400),
    provenance, scope: 'system', device: host, host,
  };
  if (version) { f.version = version; f.scheme = classifyScheme(version); }
  else { f.unorderable = true; f.scheme = 'opaque'; }
  if (purl) f.purl = purl;
  if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') f[k] = v;
  return f;
}

// A device fact: a board that is NOT the prober. It carries its own identity
// (device) AND the host that read it (host/probed_by), and rides its own topic.
function deviceFact({ category, tool, device, target, raw, version, scheme, provenance, purl, extra }) {
  const f = {
    category, tool, state: 'present', raw: String(raw ?? '').trim().slice(0, 400),
    provenance, scope: 'system', device, host, probed_by: host,
    topic: `firmware.${sanitize(device)}`,
  };
  if (target) f.target = target;
  if (version) { f.version = version; f.scheme = scheme || classifyScheme(version); }
  else { f.unorderable = true; f.scheme = scheme || 'opaque'; }
  if (purl) f.purl = purl;
  if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') f[k] = v;
  return f;
}

const shown = (f) => f.version ?? f.raw ?? '(unknown)';

// ------------------------------------------------------ host silicon probes
//
// Each area is one detection pipeline that tries the tools in order and prints
// a tagged marker, so the same tailer runs on macOS and Linux and a test can
// stand in for any tool on PATH. Anything not found leaves the fact absent
// rather than reporting a model or a driver of zero.

const CPU_PROBE =
  'if command -v sysctl >/dev/null 2>&1 && sysctl -n machdep.cpu.brand_string >/dev/null 2>&1; then ' +
  '  echo "@@sysctl"; sysctl -n machdep.cpu.brand_string; ' +
  '  sysctl -n machdep.cpu.microcode_version 2>/dev/null; ' +
  'elif command -v lscpu >/dev/null 2>&1; then echo "@@lscpu"; lscpu; ' +
  '  grep -m1 microcode /proc/cpuinfo 2>/dev/null; ' +
  'elif [ -r /proc/cpuinfo ]; then echo "@@cpuinfo"; cat /proc/cpuinfo; ' +
  'else echo "@@none"; fi';

// nvidia-smi is the one that also carries the DRIVER version, the half of the
// GPU story that actually changes and breaks CUDA. system_profiler/lspci give
// the model only, and are honest about having no driver version to report.
const GPU_PROBE =
  'if command -v nvidia-smi >/dev/null 2>&1; then echo "@@nvidia"; ' +
  '  nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null; ' +
  'elif command -v system_profiler >/dev/null 2>&1; then echo "@@sp"; ' +
  '  system_profiler SPDisplaysDataType 2>/dev/null; ' +
  'elif command -v lspci >/dev/null 2>&1; then echo "@@lspci"; ' +
  '  lspci 2>/dev/null | grep -iE "vga|3d controller|display"; ' +
  'else echo "@@none"; fi';

const DISK_PROBE =
  'if command -v lsblk >/dev/null 2>&1; then echo "@@lsblk"; ' +
  '  lsblk -dn -o NAME,MODEL,REV 2>/dev/null; ' +
  'elif command -v system_profiler >/dev/null 2>&1; then echo "@@sp"; ' +
  '  system_profiler SPNVMeDataType SPSerialATADataType 2>/dev/null; ' +
  'else echo "@@none"; fi';

const USB_PROBE =
  'if command -v lsusb >/dev/null 2>&1; then echo "@@lsusb"; ' +
  '  lsusb -v 2>/dev/null; ' +
  'elif command -v ioreg >/dev/null 2>&1; then echo "@@ioreg"; ' +
  '  ioreg -a -r -c IOUSBHostDevice -l 2>/dev/null; ' +
  'else echo "@@none"; fi';

// --firmware only. dmidecode needs root and may come back empty; the boot ROM
// on macOS does not. Never gated on root - if the privileged read is refused,
// one line says why and the rest of the inventory carries on.
const FW_PROBE =
  'if command -v dmidecode >/dev/null 2>&1; then echo "@@dmidecode"; ' +
  '  dmidecode -t bios 2>/dev/null; ' +
  'elif command -v system_profiler >/dev/null 2>&1; then echo "@@sp"; ' +
  '  system_profiler SPHardwareDataType 2>/dev/null; ' +
  'else echo "@@none"; fi';

const marker = (out) => /@@(\w+)/.exec(out)?.[1] ?? 'none';
const bodyOf = (out) => out.replace(/^[\s\S]*?@@\w+\n?/, '');
const firstLine = (t) => (t.split('\n').find((l) => l.trim()) ?? '').trim();

async function probeCpu(facts) {
  const out = await run(CPU_PROBE);
  const kind = marker(out);
  const body = bodyOf(out);
  if (kind === 'none') return;
  let model = '', micro = '';
  if (kind === 'sysctl') {
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    model = lines[0] ?? '';
    micro = lines[1] && /\d/.test(lines[1]) ? lines[1] : '';
  } else {
    model = /Model name:\s*(.+)/.exec(body)?.[1]?.trim()
      || /model name\s*:\s*(.+)/.exec(body)?.[1]?.trim() || '';
    micro = /microcode\s*:?\s*(\S+)/i.exec(body)?.[1]?.trim() || '';
  }
  if (model) facts.push(hostFact({
    category: 'hardware', tool: 'cpu', raw: model, provenance: kind === 'sysctl' ? 'sysctl' : 'lscpu',
  }));
  // Microcode where the OS hands it over for free (Intel sysctl, /proc/cpuinfo).
  // Its value is unorderable, but a microcode CHANGE is a real event and the
  // diff fires on raw regardless of order.
  if (micro) facts.push(hostFact({
    category: 'firmware', tool: 'cpu-microcode', raw: micro,
    provenance: kind === 'sysctl' ? 'sysctl' : 'cpuinfo',
  }));
}

async function probeGpu(facts) {
  const out = await run(GPU_PROBE);
  const kind = marker(out);
  const body = bodyOf(out);
  if (kind === 'none') return;
  if (kind === 'nvidia') {
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const [name, driver] = line.split(',').map((s) => s.trim());
      if (name) facts.push(hostFact({ category: 'hardware', tool: 'gpu', raw: name, provenance: 'nvidia-smi' }));
      if (driver) facts.push(hostFact({
        category: 'hardware', tool: 'gpu-driver', raw: driver, version: driver, provenance: 'nvidia-smi',
        purl: `pkg:generic/nvidia-driver@${driver}`, extra: { gpu: name },
      }));
    }
    return;
  }
  if (kind === 'sp') {
    const model = /Chipset Model:\s*(.+)/.exec(body)?.[1]?.trim();
    if (model) facts.push(hostFact({ category: 'hardware', tool: 'gpu', raw: model, provenance: 'system_profiler' }));
    return;
  }
  const model = firstLine(body).replace(/^\S+\s+/, '');
  if (model) facts.push(hostFact({ category: 'hardware', tool: 'gpu', raw: model, provenance: 'lspci' }));
}

async function probeDisk(facts) {
  const out = await run(DISK_PROBE);
  const kind = marker(out);
  const body = bodyOf(out);
  if (kind === 'none') return;
  if (kind === 'lsblk') {
    for (const line of body.split('\n')) {
      const t = line.trim().split(/\s+/);
      if (t.length < 2) continue;
      const name = t[0];
      const rev = t.length >= 3 ? t[t.length - 1] : '';
      const model = t.slice(1, rev ? t.length - 1 : t.length).join(' ');
      if (model) facts.push(hostFact({
        category: 'hardware', tool: `disk:${name}`, raw: model, provenance: 'lsblk',
        extra: rev ? { firmware_rev: rev } : undefined,
      }));
      // The drive's own firmware revision is a firmware fact: a silent SSD
      // firmware bump has changed a fleet's latency before now.
      if (rev) facts.push(hostFact({
        category: 'firmware', tool: `disk-fw:${name}`, raw: rev, version: parseVersion(rev) || undefined,
        provenance: 'lsblk',
      }));
    }
    return;
  }
  // macOS system_profiler storage: Model/Revision pairs, in order.
  const models = [...body.matchAll(/Model:\s*(.+)/g)].map((m) => m[1].trim());
  const revs = [...body.matchAll(/Revision:\s*(.+)/g)].map((m) => m[1].trim());
  models.forEach((model, i) => {
    facts.push(hostFact({
      category: 'hardware', tool: `disk:${sanitize(model)}`, raw: model, provenance: 'system_profiler',
      extra: revs[i] ? { firmware_rev: revs[i] } : undefined,
    }));
    if (revs[i]) facts.push(hostFact({
      category: 'firmware', tool: `disk-fw:${sanitize(model)}`, raw: revs[i],
      version: parseVersion(revs[i]) || undefined, provenance: 'system_profiler',
    }));
  });
}

async function probeFirmware(facts) {
  const out = await run(FW_PROBE);
  const kind = marker(out);
  const body = bodyOf(out);
  if (kind === 'none') {
    noteOnce('fw-none', () => publish(hostTopic, 'INFO',
      'no BIOS/boot-ROM reader found (dmidecode, system_profiler) - firmware tier skipped',
      { change: 'firmware-tooling', tier: 'firmware' }));
    return;
  }
  if (kind === 'dmidecode') {
    const ver = /Version:\s*(.+)/.exec(body)?.[1]?.trim();
    const vendor = /Vendor:\s*(.+)/.exec(body)?.[1]?.trim();
    if (ver) {
      facts.push(hostFact({
        category: 'firmware', tool: 'bios', raw: `${vendor ? `${vendor} ` : ''}${ver}`.trim(),
        version: parseVersion(ver) || undefined, provenance: 'dmidecode',
        extra: vendor ? { vendor } : undefined,
      }));
    } else {
      // dmidecode is present but told us nothing: almost always no root. Say
      // so once, the way superlog-power does, and never ask for a password.
      noteOnce('fw-priv', () => publish(hostTopic, 'WARN',
        'dmidecode returned no BIOS data - it needs root; run this tailer as root for the firmware tier',
        { change: 'firmware-unavailable', reason: 'not root' }));
    }
    return;
  }
  // macOS: the boot ROM and SMC are readable without root.
  const rom = /(?:System Firmware|Boot ROM) Version:\s*(.+)/.exec(body)?.[1]?.trim();
  const smc = /SMC Version[^:]*:\s*(.+)/.exec(body)?.[1]?.trim();
  if (rom) facts.push(hostFact({
    category: 'firmware', tool: 'boot-rom', raw: rom, version: parseVersion(rom) || undefined,
    provenance: 'system_profiler',
  }));
  if (smc) facts.push(hostFact({
    category: 'firmware', tool: 'smc', raw: smc, version: parseVersion(smc) || undefined,
    provenance: 'system_profiler',
  }));
}

// -------------------------------------------------------------- USB devices
//
// A USB gadget's firmware lives in its bcdDevice/revision; that number moving
// is the event. Each gadget is a device in its own right (keyed by serial, or
// by vid:pid where it has none), so it rides its own firmware.<device> topic
// and its timeline follows it from bench to bench.

function parseLsusbVerbose(body) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && (cur.vid || cur.serial)) out.push(cur); cur = null; };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const dev = /^Bus \d+ Device \d+: ID ([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/.exec(line);
    if (dev) { flush(); cur = { vid: dev[1], pid: dev[2], name: dev[3] || '', bcd: '', serial: '' }; continue; }
    if (!cur) continue;
    const m1 = /^bcdDevice\s+([\d.]+)/.exec(line); if (m1) cur.bcd = m1[1];
    const m2 = /^iProduct\s+\d+\s+(.+)/.exec(line); if (m2 && !cur.name) cur.name = m2[1].trim();
    const m3 = /^iSerial\s+\d+\s+(.+)/.exec(line); if (m3) cur.serial = m3[1].trim();
  }
  flush();
  return out;
}

async function collectUsb() {
  const out = await run(USB_PROBE);
  const kind = marker(out);
  const body = bodyOf(out);
  if (kind === 'none') {
    noteOnce('usb-none', () => publish(hostTopic, 'INFO',
      'no USB enumeration tool found (lsusb, ioreg) - USB firmware skipped',
      { change: 'usb-tooling' }));
    return [];
  }
  const devices = kind === 'lsusb' ? parseLsusbVerbose(body) : parseIoregUsb(body);
  return devices.map((d) => {
    const id = d.serial ? `usb-${d.vid}-${d.pid}-${sanitize(d.serial)}` : `usb-${d.vid}-${d.pid}`;
    return deviceFact({
      category: 'firmware', tool: 'usb-device', device: id,
      raw: `${d.name || `${d.vid}:${d.pid}`}${d.bcd ? ` rev ${d.bcd}` : ''}`,
      version: d.bcd || undefined, provenance: kind === 'lsusb' ? 'lsusb' : 'ioreg',
      extra: { product: d.name, vid: d.vid, pid: d.pid, serial: d.serial },
    });
  });
}

// Best-effort macOS parse: ioreg -a emits a plist, but the two properties this
// needs sit on plain lines even in -a output, so a tolerant scan is enough and
// avoids dragging in the plist reader for two fields.
function parseIoregUsb(body) {
  const out = [];
  const blocks = body.split(/\+-o /).slice(1);
  for (const b of blocks) {
    const vid = /"idVendor"\s*=\s*(\d+)/.exec(b)?.[1];
    const pid = /"idProduct"\s*=\s*(\d+)/.exec(b)?.[1];
    if (!vid || !pid) continue;
    const bcdN = Number(/"bcdDevice"\s*=\s*(\d+)/.exec(b)?.[1] ?? '');
    const bcd = Number.isFinite(bcdN) && bcdN > 0
      ? `${((bcdN >> 8) & 0xff).toString(16)}.${(bcdN & 0xff).toString(16).padStart(2, '0')}` : '';
    out.push({
      vid: Number(vid).toString(16).padStart(4, '0'),
      pid: Number(pid).toString(16).padStart(4, '0'),
      name: /"USB Product Name"\s*=\s*"([^"]+)"/.exec(b)?.[1] || '',
      serial: /"USB Serial Number"\s*=\s*"([^"]+)"/.exec(b)?.[1] || '',
      bcd,
    });
  }
  return out;
}

// --------------------------------------------------- deployed / FPGA probes
//
// The hardest capture and the highest value: what is actually RUNNING on a
// board, not what is installed. There is no universal way to ask a board its
// version, so the user supplies the read per device - a JSON list of
// { device, target?, tool?, cmd, scheme? } - and this runs each and diffs the
// result. That is the FPGA bitstream-vs-toolchain drift, generalised to any
// target with a version register.

function loadProbes() {
  if (!probesFile) return [];
  try {
    const doc = JSON.parse(readFileSync(probesFile, 'utf8'));
    const list = Array.isArray(doc) ? doc : (doc.probes ?? []);
    return list.filter((p) => p && p.device && p.cmd);
  } catch (e) {
    noteOnce('probes-bad', () => publish(hostTopic, 'WARN',
      `could not read --probes ${probesFile}: ${String(e.message ?? e).slice(0, 160)}`,
      { change: 'probes-unreadable' }));
    return [];
  }
}

async function collectDeployed() {
  const facts = [];
  for (const p of loadProbes()) {
    const out = (await run(p.cmd)).trim();
    if (!out) {
      // A version register that would not read: report it absent, not stale.
      // The present->absent transition is a real, once WARN.
      facts.push(deviceFact({
        category: 'deployed', tool: p.tool || 'bitstream', device: p.device, target: p.target,
        raw: '', provenance: 'probe',
      }));
      facts[facts.length - 1].state = 'absent';
      delete facts[facts.length - 1].version;
      delete facts[facts.length - 1].unorderable;
      continue;
    }
    const rawLine = firstLine(out);
    const version = p.pattern ? new RegExp(p.pattern).exec(out)?.[1] : parseVersion(out);
    facts.push(deviceFact({
      category: 'deployed', tool: p.tool || 'bitstream', device: p.device, target: p.target,
      raw: rawLine, version: version || undefined, scheme: p.scheme, provenance: 'probe',
    }));
  }
  return facts;
}

// -------------------------------------------------------- drone firmware
//
// What firmware is ACTUALLY flying: MAVLink's AUTOPILOT_VERSION (msgid 148)
// carries the flight-controller's flashed firmware version, its board version
// and the git hash the vehicle was built from. The framer and CRC are
// superlog-mavlink's, pared to the one message this cares about - a frame that
// does not pass the real CRC is never decoded, so a stray 0xFD is not a
// phantom autopilot.

const AV_MSGID = 148;
const AV_CRC_EXTRA = 178;   // AUTOPILOT_VERSION, MAVLink common dialect

function crcAccumulate(b, crc) {
  let tmp = b ^ (crc & 0xff);
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}
function crc16(bytes, extra) {
  let crc = 0xffff;
  for (const b of bytes) crc = crcAccumulate(b, crc);
  return crcAccumulate(extra, crc);
}

function decodeAutopilotVersion(sysid, view) {
  // Fields are at MAVLink's size-descending wire offsets. flight_sw_version
  // packs major.minor.patch into the top three bytes; the low byte is the
  // release-type enum, not part of the number.
  const packed = view.getUint32(16, true);
  const flightSw = `${(packed >>> 24) & 0xff}.${(packed >>> 16) & 0xff}.${(packed >>> 8) & 0xff}`;
  const boardVer = view.getUint32(28, true);
  const vendorId = view.getUint16(32, true);
  const productId = view.getUint16(34, true);
  const uid = view.byteLength >= 16 ? view.getBigUint64(8, true) : 0n;

  // flight_custom_version[8] is the git hash. ArduPilot stores it as ASCII
  // characters, PX4 as raw bytes - show the ASCII when it is printable, hex
  // otherwise, so the same field is legible from either stack.
  const bytes = [];
  for (let i = 36; i < 44; i++) { const c = view.getUint8(i); if (c === 0) break; bytes.push(c); }
  const printable = bytes.length > 0 && bytes.every((c) => c >= 0x20 && c <= 0x7e);
  const gitHash = bytes.length
    ? (printable ? String.fromCharCode(...bytes) : bytes.map((b) => b.toString(16).padStart(2, '0')).join(''))
    : '';

  // The board's hardware UID is the truest device identity; sysid is a bus
  // address that two vehicles can share. Fall back to sysid when there is no UID.
  const device = opt('device')
    || (uid ? `mav-${uid.toString(16)}` : `mav-sys-${sysid}`);

  return deviceFact({
    category: 'firmware', tool: 'autopilot', device,
    raw: `autopilot fw ${flightSw} board ${boardVer}${gitHash ? ` git ${gitHash}` : ''}`,
    version: flightSw, scheme: 'semver', provenance: 'mavlink',
    extra: {
      flight_sw_version: flightSw, board_version: boardVer, git_hash: gitHash,
      vendor_id: vendorId, product_id: productId, sysid,
      uid: uid ? uid.toString(16) : undefined,
    },
  });
}

// The framer, feeding only AUTOPILOT_VERSION on to the decoder. Everything
// else is advanced past structurally (its length is trusted from the header)
// but never emitted - honest about the one message it knows.
let mavBuf = Buffer.alloc(0);
function feedMavlink(chunk) {
  mavBuf = mavBuf.length ? Buffer.concat([mavBuf, chunk]) : chunk;
  let i = 0;
  while (i < mavBuf.length) {
    const magic = mavBuf[i];
    const v2 = magic === 0xFD;
    const v1 = magic === 0xFE;
    if (!v1 && !v2) { i++; continue; }
    const headerLen = v2 ? 10 : 6;
    if (i + 1 >= mavBuf.length) break;
    const payloadLen = mavBuf[i + 1];
    const frameLen = headerLen + payloadLen + 2;
    const signed = v2 && (mavBuf[i + 2] & 0x01);
    const total = frameLen + (signed ? 13 : 0);
    if (i + total > mavBuf.length) break;

    let sysid, msgid, payloadOff;
    if (v2) {
      sysid = mavBuf[i + 5];
      msgid = mavBuf[i + 7] | (mavBuf[i + 8] << 8) | (mavBuf[i + 9] << 16);
      payloadOff = i + 10;
    } else {
      sysid = mavBuf[i + 3]; msgid = mavBuf[i + 5]; payloadOff = i + 6;
    }
    if (msgid === AV_MSGID) {
      const crcBytes = mavBuf.subarray(i + 1, payloadOff + payloadLen);
      const want = crc16(crcBytes, AV_CRC_EXTRA);
      const got = mavBuf[payloadOff + payloadLen] | (mavBuf[payloadOff + payloadLen + 1] << 8);
      if (want !== got) { i++; continue; }        // bad CRC: not really a frame
      const payload = mavBuf.subarray(payloadOff, payloadOff + payloadLen);
      const padded = Buffer.alloc(Math.max(payloadLen, 64));
      payload.copy(padded);
      try {
        const fact = decodeAutopilotVersion(sysid, new DataView(padded.buffer, padded.byteOffset, padded.byteLength));
        reconcile('drone', [fact], { vanish: false });
      } catch { /* a malformed known message is not worth crashing the bench */ }
    }
    i += total;
  }
  mavBuf = mavBuf.subarray(i);
  void flush();
}

// -------------------------------------------------------------- diffing
//
// A silent baseline, then a version CHANGE is the event, with before+after.
// One baseline map spans every topic (keyed by namespace + device/tool) so a
// board's timeline is one thing wherever it is filed. A newly seen key is
// baseline (silent) during the first poll, and news (INFO "found") after it -
// exactly superlog-versions' discipline, and usb's.

const baseline = new Map();     // "namespace\0device/tool" -> fact
const notes = new Set();
let baselineDone = false;
function noteOnce(id, fn) { if (!notes.has(id)) { notes.add(id); fn(); } }

function factFields(f) {
  const { topic, ...rest } = f;   // topic is transport, not a field
  return rest;
}

function reconcile(namespace, facts, { vanish = false } = {}) {
  const cur = new Map();
  for (const f of facts) {
    const key = `${namespace} ${f.device}/${f.tool}`;
    cur.set(key, f);
    const was = baseline.get(key);
    const topic = f.topic ?? hostTopic;

    if (f.state === 'absent') {
      if (was && was.state === 'present')
        publish(topic, 'WARN', `${f.device} ${f.tool} is unreadable (was ${shown(was)})`,
          { change: 'vanished', category: f.category, device: f.device, tool: f.tool, before: shown(was) });
      baseline.set(key, f);
      continue;
    }

    // The current reading, always, out of a default INFO view - a viewer
    // opened after the last change still sees what is there now.
    publish(topic, 'DEBUG', `${f.device} ${f.tool} ${shown(f)}`, factFields(f));

    if (!baselineDone || !was) {
      if (baselineDone && !was)
        publish(topic, 'INFO', `found ${f.tool} ${shown(f)} on ${f.device}`,
          { change: 'appeared', category: f.category, device: f.device, tool: f.tool,
            after: shown(f), purl: f.purl });
      baseline.set(key, f);
      continue;
    }
    if ((was.version ?? was.raw) !== (f.version ?? f.raw)) {
      const major = f.version && was.version && f.version.split('.')[0] !== was.version.split('.')[0];
      publish(topic, major ? 'WARN' : 'INFO',
        `${f.device} ${f.tool} ${shown(was)} -> ${shown(f)}${major ? ' (major)' : ''}`,
        { change: 'changed', category: f.category, device: f.device, tool: f.tool,
          before: shown(was), after: shown(f), scheme: f.scheme, purl: f.purl });
    }
    baseline.set(key, f);
  }

  if (vanish)
    for (const [key, was] of baseline) {
      if (!key.startsWith(`${namespace} `)) continue;
      if (cur.has(key) || was.state !== 'present') continue;
      publish(was.topic ?? hostTopic, 'WARN', `${was.device} ${was.tool} is GONE (was ${shown(was)})`,
        { change: 'vanished', category: was.category, device: was.device, tool: was.tool, before: shown(was) });
      baseline.set(key, { ...was, state: 'absent' });
    }
}

// The host inventory as one reading (fields.versions), so a viewer can show the
// whole silicon stack and diff two hosts - then the per-fact edges.
function reconcileHost(facts) {
  const present = facts.filter((f) => f.state === 'present');
  publish(hostTopic, 'DEBUG', `${present.length} hardware/firmware fact(s)`,
    { versions: JSON.stringify(facts).slice(0, 16000), count: present.length });
  reconcile('host', facts, { vanish: true });
}

// ------------------------------------------------------------------ main

async function tick() {
  const hostFacts = [];
  await probeCpu(hostFacts);
  await probeGpu(hostFacts);
  await probeDisk(hostFacts);
  // RAM is a hardware fact but not a version - present, and honestly unorderable.
  hostFacts.push(hostFact({
    category: 'hardware', tool: 'ram', raw: `${Math.round(totalmem() / 1073741824)}GB`, provenance: 'os',
  }));
  if (wantFirmware) await probeFirmware(hostFacts);
  reconcileHost(hostFacts);

  reconcile('usb', await collectUsb(), { vanish: true });
  if (probesFile) reconcile('probe', await collectDeployed(), { vanish: false });
}

async function decodeFrameFile() {
  let data;
  try { data = readFileSync(frameFile); }
  catch (e) {
    publish(hostTopic, 'WARN', `could not read --frame ${frameFile}: ${String(e.message ?? e).slice(0, 160)}`,
      { change: 'frame-unreadable' });
    return;
  }
  // A capture may be raw bytes or a hex dump; take it either way.
  const asText = data.toString('utf8').trim();
  const buf = asText && /^[0-9a-fA-F\s]+$/.test(asText)
    ? Buffer.from(asText.replace(/\s+/g, ''), 'hex') : data;
  feedMavlink(buf);
}

const main = async () => {
  await tick();
  baselineDone = true;                 // everything after the first poll is news

  if (frameFile) await decodeFrameFile();
  await flush();

  const streaming = Boolean(udpPort);
  if (once && !streaming) { await flush(); process.exit(0); }

  if (streaming) {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (m) => feedMavlink(m));
    sock.on('error', (e) => console.error(`superlog-firmware: udp error ${e.message}`));
    sock.bind(Number(udpPort), opt('bind', '0.0.0.0'), () =>
      console.error(`superlog-firmware: listening for MAVLink AUTOPILOT_VERSION on udp/${udpPort}`));
    for (const sig of ['SIGINT', 'SIGTERM'])
      process.on(sig, async () => { try { sock.close(); } catch { /* gone */ } await flush(); process.exit(0); });
  }

  if (!once)
    setInterval(async () => { await tick(); await flush(); }, intervalS * 1000);

  console.error(`superlog-firmware: ${hostTopic}` +
    (dest ? ` (ssh ${dest})` : '') +
    (once ? ' (once)' : ` every ${intervalS}s`) +
    (wantFirmware ? ' +firmware' : '') +
    (probesFile ? ` +probes(${probesFile})` : '') +
    (streaming ? ` +udp(${udpPort})` : '') +
    ` -> ${hubUrl}`);
};

void main();
