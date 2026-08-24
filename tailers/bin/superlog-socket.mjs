#!/usr/bin/env node
//
//  superlog-socket - a plain socket inlet, and a syslog server.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Every SDK here speaks HTTP, which is fine for anything running code you
//  wrote. It is no use at all for the other half of a bench: a router, a
//  switch, a NAS, a printer, a firewall, an appliance, a Linux box you are
//  not going to install anything on. None of those will ever run an SDK,
//  and all of them already speak syslog.
//
//    superlog-socket --udp 5514                  # syslog, the usual way
//    superlog-socket --tcp 5515                  # line-delimited TCP
//    superlog-socket --udp 5514 --bind 0.0.0.0   # ...to the LAN, deliberately
//
//  Then point anything at it:
//
//    logger -n 127.0.0.1 -P 5514 "hello from logger(1)"
//    echo "a line" | nc 127.0.0.1 5515
//    *.*  @192.168.1.10:5514           # in rsyslog.conf on any Linux box
//
//  Publishes to syslog.<host>.<app> for syslog, socket.<host>.<peer>
//  otherwise. Three framings are accepted on the same port, because a device
//  will send what it sends and arguing with it is not an option:
//
//    - RFC 5424 and RFC 3164 syslog, with the priority decoded into a level
//    - a super-log NDJSON event, passed through as-is (the tolerant-reader
//      rule: if a producer already speaks the protocol, do not re-wrap it)
//    - anything else, as a plain line
//
//  It binds LOOPBACK by default. The hub has no authentication, and a log
//  sink listening on every interface is an open relay into the one screen
//  everyone on the bench is watching - exposure has to be a choice, so
//  --bind 0.0.0.0 is a thing you type. Ports default above 1024 so it never
//  needs root, and 514 is available if you ask for it and can grant it.
//
//  Node >= 18.
//

import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-socket - syslog and plain-socket inlet

  superlog-socket [--udp PORT] [--tcp PORT] [--bind ADDR] [--topic NAME]
                  [--level LEVEL] [--max-rate N] [--url HUB]

  superlog-socket --udp 5514
  logger -n 127.0.0.1 -P 5514 "hello"

Accepts RFC 5424 / RFC 3164 syslog, super-log NDJSON, or plain lines, on the
same port. Publishes to syslog.<host>.<app> or socket.<host>.<peer>.
Binds 127.0.0.1 unless --bind says otherwise - the hub has no auth.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const udpPort = opt('udp', env.SUPER_LOG_SOCKET_UDP ?? '');
const tcpPort = opt('tcp', env.SUPER_LOG_SOCKET_TCP ?? '');
const bind = opt('bind', env.SUPER_LOG_SOCKET_BIND ?? '127.0.0.1');
const fixedTopic = opt('topic', '');
const defaultLevel = (opt('level', 'INFO') || 'INFO').toUpperCase();
// One misbehaving device must not be able to fill the bench. Bounded, and
// what is refused is counted and said out loud.
const maxRate = Number(opt('max-rate', '500'));

if (!udpPort && !tcpPort) {
  console.error('superlog-socket: give --udp PORT and/or --tcp PORT');
  process.exit(2);
}

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 48) || 'unknown';
const host = sanitize(hostname().split('.')[0]);

// ---------------------------------------------------------------- syslog
//
// PRI = facility * 8 + severity. The severities are the one part of syslog
// every implementation agrees on, so they are what the level comes from -
// not the text, which every vendor writes differently.

const SEVERITY = ['CRITICAL', 'CRITICAL', 'CRITICAL', 'ERROR',
                  'WARN', 'INFO', 'INFO', 'DEBUG'];
const FACILITY = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr',
                  'news', 'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit',
                  'alert', 'clock', 'local0', 'local1', 'local2', 'local3',
                  'local4', 'local5', 'local6', 'local7'];

