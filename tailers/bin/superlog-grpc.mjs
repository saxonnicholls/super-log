#!/usr/bin/env node
//
//  superlog-grpc - a logging reverse proxy for gRPC calls.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Point a gRPC client at this instead of the real service; it forwards
//  every RPC to the target and logs one event per call to the hub as
//  grpc.<host>.<target> - method, service, gRPC status, latency, message
//  counts either way, sizes.
//
//    superlog-grpc --listen 50052 --target localhost:50051
//    superlog-grpc --listen 50052 --target api.internal:443 --tls
//    superlog-grpc --listen 50052 --target localhost:50051 --bodies --max-body 512
//
//  Why this is not superlog-net pointed at another port. gRPC is HTTP/2,
//  and an RPC's result is not in the HTTP status: a failed call is
//  ":status 200" with "grpc-status: 5" in the *trailers*, sent after the
//  body. A proxy that reads the HTTP status therefore reports every RPC on
//  the bench as a success - which is worse than not logging them at all,
//  because it is confidently wrong. Levels here come from grpc-status and
//  from nothing else.
//
//  The other half is streaming. A bidi RPC is not a request and a response,
//  it is a conversation that may last an hour, so this counts messages in
//  each direction by walking gRPC's own 5-byte length prefix and publishes
//  the event when the stream ENDS - with a DEBUG progress event every 30s
//  meanwhile, because a stream that has been open since breakfast should
//  not be invisible.
//
//  Bodies are OFF by default and credentials are always redacted, same
//  bargain as superlog-net. When they are on, messages are decoded the way
//  `protoc --decode_raw` does - `1: "alice"  2: 42  3 { 1: "x" }` - because
//  a page of hex is technically the truth and practically useless, and a
//  tool nobody turns on twice may as well not have the flag. No .proto is
//  needed and none is read: the wire format carries field numbers and wire
//  types, and what it does not carry (names, signedness) is not worth a
//  dependency. Anything that will not decode falls back to hex.
//
//  Zero dependencies - node:http2 is the whole gRPC stack needed to move
//  frames from one socket to another. Node >= 18.
//

import http2 from 'node:http2';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

