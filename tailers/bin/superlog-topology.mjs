#!/usr/bin/env node
//
//  superlog-topology - the network as a tree, and a route kept under watch.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Two questions a flat log never answers. First, "what is on my network and
//  how does it hang together" - this host, its gateway, and the devices under
//  it, as a TREE you can read at a glance rather than a scroll of ARP lines.
//  Second, "is the path to that server still the path it was" - a route held
//  under continuous watch, so a reroute or a path going bad is an event with a
//  timestamp instead of something you reconstruct after the incident.
//
//    superlog-topology                         # this machine's LAN, as a tree
//    superlog-topology --discover              # ping-sweep the /24 so ALL devices show
//    superlog-topology --to 1.1.1.1            # + watch the route to a target
//    superlog-topology --to api.example.com --to 8.8.8.8
//    superlog-topology --ssh client1 --to server.example.com   # route FROM a client
//    superlog-topology --once                  # print the tree (and routes) once
//
//  Addresses carry a reverse-DNS name where one resolves (most useful on the
//  public route hops). The LAN tree is the ARP table - only devices this
//  machine has talked to - unless --discover sweeps the subnet to find the
//  rest; the sweep sends one ping per host, so it is opt-in by design.
//
//  Publishes the LAN tree to net.<host>.topology and each watched route to
//  net.<host>.route.<target>. Structure and per-hop RTT are DEBUG `metric`
//  readings - always there for the window and the chart, out of a default INFO
//  view. Only the meaningful, STABLE route changes are edge-triggered
//  WARN/ERROR (with recovery): a target going unreachable, a path length that
//  changes and stays changed, a near hop's latency crossing a threshold.
//
//  Why not diff the whole hop list every poll: ECMP load-balances legitimately
//  across parallel paths, so two back-to-back traceroutes to one destination
//  differ in the middle for no reason worth an alarm. Diffing that teaches
//  muting. So the deep middle is charted, never alarmed; the alarms are only
//  the things that are both stable and mean something.
//
//  It does NOT re-announce new LAN devices or gateway-MAC changes - superlog-
//  netstate already owns those judgments; running both is not double alarms.
//
//  macOS and Linux are the intended platforms; --ssh drives a POSIX remote
//  with nothing installed on it (traceroute/ip/arp shipped in the probe). A
//  local Windows branch (arp -a, route print, tracert) is written but
//  unverified on this bench. Zero dependency, Node >= 18.
//

