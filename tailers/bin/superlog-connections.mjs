#!/usr/bin/env node
//
//  superlog-connections - what this machine is TALKING TO, and what it can't.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  superlog-ports watches the sockets you LISTEN on. This watches the other
//  half: the outbound connections - which process is talking to which remote
//  endpoint - and, the part a developer actually loses time to, the ones that
//  are STUCK. A socket sitting in SYN-SENT means the SYN went out and nothing
//  came back: the port is filtered, dropped, or the service is down. A refused
//  port answers instantly (a RST) and you know at once; a FILTERED port hangs,
//  and that hang is the afternoon you lose to "why won't it connect". This
//  polls for exactly that hang and names it.
//
//    superlog-connections                    # this machine's connections, as a tree
//    superlog-connections --ssh web1         # a remote box's, over ssh
//    superlog-connections --once             # what is connected right now
//
//  Publishes net.<host>.connections: a tree of process -> remote endpoint on
//  fields.tree (the viewers' Topology window renders it), a DEBUG structural
//  reading each poll. Edges are few and mean something: a connection stuck in
//  SYN-SENT across two checks is a WARN ("cannot reach X - blocked or down"),
//  reaching it afterwards is the recovery, and a process talking to a remote
//  host for the first time this run is one INFO ("is my app on dev or prod").
//
//  Zero dependency: ss on Linux, lsof on macOS (both already present); reverse
//  DNS names the remote where one resolves (--no-dns to disable - the only
//  off-machine lookup, to the system resolver). Node >= 18.
//

