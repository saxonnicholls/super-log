#!/usr/bin/env node
//
//  superlog-otlp-export.mjs - the OpenTelemetry OUTLET (bench -> OTLP/HTTP JSON)
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The mirror of superlog-otlp: that one is the INLET (OTLP in -> bench events);
//  this is the OUTLET (bench events -> OTLP out), so a bench can feed an existing
//  OpenTelemetry backend, vendor endpoint, or Collector without giving up the
//  hub. It reads the local hub over /ws exactly as the journal does, maps each
//  event to an OTLP LogRecord, batches, and POSTs OTLP/JSON to
//  <endpoint>/v1/logs (and, for `metric` events, /v1/metrics).
//
//  JSON only, on purpose. OTLP/JSON is accepted by every Collector and the major
//  vendors; writing a protobuf ENCODER here would add a hand-rolled wire format
//  to maintain and buy nothing the JSON path does not already deliver. A backend
//  that demands gRPC/protobuf is one `otlp` receiver + `otlphttp` exporter in a
//  Collector away - see docs/OTLP.md.
//
//  Signals: logs are first-class - every event becomes a LogRecord. Bench
//  `metric` events additionally export as OTLP gauge points. The bench has no
//  spans of its own, so traces are not exported; a trace id on an event rides
//  out on its LogRecord's traceId (or, for the bench's short 16-hex ids that do
//  not fit OTLP's 16-byte field, as a `superlog.trace` attribute).
//
//    superlog-otlp-export --endpoint https://otlp.example.com \
//        --header 'authorization: Bearer <token>'
//    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 superlog-otlp-export
//
//  Node >= 22 (global WebSocket, global fetch).
//

import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')
    ? args[i + 1] : dflt;
};
const optAll = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === `--${name}` && args[i + 1] !== undefined) out.push(args[i + 1]);
  return out;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-otlp-export - the OpenTelemetry outlet (bench -> OTLP/HTTP JSON)

  superlog-otlp-export [--endpoint URL] [--header 'k: v' ...] [--topic PATTERN]
                       [--service NAME] [--signals logs,metrics]
                       [--batch N] [--flush-ms MS] [--url HUB]

