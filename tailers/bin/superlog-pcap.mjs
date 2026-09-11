#!/usr/bin/env node
//
//  superlog-pcap - packets on the bench, as connection DIAGNOSTICS, not a dump.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A packet capture is thousands of packets a second and most of it is noise.
//  What a developer actually loses time to is a connection that will not form -
//  the SYN goes out and nothing comes back - so this watches the handshake, not
//  the payload. A SYN with NO REPLY is a filtered/dropped port (the hang that
//  ruins an afternoon); a RST is a refused port (the service is not listening);
//  an ICMP unreachable is no route. Each is an edge-triggered event with the
//  5-tuple and nothing else.
//
//    sudo superlog-pcap                       # live: watch the handshakes on the default iface
//    sudo superlog-pcap -i en0 --all          # + a flow summary of ALL traffic (louder)
//    superlog-pcap --pcap capture.pcapng      # offline: summarise a .pcap/.pcapng file (no sudo)
//
//  METADATA ONLY. It reads the 5-tuple, the TCP flags and the packet size - it
//  NEVER reads a payload, and there is no switch that makes it. A version list
//  is a CVE roadmap and a packet payload is worse, so the topic pcap.<host> is
//  a first-class egress-cut candidate: SUPER_LOG_NO_EGRESS=pcap.* keeps it on
//  the machine, and on any untrusted bench you should set it.
//
//  Live capture needs privilege (tcpdump wants a raw socket) - run with sudo,
//  which it says once and does not pretend around. The offline file path needs
//  none. Zero dependency: it drives tcpdump, already present on macOS and Linux.
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { hostname, networkInterfaces, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) { const v = args[i + 1]; return v !== undefined && !v.startsWith('--') ? v : dflt; }
  const j = args.indexOf(`-${name}`);
  if (j >= 0) { const v = args[j + 1]; return v !== undefined && !v.startsWith('-') ? v : dflt; }
  return dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-pcap - connection diagnostics from packets (metadata only)

  sudo superlog-pcap [-i IFACE] [--all] [--timeout SECS] [--name LABEL] [--url HUB]
  superlog-pcap --pcap FILE            # offline, no privilege

Watches the TCP handshake: a SYN with no reply is a filtered/blocked port
(WARN), a RST is refused (WARN), an ICMP unreachable is no route (WARN); a
completed handshake recovers. --all adds a flow summary of every packet. It
reads the 5-tuple and flags ONLY - never a payload. Topic pcap.<host>; cut it
from egress with SUPER_LOG_NO_EGRESS=pcap.* on any untrusted bench.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const mac = platform() === 'darwin';
const iface = opt('i', opt('iface'));
const pcapFile = opt('pcap');
const wantAll = args.includes('--all');
const timeoutMs = (Number(opt('timeout', 3)) || 3) * 1000;

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'host';
const host = opt('name') ? sanitize(opt('name')) : sanitize(hostname().split('.')[0]);
const topic = `pcap.${host}`;

// This machine's own addresses, to tell an outbound SYN (we are connecting)
// from an inbound one (someone is connecting to us). --local overrides them,
// which is how you analyse a capture taken on a DIFFERENT host offline.
const localIps = new Set(opt('local')
  ? opt('local').split(',').map((s) => s.trim())
  : Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a.address));

// ------------------------------------------------------------- publishing

const session = randomBytes(4).toString('hex');
let seq = 0;
let lines = [];
function publish(level, msg, fields, metric) {
  lines.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'pcap', platform: mac ? 'macos' : 'linux', device: host },
    tag: 'pcap', msg,
    ...(metric ? { metric } : {}),
    ...(fields && Object.keys(fields).length
      ? { fields: Object.fromEntries(Object.entries(fields)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)])) }
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

// ---------------------------------------------------------------- parsing
//
// tcpdump -n -q text. We read the 5-tuple, the flag word and the length - and
// stop there. Two forms matter:
//   IP 10.0.0.5.54321 > 1.1.1.1.443: Flags [S], seq 0, length 0
//   IP 10.0.0.1 > 10.0.0.5: ICMP 1.1.1.1 unreachable, length 36
// IPv6 uses the same shape with a different address token.

