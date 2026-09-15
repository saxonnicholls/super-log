#!/usr/bin/env node
//
//  superlog-netstate - the network's state, watched; changes, announced.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Half of "everything just broke" on a development bench is the network
//  moving underneath the developer: the VPN dropped, DHCP renumbered the
//  machine, the laptop hopped Wi-Fi, a captive portal swapped the DNS
//  resolvers, the router rebooted - and none of it says so anywhere. This
//  watches the state and says so, once per change:
//
//    - interfaces gaining/losing addresses (WARN on loss - every held
//      connection just died)
//    - the default gateway and its interface (WARN on change)
//    - the Wi-Fi SSID (INFO - "works at home, fails at the office")
//    - VPN tunnels up/down (utun/wg/tun with addresses; WARN on drop)
//    - the DNS resolver set (WARN - captive portals, split-DNS and
//      filtering resolvers live here)
//    - the ARP neighbourhood, with judgment: a NEW device is one INFO at
//      first sight, cache expiry is silence (reporting churn teaches
//      muting), and the GATEWAY's MAC changing is ERROR, because that is
//      a router swap or an ARP-spoofing MITM and both deserve the bench.
//
//  Plus path quality: --ping targets (the gateway rides along free), RTT
//  and loss as DEBUG metric readings, sustained loss as an edge-triggered
//  WARN/ERROR with recovery announced - and at the moment a target
//  crosses an edge, ONE traceroute runs and lands beside the alarm,
//  sharing its trace id: the alarm arrives carrying its own diagnosis.
//
//  First poll is a silent baseline; only changes are reported after it.
//  --once prints the current inventory instead, then exits.
//
//    superlog-netstate                       # watch, 15s state poll
//    superlog-netstate --ping 1.1.1.1 --ping api.example.com|30
//    superlog-netstate --once                # what does the network look like now
//
//  macOS is the verified platform; the Linux code paths (ip -j, ip
//  neigh, resolv.conf) are exercised by CI's --once run.
//

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const optAll = (name) => {
  const out = [];
  for (let i = 0; i < args.length - 1; i++)
    if (args[i] === `--${name}`) out.push(args[i + 1]);
  return out;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-netstate - the network's state, watched; changes, announced

  superlog-netstate [--once] [--interval 15] [--ping HOST[|SECONDS]]...
                    [--url HUB]

Publishes to net.<host>.state. First poll is a silent baseline; after that
only CHANGES are reported: interface addresses, default gateway, Wi-Fi
SSID, VPN tunnels, DNS resolvers, new LAN devices (gateway MAC change is
ERROR - that is how a MITM starts). --ping targets get RTT/loss metric
readings and edge-triggered degradation alarms with a traceroute attached
at the moment of failure. --once prints the inventory instead.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const intervalS = Number(opt('interval', 15)) || 15;
const once = args.includes('--once');
const mac = platform() === 'darwin';

const device = hostname().split('.')[0].toLowerCase();
const topic = `net.${device}.state`;
const session = randomBytes(4).toString('hex');
let seq = 0;
let lines = [];

function publish(level, msg, fields, metric, trace) {
  lines.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'netstate', platform: mac ? 'macos' : 'linux', device },
    tag: 'net', msg,
    ...(trace ? { trace } : {}),
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

const sh = async (cmd, argv) => {
  try { return (await run(cmd, argv, { timeout: 10000 })).stdout; }
  catch { return ''; }
};

// ------------------------------------------------------------ collectors
//
// Each returns a comparable snapshot piece. IPv6 temporary addresses
// rotate by design, so per-interface v6 is reduced to "has a global
// address" - announcing SLAAC privacy rotation would teach muting.

async function ifaces() {
  const out = new Map(); // name -> {v4: sorted csv, v6: bool}
  if (mac) {
    const text = await sh('ifconfig', ['-a']);
    let name = null, v4 = [], v6 = false;
    const commit = () => { if (name && !name.startsWith('lo')) out.set(name, { v4: v4.sort().join(','), v6 }); };
    for (const line of text.split('\n')) {
      const head = /^([a-z0-9]+):\s+flags/.exec(line);
      if (head) { commit(); name = head[1]; v4 = []; v6 = false; continue; }
      const inet = /^\s+inet (\d+\.\d+\.\d+\.\d+)/.exec(line);
      if (inet) v4.push(inet[1]);
      if (/^\s+inet6 (?!fe80)/.test(line)) v6 = true;
    }
    commit();
  } else {
    try {
      const j = JSON.parse(await sh('ip', ['-j', 'addr']));
      for (const it of j) {
        if (it.ifname?.startsWith('lo')) continue;
        const v4 = (it.addr_info ?? []).filter((a) => a.family === 'inet').map((a) => a.local);
        const v6 = (it.addr_info ?? []).some((a) => a.family === 'inet6' && a.scope === 'global');
        out.set(it.ifname, { v4: v4.sort().join(','), v6 });
      }
    } catch { /* no ip(8); the empty map compares as itself */ }
  }
  return out;
}

async function gateway() {
  if (mac) {
    const text = await sh('route', ['-n', 'get', 'default']);
    const gw = /gateway: (\S+)/.exec(text)?.[1] ?? null;
    const ifc = /interface: (\S+)/.exec(text)?.[1] ?? null;
    return gw ? { gw, ifc } : null;
  }
  const text = await sh('ip', ['route', 'show', 'default']);
  const m = /default via (\S+) dev (\S+)/.exec(text);
  return m ? { gw: m[1], ifc: m[2] } : null;
}

let wifiDev = null;
async function ssid() {
  if (mac) {
    if (wifiDev === null) {
      const ports = await sh('networksetup', ['-listallhardwareports']);
      wifiDev = /Hardware Port: Wi-Fi\nDevice: (\S+)/.exec(ports)?.[1] ?? '';
    }
    if (!wifiDev) return null;
    const text = await sh('networksetup', ['-getairportnetwork', wifiDev]);
    return /Current Wi-Fi Network: (.+)/.exec(text)?.[1]?.trim() ?? null;
  }
  return (await sh('iwgetid', ['-r'])).trim() || null;
}

async function dnsServers() {
  if (mac) {
    const text = await sh('scutil', ['--dns']);
    const seen = [];
    for (const m of text.matchAll(/nameserver\[\d+\] : (\S+)/g))
      if (!seen.includes(m[1])) seen.push(m[1]);
    return seen.join(',');
  }
  try {
    return readFileSync('/etc/resolv.conf', 'utf8').split('\n')
      .map((l) => /^nameserver\s+(\S+)/.exec(l)?.[1]).filter(Boolean).join(',');
  } catch { return ''; }
}

async function neighbours() {
  const out = new Map(); // ip -> mac
  if (mac) {
    const text = await sh('arp', ['-an']);
    for (const m of text.matchAll(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+) /gi))
      out.set(m[1], m[2].toLowerCase());
  } else {
    const text = await sh('ip', ['neigh']);
    for (const m of text.matchAll(/^(\d+\.\d+\.\d+\.\d+) .*lladdr ([0-9a-f:]+)/gim))
      out.set(m[1], m[2].toLowerCase());
  }
  return out;
}