if (has('help') || args.includes('-h') || !opt('target')) {
  console.error(`superlog-grpc - one bench event per gRPC call

  superlog-grpc --listen PORT --target HOST:PORT [--tls] [--bodies]
                [--max-body N] [--progress SECONDS] [--topic T]
                [--url HUB] [--bind H]

  superlog-grpc --listen 50052 --target localhost:50051
  superlog-grpc --listen 50052 --target api.internal:443 --tls

Publishes to grpc.<host>.<target>. Levels come from grpc-status in the
trailers, never from the HTTP status - a failed RPC is ":status 200" with
"grpc-status: 5", and calling that a success is the mistake this exists to
avoid. Streaming RPCs are one event at end of stream, with message counts
and a DEBUG progress event every 30s while they are open. --bodies decodes
protobuf the way protoc --decode_raw does, no .proto needed; --max-body
caps both what is read and what is published. Authorization, Cookie,
X-API-Key and credential-shaped -bin metadata are redacted.`);
  process.exit(opt('target') ? 0 : 2);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const listenPort = Number(opt('listen', '50052'));
const bind = opt('bind', '127.0.0.1'); // loopback by default, like the rest of the bench
const useTls = has('tls');
const captureBodies = has('bodies');
const maxBody = Number(opt('max-body', '512'));
const progressMs = Number(opt('progress', '30')) * 1000;

// A target is host:port. A scheme is accepted and discarded because people
// paste one, and https:// (or grpcs://) implies --tls rather than failing
// over a detail we can plainly read. --tls is about the *target's* TLS: the
// listener is always plaintext h2c, because it is on loopback and a
// certificate between two processes on one machine is ceremony, not
// security - the same call superlog-net makes.
const targetArg = String(opt('target'));
const scheme = (targetArg.match(/^([a-z0-9+.-]+):\/\//i) ?? [])[1] ?? '';
const tls = useTls || /^(https|grpcs)$/i.test(scheme);
const rawTarget = targetArg.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/\/+$/, '');
const [targetHost, targetPortRaw] = rawTarget.split(':');
const targetPort = Number(targetPortRaw || (tls ? 443 : 80));
if (!targetHost || !targetPort || !listenPort) {
  console.error('superlog-grpc: --target must be host:port, --listen a port number');
  process.exit(2);
}
const targetOrigin = `${tls ? 'https' : 'http'}://${targetHost}:${targetPort}`;

const sanitize = (s) => s.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
const host = sanitize(hostname().split('.')[0]);
// The port is part of the target's identity here in a way it is not for
// HTTP: two gRPC services on one box differ only by port, and a topic that
// cannot tell them apart is a topic nobody can read a week later.
const topic = opt('topic', `grpc.${host}.${sanitize(`${targetHost}-${targetPort}`)}`);

// ------------------------------------------------------- gRPC status codes
//
// All seventeen canonical codes, because a bench event saying "grpc_status
// 9" and nothing else sends you to a spec page mid-debug.

const STATUS = [
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED',
  'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED',
  'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
];
const statusName = (c) => STATUS[c] ?? `CODE_${c}`;

// The split is by whose problem it is. ERROR is "the server or the network
// let go": UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL,
// UNAVAILABLE, and DATA_LOSS because a truncated response is not a lesser
// failure than a refused one. OK is INFO, and so is CANCELLED - the caller
// hung up, which is what a user closing a screen looks like, and painting
// every abandoned stream yellow trains you to ignore the colour. Everything
// else - NOT_FOUND, ALREADY_EXISTS, PERMISSION_DENIED, UNAUTHENTICATED,
// INVALID_ARGUMENT, FAILED_PRECONDITION, ABORTED, OUT_OF_RANGE,
// UNIMPLEMENTED - is a call the caller can fix, so WARN.
const ERROR_CODES = new Set([2, 4, 8, 13, 14, 15]);
const levelForStatus = (c) => (c === 0 || c === 1 ? 'INFO' : ERROR_CODES.has(c) ? 'ERROR' : 'WARN');

// No grpc-status anywhere means the peer was not speaking gRPC (a load
// balancer's 502, a plain HTTP 404 from the wrong port). The gRPC spec
// maps those, so a caller sees the same code the real library would give.
const codeForHttp = (s) =>
  ({ 400: 13, 401: 16, 403: 7, 404: 12, 429: 14, 502: 14, 503: 14, 504: 4 })[s] ?? 2;

// ------------------------------------------------------------- redaction
//
// Metadata values that never reach the bench, bodies-or-not. gRPC's -bin
// suffix means base64, and base64 hides the shape that makes a credential
// obvious to the eye - so a -bin key whose name reads like a credential is
// redacted on the name alone rather than on inspection of the value.
const REDACT = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization',
                        'x-api-key', 'api-key', 'x-auth-token', 'grpc-metadata-authorization']);
const CREDENTIAL_BIN = /(auth|token|key|secret|cred|jwt|session|password|signature)[^-]*-bin$/i;
const isSecret = (k) => REDACT.has(k.toLowerCase()) || CREDENTIAL_BIN.test(k);

const redactMeta = (h) => {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith(':')) continue;               // pseudo-headers are transport, not metadata
    out[k] = isSecret(k) ? '<redacted>' : String(v);
  }
  return out;
};

// ------------------------------------------------------------- publishing
//
// Bounded, drop-oldest, counted - the same bargain every producer here
// makes. This proxy sits in front of a live RPC path; a queue that grew
// while the hub was down would eventually stall the very calls it exists
// to observe, which is the one failure it must never cause.
const MAX_QUEUE = 4096;
const session = Math.random().toString(16).slice(2, 10);
const origin = {
  runtime: 'node', app: 'grpc-proxy',
  platform: process.platform === 'darwin' ? 'macos' : 'linux', device: hostname(),
};
let buf = [];
let seq = 0;
let posted = 0, failed = 0, dropped = 0;