const addrPort = (s) => {                        // "1.2.3.4.443" or "[::1].443"
  const m = /^(.*)\.(\d+)$/.exec(s);
  return m ? { ip: m[1].replace(/^\[|\]$/g, ''), port: m[2] } : { ip: s, port: '' };
};

function parseLine(line) {
  // ICMP unreachable (v4/v6): the dst that can't be reached is named in the body.
  const un = /ICMP[6]?\s+(.+?)\s+unreachable/i.exec(line);
  if (un) {
    const who = /(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+)/i.exec(un[1]);
    return { kind: 'unreachable', dst: who?.[1] };
  }
  const m = /IP6?\s+(\S+)\s+>\s+([^:]+):\s+Flags \[([^\]]*)\]/.exec(line);
  if (!m) return null;
  const from = addrPort(m[1]), to = addrPort(m[2]);
  const flags = m[3];                            // S, S., R, R., P., ., F. ...
  const len = Number(/length (\d+)/.exec(line)?.[1] ?? 0);
  return { kind: 'tcp', from, to, flags, len };
}

// ------------------------------------------------------- the state machine
//
// A pending outbound SYN clears on SYN-ACK (connected), RST (refused) or ICMP
// unreachable (no route); if none arrives within --timeout it was filtered.
// Edge-triggered per endpoint: one line per verdict, not per packet.

const pending = new Map();      // "dst:port" -> { at }
const verdict = new Map();      // "dst:port" -> 'ok'|'refused'|'filtered'|'noroute' (last said)
const portStats = new Map();    // service port -> { pkts, bytes } over the window, for --all
const portTotals = new Map();   // service port -> { pkts, bytes } CUMULATIVE since start
let grandPkts = 0, grandBytes = 0;
const started = Date.now();
let winStart = Date.now();

function say(key, state, level, msg, fields) {
  if (verdict.get(key) === state) return;        // already said this
  verdict.set(key, state);
  publish(level, msg, { change: 'reachability', ...fields });
}

function onPacket(p) {
  if (p.kind === 'unreachable' && p.dst) {
    for (const key of [...pending.keys()]) if (key.startsWith(`${p.dst}:`)) {
      pending.delete(key);
      say(key, 'noroute', 'WARN', `no route to ${key} - ICMP unreachable`, { dst: p.dst });
    }
    return;
  }
  if (p.kind !== 'tcp') return;
  const outbound = localIps.has(p.from.ip);
  const f = p.flags;
  const isSyn = f === 'S';
  const isSynAck = f === 'S.';
  const isRst = f.startsWith('R');

  if (isSyn && outbound) {
    const key = `${p.to.ip}:${p.to.port}`;
    if (!pending.has(key)) pending.set(key, { at: Date.now() });
  } else if (isSynAck && localIps.has(p.to.ip)) {
    const key = `${p.from.ip}:${p.from.port}`;    // the peer that answered
    if (pending.delete(key))
      say(key, 'ok', 'INFO', `reached ${key} - handshake completed`, { dst: p.from.ip });
  } else if (isRst) {
    // a reset from the peer we tried to reach
    const key = localIps.has(p.to.ip) ? `${p.from.ip}:${p.from.port}` : `${p.to.ip}:${p.to.port}`;
    if (pending.delete(key))
      say(key, 'refused', 'WARN', `${key} REFUSED - the port sent a RST (nothing is listening)`, { dst: key.split(':')[0] });
  }

  if (wantAll) {                                 // opt-in: per-port packet/byte rates
    const sp = Number(p.from.port), dp = Number(p.to.port);
    // The SERVICE port is the non-ephemeral one - usually the smaller. 54321->443
    // counts against 443; 22->51000 against 22.
    const port = (sp && dp) ? Math.min(sp, dp) : (sp || dp || 0);
    const st = portStats.get(port) ?? { pkts: 0, bytes: 0 };
    st.pkts += 1; st.bytes += p.len;
    portStats.set(port, st);
    const tot = portTotals.get(port) ?? { pkts: 0, bytes: 0 };
    tot.pkts += 1; tot.bytes += p.len;
    portTotals.set(port, tot);
    grandPkts += 1; grandBytes += p.len;
  }
}