Reads the local hub over /ws and POSTs OTLP/JSON to <endpoint>/v1/logs and
/v1/metrics. --endpoint is the backend BASE (OTEL_EXPORTER_OTLP_ENDPOINT), the
/v1/* path is appended. --header is repeatable (auth). --topic filters which
bench topics leave (default *). service.name comes from --service, else each
event's origin.app. JSON only; point a Collector at us for gRPC/protobuf.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const endpoint = String(opt('endpoint', env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318'))
  .replace(/\/+$/, '');
const topic = opt('topic', '*');
const serviceOverride = opt('service', '');
const scopeName = opt('scope', 'superlog');
const batchMax = Number(opt('batch', 512)) || 512;
const flushMs = Number(opt('flush-ms', 2000)) || 2000;
const maxQueue = Number(opt('max-queue', 20000)) || 20000;
const signals = String(opt('signals', 'logs,metrics')).split(',').map((s) => s.trim());
const doLogs = signals.includes('logs');
const doMetrics = signals.includes('metrics');

// Auth and any other headers: --header 'k: v' (repeatable), plus the standard
// OTEL_EXPORTER_OTLP_HEADERS='k=v,k2=v2'. content-type is ours to set.
const headers = { 'content-type': 'application/json' };
for (const h of optAll('header')) {
  const c = h.indexOf(':');
  if (c > 0) headers[h.slice(0, c).trim().toLowerCase()] = h.slice(c + 1).trim();
}
if (env.OTEL_EXPORTER_OTLP_HEADERS) {
  for (const pair of env.OTEL_EXPORTER_OTLP_HEADERS.split(',')) {
    const e = pair.indexOf('=');
    if (e > 0) headers[pair.slice(0, e).trim().toLowerCase()] = pair.slice(e + 1).trim();
  }
}

const MAX_MSG = 8192;
const MAX_ATTR = 4096;

// The inverse of the inlet's band map: a bench level becomes the START of its
// OTLP severity band (TRACE 1-4, DEBUG 5-8, INFO 9-12, WARN 13-16, ERROR 17-20,
// FATAL 21-24). severityText carries the exact bench level beside it.
const SEVERITY = { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, CRITICAL: 21 };

const validTraceId = (t) => (typeof t === 'string' && /^[0-9a-f]{32}$/i.test(t) ? t.toLowerCase() : null);

function tsNanos(iso, tsMs) {
  const ms = Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : (tsMs ?? Date.now());
  return (BigInt(ms) * 1000000n).toString();
}

function serviceOf(ev) {
  if (serviceOverride) return serviceOverride;
  if (ev.origin && ev.origin.app) return String(ev.origin.app);
  const t = ev.__topic || '';
  return t.split('.')[0] || 'superlog';
}

function attrsOf(ev) {
  const a = [];
  const add = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    a.push({ key: k, value: { stringValue: String(v).slice(0, MAX_ATTR) } });
  };
  add('superlog.topic', ev.__topic);
  add('superlog.seq', ev.seq);
  add('superlog.session', ev.session);
  add('superlog.tag', ev.tag);
  if (ev.trace && !validTraceId(ev.trace)) add('superlog.trace', ev.trace);
  const o = ev.origin || {};
  add('superlog.runtime', o.runtime);
  add('superlog.platform', o.platform);
  add('superlog.device', o.device);
  if (ev.fields) for (const [k, v] of Object.entries(ev.fields)) add(k, v);
  return a;
}

// ----------------------------------------------------------------- the queue
//
// The same producer contract as everywhere: a bounded queue that drops OLDEST
// under burst and counts it. A backend that is down or slow costs the batch in
// flight, never the bench - the hub read never blocks on the export POST.

const queue = [];   // { service, rec?, metric? }
let dropped = 0;
let exported = 0;

function enqueue(item) {
  queue.push(item);
  while (queue.length > maxQueue) { queue.shift(); dropped += 1; }
}

function ingestEvent(ev, tsMs) {
  const service = serviceOf(ev);
  const item = { service };
  if (doLogs) {
    const level = String(ev.level || 'INFO').toUpperCase();
    const rec = {
      timeUnixNano: tsNanos(ev.ts, tsMs),
      severityNumber: SEVERITY[level] ?? 9,
      severityText: level,
      body: { stringValue: String(ev.msg ?? '').slice(0, MAX_MSG) },
      attributes: attrsOf(ev),
    };
    const t = validTraceId(ev.trace);
    if (t) rec.traceId = t;
    item.rec = rec;
  }
  if (doMetrics && ev.metric && typeof ev.metric.value === 'number' && Number.isFinite(ev.metric.value)) {
    item.metric = {
      name: String(ev.metric.name || ev.msg || 'metric'),
      point: {
        timeUnixNano: tsNanos(ev.ts, tsMs),
        asDouble: ev.metric.value,
        attributes: attrsOf(ev),
      },
    };
  }
  if (item.rec || item.metric) enqueue(item);
}

// ------------------------------------------------------- OTLP request builders

function resourceGroups(items, pick) {
  // Group by service.name into resource_*[] -> scope_*[] -> records/metrics.
  const bySvc = new Map();
  for (const it of items) {
    const got = pick(it);
    if (!got) continue;
    if (!bySvc.has(it.service)) bySvc.set(it.service, []);
    bySvc.get(it.service).push(got);
  }
  return bySvc;
}

async function post(path, body) {
  try {
    const r = await fetch(`${endpoint}${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    // A 2xx (any body - OTLP success is {} / partial) is accepted; anything
    // else is a failed delivery. We do not retry: a retry queue grows without
    // bound against a backend that stays down, and the drop is counted.
    return r.ok;
  } catch {
    return false;
  }
}

async function flush() {
  if (queue.length === 0) return;
  const items = queue.splice(0);
  let lost = 0;

  if (doLogs) {
    const bySvc = resourceGroups(items, (it) => it.rec);
    const resourceLogs = [...bySvc.entries()].map(([service, records]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeLogs: [{ scope: { name: scopeName }, logRecords: records }],
    }));
    if (resourceLogs.length) {
      const ok = await post('/v1/logs', { resourceLogs });
      if (ok) exported += items.filter((it) => it.rec).length;
      else lost += items.filter((it) => it.rec).length;
    }
  }

  if (doMetrics) {
    const bySvc = resourceGroups(items, (it) => it.metric);
    const resourceMetrics = [...bySvc.entries()].map(([service, metrics]) => {
      // Same metric name coalesces into one gauge with many data points.
      const byName = new Map();
      for (const m of metrics) {
        if (!byName.has(m.name)) byName.set(m.name, []);
        byName.get(m.name).push(m.point);
      }
      return {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeMetrics: [{
          scope: { name: scopeName },
          metrics: [...byName.entries()].map(([name, dataPoints]) => ({ name, gauge: { dataPoints } })),
        }],
      };
    });
    if (resourceMetrics.length) {
      const ok = await post('/v1/metrics', { resourceMetrics });
      if (!ok) lost += items.filter((it) => it.metric).length;
    }
  }

  if (lost) dropped += lost;
}

// A steady heartbeat to stderr: exported vs dropped, so an operator can see the
// outlet is alive and whether the backend is keeping up. Never re-injected into
// the hub (that would export its own status and, on a failing backend, amplify).
setInterval(() => {
  if (exported || dropped) console.error(`superlog-otlp-export: ${exported} exported, ${dropped} dropped -> ${endpoint}`);
}, 30000).unref?.();

const flushTimer = setInterval(() => { void flush(); }, flushMs);
flushTimer.unref?.();

// ----------------------------------------------------------- read the hub /ws
//
// The journal's contract, for the journal's reasons: read /healthz's epoch
// BEFORE subscribing and reset the cursor when the hub restarts, so a seq
// carried across a restart does not silence the whole stream as "replay".

let ws;
let closed = false;
let lastSeq = -1;
let lastEpoch = null;

async function connect() {
  try {
    const h = await fetch(`${hubUrl}/healthz`).then((r) => r.json());
    if (h?.epoch) {
      if (lastEpoch !== null && h.epoch !== lastEpoch) lastSeq = -1;
      lastEpoch = h.epoch;
    }
  } catch { /* hub down mid-reconnect; the ws open will fail and retry */ }

  const wsUrl = hubUrl.replace(/^http/, 'ws') + `/ws?topic=${encodeURIComponent(topic)}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.error(`superlog-otlp-export: subscribed ${wsUrl} -> ${endpoint}`);
  ws.onmessage = (e) => {
    const data = typeof e.data === 'string' ? e.data : String(e.data);
    let env2;
    try { env2 = JSON.parse(data); } catch { return; }
    if (!env2 || typeof env2 !== 'object' || typeof env2.payload !== 'string') return;
    const seq = Number(env2.seq);
    if (Number.isFinite(seq)) {
      if (seq <= lastSeq) return;   // reconnect replay - already exported
      lastSeq = seq;
    }
    for (const line of env2.payload.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      if (!ev || typeof ev !== 'object') continue;
      ev.__topic = env2.topic;
      ingestEvent(ev, env2.ts_ms);
    }
    if (queue.length >= batchMax) void flush();
  };
  ws.onclose = () => { if (!closed) setTimeout(connect, 1000); };
  ws.onerror = () => ws.close();
}
connect();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    closed = true;
    try { ws?.close(); } catch { /* already gone */ }
    clearInterval(flushTimer);
    await flush();   // one last delivery attempt
    console.error(`superlog-otlp-export: ${exported} exported, ${dropped} dropped`);
    process.exit(0);
  });
}