function emit(level, msg, fields, trace) {
  if (buf.length >= MAX_QUEUE) { buf.shift(); dropped += 1; }
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level, origin,
    tag: 'grpc', msg, ...(trace ? { trace } : {}), fields,
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
    posted += 1;
  } catch {
    failed += 1;
  }
}
setInterval(() => void flush(), 250).unref?.();

// ------------------------------------------------------- raw protobuf
//
// `protoc --decode_raw` in one page, no dependencies and no .proto. The
// wire format is self-describing enough to manage without one: a varint
// key whose low three bits are the wire type and whose remainder is the
// field number, then a payload whose length the type implies. What is lost
// without the schema is names and signedness - a fair trade for reading
// `1: "alice"  2: 42  3 { 1: "x" }` instead of forty bytes of hex, which
// is the difference between a --bodies run being useful once and being
// useful twice.
//
// Nothing in here throws. A truncated or corrupt frame is exactly the
// moment you are staring at this, so every failure degrades to hex rather
// than costing you the event.

const MAX_DEPTH = 6;
// Strict printable ASCII, and deliberately *not* tab or newline: 0x0a is
// also the key byte for "field 1, length-delimited", so counting it as
// text is precisely how a nested message gets misread as a string that
// happens to start with a newline.
const PRINTABLE = /^[\x20-\x7e]*$/;
// Valid text with the odd tab or newline in it - a second chance for a
// real string that the strict test rejected, before falling back to hex.
const LOOSE_TEXT = /^[^\x00-\x08\x0b\x0c\x0e-\x1f�]*$/;

function readVarint(b, off) {
  let value = 0n, shift = 0n;
  while (off < b.length) {
    const byte = b[off++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, off];
    shift += 7n;
    if (shift > 63n) return null;          // longer than any legal varint
  }
  return null;                             // ran off the end of the buffer
}

function decodeFields(b, depth) {
  const out = [];
  let off = 0;
  while (off < b.length) {
    const key = readVarint(b, off);
    if (!key) return null;
    const field = Number(key[0] >> 3n);
    const wire = Number(key[0] & 7n);
    off = key[1];
    if (field === 0) return null;          // field numbers start at 1
    if (wire === 0) {
      const v = readVarint(b, off);
      if (!v) return null;
      out.push(`${field}: ${v[0]}`);
      off = v[1];
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (off + n > b.length) return null;
      // Fixed-width fields are shown as hex the way protoc does: without
      // the schema there is no telling a double from an int64, and
      // guessing wrong prints a plausible number that is a lie.
      out.push(`${field}: 0x${b.subarray(off, off + n).toString('hex')}`);
      off += n;
    } else if (wire === 2) {
      const len = readVarint(b, off);
      if (!len) return null;
      const n = Number(len[0]);
      off = len[1];
      if (off + n > b.length) return null;
      const v = lengthDelimited(b.subarray(off, off + n), depth);
      // protoc writes a nested message as `3 { … }` and a scalar as
      // `1: "x"`; keeping that punctuation means output anyone who has run
      // --decode_raw can read without a second thought.
      out.push(v.startsWith('{') ? `${field} ${v}` : `${field}: ${v}`);
      off += n;
    } else {
      // 3 and 4 are the deprecated start/end group pair. Their length is
      // not in the frame, so a schema-less decoder cannot skip one without
      // guessing - hex is the honest answer.
      return null;
    }
  }
  return out;
}

function lengthDelimited(b, depth) {
  if (b.length === 0) return '""';
  const text = b.toString('utf8');
  if (PRINTABLE.test(text)) return JSON.stringify(text);
  if (depth < MAX_DEPTH) {
    const nested = decodeFields(b, depth + 1);
    if (nested) return nested.length ? `{ ${nested.join('  ')} }` : '{}';
  }
  if (LOOSE_TEXT.test(text)) return JSON.stringify(text);
  return `0x${b.toString('hex')}`;
}