const isVpnName = (n) => /^(utun|wg|tun|tap|ppp)/.test(n);

// --------------------------------------------------------- state diffing

let last = null;               // previous snapshot
const seenMacs = new Set();    // ARP first-sight set, per run
let lastGatewayMac = null;

async function snapshot() {
  const [ifs, gw, net, dns, arp] = await Promise.all(
    [ifaces(), gateway(), ssid(), dnsServers(), neighbours()]);
  const vpn = [...ifs.entries()].filter(([n, s]) => isVpnName(n) && (s.v4 || s.v6))
    .map(([n, s]) => `${n}${s.v4 ? ` ${s.v4}` : ''}`).sort().join(', ');
  return { ifs, gw, net, dns, arp, vpn };
}

function inventory(s) {
  for (const [n, st] of s.ifs)
    if (st.v4 || st.v6)
      publish('INFO', `${n}: ${st.v4 || '(no v4)'}${st.v6 ? ' +v6' : ''}`, { iface: n });
  publish('INFO', s.gw ? `default gateway ${s.gw.gw} via ${s.gw.ifc}` : 'NO default gateway',
          s.gw ? { gateway: s.gw.gw, iface: s.gw.ifc } : {});
  if (s.net) publish('INFO', `Wi-Fi: '${s.net}'`, { ssid: s.net });
  if (s.vpn) publish('INFO', `VPN up: ${s.vpn}`, {});
  publish('INFO', `DNS resolvers: ${s.dns || '(none)'}`, { resolvers: s.dns });
  publish('INFO', `${s.arp.size} device(s) in the ARP table`, {});
}