import { execFile } from 'node:child_process';
import { promises as dnsp } from 'node:dns';
import { hostname, networkInterfaces, platform } from 'node:os';
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
  console.error(`superlog-topology - the local network as a tree, plus route monitoring

  superlog-topology [--once] [--interval 30] [--discover] [--discover-interval 300]
                    [--to TARGET]... [--route-interval 45] [--rtt-warn MS]
                    [--geo] [--no-dns] [--name LABEL] [--ssh DEST]
                    [--identity KEY] [--ssh-port N] [--url HUB]

By default it reads the LOCAL network and reports to the LOCAL hub. Off-machine
lookups are controlled: reverse-DNS names use the system resolver (--no-dns to
disable); --geo labels public hops with their AS/owner (and country when known)
via RIPE; --discover ping-sweeps the /24. --geo and --discover are opt-in.

Publishes the LAN tree to net.<host>.topology and each watched route to
net.<host>.route.<target>. Structure and per-hop RTT are DEBUG metric readings;
only stable, meaningful route changes are edge-triggered WARN/ERROR (a target
going unreachable, a sustained path-length change, a near-hop latency edge) -
the deep middle is charted, never alarmed, because ECMP makes it churn.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const mac = platform() === 'darwin';
const win = platform() === 'win32';
const dest = opt('ssh');
const once = args.includes('--once');
const intervalS = Number(opt('interval', 30)) || 30;
const routeIntervalS = Number(opt('route-interval', 45)) || 45;
// A near hop or a target over this round-trip is a WARN. Deliberately loose:
// a busy path is not a broken one, and only the near, stable hops are judged.
const rttWarn = Number(opt('rtt-warn', 250)) || 250;
// The ARP table only holds devices this machine has TALKED TO. --discover
// ping-sweeps the local /24 to populate it, so the tree shows the whole
// subnet, not just what we happened to have spoken with. Opt-in, because a
// sweep sends a packet to every host - a deliberate act on someone's network,
// not a default.
const discover = args.includes('--discover');
const discoverIntervalS = Number(opt('discover-interval', 300)) || 300;
// --geo labels PUBLIC hops with their owning network (AS + holder) and a
// country when it is actually known. Opt-in: it sends each public hop IP to
// RIPE's registry (the same source dns --asn uses), which is a deliberate
// outbound lookup, not a default. Honest limit: backbone/anycast IPs often
// have no usable country - the registry returns "?" - so country is shown only
// when real, and the reliable half is the AS/owner, not a dot on a map.
const wantGeo = args.includes('--geo');
// Security posture: by default this tailer reads the LOCAL network and reports
// to the LOCAL hub. The only lookup that reaches off the machine by default is
// reverse-DNS, and only to the system resolver this machine already trusts (as
// traceroute does) - disable it with --no-dns. --geo (to RIPE) and --discover
// (onto the LAN) are both opt-in. Nothing here phones a vendor.
const wantDns = !args.includes('--no-dns');
// Reverse DNS turns 108.162.250.5 into a name you can read. Cheap and useful
// on the public route hops; on a LAN it only pays off when the network runs a
// reverse zone (many don't), so a bare address there is not a failure.

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'host';
// --name overrides the host label in the topic and the tree root. Its reason
// for existing is a clean screenshot: a real hostname is often one you would
// rather not publish, so `--name devbox` renders a shareable view.
// Default to the ssh alias, but resolve the box's REAL hostname at startup (see
// resolveRemoteHost) so a box is ONE identity - reached over ssh, self-reporting
// or bridged - instead of showing as both its real hostname and its ssh alias.
let host = opt('name') ? sanitize(opt('name'))
         : dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest)
                : sanitize(hostname().split('.')[0]);
const localPlatform = win ? 'windows' : mac ? 'macos' : 'linux';
const targets = optAll('to');

// ------------------------------------------------------------- publishing

const session = randomBytes(4).toString('hex');
const buf = new Map();      // topic -> [ndjson lines]
let seq = 0;

function publish(topic, level, msg, fields, metric, trace) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'topology', platform: localPlatform, device: host },
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
  for (const [topic, lines] of buf) {
    if (!lines.length) continue;
    const body = lines.join('\n');
    buf.set(topic, []);
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
      });
    } catch { /* hub down; the next batch counts again */ }
  }
}

// ---------------------------------------------------------------- running

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];

// A collector produces SOME text; the parsers below accept any of the formats
// it might be, so the source (local macOS/Linux/Windows, or a POSIX remote
// over ssh) does not change the parsing. Errors become '' - a missing tool is
// a fact, never a crash.
async function execText(cmd, argv) {
  try { return (await run(cmd, argv, { timeout: 12000 })).stdout; }
  catch { return ''; }
}
async function sshText(remoteCmd) {
  try { return (await run('ssh', [...SSH_BASE, dest, remoteCmd], { timeout: 15000 })).stdout; }
  catch { return ''; }
}
// The box's own short hostname, so its identity does not depend on the ssh
// alias used to reach it (which is what made one box show up as two).
async function resolveRemoteHost(fallback) {
  const out = await sshText('hostname -s 2>/dev/null || hostname 2>/dev/null');
  const h = sanitize(out.split('\n')[0].trim());
  return h || fallback;
}

// Each collector: a POSIX one-liner for the remote (tries Linux then macOS
// forms), and the platform-native command for local.
async function rawNeighbours() {
  if (dest) return sshText('ip neigh 2>/dev/null || arp -an 2>/dev/null');
  if (win) return execText('arp', ['-a']);
  if (mac) return execText('arp', ['-an']);
  return (await execText('ip', ['neigh'])) || execText('arp', ['-an']);
}
async function rawGateway() {
  if (dest) return sshText('ip route show default 2>/dev/null || route -n get default 2>/dev/null');
  if (win) return execText('route', ['print', '0.0.0.0']);
  if (mac) return execText('route', ['-n', 'get', 'default']);
  return (await execText('ip', ['route', 'show', 'default'])) || execText('route', ['-n', 'get', 'default']);
}
async function rawHops(target) {
  if (dest) return sshText(`traceroute -n -w 2 -q 1 -m 20 ${target} 2>/dev/null`);
  if (win) return execText('tracert', ['-d', '-w', '2000', '-h', '20', target]);
  return execText('traceroute', ['-n', '-w', '2', '-q', '1', '-m', '20', target]);
}

// ---------------------------------------------------------------- parsing
//
// Format-tolerant on purpose: one parser for `ip neigh`, `arp -an` (macOS/BSD)
// and `arp -a` (Windows), so a remote box's output parses the same as a local
// one. A reading we cannot make is absent, never a zero or an invented node.

function parseNeighbours(text) {
  const out = new Map(); // ip -> { mac, iface }
  for (const line of text.split('\n')) {
    // Linux `ip neigh`:  192.168.1.1 dev en0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
    let m = /^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+).*?lladdr\s+([0-9a-fA-F:]{11,17})/.exec(line);
    if (m) { out.set(m[1], { mac: m[3].toLowerCase(), iface: m[2] }); continue; }
    // BSD/macOS `arp -an`:  ? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ...
    m = /\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-fA-F:]{11,17})(?:\s+on\s+(\S+))?/.exec(line);
    if (m) { out.set(m[1], { mac: m[2].toLowerCase(), iface: m[3] }); continue; }
    // Windows `arp -a`:    192.168.1.1        aa-bb-cc-dd-ee-ff     dynamic
    m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})\s/.exec(line);
    if (m) { out.set(m[1], { mac: m[2].toLowerCase().replace(/-/g, ':'), iface: undefined }); continue; }
  }
  return out;
}

function parseGateway(text) {
  // Linux `ip route`:   default via 192.168.1.1 dev en0 ...
  let m = /default via (\d+\.\d+\.\d+\.\d+) dev (\S+)/.exec(text);
  if (m) return { gw: m[1], ifc: m[2] };
  // macOS `route -n get default`:  gateway: 192.168.1.1 \n interface: en0
  const gw = /gateway: (\d+\.\d+\.\d+\.\d+)/.exec(text)?.[1];
  const ifc = /interface: (\S+)/.exec(text)?.[1];
  if (gw) return { gw, ifc: ifc ?? undefined };
  // Windows `route print 0.0.0.0`:  0.0.0.0  0.0.0.0  192.168.1.1  192.168.1.20  25
  m = /\b0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/.exec(text);
  if (m) return { gw: m[1], ifc: undefined };
  return null;
}

function parseHops(text) {
  const hops = [];
  for (const line of text.split('\n')) {
    // Unix traceroute:  " 3  10.0.0.1  4.123 ms"  (or " 3  * * *")
    let m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pos = Number(m[1]);
    const rest = m[2];
    if (/^\s*\*/.test(rest) && !/\d+\.\d+\.\d+\.\d+/.test(rest)) {
      hops.push({ pos, addr: undefined, rtt: undefined });   // an opaque hop, kept as such
      continue;
    }
    const addr = /(\d+\.\d+\.\d+\.\d+)/.exec(rest)?.[1];
    const rtt = Number(/([\d.]+)\s*ms/.exec(rest)?.[1] ?? NaN);
    hops.push({ pos, addr, rtt: Number.isFinite(rtt) ? rtt : undefined });
  }
  // Windows tracert numbers hops the same way; the RTT columns precede the
  // address, and the regex above takes the first "N ms" it sees - good enough
  // for the near-hop and reachability judgments we actually alarm on.
  return hops;
}

// ------------------------------------------------------ reverse DNS + sweep

const rdns = new Map();          // ip -> resolved name | '' (tried, none)
const resolvable = (ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) &&
  !ip.startsWith('169.254.') && !ip.startsWith('224.') && !ip.startsWith('239.') &&
  !ip.endsWith('.255') && ip !== '255.255.255.255' && ip !== '0.0.0.0';

// A public, routable unicast address - the only kind an AS/geo lookup means
// anything for. Private, CGNAT, link-local, loopback and multicast are skipped.
const isPublic = (ip) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;   // CGNAT
  if (a >= 224) return false;                            // multicast + reserved
  return true;
};

// --geo: AS + owning network (reliable) and a country when the registry
// actually knows it (often it does not for backbone IPs - shown only when
// real). Cached hard - an IP's AS does not change between polls - and never
// throws. RIPE is the same source dns --asn uses; no token, HTTPS, polite.
const geo = new Map();            // ip -> "AS13335 Cloudflare · DE" | ''
async function ripe(call, ip) {
  const res = await Promise.race([
    fetch(`https://stat.ripe.net/data/${call}/data.json?resource=${ip}`),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
  ]);
  return res.json();
}
async function resolveGeo(ips) {
  if (!wantGeo) return;
  await Promise.all([...new Set(ips)].filter((ip) => ip && isPublic(ip) && !geo.has(ip))
    .map(async (ip) => {
      geo.set(ip, '');
      try {
        const [asJson, geoJson] = await Promise.all([
          ripe('prefix-overview', ip), ripe('maxmind-geo-lite', ip),
        ]);
        const as = asJson?.data?.asns?.[0];
        let label = '';
        if (as?.asn) {
          const h = String(as.holder || '');
          const nice = (h.includes(' - ') ? h.split(' - ')[1] : h).split(',')[0].trim();
          label = `AS${as.asn}${nice ? ` ${nice}` : ''}`;
        }
        const loc = geoJson?.data?.located_resources?.[0]?.locations?.[0];
        const cc = loc && loc.country && loc.country !== '?' ? loc.country : '';
        const place = cc ? (loc.city ? `${loc.city}, ${cc}` : cc) : '';
        geo.set(ip, [label, place].filter(Boolean).join(' · '));
      } catch { /* registry slow or down - the label is simply absent */ }
    }));
}
const geoOf = (ip) => geo.get(ip) || '';