function decodeRaw(b) {
  try {
    const fields = decodeFields(b, 0);
    return fields ? (fields.length ? fields.join('  ') : '{}') : null;
  } catch {
    return null;                           // malformed input is never fatal
  }
}

// ------------------------------------------------------------ gRPC framing
//
// The only part of a payload this tool parses: one compressed-flag byte,
// four bytes of big-endian length, then that many bytes of protobuf. The
// bytes are walked and counted but never held - a 4 MB message must not
// become 4 MB of proxy memory - and a message counts when its payload is
// complete, so a stream cut mid-message does not claim to have delivered
// one it did not.
function tap() {
  const hdr = Buffer.alloc(5);
  let hdrGot = 0, payloadLeft = 0, inHeader = true;
  let msgs = 0, bytes = 0, kept = 0;
  const chunks = [];

  return {
    push(chunk) {
      bytes += chunk.length;
      if (captureBodies && kept < maxBody) {
        const slice = chunk.subarray(0, maxBody - kept);
        chunks.push(Buffer.from(slice));
        kept += slice.length;
      }
      let off = 0;
      while (off < chunk.length) {
        if (inHeader) {
          const take = Math.min(5 - hdrGot, chunk.length - off);
          chunk.copy(hdr, hdrGot, off, off + take);
          hdrGot += take; off += take;
          if (hdrGot === 5) {
            payloadLeft = hdr.readUInt32BE(1);
            hdrGot = 0;
            inHeader = false;
            // An empty message (google.protobuf.Empty, a bare ack) is a
            // message; length zero completes it here and now.
            if (payloadLeft === 0) { msgs += 1; inHeader = true; }
          }
        } else {
          const take = Math.min(payloadLeft, chunk.length - off);
          payloadLeft -= take; off += take;
          if (payloadLeft === 0) { msgs += 1; inHeader = true; }
        }
      }
    },
    get msgs() { return msgs; },
    get bytes() { return bytes; },

    // What --bodies actually publishes: the kept bytes re-split into gRPC
    // messages and each one decoded. One field per direction rather than a
    // decoded field beside a hex one, because anything that would not
    // decode is already hex here - and doubling every captured body on the
    // wire to the hub is a poor trade for bytes the fallback already
    // shows.
    body() {
      if (!captureBodies || !bytes) return undefined;
      const b = Buffer.concat(chunks);
      const parts = [];
      let off = 0;
      while (off + 5 <= b.length) {
        const len = b.readUInt32BE(off + 1);
        const end = off + 5 + len;
        if (end > b.length) {
          // The cap cut a message in half. Say so, rather than decoding a
          // fragment and presenting the result as the whole message.
          parts.push(`<truncated ${b.length - off - 5}/${len}B 0x${b.subarray(off + 5).toString('hex')}>`);
          off = b.length;
          break;
        }
        const payload = b.subarray(off + 5, end);
        // A set compressed-flag means the payload is gzip or deflate per
        // grpc-encoding, not protobuf; decoding it as protobuf would
        // produce confident nonsense.
        parts.push(b[off] === 1
          ? `<compressed ${len}B 0x${payload.toString('hex')}>`
          : (decodeRaw(payload) ?? `0x${payload.toString('hex')}`));
        off = end;
      }
      if (off < b.length) parts.push(`<partial prefix 0x${b.subarray(off).toString('hex')}>`);

      let out = parts.length > 1 ? parts.map((p, i) => `[${i + 1}] ${p}`).join('  ') : (parts[0] ?? '');
      // The cap applies to what is published, not only to what is read: a
      // 40-field message decodes to far more text than it occupies on the
      // wire, and the bench is the thing being protected here.
      if (out.length > maxBody) out = `${out.slice(0, maxBody)}…`;
      if (bytes > kept) out += ` (+${bytes - kept}B not captured)`;
      return out;
    },
  };
}

// ----------------------------------------------------------- header hygiene
//
// HTTP/2 forbids the HTTP/1 connection-management headers outright, and
// Node throws rather than sending them, so a blind header copy from an
// inbound stream would take the proxy down on the first call. `te` is the
// exception that must survive: gRPC requires `te: trailers`, and dropping
// it is how a proxy quietly breaks the trailers everything here depends on.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection',
                            'transfer-encoding', 'upgrade', 'http2-settings', 'host']);

