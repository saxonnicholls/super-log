#!/usr/bin/env node
//
//  demo/inlets/demo.mjs - the inlets, demonstrated without any hardware.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Three of the tools here look like they need equipment you have not got: a
//  router to send syslog, a board on a USB port, a WebSocket service. None
//  of them actually do, and a feature nobody can try is a feature nobody
//  believes. So this stands each one up against something local:
//
//    superlog-socket   <- real RFC 5424 and RFC 3164 datagrams, and a raw
//                         TCP line, sent by this script
//    superlog-serial   <- a pseudo-terminal, which is a character device in
//                         every way that matters, fed real ESP-IDF and
//                         Zephyr console output
//    superlog-ws       <- a WebSocket server this script runs, so no network
//                         and no account
//
//  Everything published lands on the same hub as every other stream, which
//  is the point being demonstrated.
//
//    npm run demo:inlets
//
//  Node >= 22 (global WebSocket), and a POSIX pty for the serial part -
//  Windows skips that one and says so.
//

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { platform } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const bin = (n) => resolve(here, '../../tailers/bin', n);
const hubUrl = process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const start = (script, args) => {
  const c = spawn(process.execPath, [bin(script), ...args, '--url', hubUrl],
                  { stdio: ['ignore', 'ignore', 'inherit'] });
  kids.push(c);
  return c;
};
const stopAll = () => { for (const c of kids) { try { c.kill(); } catch { /* gone */ } } };
process.on('SIGINT', () => { stopAll(); process.exit(130); });

async function hubUp() {
  try {
    const r = await fetch(`${hubUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

if (!await hubUp()) {
  console.error(`demo:inlets: no hub at ${hubUrl}. Start one with ./scripts/dev.sh`);
  process.exit(1);
}

// ---------------------------------------------------------------- syslog

console.log('\n\x1b[1msuperlog-socket\x1b[0m  syslog over UDP and a raw TCP line');
start('superlog-socket.mjs', ['--udp', '5514', '--tcp', '5515']);
await sleep(900);

// Real priorities: 34 = auth.crit, 11 = user.err, 86 = authpriv.info.
// The level comes from the priority, so these arrive as CRITICAL, ERROR and
// INFO without anyone parsing English.
const u = createSocket('udp4');
for (const m of [
  '<34>1 2026-08-24T04:12:00.003Z fw01 sshd 1234 ID47 - Failed password for root from 10.0.0.9',
  '<11>1 2026-08-24T04:12:01.000Z nas01 smbd - - - disk array degraded',
  '<86>Aug 24 04:12:02 router01 dhcpd[901]: lease 192.168.1.44 renewed',
]) {
  u.send(Buffer.from(m), 5514, '127.0.0.1');
  await sleep(120);
}
u.close();

await new Promise((done) => {
  const t = connect(5515, '127.0.0.1', () => {
    t.end('a plain line on a raw TCP socket, no syslog framing at all\n', done);
  });
  t.on('error', () => done());
});
console.log('  sent 3 syslog datagrams + 1 raw TCP line -> syslog.* and socket.*');

// ---------------------------------------------------------------- serial

console.log('\n\x1b[1msuperlog-serial\x1b[0m  a board, played by a pseudo-terminal');
if (platform() === 'win32') {
  console.log('  skipped: needs a POSIX pty');
} else if (!spawnSync('python3', ['-c', 'import pty']).status === 0) {
  console.log('  skipped: needs python3 with the pty module to create the device');
} else {
  // A pty IS a character device, so the tailer opens it exactly as it would
  // open /dev/tty.usbmodem1101 - stty and all. The only thing being faked
  // is which side the bytes came from.
  const feeder = spawn('python3', ['-c', `
import os, pty, sys, time
master, slave = pty.openpty()
sys.stdout.write(os.ttyname(slave) + "\\n"); sys.stdout.flush()
time.sleep(2.5)
for line in [
  b"ets Jul 29 2019 12:21:46\\r\\n",
  b"rst:0x1 (POWERON_RESET),boot:0x13\\r\\n",
  b"I (312) wifi: connected to bench-ap\\r\\n",
  b"W (402) power: battery low: 3.41V\\r\\n",
  b"E (501) mqtt: connect failed rc=-1\\r\\n",
  b"[00:00:12.345,678] <err> net_if: no route to host\\r\\n",
  b"Guru Meditation Error: Core 0 panic'ed (LoadProhibited)\\r\\n",
]:
    os.write(master, line); time.sleep(0.15)
time.sleep(2)
`], { stdio: ['ignore', 'pipe', 'ignore'] });
  kids.push(feeder);
  const port = await new Promise((res) => feeder.stdout.once('data', (d) => res(d.toString().trim())));
  console.log(`  pty at ${port}`);
  start('superlog-serial.mjs', ['--port', port, '--topic', 'serial.demo.board']);
  await sleep(4500);
  console.log('  fed ESP-IDF + Zephyr console output -> serial.demo.board');
  console.log('  (a panic arrives CRITICAL, a boot banner is tagged as a reset)');
}

// -------------------------------------------------------------------- ws

console.log('\n\x1b[1msuperlog-ws\x1b[0m  a WebSocket, served locally');
// Node has no built-in WebSocket SERVER, only a client, so this is a
// hand-rolled RFC 6455 handshake and a few text frames. Enough to prove the
// tool reads a real socket; not enough to be a WebSocket library.
const { createHash } = await import('node:crypto');
const srv = createServer();
srv.on('upgrade', (req, sock) => {
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
             `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let n = 0;
  const tick = setInterval(() => {
    const body = Buffer.from(JSON.stringify({ event: 'tick', n: ++n, ts: Date.now() }));
    const head = body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => {
          const b = Buffer.alloc(2); b.writeUInt16BE(body.length); return b; })()]);
    sock.write(Buffer.concat([head, body]));
    if (n >= 6) { clearInterval(tick); sock.end(); }
  }, 300);
  sock.on('error', () => clearInterval(tick));
});
await new Promise((r) => srv.listen(7459, '127.0.0.1', r));
start('superlog-ws.mjs', ['ws://127.0.0.1:7459/feed', '--summary', '3',
                          '--topic', 'ws.demo.local']);
await sleep(4000);
srv.close();
console.log('  served 6 frames over a real RFC 6455 socket -> ws.demo.local');

// ------------------------------------------------------------------ show

await sleep(1200);
stopAll();

console.log('\n\x1b[1mwhat arrived\x1b[0m');
const r = await fetch(`${hubUrl}/recent?topic=*&limit=400`);
const { events } = await r.json();
const want = (t) => t.startsWith('syslog.') || t.startsWith('socket.') ||
                    t.startsWith('serial.demo') || t.startsWith('ws.demo');
const byTopic = new Map();
for (const e of events) if (want(e.topic)) {
  if (!byTopic.has(e.topic)) byTopic.set(e.topic, []);
  byTopic.get(e.topic).push(e.event);
}
if (!byTopic.size) {
  console.log('  nothing - is the hub the one the inlets were pointed at?');
  process.exit(1);
}
for (const [t, evs] of [...byTopic].sort()) {
  console.log(`  \x1b[36m${t}\x1b[0m (${evs.length})`);
  for (const e of evs.slice(-2)) console.log(`      ${e.level.padEnd(8)} ${String(e.msg).slice(0, 62)}`);
}
console.log('\nAll of it is on the same viewer as the clocks, the builds and the OS log.');
process.exit(0);