// A SYN that never got any reply within the window: filtered/dropped - the hang.
function sweep() {
  const now = Date.now();
  for (const [key, s] of pending) {
    if (now - s.at >= timeoutMs) {
      pending.delete(key);
      say(key, 'filtered', 'WARN',
          `${key} not answering - SYN sent, no reply in ${timeoutMs / 1000}s (filtered/dropped, or the host is down)`,
          { dst: key.split(':')[0] });
    }
  }
}

// Packets/sec and MB/sec THROUGH EACH PORT over the window - the "how much is
// flowing where" view. Byte rate uses tcpdump's reported length (payload), so
// it is a floor, not the wire total; the shape and the busy ports are exact.
function emitPortRates() {
  const now = Date.now();
  const secs = Math.max(0.001, (now - winStart) / 1000);
  winStart = now;
  for (const [port, st] of portStats) {
    const pps = st.pkts / secs, mbps = st.bytes / secs / 1e6;
    const tot = portTotals.get(port) ?? { pkts: 0, bytes: 0 };
    publish('DEBUG',
            `port ${port}: ${pps.toFixed(0)} pkt/s, ${mbps.toFixed(2)} MB/s` +
            `  (total ${tot.pkts.toLocaleString()} pkts, ${(tot.bytes / 1e6).toFixed(1)} MB since start)`,
            { port: String(port), pps: pps.toFixed(0),
              total_pkts: String(tot.pkts), total_mb: (tot.bytes / 1e6).toFixed(3) },
            { name: 'pcap.port_mbps', value: Number(mbps.toFixed(4)) });
  }
  portStats.clear();
  // The grand total across every port, since the capture started.
  const upS = Math.max(1, Math.round((now - started) / 1000));
  publish('DEBUG',
          `TOTAL since start (${upS}s): ${grandPkts.toLocaleString()} pkts, ${(grandBytes / 1e6).toFixed(1)} MB`,
          { total_pkts: String(grandPkts), total_mb: (grandBytes / 1e6).toFixed(3), uptime_s: String(upS) },
          { name: 'pcap.total_mb', value: Number((grandBytes / 1e6).toFixed(3)) });
}

// ------------------------------------------------------------------ main

function tcpdumpArgs() {
  // Control packets only by default (SYN/RST) plus ICMP - low volume, and the
  // handshake is all the diagnostics need. --all drops the filter.
  const base = ['-n', '-q', '-l'];
  if (pcapFile) return [...base, '-r', pcapFile];
  if (iface) base.push('-i', iface);
  const filter = wantAll ? [] : ['(tcp[tcpflags] & (tcp-syn|tcp-rst)) != 0 or icmp or icmp6'];
  return [...base, ...filter];
}

const child = spawn('tcpdump', tcpdumpArgs(), { stdio: ['ignore', 'pipe', 'pipe'] });
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const p = parseLine(line);
    if (p) onPacket(p);
  }
});
let privWarned = false;
child.stderr.on('data', (d) => {
  const s = String(d);
  if (/permission denied|Operation not permitted|root|sudo/i.test(s) && !privWarned) {
    privWarned = true;
    console.error('superlog-pcap: live capture needs privilege - run with sudo (the offline --pcap path does not).');
  }
});
child.on('error', () => {
  console.error('superlog-pcap: tcpdump not found - install it (apt install tcpdump / it ships on macOS).');
  process.exit(1);
});
child.on('close', () => { void flush(); if (pcapFile) process.exit(0); });

const timers = [
  setInterval(() => { sweep(); }, 1000),
  setInterval(async () => { if (wantAll) emitPortRates(); await flush(); }, 2000),
];
process.on('SIGINT', async () => { timers.forEach(clearInterval); child.kill(); await flush(); process.exit(130); });
process.on('SIGTERM', async () => { timers.forEach(clearInterval); child.kill(); await flush(); process.exit(143); });

console.error(`superlog-pcap: ${pcapFile ? `reading ${pcapFile}` : `live ${iface || 'default iface'}${wantAll ? ' (+flows)' : ''}`}` +
              ` -> ${topic} @ ${hubUrl}`);