// RFC 5424: <34>1 2026-08-24T04:12:00Z host app 1234 ID - message
const RFC5424 = /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (?:\[.*?\]|-) ?(.*)$/s;
// RFC 3164: <34>Aug 24 04:12:00 host app[1234]: message
const RFC3164 = /^<(\d{1,3})>(\w{3} +\d+ [\d:]+) (\S+) ([^:[\s]+)(?:\[(\d+)\])?: ?(.*)$/s;
// Bare priority, which plenty of appliances send and nothing else parses.
const BARE_PRI = /^<(\d{1,3})>(.*)$/s;

function parseSyslog(line) {
  let m = RFC5424.exec(line);
  if (m) {
    const pri = Number(m[1]);
    return { pri, host: m[3] === '-' ? '' : m[3], app: m[4] === '-' ? '' : m[4],
             pid: m[5] === '-' ? '' : m[5], msg: m[7], rfc: '5424' };
  }
  m = RFC3164.exec(line);
  if (m) {
    const pri = Number(m[1]);
    return { pri, host: m[3], app: m[4], pid: m[5] ?? '', msg: m[6], rfc: '3164' };
  }
  m = BARE_PRI.exec(line);
  if (m) return { pri: Number(m[1]), host: '', app: '', pid: '', msg: m[2], rfc: 'bare' };
  return null;
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();     // topic -> lines
let seq = 0;
let inWindow = 0;
let refused = 0;

setInterval(() => {
  if (refused) {
    publish(`socket.${host}.control`, 'WARN',
            `${refused} message(s) refused this second (rate cap ${maxRate}/s)`,
            { change: 'rate-limited', count: String(refused) });
    refused = 0;
  }
  inWindow = 0;
}, 1000).unref?.();

function publish(topic, level, msg, fields, tag) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'socket', app: tag || 'socket', platform: 'net', device: host },
    ...(tag ? { tag } : {}), msg, ...(fields ? { fields } : {}),
  }));
}

/** A producer that already speaks the protocol is forwarded verbatim - the
 *  tolerant-reader rule cuts both ways, and re-wrapping an event would bury
 *  its own level, trace and fields inside a string. */
function passthrough(topic, line) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(line);
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
setInterval(() => void flush(), 250).unref?.();

// ------------------------------------------------------------------ intake

function intake(line, peer, transport) {
  const text = line.replace(/\0+$/, '').trimEnd();
  if (!text) return;
  if (inWindow >= maxRate) { refused += 1; return; }
  inWindow += 1;

  // Already a super-log event? Forward it untouched.
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const o = JSON.parse(text);
      if (o && typeof o === 'object' && o.v === 1 && typeof o.msg === 'string') {
        passthrough(fixedTopic || `socket.${host}.${sanitize(peer)}`, text);
        return;
      }
    } catch { /* not JSON after all; fall through as a line */ }
  }

  const sl = parseSyslog(text);
  if (sl) {
    const level = SEVERITY[sl.pri & 7] ?? 'INFO';
    const facility = FACILITY[sl.pri >> 3] ?? String(sl.pri >> 3);
    const src = sanitize(sl.host || peer);
    const app = sanitize(sl.app || facility);
    publish(fixedTopic || `syslog.${src}.${app}`, level, sl.msg, {
      facility, severity: String(sl.pri & 7), transport,
      peer, ...(sl.pid ? { pid: sl.pid } : {}), rfc: sl.rfc,
    }, sl.app || undefined);
    return;
  }

  publish(fixedTopic || `socket.${host}.${sanitize(peer)}`, defaultLevel, text,
          { peer, transport });
}

// -------------------------------------------------------------- listeners

if (udpPort) {
  const sock = createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    // A datagram is one message by definition, but rsyslog will pack
    // several into one packet when forwarding a backlog.
    for (const line of msg.toString('utf8').split('\n')) intake(line, rinfo.address, 'udp');
  });
  sock.on('error', (e) => {
    console.error(`superlog-socket: udp ${udpPort}: ${e.message}`);
    process.exit(1);
  });
  sock.bind(Number(udpPort), bind, () =>
    console.error(`superlog-socket: syslog/udp on ${bind}:${udpPort}`));
}

if (tcpPort) {
  const server = createServer((sock) => {
    const peer = sock.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
    let carry = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() ?? '';
      // A peer that never sends a newline must not grow the buffer forever.
      if (carry.length > 65536) { intake(carry, peer, 'tcp'); carry = ''; }
      for (const l of lines) intake(l, peer, 'tcp');
    });
    sock.on('end', () => { if (carry.trim()) intake(carry, peer, 'tcp'); });
    sock.on('error', () => { /* a peer vanishing is normal */ });
  });
  server.on('error', (e) => {
    console.error(`superlog-socket: tcp ${tcpPort}: ${e.message}`);
    process.exit(1);
  });
  server.listen(Number(tcpPort), bind, () =>
    console.error(`superlog-socket: lines/tcp on ${bind}:${tcpPort}`));
}

if (bind === '0.0.0.0' || bind === '::')
  console.error('superlog-socket: WARNING - listening on all interfaces. ' +
                'The hub has no auth; anyone who can reach this port can write to the bench.');

process.on('SIGINT', async () => { await flush(); process.exit(130); });
process.on('SIGTERM', async () => { await flush(); process.exit(143); });
