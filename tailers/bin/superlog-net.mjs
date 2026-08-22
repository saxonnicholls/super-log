#!/usr/bin/env node
//
//  superlog-net - a logging reverse proxy for debugging calls.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Point a client at this instead of the real service; it forwards every
//  request to the target and logs both halves to the hub as net.<label> -
//  method, path, status, latency, sizes, content-type, one event per call.
//
//    superlog-net 9000 http://localhost:3000        # debug your backend
//    superlog-net 9443 https://api.internal          # https target, no certs
//    superlog-net 9000 http://localhost:3000 --bodies --max-body 2048
//
//  Why a reverse proxy and not a packet sniffer: the client->proxy hop is
//  plain http on loopback, and this process terminates it and re-dials the
//  target itself (handling the target's TLS), so HTTPS *targets* work with
//  no CA cert and nothing installed system-wide. It sees only what flows
//  through the port you point it at - which is the whole debugging story
//  and none of the surveillance one. (Intercepting arbitrary outbound
//  HTTPS you do NOT control needs a MITM CA the client trusts; that is a
//  deliberate, separate decision, not this tool.)
//
//  Bodies are OFF by default and secrets are always redacted: on your own
//  machine you *can* capture them, but a log that quietly hoovers up
//  Authorization headers and request payloads is a liability, so capturing
//  is a choice you make per run. Node >= 18.
//

import http from 'node:http';
import https from 'node:https';
import { hostname } from 'node:os';
import { URL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const listenPort = Number(args[0]);
const target = args[1];
if (!listenPort || !target || target.startsWith('--')) {
  console.error('usage: superlog-net <listen-port> <target-url> [--bodies] [--max-body N] [--topic T] [--url U] [--bind H]');
  process.exit(2);
}
const targetUrl = new URL(target);
const upstream = targetUrl.protocol === 'https:' ? https : http;

const hubUrl = opt('url', process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const shortHost = () => hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const label = opt('topic', `net.${shortHost()}.${targetUrl.hostname.replace(/[^a-z0-9._-]/gi, '-')}`);
const bind = opt('bind', '127.0.0.1'); // loopback by default, like the rest of the bench
const captureBodies = has('bodies');
const maxBody = Number(opt('max-body', '4096'));

// Headers whose values never reach the bench, bodies-or-not.
const REDACT = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key']);
const redactHeaders = (h) => {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = REDACT.has(k.toLowerCase()) ? '<redacted>' : v;
  return out;
};

// --- tiny non-blocking batcher (same contract as the tailers) ------------
const session = Math.random().toString(16).slice(2, 10);
let seq = 0;
let buf = [];
let posted = 0, failed = 0;
const origin = { runtime: 'node', app: 'net-proxy', platform: process.platform === 'darwin' ? 'macos' : 'linux', device: hostname() };

function emit(level, msg, fields) {
  buf.push(JSON.stringify({ v: 1, ts: new Date().toISOString(), seq: seq++, session, level, origin, tag: 'http', msg, fields }));
  if (buf.length >= 256) void flush();
}
async function flush() {
  if (!buf.length) return;
  const body = buf.join('\n');
  buf = [];
  try {
    await fetch(`${hubUrl}/ingest/${label}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
    posted++;
  } catch {
    failed++;
  }
}
setInterval(flush, 250).unref?.();

// A capped body sink: tee a stream without buffering more than the cap, and
// without stalling the pipe when the body is bigger than we want to keep.
function capture(readable, onDone) {
  if (!captureBodies) {
    let n = 0;
    readable.on('data', (c) => (n += c.length));
    readable.on('end', () => onDone(n, undefined));
    return;
  }
  let n = 0;
  const chunks = [];
  let kept = 0;
  readable.on('data', (c) => {
    n += c.length;
    if (kept < maxBody) {
      chunks.push(c.subarray(0, maxBody - kept));
      kept += c.length;
    }
  });
  readable.on('end', () => {
    let text = Buffer.concat(chunks).toString('utf8');
    if (n > maxBody) text += `…(+${n - maxBody}B)`;
    onDone(n, text);
  });
}

const levelForStatus = (s) => (s >= 500 ? 'ERROR' : s >= 400 ? 'WARN' : 'INFO');

const server = http.createServer((req, res) => {
  const started = Date.now();
  // Listen to the request stream BEFORE piping it upstream: once piped it
  // is consumed, and a listener attached later never sees 'end'.
  const reqInfo = new Promise((resolve) =>
    capture(req, (bytes, body) => resolve({ bytes, body })),
  );
  const upReq = upstream.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: targetUrl.host },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      capture(upRes, (resBytes, resBody) => {
        void reqInfo.then(({ bytes: reqBytes, body: reqBody }) => {
          const dur = Date.now() - started;
          const fields = {
            method: req.method ?? '?',
            path: (req.url ?? '').slice(0, 512),
            status: String(upRes.statusCode ?? 0),
            ms: String(dur),
            req_bytes: String(reqBytes),
            resp_bytes: String(resBytes),
            type: String(upRes.headers['content-type'] ?? ''),
          };
          if (captureBodies) {
            if (reqBody) fields.req_body = reqBody;
            if (resBody) fields.resp_body = resBody;
            fields.req_headers = JSON.stringify(redactHeaders(req.headers));
          }
          emit(
            levelForStatus(upRes.statusCode ?? 0),
            `${req.method} ${req.url} → ${upRes.statusCode} in ${dur}ms`,
            fields,
          );
        });
      });
      upRes.pipe(res);
    },
  );
  upReq.on('error', (e) => {
    emit('ERROR', `${req.method} ${req.url} → upstream error: ${e.message}`, {
      method: req.method ?? '?', path: (req.url ?? '').slice(0, 512), error: e.message,
    });
    if (!res.headersSent) res.writeHead(502);
    res.end('super-log net: upstream error');
  });
  req.pipe(upReq);
});

// WebSocket / other upgrades: pass the raw socket through so we don't break
// them; log the handshake, not the frames (framing is out of scope here).
server.on('upgrade', (req, clientSocket, head) => {
  const upReq = upstream.request({
    protocol: targetUrl.protocol, hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    method: req.method, path: req.url,
    headers: { ...req.headers, host: targetUrl.host },
  });
  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    emit('INFO', `${req.method} ${req.url} → ${upRes.statusCode} (upgrade ${req.headers.upgrade ?? '?'})`, {
      method: req.method ?? '?', path: (req.url ?? '').slice(0, 512),
      status: String(upRes.statusCode ?? 0), upgrade: String(req.headers.upgrade ?? ''),
    });
    clientSocket.write(
      `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n` +
        Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n',
    );
    if (upHead?.length) upSocket.unshift(upHead);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
  });
  upReq.on('error', () => clientSocket.destroy());
  if (head?.length) upReq.write(head);
  upReq.end();
});

server.listen(listenPort, bind, () => {
  console.error(
    `superlog-net: http://${bind}:${listenPort} → ${target} -> ${hubUrl}/ingest/${label}` +
      (captureBodies ? ` (bodies on, ${maxBody}B cap, secrets redacted)` : ' (metadata only)'),
  );
});

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    server.close();
    void flush().then(() => {
      console.error(`superlog-net: ${posted} batches posted, ${failed} failed`);
      process.exit(0);
    });
  });
