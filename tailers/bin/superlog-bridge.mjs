#!/usr/bin/env node
//
//  superlog-bridge - one bench out of many hubs.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A hub already rebroadcasts everything it ingests on /ws, so hubs
//  compose: subscribe to one, re-ingest into another, and the second bench
//  shows both machines' streams under their original topics. This is that
//  subscription. Payloads are relayed VERBATIM - same topics, same events,
//  byte for byte - so nothing downstream can tell a bridged stream from a
//  local one, which is the point.
//
//    superlog-bridge --ssh otherbench            # their loopback hub -> ours
//    superlog-bridge --from http://10.0.1.9:7333
//    superlog-bridge --ssh otherbench --topic 'os.'
//
//  --ssh is the honest default: it tunnels to the remote hub's LOOPBACK
//  port, so neither hub ever has to listen on the network - the same
//  posture as superlog-fleet, and the reason bridging is safe to leave
//  running. --from is for a hub already reachable directly.
//
//  One direction only. Bridging A into B and B into A is a cycle, and a
//  cycle of verbatim relays is a feedback loop that fills both rings with
//  the same events forever. Pick one bench to be the bench.
//
//  Reconnects like the viewers do; the hub replays recent history on
//  connect, so frames already relayed are skipped by source seq rather
//  than ingested twice.
//
//  Node >= 22 (global WebSocket).
//

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h') || (!opt('ssh') && !opt('from'))) {
  console.error(`superlog-bridge - relay another hub's feed into this one, verbatim

  superlog-bridge --ssh DEST [--from-port 7333] [--topic '*'] [--url TARGET]
  superlog-bridge --from http://host:7333 [--topic '*'] [--url TARGET]

--ssh tunnels to the remote hub's loopback port over ssh, so neither hub
listens on the network. Topics and events pass through unchanged.

One direction only: bridging two hubs at each other is a feedback loop.`);
  process.exit(opt('ssh') || opt('from') ? 0 : 2);
}

const env = loadEnv();
const target = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const dest = opt('ssh');
const from = opt('from');
const fromPort = Number(opt('from-port', '7333'));
const topic = opt('topic', '*');

// The one loop we can catch cheaply. An ssh tunnel to this same machine is
// the same mistake with more steps, but that one needs the operator to
// have typed it on purpose.
if (from && new URL(from).origin === new URL(target).origin) {
  console.error('superlog-bridge: source and target are the same hub - that is a feedback loop, not a bridge.');
  process.exit(2);
}

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ExitOnForwardFailure=yes', '-N',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- the tunnel

let tunnel = null;
let closed = false;

/** Resolve the source hub URL, holding an ssh tunnel open when the source
 *  is remote. The tunnel dying is normal life on a bench - a laptop lid, a
 *  network blip - so callers get a fresh URL each (re)connect and the
 *  tunnel is restarted here with backoff. */
async function sourceUrl(attempt) {
  if (from) return from;
  if (tunnel && tunnel.exitCode === null && tunnel.port) return `http://127.0.0.1:${tunnel.port}`;
  const port = await freePort();
  const child = spawn('ssh', [...SSH_BASE, '-L', `${port}:127.0.0.1:${fromPort}`, dest],
                      { stdio: ['ignore', 'ignore', 'pipe'] });
  child.port = port;
  let err = '';
  child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-500)));
  child.on('close', () => {
    if (!closed && tunnel === child)
      console.error(`superlog-bridge: tunnel to ${dest} dropped${err ? ` (${err.trim().split('\n').pop()})` : ''}`);
  });
  tunnel = child;
  // Give ssh a moment; a bad host fails fast, a good one binds fast.
  await sleep(Math.min(500 + attempt * 250, 3000));
  return `http://127.0.0.1:${port}`;
}

// -------------------------------------------------------------- the relay

let ws = null;
let lastSeq = -1;   // source hub seq: the dedupe across reconnect replay
let relayed = 0;
let dropped = 0;
let attempt = 0;

async function connect() {
  if (closed) return;
  const src = await sourceUrl(attempt++);
  const wsUrl = src.replace(/^http/, 'ws') + `/ws?topic=${encodeURIComponent(topic)}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    attempt = 0;
    console.error(`superlog-bridge: ${dest ?? from} -> ${target} (${topic})`);
  };
  ws.onmessage = async (e) => {
    const line = typeof e.data === 'string' ? e.data : String(e.data);
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      return;                                   // not an envelope; not ours to relay
    }
    if (!f || typeof f.topic !== 'string' || typeof f.payload !== 'string') return;
    if (Number.isFinite(f.seq)) {
      if (f.seq <= lastSeq) return;             // reconnect replay - already relayed
      lastSeq = f.seq;
    }
    try {
      await fetch(`${target}/ingest/${encodeURIComponent(f.topic)}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: f.payload,
      });
      relayed += 1;
    } catch {
      // Target hub down. The frame is gone from our side, but the source
      // replays recent history on reconnect, so the durable copy is the
      // source's journal - this bridge is a wire, not a buffer.
      dropped += 1;
    }
  };
  ws.onclose = () => {
    if (!closed) setTimeout(connect, Math.min(1000 * (attempt + 1), 10000));
  };
  ws.onerror = () => ws.close();
}
connect();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    closed = true;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    try {
      tunnel?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    console.error(`superlog-bridge: ${relayed} chunk(s) relayed` +
                  (dropped ? `, ${dropped} dropped while the target was down` : ''));
    process.exit(0);
  });
}