function diff(prev, cur) {
  for (const [n, st] of cur.ifs) {
    const was = prev.ifs.get(n);
    if (!was && (st.v4 || st.v6)) {
      publish('INFO', `${n} appeared with ${st.v4 || 'a v6 address'}`, { iface: n });
    } else if (was && was.v4 !== st.v4) {
      if (!st.v4)
        publish('WARN', `${n} lost its address (was ${was.v4}) - every held ` +
          'connection on it just died', { iface: n, was: was.v4 });
      else
        publish(was.v4 ? 'WARN' : 'INFO',
          `${n} address ${was.v4 ? `changed ${was.v4} -> ` : 'is '}${st.v4}` +
          (was.v4 ? ' - DHCP renumbered, held connections died' : ''),
          { iface: n, now: st.v4 });
    }
  }
  for (const [n, was] of prev.ifs)
    if (!cur.ifs.has(n) && (was.v4 || was.v6) && !isVpnName(n))
      publish('WARN', `${n} vanished (had ${was.v4 || 'v6'})`, { iface: n });

  const gwKey = (g) => (g ? `${g.gw}%${g.ifc}` : '');
  if (gwKey(prev.gw) !== gwKey(cur.gw)) {
    if (!cur.gw)
      publish('ERROR', `default gateway GONE (was ${prev.gw.gw} via ${prev.gw.ifc}) - ` +
        'nothing off this machine is reachable', {});
    else
      publish(prev.gw ? 'WARN' : 'INFO',
        `default gateway ${prev.gw ? `changed ${prev.gw.gw}(${prev.gw.ifc}) -> ` : 'is '}` +
        `${cur.gw.gw}(${cur.gw.ifc})`, { gateway: cur.gw.gw, iface: cur.gw.ifc });
    lastGatewayMac = null; // a new gateway legitimately has a new MAC
  }

  if (prev.net !== cur.net) {
    if (cur.net) publish('INFO', `Wi-Fi moved to '${cur.net}'${prev.net ? ` (was '${prev.net}')` : ''}`,
                         { ssid: cur.net });
    else if (prev.net) publish('WARN', `Wi-Fi left '${prev.net}'`, { was: prev.net });
  }

  if (prev.dns !== cur.dns)
    publish('WARN', `DNS resolvers changed: [${prev.dns || 'none'}] -> [${cur.dns || 'none'}] - ` +
      'captive portal, VPN split-DNS, or a filtering resolver',
      { was: prev.dns, now: cur.dns });

  if (prev.vpn !== cur.vpn) {
    if (cur.vpn && !prev.vpn) publish('INFO', `VPN up: ${cur.vpn}`, {});
    else if (!cur.vpn && prev.vpn)
      publish('WARN', `VPN DOWN (was ${prev.vpn}) - the next twenty failures are this event`, {});
    else publish('INFO', `VPN changed: ${prev.vpn} -> ${cur.vpn}`, {});
  }

  // ARP, with judgment: first sight of a MAC is one INFO; expiry is
  // silence; the gateway's MAC changing is the one that matters.
  for (const [ip, hw] of cur.arp) {
    if (!seenMacs.has(hw)) {
      seenMacs.add(hw);
      if (prev !== null) // not during baseline
        publish('INFO', `new device on the LAN: ${ip} at ${hw}`, { ip, mac: hw });
    }
  }
  const gwMac = cur.gw ? cur.arp.get(cur.gw.gw) : null;
  if (gwMac) {
    if (lastGatewayMac && gwMac !== lastGatewayMac)
      publish('ERROR', `gateway ${cur.gw.gw} changed MAC ${lastGatewayMac} -> ${gwMac} - ` +
        'router swap, or ARP spoofing (how a MITM starts)',
        { gateway: cur.gw.gw, was: lastGatewayMac, now: gwMac });
    lastGatewayMac = gwMac;
  }
}