function forwardable(headers, { keepStatus = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk.startsWith(':')) {
      if (keepStatus && lk === ':status') out[':status'] = v;
      continue;
    }
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'te') { if (String(v).toLowerCase() === 'trailers') out.te = 'trailers'; continue; }
    out[lk] = v;
  }
  return out;
}

// grpc-message is percent-encoded UTF-8 on the wire. Malformed encoding is
// the server's bug, not a reason to lose the event.
const decodeMessage = (m) => {
  if (m === undefined) return undefined;
  try { return decodeURIComponent(String(m)); } catch { return String(m); }
};

const statusFrom = (h) => {
  const raw = h?.['grpc-status'];
  return raw === undefined ? undefined : Number(Array.isArray(raw) ? raw[0] : raw);
};

// ------------------------------------------------------- upstream session
//
// One HTTP/2 session, many streams: that is what HTTP/2 is for, and a
// connection per RPC would misrepresent the target's own connection
// behaviour as well as being slower. The session is lazy and replaced
// after a failure, so a target that comes back needs no restart here.
let up = null;
let upError = null;
const inFlight = new Set();

// A refused connect arrives as an AggregateError - one failed attempt per
// resolved address - and an AggregateError's own message is empty, so
// reporting e.message alone would put "upstream localhost:51099: " on the
// bench with no reason attached at all.
const reason = (e) =>
  (e?.errors?.length ? e.errors.map((x) => x.message || x.code).join('; ') : '') ||
  e?.message || e?.code || String(e);

function upstream() {
  if (up && !up.closed && !up.destroyed) return up;
  up = http2.connect(targetOrigin);
  upError = null;
  up.on('error', (e) => {
    upError = e;
    // Every call waiting on this session is now dead; each gets its own
    // event and its own UNAVAILABLE, because a caller left hanging is the
    // worst thing a debugging proxy can do to the thing it is debugging.
    for (const ctx of [...inFlight]) ctx.fail(14, `upstream ${targetOrigin}: ${reason(e)}`);
    up?.destroy();
    up = null;
  });
  up.on('close', () => { up = null; });
  return up;
}

// ------------------------------------------------------------- the proxy

const server = http2.createServer();

