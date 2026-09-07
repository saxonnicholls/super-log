#!/usr/bin/env node
//
//  superlog-ports - what is listening, and which process owns it.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A listening socket is boring until it changes, and then it is the most
//  interesting thing on the screen. A new listener on a production box is
//  either a deploy you did or something you very much want to know about;
//  a listener that disappears is an outage several minutes before anyone
//  says so; a process whose pid changed restarted without necessarily
//  logging that it did.
//
//    superlog-ports                       # this machine, watch for change
//    superlog-ports --once                # inventory: everything listening now
//    superlog-ports --ssh web1            # a remote box, nothing installed there
//    superlog-ports --procs nginx,postgres --interval 30
//
//  Publishes to net.<host>.listeners. Like the DNS watcher, the first poll
//  is a silent baseline and only changes are reported after it - a poll
//  that re-lists forty sockets every thirty seconds is noise, and noise is
//  how a watcher teaches you to ignore it.
//
//  Levels follow meaning. A new listener bound to a public address is WARN
//  because nobody meant to leave one there; the same thing on loopback is
//  INFO because that is a dev tool starting. A listener vanishing is WARN;
//  a watched process vanishing is ERROR.
//
//  Zero dependency: `ss` on Linux, `lsof` on macOS, both already present.
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
  console.error(`superlog-ports - listening sockets and their processes, watched for change

  superlog-ports [--once] [--ssh DEST] [--interval SECONDS] [--url HUB]
                 [--procs name,name] [--udp] [--identity KEY] [--ssh-port N]

Publishes to net.<host>.listeners. First poll is a silent baseline; after
that only changes are reported. --once prints the current inventory instead.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const intervalMs = Number(opt('interval', env.SUPER_LOG_PORTS_INTERVAL ?? '30')) * 1000;
const once = args.includes('--once');
const withUdp = args.includes('--udp');
const dest = opt('ssh');
const procWatch = (opt('procs', env.SUPER_LOG_PORTS_PROCS ?? '') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const sanitize = (s) => s.split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const host = dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest) : sanitize(hostname());
const topic = opt('topic', `net.${host}.listeners`);

// ---------------------------------------------------------------- running

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];

/** Run a shell command here or there, and hand back stdout. Never throws:
 *  a host that is down is a fact to report, not an exception to crash on. */
function run(cmd) {
  return new Promise((resolve) => {
    const child = dest
      ? spawn('ssh', [...SSH_BASE, dest, cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ ok: false, out: '' }));
    child.on('close', (code) => resolve({ ok: code === 0 || out.length > 0, out }));
  });
}

// ---------------------------------------------------------------- parsing
//
// Two very different output formats, one shape out. A listener is identified
// by proto + address + port + process NAME; the pid is carried separately,
// because a pid change means "restarted" and should not read as a new
// service appearing and an old one vanishing.

const KEY = (l) => `${l.proto} ${l.address}:${l.port} ${l.process}`;

/** ss -tulpnH:  tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6)) */
function parseSs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const proto = f[0];
    if (!/^(tcp|udp)$/.test(proto)) continue;
    if (proto === 'tcp' && f[1] !== 'LISTEN') continue;
    const local = f[4];
    const at = local.lastIndexOf(':');
    if (at < 0) continue;
    const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    out.push({
      proto,
      address: local.slice(0, at).replace(/^\[|\]$/g, ''),
      port: local.slice(at + 1),
      process: m?.[1] ?? '?',
      pid: m?.[2] ?? '',
    });
  }
  return out;
}

/** lsof -nP -iTCP -sTCP:LISTEN:  nginx 1234 root 6u IPv4 0x.. 0t0 TCP *:80 (LISTEN) */
function parseLsof(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 9 || f[0] === 'COMMAND') continue;
    const name = f[8];
    const at = name.lastIndexOf(':');
    if (at < 0) continue;
    out.push({
      proto: (f[7] || 'TCP').toLowerCase(),
      address: name.slice(0, at).replace(/^\[|\]$/g, ''),
      port: name.slice(at + 1),
      process: f[0],
      pid: f[1],
    });
  }
  return out;
}

async function listeners() {
  // ss first: it is the modern tool and it names the process without root
  // for your own sockets. lsof is the macOS answer and the fallback.
  const ss = await run(`ss -tulpnH 2>/dev/null || ss -tulpn 2>/dev/null`);
  if (ss.out.trim()) {
    const parsed = parseSs(ss.out);
    if (parsed.length) return withUdp ? parsed : parsed.filter((l) => l.proto === 'tcp');
  }
  const flags = withUdp ? '-iTCP -sTCP:LISTEN -iUDP' : '-iTCP -sTCP:LISTEN';
  const lsof = await run(`lsof -nP ${flags} 2>/dev/null`);
  return parseLsof(lsof.out);
}

// ------------------------------------------------------------- firewall
//
// Listening and reachable are different questions, and the gap between them
// is where the surprises live: a service bound to 0.0.0.0 that the firewall
// blocks is fine, and one you thought was firewalled but is not is an
// exposure. So the rules are watched alongside the sockets, and a change to
// them is WARN - nobody edits a firewall by accident, which is exactly why
// an edit you did not make is worth seeing.

/** ufw, firewalld, nftables, iptables or pf - whichever answers. Returns a
 *  stable, sorted list of rule lines, or null when none can be read (no
 *  firewall tool, or no permission - both of which are facts, not errors). */
async function firewallRules() {
  const probes = [
    { name: 'ufw', cmd: 'ufw status 2>/dev/null | tail -n +2' },
    { name: 'firewalld', cmd: 'firewall-cmd --list-all 2>/dev/null' },
    { name: 'nftables', cmd: 'nft list ruleset 2>/dev/null' },
    { name: 'iptables', cmd: 'iptables -S 2>/dev/null' },
    // macOS: the application firewall is the one people actually set
    { name: 'pf', cmd: 'pfctl -sr 2>/dev/null' },
    { name: 'alf', cmd: '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null' },
  ];
  for (const p of probes) {
    const r = await run(p.cmd);
    const lines = r.out.split('\n').map((s) => s.trim())
      .filter((s) => s && !/^#/.test(s) && !/^Chain /.test(s));
    if (lines.length) return { tool: p.name, rules: lines.sort() };
  }
  return null;
}

/** A watched process, whether or not it listens on anything. */
async function processPids(names) {
  const found = new Map();
  for (const n of names) {
    const r = await run(`pgrep -d, -x ${n} 2>/dev/null || pgrep -d, -f ${n} 2>/dev/null`);
    const pids = r.out.trim().split(',').filter(Boolean);
    if (pids.length) found.set(n, pids.sort().join(','));
  }
  return found;
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;

function publish(level, msg, fields) {
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'ports-watcher', platform: 'net', device: host },
    tag: 'ports', msg, fields,
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

// A bind on 0.0.0.0, :: or a routable address is reachable by someone else.
// Loopback is not, and dev machines churn loopback listeners constantly.
const isPublic = (a) =>
  !/^(127\.|::1$|localhost$)/.test(a) && a !== '' && a !== '*:';

// ------------------------------------------------------------------ loop

let prev = null;
let prevProcs = new Map();
let prevFw = null;
const checkFirewall = !args.includes('--no-firewall');

async function tick(first) {
  const now = await listeners();
  if (!now.length && prev === null) {
    console.error(`superlog-ports: no listeners found${dest ? ` on ${dest}` : ''} - ` +
                  `is ss/lsof available there?`);
  }
  const byKey = new Map(now.map((l) => [KEY(l), l]));

  if (once) {
    // byKey, not `now`: lsof lists IPv4 and IPv6 as separate rows that
    // display identically (`*:8080` twice), and an inventory that prints
    // the same line twice reads as a bug in the thing being inventoried.
    for (const l of byKey.values())
      publish('INFO', `${l.proto} ${l.address}:${l.port} ${l.process}${l.pid ? ` (pid ${l.pid})` : ''}`,
              { host, proto: l.proto, address: l.address, port: l.port,
                process: l.process, pid: l.pid, exposure: isPublic(l.address) ? 'public' : 'loopback' });
    // Deliberately falls through to the firewall block: an inventory of
    // what is listening without what is reachable answers half a question.
  }

  if (!once && prev) {
    for (const [k, l] of byKey) {
      const before = prev.get(k);
      if (!before) {
        const pub = isPublic(l.address);
        publish(pub ? 'WARN' : 'INFO',
                `new listener ${l.proto} ${l.address}:${l.port} (${l.process}${l.pid ? ` pid ${l.pid}` : ''})`,
                { host, change: 'opened', proto: l.proto, address: l.address, port: l.port,
                  process: l.process, pid: l.pid, exposure: pub ? 'public' : 'loopback' });
      } else if (before.pid && l.pid && before.pid !== l.pid) {
        // Same socket, new owner: the service restarted. Worth saying,
        // because a crash-loop looks like silence in its own log.
        publish('WARN', `${l.process} restarted on ${l.address}:${l.port} (pid ${before.pid} -> ${l.pid})`,
                { host, change: 'restarted', proto: l.proto, address: l.address, port: l.port,
                  process: l.process, pid: l.pid, pid_before: before.pid });
      }
    }
    for (const [k, l] of prev)
      if (!byKey.has(k))
        publish('WARN', `listener gone ${l.proto} ${l.address}:${l.port} (${l.process})`,
                { host, change: 'closed', proto: l.proto, address: l.address, port: l.port,
                  process: l.process, exposure: isPublic(l.address) ? 'public' : 'loopback' });
  }
  prev = byKey;

  if (checkFirewall) {
    const fw = await firewallRules();
    if (!fw) {
      if (first)
        publish('WARN', 'no readable firewall rules (no tool found, or not permitted) - ' +
                'listening ports below are as good as public unless something upstream filters them',
                { host, firewall: 'unknown' });
    } else if (once || first) {
      publish('INFO', `firewall (${fw.tool}): ${fw.rules.length} rule(s)`,
              { host, firewall: fw.tool, rules: fw.rules.slice(0, 40).join(' | '),
                count: String(fw.rules.length) });
    } else if (prevFw && prevFw.rules.join('\n') !== fw.rules.join('\n')) {
      const added = fw.rules.filter((r) => !prevFw.rules.includes(r));
      const removed = prevFw.rules.filter((r) => !fw.rules.includes(r));
      publish('WARN', `firewall changed (${fw.tool}): ` +
              `${added.length} added, ${removed.length} removed`,
              { host, firewall: fw.tool, change: 'firewall',
                added: added.join(' | ').slice(0, 500),
                removed: removed.join(' | ').slice(0, 500) });
    }
    if (fw) prevFw = fw;
  }

  if (procWatch.length) {
    const procs = await processPids(procWatch);
    for (const name of procWatch) {
      const before = prevProcs.get(name);
      const now2 = procs.get(name);
      if (first) continue;
      if (before && !now2)
        publish('ERROR', `process ${name} is no longer running`, { host, change: 'process_gone', process: name });
      else if (!before && now2)
        publish('INFO', `process ${name} started (pid ${now2})`, { host, change: 'process_started', process: name, pid: now2 });
      else if (before && now2 && before !== now2)
        publish('WARN', `process ${name} restarted (pid ${before} -> ${now2})`,
                { host, change: 'process_restarted', process: name, pid: now2, pid_before: before });
    }
    prevProcs = procs;
  }
}

console.error(`superlog-ports: ${dest ? dest : 'this machine'} -> ${topic}` +
              (once ? ' (inventory)' : ` every ${intervalMs / 1000}s`));

let first = true;
for (;;) {
  await tick(first);
  await flush();
  if (once) break;
  if (first) {
    const n = prev ? prev.size : 0;
    console.error(`superlog-ports: baseline ${n} listener(s); reporting changes from here`);
    first = false;
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