// ------------------------------------------------------------------ ping
//
// RTT and loss are readings; degradation is an edge, said once and
// recovered once - and at the crossing, ONE traceroute runs and lands
// beside the alarm, sharing its trace id. The alarm carries its own
// diagnosis instead of asking the developer to go collect one.

const pings = optAll('ping').map((p) => {
  const [target, iv] = p.split('|');
  return { target: target.trim(), intervalS: Number(iv) || 30,
           bad: 0, degraded: false };
});

async function pingOnce(target) {
  const argv = mac ? ['-c', '3', '-q', '-t', '5', target]
                   : ['-c', '3', '-q', '-w', '5', target];
  try {
    const { stdout } = await run('ping', argv, { timeout: 12000 });
    const loss = Number(/([\d.]+)% packet loss/.exec(stdout)?.[1] ?? 100);
    const rtt = Number(/= [\d.]+\/([\d.]+)\//.exec(stdout)?.[1] ?? NaN);
    return { loss, rtt };
  } catch {
    return { loss: 100, rtt: NaN };
  }
}

async function tracerouteTo(target, trace, why) {
  const argv = ['-n', '-w', '2', '-q', '1', '-m', '20', target];
  const out = await sh('traceroute', argv);
  const hops = out.split('\n').filter((l) => /^\s*\d+/.test(l))
    .map((l) => l.trim()).join('\n').slice(0, 3000);
  publish('INFO', `path to ${target} (${why}):\n${hops || '(traceroute produced nothing)'}`,
          { target, why }, undefined, trace);
  await flush();
}

async function pollPing(p) {
  const { loss, rtt } = await pingOnce(p.target);
  if (Number.isFinite(rtt))
    publish('DEBUG', `${p.target} rtt =${rtt}ms loss =${loss}%`, { target: p.target },
            { name: 'net.rtt_ms', value: rtt });
  publish('DEBUG', `${p.target} loss =${loss}%`, { target: p.target },
          { name: 'net.loss_pct', value: loss });

  if (loss >= 50) {
    p.bad += 1;
    if (p.bad === 2 && !p.degraded) {
      p.degraded = true;
      const trace = randomBytes(8).toString('hex');
      publish(loss >= 100 ? 'ERROR' : 'WARN',
        `path to ${p.target} ${loss >= 100 ? 'is DOWN' : 'degraded'} - ` +
        `${loss}% loss over two checks; traceroute follows on this trace`,
        { target: p.target, loss }, undefined, trace);
      void tracerouteTo(p.target, trace, 'captured at failure');
    }
  } else {
    if (p.degraded) {
      p.degraded = false;
      const trace = randomBytes(8).toString('hex');
      publish('INFO', `RECOVERED: path to ${p.target} is clean again ` +
        `(${loss}% loss, ${rtt}ms); healthy path follows for comparison`,
        { target: p.target }, undefined, trace);
      void tracerouteTo(p.target, trace, 'healthy, for comparison');
    }
    p.bad = 0;
  }
  await flush();
}

// ------------------------------------------------------------------ main

const main = async () => {
  const s = await snapshot();
  if (once) {
    inventory(s);
    await flush();
    process.exit(0);
  }
  // Silent baseline: remember everything, announce nothing - a watcher
  // that recites the world on startup teaches muting. ARP first-sight
  // fills silently here too.
  last = s;
  for (const hw of s.arp.values()) seenMacs.add(hw);
  lastGatewayMac = s.gw ? s.arp.get(s.gw.gw) ?? null : null;

  // The gateway rides along as a free ping target on the state clock.
  if (s.gw && !pings.some((p) => p.target === s.gw.gw))
    pings.push({ target: s.gw.gw, intervalS: intervalS, bad: 0, degraded: false });

  setInterval(async () => {
    const cur = await snapshot();
    diff(last, cur);
    last = cur;
    await flush();
  }, intervalS * 1000);

  for (const p of pings) {
    void pollPing(p);
    setInterval(() => void pollPing(p), p.intervalS * 1000);
  }

  console.error(`superlog-netstate: ${topic} every ${intervalS}s` +
    (pings.length ? `, pinging ${pings.map((p) => p.target).join(', ')}` : '') +
    ` -> ${hubUrl}`);
};

void main();