server.on('stream', (stream, headers) => {
  const started = Date.now();
  // Read once, now: by the time a cancelled or reset stream is reported the
  // socket may be gone, and "?:0" is not who called.
  const peer = `${stream.session?.socket?.remoteAddress ?? '?'}:${stream.session?.socket?.remotePort ?? 0}`;
  const path = String(headers[':path'] ?? '');
  // /package.Service/Method - everything before the last slash is the
  // service, and a path that is not that shape is passed through unparsed
  // rather than guessed at.
  const cut = path.lastIndexOf('/');
  const service = cut > 0 ? path.slice(1, cut) : '';
  const trace = headers['x-superlog-trace']
    ? String(headers['x-superlog-trace']).slice(0, 64)
    : undefined;                        // absent means absent - never invented

  const req = tap();
  const resp = tap();
  const ctx = { done: false, timer: null, fail: null };
  inFlight.add(ctx);

  let httpStatus = 0;
  let respHeaders = null;

  const done = (code, src, message) => {
    if (ctx.done) return;
    ctx.done = true;
    inFlight.delete(ctx);
    if (ctx.timer) clearInterval(ctx.timer);

    const ms = Date.now() - started;
    const streaming = req.msgs > 1 || resp.msgs > 1;
    const fields = {
      method: path.slice(0, 512),
      service,
      grpc_status: String(code),
      grpc_status_name: statusName(code),
      status_src: src,                  // trailers | headers | http | proxy
      latency_ms: String(ms),
      req_msgs: String(req.msgs),
      resp_msgs: String(resp.msgs),
      req_bytes: String(req.bytes),
      resp_bytes: String(resp.bytes),
      http_status: String(httpStatus),
      peer,
      stream_id: String(stream.id ?? 0),
      // Inferred from what actually crossed the wire, not from the service
      // definition this proxy has never seen: a server-streaming RPC that
      // happened to yield one message is indistinguishable from a unary one
      // here, and claiming otherwise would be a guess dressed as a fact.
      kind: req.msgs > 1 && resp.msgs > 1 ? 'bidi-stream'
        : req.msgs > 1 ? 'client-stream'
          : resp.msgs > 1 ? 'server-stream' : 'unary',
    };
    if (message) fields.grpc_message = String(message).slice(0, 512);
    if (captureBodies) {
      const rq = req.body(); const rs = resp.body();
      if (rq) fields.req_proto = rq;
      if (rs) fields.resp_proto = rs;
      fields.req_meta = JSON.stringify(redactMeta(headers));
    }
    emit(
      levelForStatus(code),
      `${path} → ${statusName(code)} in ${ms}ms` +
        (streaming ? ` (${req.msgs}↑ ${resp.msgs}↓ msgs)` : '') +
        (message ? `: ${String(message).slice(0, 200)}` : ''),
      fields,
      trace,
    );
  };

  // Answering a caller ourselves. gRPC's own error shape is ":status 200"
  // plus trailers, so a client library reports "UNAVAILABLE: connection
  // refused" rather than an HTTP-level surprise it has no idea what to do
  // with.
  ctx.fail = (code, message) => {
    done(code, 'proxy', message);
    if (stream.destroyed || stream.closed) return;
    try {
      if (!stream.headersSent) {
        stream.respond({
          ':status': 200,
          'content-type': 'application/grpc',
          'grpc-status': String(code),
          'grpc-message': encodeURIComponent(`super-log grpc: ${message}`),
        }, { endStream: true });
      } else {
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      }
    } catch { /* the caller left first; nothing to tell */ }
  };

  if (progressMs > 0) {
    ctx.timer = setInterval(() => {
      if (ctx.done) return;
      const secs = Math.round((Date.now() - started) / 1000);
      emit('DEBUG', `${path} open ${secs}s (${req.msgs}↑ ${resp.msgs}↓ msgs)`, {
        method: path.slice(0, 512), service, change: 'progress',
        open_s: String(secs), req_msgs: String(req.msgs), resp_msgs: String(resp.msgs),
        req_bytes: String(req.bytes), resp_bytes: String(resp.bytes),
        stream_id: String(stream.id ?? 0),
      }, trace);
    }, progressMs);
    ctx.timer.unref?.();
  }

  let upReq;
  try {
    upReq = upstream().request({
      ...forwardable(headers),
      ':method': String(headers[':method'] ?? 'POST'),
      ':path': path,
    });
  } catch (e) {
    ctx.fail(14, `cannot open upstream stream: ${reason(e)}`);
    return;
  }

  upReq.on('response', (rh, flags) => {
    respHeaders = rh;
    httpStatus = Number(rh[':status'] ?? 0);
    // Trailers-only: one HEADERS frame with END_STREAM carrying the whole
    // result. It is the normal shape for an error raised before the handler
    // produced anything, and Node surfaces it here rather than as trailers,
    // so a proxy that only reads the 'trailers' event sees nothing at all.
    const endStream = Boolean(flags & http2.constants.NGHTTP2_FLAG_END_STREAM);
    if (stream.destroyed || stream.closed) return;
    try {
      stream.respond(forwardable(rh, { keepStatus: true }), { endStream, waitForTrailers: !endStream });
    } catch {
      return;                            // caller gone mid-response
    }
    if (endStream) {
      const code = statusFrom(rh);
      if (code !== undefined) done(code, 'headers', decodeMessage(rh['grpc-message']));
      else done(codeForHttp(httpStatus), 'http', `upstream replied ${httpStatus} with no grpc-status`);
    }
  });

  let trailers = null;
  upReq.on('trailers', (t) => { trailers = t; });

  // Trailers are only ours to send once the body has been written, which is
  // exactly what 'wantTrailers' means. An upstream that ends without a
  // grpc-status has broken the contract; saying so as UNKNOWN keeps the
  // caller from waiting for a status that is never coming.
  stream.on('wantTrailers', () => {
    const t = trailers ? forwardable(trailers) : {};
    if (t['grpc-status'] === undefined) {
      t['grpc-status'] = '2';
      t['grpc-message'] = encodeURIComponent('super-log grpc: upstream sent no grpc-status');
    }
    try { stream.sendTrailers(t); } catch { /* stream already closed */ }
  });

  upReq.on('data', (c) => resp.push(c));
  upReq.on('end', () => {
    if (ctx.done) return;
    const code = statusFrom(trailers) ?? statusFrom(respHeaders);
    const msg = decodeMessage(trailers?.['grpc-message'] ?? respHeaders?.['grpc-message']);
    if (code !== undefined) done(code, trailers?.['grpc-status'] !== undefined ? 'trailers' : 'headers', msg);
    else if (httpStatus && httpStatus !== 200) done(codeForHttp(httpStatus), 'http', `upstream replied ${httpStatus}`);
    else done(2, 'proxy', 'upstream ended with no grpc-status');
  });
  upReq.on('error', (e) => {
    // When a session dies it takes its streams with it, and the stream's
    // own error is a generic "pending stream has been canceled" - the
    // reason worth reading ("connect ECONNREFUSED") is on the session,
    // which Node emits a beat later. One turn of the loop, on a failure
    // path only, is what it costs to report the cause instead of the
    // symptom.
    setImmediate(() => {
      if (!ctx.done) ctx.fail(14, `upstream ${targetOrigin}: ${reason(upError ?? e)}`);
    });
  });

  stream.on('data', (c) => req.push(c));
  stream.on('error', () => { /* reported by 'close' below */ });
  stream.on('close', () => {
    // A caller that resets the stream has cancelled the RPC. The upstream
    // stream must go with it, or a cancelled server-stream keeps producing
    // into a socket nobody is reading.
    if (!ctx.done) {
      const cancelled = stream.rstCode === http2.constants.NGHTTP2_CANCEL;
      done(cancelled ? 1 : 2, 'proxy',
           cancelled ? 'caller cancelled' : `caller closed the stream (rst ${stream.rstCode})`);
    }
    if (!upReq.closed && !upReq.destroyed) upReq.close(http2.constants.NGHTTP2_CANCEL);
  });

  stream.pipe(upReq);
  upReq.pipe(stream);
});