import { execFile } from 'node:child_process';
import { promises as dnsp } from 'node:dns';
import { hostname, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { loadEnv } from './env.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-connections - outbound connections, and the ones that are stuck

  superlog-connections [--once] [--interval 10] [--no-dns] [--name LABEL]
                       [--ssh DEST] [--identity KEY] [--ssh-port N] [--url HUB]

Publishes net.<host>.connections: a process -> remote-endpoint tree on
fields.tree. A connection stuck in SYN-SENT across two checks is a WARN (the
port is filtered/dropped or the service is down - the hang a dev loses time
to); reaching it afterwards recovers; a first-seen remote host is one INFO.
Uses ss (Linux) / lsof (macOS); reverse-DNS names the remote (--no-dns off).`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const mac = platform() === 'darwin';
const win = platform() === 'win32';
const dest = opt('ssh');
const once = args.includes('--once');
const intervalS = Number(opt('interval', 10)) || 10;
const wantDns = !args.includes('--no-dns');

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'host';
// Resolved to the box's real hostname at startup when reached over ssh, so one
// box is one identity regardless of the alias used to reach it.
let host = opt('name') ? sanitize(opt('name'))
         : dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest)
                : sanitize(hostname().split('.')[0]);
let topic = `net.${host}.connections`;
async function resolveRemoteHost() {
  if (!dest || opt('name')) return;
  try {
    const { stdout } = await run('ssh', [...SSH_BASE, dest, 'hostname -s 2>/dev/null || hostname 2>/dev/null'],
      { timeout: 10000 });
    const h = sanitize(stdout.split('\n')[0].trim());
    if (h) { host = h; topic = `net.${host}.connections`; }
  } catch { /* keep the alias */ }
}
const localPlatform = win ? 'windows' : mac ? 'macos' : 'linux';

// ------------------------------------------------------------- publishing

const session = randomBytes(4).toString('hex');
let seq = 0;
let lines = [];

function publish(level, msg, fields) {
  lines.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'connections', platform: localPlatform, device: host },
    tag: 'net', msg,
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

// ---------------------------------------------------------------- running

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];
async function execText(cmd, argv) {
  try { return (await run(cmd, argv, { timeout: 12000 })).stdout; }
  catch { return ''; }
}
async function rawConns() {
  // ss names the process without root for your own sockets; lsof is the macOS
  // answer. Over ssh, try the Linux form then the macOS form on the remote.
  if (dest) {
    try {
      return (await run('ssh', [...SSH_BASE, dest,
        'ss -tanpH 2>/dev/null || lsof -nP -iTCP 2>/dev/null'], { timeout: 15000 })).stdout;
    } catch { return ''; }
  }
  if (win) return execText('netstat', ['-ano', '-p', 'tcp']);
  const ss = await execText('ss', ['-tanpH']);
  if (ss.trim()) return ss;
  return execText('lsof', ['-nP', '-iTCP']);
}

// ---------------------------------------------------------------- parsing
//
// One shape - { proc, pid, host, port, state } - out of ss, lsof or netstat.
// We keep only the states that carry a decision: ESTABLISHED (what you are
// talking to) and SYN-SENT (what you cannot reach). LISTEN is superlog-ports'
// job; teardown states are noise here.

const normState = (s) => {
  const u = s.toUpperCase().replace(/_/g, '-');
  if (u.startsWith('ESTAB')) return 'established';
  if (u === 'SYN-SENT') return 'syn-sent';
  return '';                                     // everything else: not our concern
};

function parseConns(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // ss -tanpH:  ESTAB 0 0 192.168.1.5:54321 93.184.216.34:443 users:(("curl",pid=123,...))
    let m = /^(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+users:\(\("([^"]+)",pid=(\d+))?/.exec(line);
    if (m && /:\d+$/.test(m[3])) {
      const state = normState(m[1]);
      if (!state) continue;
      const peer = m[3]; const at = peer.lastIndexOf(':');
      out.push({ proc: m[4] ?? '?', pid: m[5] ?? '', state,
                 host: peer.slice(0, at).replace(/^\[|\]$/g, ''), port: peer.slice(at + 1) });
      continue;
    }
    // lsof -nP -iTCP:  curl 123 user 5u IPv4 0x.. 0t0 TCP 192.168.1.5:54321->93.184.216.34:443 (ESTABLISHED)
    m = /^(\S+)\s+(\d+)\s+\S+.*\sTCP\s+\S+->(\S+):(\d+)\s+\((\w+)\)/.exec(line);
    if (m) {
      const state = normState(m[5]);
      if (!state) continue;
      out.push({ proc: m[1], pid: m[2], state, host: m[3].replace(/^\[|\]$/g, ''), port: m[4] });
      continue;
    }
    // netstat -ano (Windows):  TCP  192.168.1.5:54321  93.184.216.34:443  ESTABLISHED  123
    m = /^\s*TCP\s+\S+\s+([\d.]+|\[[0-9a-f:]+\]):(\d+)\s+(\w+)\s+(\d+)/i.exec(line);
    if (m) {
      const state = normState(m[3]);
      if (!state) continue;
      out.push({ proc: '?', pid: m[4], state, host: m[1].replace(/^\[|\]$/g, ''), port: m[2] });
    }
  }
  return out;
}

// ------------------------------------------------------ reverse DNS (lean)

const rdns = new Map();
const resolvable = (ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) &&
  !ip.startsWith('127.') && !ip.startsWith('169.254.') && ip !== '0.0.0.0';
async function resolveNames(ips) {
  if (!wantDns) return;
  await Promise.all([...new Set(ips)].filter((ip) => ip && resolvable(ip) && !rdns.has(ip))
    .map(async (ip) => {
      rdns.set(ip, '');
      try {
        const names = await Promise.race([
          dnsp.reverse(ip),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
        ]);
        const nm = Array.isArray(names) && names[0] ? names[0] : '';
        if (nm && !/(^|\.)localhost$|\b(unknown|undefined)\b/i.test(nm)) rdns.set(ip, nm);
      } catch { /* no PTR - absent, not an error */ }
    }));
}
const nameOf = (ip) => rdns.get(ip) || '';

// --------------------------------------------------------------- the tree

function buildTree(conns) {
  // process (pid) -> its remote endpoints, identical sockets collapsed with a
  // count, stuck ones first so the eye lands on the problem.
  const byProc = new Map();
  for (const c of conns) {
    const pkey = `${c.proc} (${c.pid})`;
    if (!byProc.has(pkey)) byProc.set(pkey, new Map());
    const nm = nameOf(c.host);
    const who = nm ? `${c.host} (${nm})` : c.host;
    const mark = c.state === 'syn-sent' ? '  ⚠ SYN-SENT no reply - blocked or down' : '';
    const label = `${who}:${c.port}  ${c.state.toUpperCase()}${mark}`;
    const eps = byProc.get(pkey);
    const cur = eps.get(label) ?? { count: 0, stuck: c.state === 'syn-sent' };
    cur.count += 1;
    eps.set(label, cur);
  }
  const children = [...byProc.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([proc, eps]) => {
      const kids = [...eps.entries()].map(([label, v]) => ({
        name: v.count > 1 ? `${label}  (×${v.count})` : label, _stuck: v.stuck,
      }));
      kids.sort((a, b) => (b._stuck ? 1 : 0) - (a._stuck ? 1 : 0) || a.name.localeCompare(b.name));
      kids.forEach((k) => delete k._stuck);
      return { name: proc, children: kids };
    });
  return { name: `${host}${dest ? '' : ' (this machine)'}`, children };
}

// -------------------------------------------------------------- diffing

const state = new Map();      // "proc/host:port" -> { was: 'syn-sent'|'established', bad, warned }
let baselined = false;
const seenEndpoints = new Set();  // proc->host first-sight

function key(c) { return `${c.proc}/${c.host}:${c.port}`; }

function diff(conns) {
  const live = new Set(conns.map(key));
  for (const c of conns) {
    const k = key(c);
    const st = state.get(k) ?? { bad: 0, warned: false };

    // First sight of a process talking to a remote HOST - the dev/prod answer.
    const ep = `${c.proc}->${c.host}`;
    if (!seenEndpoints.has(ep)) {
      seenEndpoints.add(ep);
      if (baselined)
        publish('INFO', `${c.proc} opened a connection to ${c.host}${nameOf(c.host) ? ` (${nameOf(c.host)})` : ''}:${c.port}`,
                { change: 'new-endpoint', proc: c.proc, host: c.host, port: c.port });
    }

    // The stuck-connection alarm: SYN-SENT that holds across two checks.
    if (c.state === 'syn-sent') {
      st.bad += 1;
      if (st.bad >= 2 && !st.warned) {
        st.warned = true;
        publish('WARN', `${c.proc} cannot reach ${c.host}:${c.port} - SYN-SENT with no reply over two checks ` +
                        '(the port is filtered/dropped or the service is down)',
                { change: 'stuck', proc: c.proc, host: c.host, port: c.port });
      }
    } else if (c.state === 'established' && st.warned) {
      publish('INFO', `${c.proc} reached ${c.host}:${c.port} - recovered`,
              { change: 'stuck', proc: c.proc, host: c.host, port: c.port });
      st.bad = 0; st.warned = false;
    } else {
      st.bad = 0;
    }
    state.set(k, st);
  }
  // Forget sockets that are gone, so a later reuse alarms fresh.
  for (const k of [...state.keys()]) if (!live.has(k)) state.delete(k);
}

// ------------------------------------------------------------------ main

async function tick() {
  const conns = parseConns(await rawConns());
  await resolveNames(conns.map((c) => c.host));
  const syn = conns.filter((c) => c.state === 'syn-sent').length;
  publish('DEBUG', `${conns.length} connection(s)${syn ? `, ${syn} stuck (SYN-SENT)` : ''}`,
          { tree: JSON.stringify(buildTree(conns)), connections: conns.length, stuck: syn });
  if (!baselined) {
    for (const c of conns) seenEndpoints.add(`${c.proc}->${c.host}`);   // silent baseline
    baselined = true;
  } else {
    diff(conns);
  }
}

const main = async () => {
  await resolveRemoteHost();                     // real hostname, not the ssh alias
  await tick();
  await flush();
  if (once) process.exit(0);
  setInterval(async () => { await tick(); await flush(); }, intervalS * 1000);
  console.error(`superlog-connections: ${topic} every ${intervalS}s${dest ? ` (via ssh ${dest})` : ''} -> ${hubUrl}`);
};

void main();
