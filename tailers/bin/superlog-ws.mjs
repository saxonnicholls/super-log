#!/usr/bin/env node
//
//  superlog-ws - what is actually flowing down a WebSocket.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A WebSocket is the one part of a system with no log. HTTP leaves a trail
//  in a proxy, a database leaves a slow-query log, but a socket that opened
//  an hour ago and has been quietly not delivering the thing you subscribed
//  to leaves nothing at all. This connects, subscribes if you tell it to,
//  and puts every frame on the bench beside everything else.
//
//    superlog-ws wss://stream.binance.com:9443/ws/btcusdt@trade
//    superlog-ws wss://ws.example.com --header 'Authorization: Bearer …'
//    superlog-ws wss://stream.binance.com:9443/ws \\
//      --send '{"method":"SUBSCRIBE","params":["btcusdt@trade"],"id":1}'
//
//  Publishes to ws.<host>.<name>.
//
//  The hard part is volume, not connection. A market data stream is
//  hundreds of frames a second; logged one for one it would drown every
//  other stream on the bench and tell you nothing you could read. So the
//  default is a rate cap with an honest summary: at most --max-rate frames
//  a second are published in full, and what was skipped is counted and
//  reported rather than silently dropped. --summary adds a periodic metric
//  event with frames and bytes per second, which is the number you actually
//  want from a firehose - "is it still flowing, and at what rate".
//
//  Auth: --header, repeatable. Values for Authorization, Cookie and
//  X-API-Key are redacted in everything published - the point is to see the
//  traffic, not to copy the credential into a log that then gets exported.
//
//  Read-only unless you use --send: it subscribes, it does not trade.
//
//  Node >= 22 (global WebSocket).
//