// Resolve a batch, cached and time-boxed, and never throw: a name we cannot get
// is simply absent (the house rule - an address with no name is a fact, not an
// error). Populates the cache; the tree builders read it synchronously.
async function resolveNames(ips) {
  if (!wantDns) return;
  await Promise.all([...new Set(ips)].filter((ip) => ip && resolvable(ip) && !rdns.has(ip))
    .map(async (ip) => {
      rdns.set(ip, '');                          // claim it, so it isn't resolved twice
      try {
        const names = await Promise.race([
          dnsp.reverse(ip),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
        ]);
        // Some ISPs set placeholder PTRs (undefined.hostname.localhost, ...);
        // a name that resolves to localhost/unknown is noise, not a name.
        const nm = Array.isArray(names) && names[0] ? names[0] : '';
        if (nm && !/(^|\.)localhost$|\b(unknown|undefined)\b/i.test(nm)) rdns.set(ip, nm);
      } catch { /* no PTR, or slow - leave it '' */ }
    }));
}
const nameOf = (ip) => rdns.get(ip) || '';

// Ping-sweep the local /24 to fill the ARP table. One packet per host, bounded
// concurrency, every failure swallowed - the point is the ARP side effect, not
// the ping result. --ssh is not swept (that would need ping on the remote).
async function sweep() {
  if (dest) return;
  const gw = parseGateway(await rawGateway());
  if (!gw?.gw) return;
  const base = gw.gw.replace(/\.\d+$/, '.');
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(base + i);
  const argvFor = (ip) => win ? ['-n', '1', '-w', '400', ip]
                        : mac ? ['-c', '1', '-t', '1', ip]
                              : ['-c', '1', '-W', '1', ip];
  let idx = 0;
  const worker = async () => {
    while (idx < ips.length) {
      const ip = ips[idx++];
      try { await run('ping', argvFor(ip), { timeout: 1500 }); } catch { /* unreachable is fine */ }
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
}

// -------------------------------------------------------------- the trees

const seenMacs = new Set();     // first-sight set, filled silently at baseline
let baselined = false;

function buildLanTree(gw, neigh) {
  const nodeFor = (ip, info) => {
    const nm = nameOf(ip);
    const g = geoOf(ip);
    const parts = [nm ? `${ip} (${nm})` : ip];
    if (info.mac) parts.push(info.mac);
    if (info.iface) parts.push(info.iface);
    if (g) parts.push(`[${g}]`);
    if (baselined && info.mac && !seenMacs.has(info.mac)) parts.push('(new)');
    return { name: parts.join('  ') };
  };
  const downstream = [];
  for (const [ip, info] of neigh) {
    if (gw && ip === gw.gw) continue;             // the gateway is the parent, not a leaf
    downstream.push(nodeFor(ip, info));
  }
  downstream.sort((a, b) => a.name.localeCompare(b.name));
  // This machine's own addresses - the root had a name but no IP. Only local
  // (not --ssh, where we don't hold the remote's interface list).
  const myIps = dest ? [] : [...new Set(Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address))];
  const root = {
    name: `${host}${dest ? '' : ' (this machine)'}${myIps.length ? `  ${myIps.join(', ')}` : ''}`,
    children: [],
  };
  if (gw) {
    const gwMac = neigh.get(gw.gw)?.mac;
    const gwName = nameOf(gw.gw);
    root.children.push({
      name: `gateway ${gw.gw}${gwName ? ` (${gwName})` : ''}${gwMac ? `  ${gwMac}` : ''}` +
            `${gw.ifc ? `  via ${gw.ifc}` : ''}`,
      children: downstream,
    });
  } else {
    root.children.push({ name: 'no default gateway - nothing off this machine is reachable' });
    root.children.push(...downstream);
  }
  return root;
}

function buildRouteTree(target, hops) {
  return {
    name: `route to ${target} (${hops.length} hop${hops.length === 1 ? '' : 's'})`,
    children: hops.map((h) => {
      const nm = h.addr ? nameOf(h.addr) : '';
      const g = h.addr ? geoOf(h.addr) : '';
      const who = h.addr ? (nm ? `${h.addr} (${nm})` : h.addr) : '* * *';
      return { name: `${h.pos}. ${who}${g ? `  [${g}]` : ''}${h.rtt !== undefined ? `  ${h.rtt}ms` : ''}` };
    }),
  };
}

// ------------------------------------------------------- the LAN topology

async function topologyTick() {
  const [gwText, arpText] = await Promise.all([rawGateway(), rawNeighbours()]);
  const gw = parseGateway(gwText);
  const neigh = parseNeighbours(arpText);

  if (!baselined) {
    for (const info of neigh.values()) if (info.mac) seenMacs.add(info.mac);
  }

  const ips = [...neigh.keys(), gw?.gw];
  await Promise.all([resolveNames(ips), resolveGeo(ips)]);
  const tree = buildLanTree(gw, neigh);
  // The tree is a structural reading: DEBUG, so it stays out of a default INFO
  // view while the topology window (which reads every level off the firehose)
  // always has the current shape, and the hub's replay ring hands it to a
  // window that connects late.
  publish(`net.${host}.topology`, 'DEBUG',
          `${neigh.size} device(s)${gw ? `, gateway ${gw.gw}` : ', no gateway'}`,
          { tree: JSON.stringify(tree), devices: neigh.size, gateway: gw?.gw });

  // Fill the first-sight set only after the baseline is published, so a "(new)"
  // marker means new since we started, not new to the world.
  if (!baselined) { baselined = true; }
  else for (const info of neigh.values()) if (info.mac) seenMacs.add(info.mac);
}

// ----------------------------------------------------------- route watch
//
// Per target: per-hop RTT and the path shape are readings; the alarms are only
// the stable, meaningful facts, each behind a two-strikes window so a single
// unlucky poll never speaks.

const routeState = new Map();  // target -> { badReach, unreachable, len, lenPending, rtt }

function crossing(topic, key, now, prev, msgs, trace) {
  if (now === prev) return;
  const [level, msg] = msgs[now];
  publish(topic, level, msg, { change: key, from: prev, to: now }, undefined, trace);
}

async function routeTick(target) {
  const topic = `net.${host}.route.${sanitize(target)}`;
  const hops = parseHops(await rawHops(target));
  const hopIps = hops.map((h) => h.addr);
  await Promise.all([resolveNames(hopIps), resolveGeo(hopIps)]);
  const st = routeState.get(target) ?? { badReach: 0, unreachable: false, len: null, lenPending: null, rtt: 'ok' };

  // Readings: the path shape, and each hop's RTT. Charting the noisy middle is
  // fine - a chart absorbs the ECMP jitter an alarm cannot.
  publish(topic, 'DEBUG', `route to ${target}: ${hops.length} hops`,
          { tree: JSON.stringify(buildRouteTree(target, hops)), target, hops: hops.length });
  for (const h of hops)
    if (h.rtt !== undefined)
      publish(topic, 'DEBUG', `hop ${h.pos} ${h.addr ?? ''} ${h.rtt}ms`,
              { target, hop: h.pos, addr: h.addr }, { name: 'net.route.hop_rtt_ms', value: h.rtt });

  const responding = hops.filter((h) => h.addr !== undefined);
  const last = responding[responding.length - 1];
  const reached = !!last && last.addr === target;   // target answered as itself
  // "reachable" is: we got answers and the last answer is the target, OR we got
  // answers at all and the target is a hostname (we can't match the name to an
  // IP without a resolver, so a responding tail counts). Unreachable = no hop
  // answered at all across the whole path.
  const anyAnswer = responding.length > 0;

  // Reachability - the one alarm that has nothing to do with middle-hop churn.
  if (!anyAnswer) {
    st.badReach += 1;
    if (st.badReach >= 2 && !st.unreachable) {
      st.unreachable = true;
      const trace = randomBytes(8).toString('hex');
      publish(topic, 'ERROR', `route to ${target} is UNREACHABLE - no hop answered over two checks`,
              { target, change: 'reachability' }, undefined, trace);
    }
  } else {
    if (st.unreachable) {
      st.unreachable = false;
      publish(topic, 'INFO', `RECOVERED: route to ${target} answers again (${responding.length} hops responding)`,
              { target, change: 'reachability' });
    }
    st.badReach = 0;

    // Path length changed AND stayed changed: a reroute, not ECMP jitter.
    const len = responding.length;
    if (st.len === null) {
      st.len = len;
    } else if (len !== st.len) {
      if (st.lenPending === len) {
        publish(topic, 'WARN', `route to ${target} changed length ${st.len} -> ${len} hops (held two checks) - a reroute`,
                { target, change: 'path-length', from: st.len, to: len });
        st.len = len;
        st.lenPending = null;
      } else {
        st.lenPending = len;        // first sighting; wait for a second before speaking
      }
    } else {
      st.lenPending = null;
    }

    // Near-hop / end-to-end latency: judge only a stable value.
    const endRtt = reached ? last.rtt : responding[0]?.rtt;   // target's own RTT, else the first hop's
    if (endRtt !== undefined) {
      const now = endRtt >= rttWarn ? 'warn' : 'ok';
      crossing(topic, 'latency', now, st.rtt, {
        warn: ['WARN', `route to ${target}: ${reached ? 'round trip' : 'first hop'} ${endRtt}ms (over ${rttWarn}ms)`],
        ok: ['INFO', `route to ${target}: latency back under ${rttWarn}ms at ${endRtt}ms`],
      });
      st.rtt = now;
    }
  }

  routeState.set(target, st);
  await flush();
}

// ------------------------------------------------------------------ main

async function inventory() {
  await topologyTick();
  for (const t of targets) {
    const hops = parseHops(await rawHops(t));
    const hopIps = hops.map((h) => h.addr);
    await Promise.all([resolveNames(hopIps), resolveGeo(hopIps)]);
    publish(`net.${host}.route.${sanitize(t)}`, 'INFO',
            `route to ${t}: ${hops.length} hops`,
            { tree: JSON.stringify(buildRouteTree(t, hops)), target: t });
  }
  await flush();
}

const main = async () => {
  if (dest && !opt('name')) host = await resolveRemoteHost(host);   // real name, not the ssh alias
  if (once) {
    if (discover) await sweep();
    await inventory();
    process.exit(0);
  }

  if (discover) {
    await sweep();                               // fill the ARP table before the first tree
    setInterval(async () => { await sweep(); await topologyTick(); await flush(); },
                discoverIntervalS * 1000);
  }
  await topologyTick();
  await flush();
  setInterval(async () => { await topologyTick(); await flush(); }, intervalS * 1000);

  for (const t of targets) {
    void routeTick(t);
    setInterval(() => void routeTick(t), routeIntervalS * 1000);
  }

  console.error(`superlog-topology: net.${host}.topology every ${intervalS}s` +
    (targets.length ? `, routes ${targets.join(', ')} every ${routeIntervalS}s` : '') +
    (dest ? ` (via ssh ${dest})` : '') + ` -> ${hubUrl}`);
};

void main();