server.on('sessionError', (e) => emit('WARN', `session error: ${e.message}`, { error: e.message }));
server.on('error', (e) => {
  console.error(`superlog-grpc: ${e.message}`);
  process.exit(1);
});

server.listen(listenPort, bind, () => {
  const exposed = bind === '0.0.0.0' || bind === '::';
  console.error(
    `superlog-grpc: h2c://${bind}:${listenPort} → ${targetOrigin} -> ${hubUrl}/ingest/${topic}` +
      (captureBodies ? ` (bodies on, decoded, ${maxBody}B cap, credentials redacted)` : ' (metadata only)'),
  );
  if (exposed) {
    // Loud on both channels. Anyone who can reach this port can call the
    // target through it, and the bench should carry the fact that it was
    // opened as much as the terminal that opened it.
    console.error(
      `superlog-grpc: WARNING - bound to ${bind}, so ANY host that can reach ` +
        `${listenPort} can call ${targetOrigin} through this proxy. Use --bind 127.0.0.1 unless that is the point.`,
    );
    emit('WARN', `listening on ${bind}:${listenPort} - reachable beyond loopback`, {
      bind, port: String(listenPort), target: targetOrigin,
    });
  }
});

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    server.close();
    up?.destroy();
    void flush().then(() => {
      console.error(
        `superlog-grpc: ${posted} batches posted, ${failed} failed` +
          (dropped ? `, ${dropped} event(s) dropped (queue full)` : ''),
      );
      process.exit(0);
    });
  });