import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const optAll = (name) =>
  args.reduce((acc, a, i) => (a === `--${name}` && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

const url = args.find((a) => /^wss?:\/\//.test(a));

if (!url || args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-ws - log every frame on a WebSocket

  superlog-ws <ws://… | wss://…> [--send JSON]... [--header 'K: V']...
              [--max-rate N] [--summary SECONDS] [--max-payload BYTES]
              [--no-payload] [--topic NAME] [--url HUB]

  superlog-ws wss://stream.binance.com:9443/ws/btcusdt@trade
  superlog-ws wss://ws.example.com --header 'Authorization: Bearer …'

Publishes to ws.<host>.<name>. At most --max-rate frames a second are
published in full (default 10); the rest are counted and reported, never
silently dropped. Authorization, Cookie and X-API-Key are redacted.`);
  process.exit(url ? 0 : 2);
}

if (typeof globalThis.WebSocket !== 'function') {
  console.error('superlog-ws: this Node has no global WebSocket - Node >= 22 is required');
  process.exit(2);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const maxRate = Number(opt('max-rate', '10'));
const summarySec = Number(opt('summary', '10'));
const maxPayload = Number(opt('max-payload', '512'));
const noPayload = args.includes('--no-payload');
const sends = optAll('send');

const sanitize = (s) => s.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
const host = sanitize(hostname().split('.')[0]);
const parsed = new URL(url);
// stream.binance.com + /ws/btcusdt@trade -> binance.btcusdt-trade, which is
// a name you can pick out of a topic list a week later.
const streamName = sanitize(
  `${parsed.hostname.split('.').slice(-2, -1)[0] ?? parsed.hostname}` +
  `${parsed.pathname && parsed.pathname !== '/' ? `.${parsed.pathname.replace(/^\/+/, '')}` : ''}`,
);
const topic = opt('topic', `ws.${host}.${streamName || 'stream'}`);

const SECRET = /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
const headers = Object.fromEntries(optAll('header').map((h) => {
  const at = h.indexOf(':');
  return at < 0 ? [h.trim(), ''] : [h.slice(0, at).trim(), h.slice(at + 1).trim()];
}));
// What gets logged about the connection, as opposed to what gets sent.
const shownHeaders = Object.keys(headers)
  .map((k) => (SECRET.test(k) ? `${k}: <redacted>` : `${k}: ${headers[k]}`)).join(', ');

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;

function publish(level, msg, fields, metric) {
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'ws-watcher', platform: 'ws', device: host },
    tag: 'ws', msg, ...(fields ? { fields } : {}), ...(metric ? { metric } : {}),
  }));
  if (buf.length >= 256) void flush();
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
setInterval(() => void flush(), 250).unref?.();

// A credential can travel in the payload as easily as in a header - a
// subscribe frame carrying an API key is the normal case, not the odd one.
const redactPayload = (s) =>
  s.replace(/("(?:api[_-]?key|token|secret|signature|password|authorization)"\s*:\s*")[^"]*(")/gi,
            '$1<redacted>$2');

// ------------------------------------------------------------------ rates

let inWindow = 0;        // published this second
let skipped = 0;         // suppressed this second
let framesTotal = 0;
let bytesTotal = 0;
let framesSincesummary = 0;
let bytesSinceSummary = 0;

setInterval(() => {
  if (skipped) {
    // Never a silent drop. A stream that quietly stops showing you frames
    // is indistinguishable from a stream that stopped sending them, which
    // is the exact question this tool exists to answer.
    publish('DEBUG', `${skipped} more frame(s) this second not shown (rate cap ${maxRate}/s)`,
            { change: 'suppressed', count: String(skipped) });
  }
  inWindow = 0;
  skipped = 0;
}, 1000).unref?.();

if (summarySec > 0) {
  setInterval(() => {
    const fps = framesSincesummary / summarySec;
    const bps = bytesSinceSummary / summarySec;
    publish('INFO', `${fps.toFixed(1)} frames/s, ${(bps / 1024).toFixed(1)} KiB/s`,
            { change: 'rate', frames: String(framesSincesummary),
              bytes: String(bytesSinceSummary), window: String(summarySec) },
            { name: 'ws.frames_per_s', value: Number(fps.toFixed(2)) });
    framesSincesummary = 0;
    bytesSinceSummary = 0;
  }, summarySec * 1000).unref?.();
}

// ------------------------------------------------------------- connection

let attempt = 0;
let ws = null;

function frame(direction, data) {
  const text = typeof data === 'string' ? data : '<binary>';
  const bytes = typeof data === 'string' ? Buffer.byteLength(data) : (data?.byteLength ?? 0);
  framesTotal += 1; bytesTotal += bytes;
  framesSincesummary += 1; bytesSinceSummary += bytes;

  if (inWindow >= maxRate) { skipped += 1; return; }
  inWindow += 1;

  const fields = { direction, bytes: String(bytes) };
  if (!noPayload && typeof data === 'string')
    fields.payload = redactPayload(text.length > maxPayload
      ? `${text.slice(0, maxPayload)}… (${text.length} bytes)` : text);

  publish('DEBUG', `${direction} ${bytes}B`, fields);
}

function connect() {
  const shown = `${url}${shownHeaders ? ` [${shownHeaders}]` : ''}`;
  publish('INFO', `connecting to ${shown}`, { change: 'connecting', url });

  // The headers option is honoured by Node's WebSocket; browsers cannot set
  // them at all, which is why token-in-query-string exists.
  try {
    ws = new WebSocket(url, Object.keys(headers).length ? { headers } : undefined);
  } catch (e) {
    publish('ERROR', `cannot open socket: ${String(e.message ?? e)}`, { change: 'error' });
    return retry();
  }

  ws.addEventListener('open', () => {
    attempt = 0;
    publish('INFO', `connected to ${url}`, { change: 'open', url });
    for (const s of sends) {
      ws.send(s);
      frame('sent', s);
    }
  });

  ws.addEventListener('message', (ev) => {
    const d = ev.data;
    if (typeof d === 'string') frame('recv', d);
    else if (d instanceof Blob) d.text().then((t) => frame('recv', t)).catch(() => frame('recv', d));
    else frame('recv', d);
  });

  ws.addEventListener('error', () => {
    // The event carries nothing useful by design (it would leak network
    // details to a page); the close that follows carries the reason.
    publish('WARN', 'socket error', { change: 'error', url });
  });

  ws.addEventListener('close', (ev) => {
    // 1000 and 1005 are orderly. Anything else ended without agreement,
    // which is the case worth a level above INFO.
    const clean = ev.code === 1000 || ev.code === 1005;
    publish(clean ? 'INFO' : 'WARN',
            `closed ${ev.code}${ev.reason ? `: ${ev.reason}` : ''} after ${framesTotal} frame(s)`,
            { change: 'close', code: String(ev.code), reason: ev.reason ?? '',
              frames: String(framesTotal), bytes: String(bytesTotal) });
    retry();
  });
}

function retry() {
  // Capped exponential backoff. A market data endpoint that is refusing
  // connections will not be persuaded by a tighter loop, and being banned
  // for hammering it is a worse outcome than reconnecting a second later.
  attempt += 1;
  const wait = Math.min(30000, 500 * 2 ** Math.min(attempt, 6));
  publish('DEBUG', `reconnecting in ${(wait / 1000).toFixed(1)}s (attempt ${attempt})`,
          { change: 'retry', attempt: String(attempt) });
  setTimeout(connect, wait);
}

async function bye(code) {
  publish('INFO', `stopping after ${framesTotal} frame(s), ${(bytesTotal / 1024).toFixed(1)} KiB`,
          { change: 'stop', frames: String(framesTotal), bytes: String(bytesTotal) });
  try { ws?.close(1000, 'superlog-ws stopping'); } catch { /* already gone */ }
  await flush();
  process.exit(code);
}
process.on('SIGINT', () => void bye(130));
process.on('SIGTERM', () => void bye(143));

console.error(`superlog-ws: ${url} -> ${topic} (max ${maxRate} frame(s)/s shown)`);
connect();
