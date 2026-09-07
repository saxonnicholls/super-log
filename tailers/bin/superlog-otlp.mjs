#!/usr/bin/env node
//
//  superlog-otlp - the OpenTelemetry inlet: OTel -> the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Anything OpenTelemetry-instrumented joins the bench with no new SDK -
//  one exporter stanza pointed here, and its logs, metrics and spans land
//  as ordinary bench events. The payoff for a debugging session: OTel
//  trace ids arrive in the event's `trace` field, so they line up with
//  withTrace()'s own ids and /recent?trace= returns the whole story
//  across both worlds.
//
//    superlog-otlp                        # OTLP/HTTP on 127.0.0.1:4318
//    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 your-app
//
//  This is the INLET (OTel -> bench). The bench -> collector forwarder is
//  a separate, later thing (see README Future directions) - untouched.
//
//  Routes: POST /v1/logs (first-class), /v1/metrics, /v1/traces.
//  Encodings: application/json (OTLP/JSON) and application/x-protobuf via
//  a hand-rolled BOUNDED decoder for just the subset we need - most SDKs
//  default to http/protobuf, so JSON-only would gut the value. The log4j
//  rule holds throughout: bounded parsing, content is DATA and never
//  evaluated, malformed input answers 400 and never crashes the server.
//
//  Publishes to otlp.<service.name> (from the resource's service.name,
//  sanitized; --topic-prefix to change the otlp. part). Binds LOOPBACK by
//  default - the hub has no auth, and 4318 open to the LAN is an open
//  relay into the one screen everyone watches, so --bind is a choice.
//
//  Node >= 18, zero dependencies.
//

import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')
    ? args[i + 1] : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-otlp - the OpenTelemetry inlet (OTLP/HTTP)

  superlog-otlp [--port 4318] [--bind ADDR] [--topic-prefix otlp]
                [--max-queue N] [--url HUB]

Accepts POST /v1/logs, /v1/metrics, /v1/traces in OTLP/JSON and
OTLP/protobuf. Publishes to otlp.<service.name>. severityNumber maps to
bench levels; trace_id becomes the event's trace field. Binds 127.0.0.1
unless --bind says otherwise - the hub has no auth.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const port = Number(opt('port', env.SUPER_LOG_OTLP_PORT ?? 4318));
const bind = opt('bind', env.SUPER_LOG_OTLP_BIND ?? '127.0.0.1');
const topicPrefix = (opt('topic-prefix', 'otlp')).replace(/[^a-z0-9._-]/gi, '') || 'otlp';
const maxQueue = Number(opt('max-queue', 10000)) || 10000;

// Bounds - the log4j lesson made concrete. A payload larger than this is
// refused before it is parsed; a field, string or nesting deeper than
// these is refused during parse. None of it is ever evaluated.
const MAX_PAYLOAD = 8 * 1024 * 1024;
const MAX_FIELD = 1024 * 1024;
const MAX_NEST = 32;
const MAX_ATTR_VALUE = 4096;
const MAX_ATTRS = 64;
const MAX_MSG = 8192;

const device = hostname().split('.')[0].toLowerCase();
const session = Math.random().toString(16).slice(2, 10);
let seq = 0;

// ------------------------------------------------------------- the queue
//
// Producer contract, as everywhere: a bounded queue that drops OLDEST
// under burst, counts what it dropped, and never blocks the exporter's
// POST waiting on the hub - the response goes back immediately, the batch
// drains on its own clock.

const queue = [];
let dropped = 0;

function enqueue(ev) {
  queue.push(ev);
  while (queue.length > maxQueue) { queue.shift(); dropped += 1; }
}

function event(level, msg, service, { fields, metric, trace, ts } = {}) {
  const topic = `${topicPrefix}.${sanitizeService(service)}`;
  const ev = {
    v: 1, ts: ts ?? new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'otel', app: service || 'otlp', platform: 'otlp', device },
    tag: 'otlp', msg: String(msg).slice(0, MAX_MSG),
    ...(trace ? { trace } : {}),
    ...(metric ? { metric } : {}),
    ...(fields && Object.keys(fields).length ? { fields } : {}),
  };
  enqueue({ topic, line: JSON.stringify(ev) });
}

async function drain() {
  if (!queue.length) return;
  const byTopic = new Map();
  for (const { topic, line } of queue.splice(0)) {
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(line);
  }
  if (dropped) {
    // A dropped producer is news the bench must hear, on its own topic so
    // it never masquerades as one service's problem.
    const line = JSON.stringify({
      v: 1, ts: new Date().toISOString(), seq: seq++, session, level: 'WARN',
      origin: { runtime: 'otel', app: 'otlp', platform: 'otlp', device },
      tag: 'otlp', msg: `dropped ${dropped} event(s) under burst (queue cap ${maxQueue})`,
      fields: { dropped: String(dropped) },
    });
    byTopic.set(`${topicPrefix}.inlet`, [...(byTopic.get(`${topicPrefix}.inlet`) ?? []), line]);
    dropped = 0;
  }
  for (const [topic, lines] of byTopic) {
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' },
        body: lines.join('\n'), signal: AbortSignal.timeout(5000),
      });
    } catch { /* hub down; the events are gone, the next batch counts again */ }
  }
}
setInterval(() => void drain(), 250).unref?.();

// ------------------------------------------------------------- helpers

const sanitizeService = (s) =>
  String(s || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) || 'unknown';

// severityNumber bands, with severityText (and the JSON enum name) as the
// fallback, and INFO when a record says nothing about its own severity.
function levelFor(num, text) {
  const n = Number(num);
  if (Number.isFinite(n) && n >= 1) {
    if (n >= 21) return 'CRITICAL';
    if (n >= 17) return 'ERROR';
    if (n >= 13) return 'WARN';
    if (n >= 9) return 'INFO';
    if (n >= 5) return 'DEBUG';
    return 'TRACE';
  }
  const t = String(text ?? '').toUpperCase();
  if (/FATAL|CRIT/.test(t)) return 'CRITICAL';
  if (/ERR/.test(t)) return 'ERROR';
  if (/WARN/.test(t)) return 'WARN';
  if (/INFO/.test(t)) return 'INFO';
  if (/DEBUG/.test(t)) return 'DEBUG';
  if (/TRACE/.test(t)) return 'TRACE';
  return 'INFO';
}

function nanoToIso(nano) {
  try {
    const ms = Number(BigInt(nano) / 1000000n);
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  } catch { return undefined; }
}

const hexOk = (h) => typeof h === 'string' && /^[0-9a-f]+$/i.test(h) && h.length >= 8;

// A resolved attribute value -> a capped string, because fields are
// string-valued on the wire and a giant attribute is not a field, it is
// an attack surface.
function attrString(v) {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.slice(0, MAX_ATTR_VALUE);
}

function bodyString(v) {
  if (v === undefined || v === null) return '';
  return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, MAX_MSG);
}

// ================================================================ OTLP/JSON
//
// proto3 JSON: field names are lowerCamelCase, but a compliant producer
// may also send the original snake_case - accept either. AnyValue is a
// tagged object ({stringValue}, {intValue}, ...); int64 rides as a string.

const pick = (o, ...names) => {
  for (const n of names) if (o && o[n] !== undefined) return o[n];
  return undefined;
};

function jsonAnyValue(v, depth = 0) {
  if (v == null || depth > MAX_NEST) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return v.intValue;         // string in JSON
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.bytesValue !== undefined) return '0x' + Buffer.from(String(v.bytesValue), 'base64').toString('hex');
  if (v.arrayValue !== undefined)
    return (v.arrayValue.values ?? []).slice(0, MAX_ATTRS).map((x) => jsonAnyValue(x, depth + 1));
  if (v.kvlistValue !== undefined) {
    const o = {};
    for (const kv of (v.kvlistValue.values ?? []).slice(0, MAX_ATTRS))
      o[kv.key] = jsonAnyValue(kv.value, depth + 1);
    return o;
  }
  return undefined;
}

function jsonAttrs(list, into = {}) {
  let n = 0;
  for (const kv of list ?? []) {
    if (n++ >= MAX_ATTRS) break;
    const s = attrString(jsonAnyValue(kv.value));
    if (s !== undefined && kv.key) into[String(kv.key).slice(0, 128)] = s;
  }
  return into;
}

const serviceOf = (resource) => {
  const attrs = jsonAttrs(pick(resource ?? {}, 'attributes'));
  return attrs['service.name'];
};

function ingestLogsJson(root) {
  let count = 0;
  for (const rl of pick(root, 'resourceLogs', 'resource_logs') ?? []) {
    const service = serviceOf(pick(rl, 'resource'));
    const rattrs = jsonAttrs(pick(pick(rl, 'resource') ?? {}, 'attributes'));
    for (const sl of pick(rl, 'scopeLogs', 'scope_logs') ?? []) {
      for (const rec of pick(sl, 'logRecords', 'log_records') ?? []) {
        const fields = { ...rattrs };
        jsonAttrs(pick(rec, 'attributes'), fields);
        const dropCount = pick(rec, 'droppedAttributesCount', 'dropped_attributes_count');
        if (dropCount) fields.dropped_attributes = String(dropCount);
        const span = pick(rec, 'spanId', 'span_id');
        if (span) fields.span_id = String(span);
        const trace = pick(rec, 'traceId', 'trace_id');
        const level = levelFor(pick(rec, 'severityNumber', 'severity_number'),
                               pick(rec, 'severityText', 'severity_text'));
        const msg = bodyString(jsonAnyValue(pick(rec, 'body'))) ||
                    pick(rec, 'severityText', 'severity_text') || '(otlp log)';
        event(level, msg, service,
          { fields, trace: hexOk(trace) ? trace : undefined,
            ts: nanoToIso(pick(rec, 'timeUnixNano', 'time_unix_nano')) });
        count++;
      }
    }
  }
  return count;
}

function ingestMetricsJson(root) {
  let count = 0;
  for (const rm of pick(root, 'resourceMetrics', 'resource_metrics') ?? []) {
    const service = serviceOf(pick(rm, 'resource'));
    for (const sm of pick(rm, 'scopeMetrics', 'scope_metrics') ?? []) {
      for (const metric of pick(sm, 'metrics') ?? []) {
        const name = pick(metric, 'name') || 'metric';
        const g = pick(metric, 'gauge');
        const s = pick(metric, 'sum');
        const h = pick(metric, 'histogram');
        const points = pick(g ?? s ?? {}, 'dataPoints', 'data_points') ?? [];
        for (const dp of points) {
          const value = pick(dp, 'asDouble', 'as_double') !== undefined
            ? Number(pick(dp, 'asDouble', 'as_double'))
            : Number(pick(dp, 'asInt', 'as_int'));
          if (!Number.isFinite(value)) continue;
          const fields = jsonAttrs(pick(dp, 'attributes'));
          event('DEBUG', `${name} =${value}`, service,
            { fields, metric: { name: String(name).slice(0, 128), value } });
          count++;
        }
        if (h) {
          for (const dp of pick(h, 'dataPoints', 'data_points') ?? []) {
            const c = Number(pick(dp, 'count'));
            const sum = Number(pick(dp, 'sum'));
            if (!Number.isFinite(c)) continue;
            // Histograms are summarized to count and sum - inventing
            // percentiles from buckets would be a lie the bench never tells.
            event('DEBUG', `${name} histogram: count ${c}` +
              (Number.isFinite(sum) ? `, sum ${sum}` : '') + ' (summarized)', service,
              { fields: jsonAttrs(pick(dp, 'attributes')),
                metric: { name: `${String(name).slice(0, 120)}.count`, value: c } });
            count++;
          }
        }
      }
    }
  }
  return count;
}

function ingestTracesJson(root) {
  let count = 0;
  for (const rs of pick(root, 'resourceSpans', 'resource_spans') ?? []) {
    const service = serviceOf(pick(rs, 'resource'));
    for (const ss of pick(rs, 'scopeSpans', 'scope_spans') ?? []) {
      for (const span of pick(ss, 'spans') ?? []) {
        const trace = pick(span, 'traceId', 'trace_id');
        const name = pick(span, 'name') || 'span';
        const start = pick(span, 'startTimeUnixNano', 'start_time_unix_nano');
        const end = pick(span, 'endTimeUnixNano', 'end_time_unix_nano');
        let durMs;
        try { durMs = Number((BigInt(end) - BigInt(start)) / 1000000n); } catch { /* absent */ }
        const status = pick(span, 'status') ?? {};
        const code = pick(status, 'code');
        const fields = jsonAttrs(pick(span, 'attributes'));
        fields.span_id = String(pick(span, 'spanId', 'span_id') ?? '');
        if (durMs !== undefined) fields.duration_ms = String(durMs);
        if (pick(status, 'message')) fields.status = String(pick(status, 'message'));
        // A span is a DEBUG event carrying its trace - this is an inlet,
        // not a span store; the correlation is the point, not the tree.
        const level = String(code) === '2' || String(code) === 'STATUS_CODE_ERROR' ? 'WARN' : 'DEBUG';
        event(level, `span ${name}` + (durMs !== undefined ? ` (${durMs}ms)` : ''),
          service, { fields, trace: hexOk(trace) ? trace : undefined });
        count++;
      }
    }
  }
  return count;
}

// ============================================================ OTLP/protobuf
//
// A hand-rolled BOUNDED walker for exactly the subset we consume. It
// decodes into the same shape the JSON path produces, so one normalizer
// serves both encodings. Unknown fields are skipped; every length is
// checked against the caps before a byte is read.

function uvarint(buf, pos, end) {
  let result = 0n, shift = 0n, p = pos;
  for (let i = 0; i < 10; i++) {
    if (p >= end) throw new Error('otlp: varint truncated');
    const b = buf[p++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, p];
    shift += 7n;
  }
  throw new Error('otlp: varint too long');
}

// Walk one message, calling cb(field, wire, payload) where payload is a
// BigInt (wire 0), or a Buffer slice (wire 1 -> 8 bytes, 2 -> the bytes,
// 5 -> 4 bytes). Bounded on entry by the caller; caps enforced here.
function walk(buf, start, end, cb) {
  let p = start;
  while (p < end) {
    let tag; [tag, p] = uvarint(buf, p, end);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      let v; [v, p] = uvarint(buf, p, end);
      cb(field, 0, v);
    } else if (wire === 1) {
      if (p + 8 > end) throw new Error('otlp: 64-bit truncated');
      cb(field, 1, buf.subarray(p, p + 8)); p += 8;
    } else if (wire === 2) {
      let len; [len, p] = uvarint(buf, p, end);
      len = Number(len);
      if (len < 0 || len > MAX_FIELD || p + len > end) throw new Error('otlp: length out of range');
      cb(field, 2, buf.subarray(p, p + len)); p += len;
    } else if (wire === 5) {
      if (p + 4 > end) throw new Error('otlp: 32-bit truncated');
      cb(field, 5, buf.subarray(p, p + 4)); p += 4;
    } else {
      throw new Error('otlp: bad wire type ' + wire);
    }
  }
}
const f64double = (b) => b.length === 8 ? b.readDoubleLE(0) : NaN;
const f64uint = (b) => b.length === 8 ? b.readBigUInt64LE(0) : 0n;
const f64int = (b) => b.length === 8 ? b.readBigInt64LE(0) : 0n;
const utf8 = (b) => b.toString('utf8');
const hex = (b) => Buffer.from(b).toString('hex');

function pbAnyValue(buf, depth) {
  if (depth > MAX_NEST) return undefined;
  let out;
  walk(buf, 0, buf.length, (f, w, v) => {
    if (f === 1 && w === 2) out = utf8(v);
    else if (f === 2 && w === 0) out = v !== 0n;
    else if (f === 3 && w === 0) out = Number(BigInt.asIntN(64, v));
    else if (f === 4 && w === 1) out = f64double(v);
    else if (f === 5 && w === 2) {                              // ArrayValue
      const arr = [];
      walk(v, 0, v.length, (af, aw, av) => { if (af === 1 && aw === 2) arr.push(pbAnyValue(av, depth + 1)); });
      out = arr;
    } else if (f === 6 && w === 2) {                            // KeyValueList
      const o = {};
      walk(v, 0, v.length, (kf, kw, kv) => {
        if (kf === 1 && kw === 2) { const [k, val] = pbKeyValue(kv, depth + 1); o[k] = val; }
      });
      out = o;
    } else if (f === 7 && w === 2) out = '0x' + hex(v);
  });
  return out;
}

function pbKeyValue(buf, depth) {
  let key, value;
  walk(buf, 0, buf.length, (f, w, v) => {
    if (f === 1 && w === 2) key = utf8(v).slice(0, 128);
    else if (f === 2 && w === 2) value = pbAnyValue(v, depth + 1);
  });
  return [key, value];
}

// Resource: field 1 repeated KeyValue attributes.
function pbResourceAttrs(buf) {
  const into = {};
  let n = 0;
  walk(buf, 0, buf.length, (f, w, v) => {
    if (f === 1 && w === 2 && n++ < MAX_ATTRS) {
      const [k, val] = pbKeyValue(v, 0);
      const s = attrString(val);
      if (k && s !== undefined) into[k] = s;
    }
  });
  return into;
}

function ingestLogsProto(buf) {
  let count = 0;
  walk(buf, 0, buf.length, (f, w, rl) => {              // ExportLogs.resource_logs = 1
    if (f !== 1 || w !== 2) return;
    let rattrs = {};
    const scopeLogs = [];
    walk(rl, 0, rl.length, (rf, rw, v) => {
      if (rf === 1 && rw === 2) rattrs = pbResourceAttrs(v);   // ResourceLogs.resource
      else if (rf === 2 && rw === 2) scopeLogs.push(v);        // ResourceLogs.scope_logs
    });
    const service = rattrs['service.name'];
    for (const sl of scopeLogs) {
      walk(sl, 0, sl.length, (sf, sw, rec) => {
        if (sf !== 2 || sw !== 2) return;                      // ScopeLogs.log_records = 2
        const fields = { ...rattrs };
        let sevNum, sevText, body, trace, timeNano, dropCount;
        walk(rec, 0, rec.length, (lf, lw, lv) => {
          if (lf === 1 && lw === 1) timeNano = f64uint(lv);     // time_unix_nano
          else if (lf === 2 && lw === 0) sevNum = Number(lv);   // severity_number
          else if (lf === 3 && lw === 2) sevText = utf8(lv);    // severity_text
          else if (lf === 5 && lw === 2) body = pbAnyValue(lv, 0); // body
          else if (lf === 7 && lw === 0) dropCount = Number(lv); // dropped_attributes_count
          else if (lf === 9 && lw === 2) trace = hex(lv);        // trace_id
          else if (lf === 10 && lw === 2) fields.span_id = hex(lv); // span_id
        });
        // attributes (field 6) are repeated KeyValue, one per occurrence -
        // walk them explicitly so each is a distinct field.
        let n = 0;
        walk(rec, 0, rec.length, (lf, lw, lv) => {
          if (lf === 6 && lw === 2 && n++ < MAX_ATTRS) {
            const [k, val] = pbKeyValue(lv, 0);
            const s = attrString(val);
            if (k && s !== undefined) fields[k] = s;
          }
        });
        if (dropCount) fields.dropped_attributes = String(dropCount);
        event(levelFor(sevNum, sevText), bodyString(body) || sevText || '(otlp log)',
          service, { fields, trace: hexOk(trace) ? trace : undefined,
                     ts: nanoToIso(timeNano) });
        count++;
      });
    }
  });
  return count;
}

function pbNumberDataPoints(buf, service, name, emit) {
  walk(buf, 0, buf.length, (f, w, dp) => {                // gauge/sum.data_points = 1
    if (f !== 1 || w !== 2) return;
    let value, hasVal = false;
    const fields = {};
    let n = 0;
    walk(dp, 0, dp.length, (pf, pw, pv) => {
      if (pf === 4 && pw === 1) { value = f64double(pv); hasVal = true; }   // as_double
      else if (pf === 6 && pw === 1) { value = Number(f64int(pv)); hasVal = true; } // as_int
      else if (pf === 7 && pw === 2 && n++ < MAX_ATTRS) {                    // attributes = 7
        const [k, val] = pbKeyValue(pv, 0);
        const s = attrString(val);
        if (k && s !== undefined) fields[k] = s;
      }
    });
    if (hasVal && Number.isFinite(value)) emit(value, fields);
  });
}

function ingestMetricsProto(buf) {
  let count = 0;
  walk(buf, 0, buf.length, (f, w, rm) => {               // ExportMetrics.resource_metrics = 1
    if (f !== 1 || w !== 2) return;
    let rattrs = {};
    const scopeMetrics = [];
    walk(rm, 0, rm.length, (rf, rw, v) => {
      if (rf === 1 && rw === 2) rattrs = pbResourceAttrs(v);
      else if (rf === 2 && rw === 2) scopeMetrics.push(v);
    });
    const service = rattrs['service.name'];
    for (const sm of scopeMetrics) {
      walk(sm, 0, sm.length, (sf, sw, metric) => {
        if (sf !== 2 || sw !== 2) return;                  // ScopeMetrics.metrics = 2
        let name = 'metric', gauge, sum, hist;
        walk(metric, 0, metric.length, (mf, mw, mv) => {
          if (mf === 1 && mw === 2) name = utf8(mv).slice(0, 128);  // name
          else if (mf === 5 && mw === 2) gauge = mv;                // gauge
          else if (mf === 7 && mw === 2) sum = mv;                  // sum
          else if (mf === 9 && mw === 2) hist = mv;                 // histogram
        });
        const emit = (value, fields) => {
          event('DEBUG', `${name} =${value}`, service,
            { fields, metric: { name, value } });
          count++;
        };
        if (gauge) pbNumberDataPoints(gauge, service, name, emit);
        if (sum) pbNumberDataPoints(sum, service, name, emit);
        if (hist) {
          walk(hist, 0, hist.length, (hf, hw, dp) => {
            if (hf !== 1 || hw !== 2) return;              // histogram.data_points = 1
            let c, s;
            walk(dp, 0, dp.length, (pf, pw, pv) => {
              if (pf === 4 && pw === 1) c = Number(f64uint(pv));   // count (fixed64)
              else if (pf === 5 && pw === 1) s = f64double(pv);    // sum (double)
            });
            if (Number.isFinite(c)) {
              event('DEBUG', `${name} histogram: count ${c}` +
                (Number.isFinite(s) ? `, sum ${s}` : '') + ' (summarized)', service,
                { metric: { name: `${name}.count`, value: c } });
              count++;
            }
          });
        }
      });
    }
  });
  return count;
}

function ingestTracesProto(buf) {
  let count = 0;
  walk(buf, 0, buf.length, (f, w, rs) => {               // ExportTrace.resource_spans = 1
    if (f !== 1 || w !== 2) return;
    let rattrs = {};
    const scopeSpans = [];
    walk(rs, 0, rs.length, (rf, rw, v) => {
      if (rf === 1 && rw === 2) rattrs = pbResourceAttrs(v);
      else if (rf === 2 && rw === 2) scopeSpans.push(v);
    });
    const service = rattrs['service.name'];
    for (const ss of scopeSpans) {
      walk(ss, 0, ss.length, (sf, sw, span) => {
        if (sf !== 2 || sw !== 2) return;                  // ScopeSpans.spans = 2
        let trace, name = 'span', start, end, statusCode, statusMsg;
        const fields = {};
        let n = 0;
        walk(span, 0, span.length, (pf, pw, pv) => {
          if (pf === 1 && pw === 2) trace = hex(pv);              // trace_id
          else if (pf === 2 && pw === 2) fields.span_id = hex(pv); // span_id
          else if (pf === 5 && pw === 2) name = utf8(pv).slice(0, 256); // name
          else if (pf === 7 && pw === 1) start = f64uint(pv);    // start_time_unix_nano
          else if (pf === 8 && pw === 1) end = f64uint(pv);      // end_time_unix_nano
          else if (pf === 9 && pw === 2 && n++ < MAX_ATTRS) {    // attributes
            const [k, val] = pbKeyValue(pv, 0);
            const s = attrString(val);
            if (k && s !== undefined) fields[k] = s;
          } else if (pf === 15 && pw === 2) {                    // status
            walk(pv, 0, pv.length, (xf, xw, xv) => {
              if (xf === 2 && xw === 2) statusMsg = utf8(xv);
              else if (xf === 3 && xw === 0) statusCode = Number(xv);
            });
          }
        });
        let durMs;
        try { if (start !== undefined && end !== undefined) durMs = Number((end - start) / 1000000n); } catch { /* */ }
        if (durMs !== undefined) fields.duration_ms = String(durMs);
        if (statusMsg) fields.status = statusMsg;
        const level = statusCode === 2 ? 'WARN' : 'DEBUG';
        event(level, `span ${name}` + (durMs !== undefined ? ` (${durMs}ms)` : ''),
          service, { fields, trace: hexOk(trace) ? trace : undefined });
        count++;
      });
    }
  });
  return count;
}

// ------------------------------------------------------------- the server

const ROUTES = {
  '/v1/logs': { json: ingestLogsJson, proto: ingestLogsProto },
  '/v1/metrics': { json: ingestMetricsJson, proto: ingestMetricsProto },
  '/v1/traces': { json: ingestTracesJson, proto: ingestTracesProto },
};

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > cap) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const route = ROUTES[(req.url ?? '').split('?')[0]];
  if (req.method !== 'POST' || !route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"code":12,"message":"POST /v1/logs, /v1/metrics or /v1/traces"}');
  }
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  let body;
  try {
    body = await readBody(req, MAX_PAYLOAD);
  } catch {
    res.writeHead(413, { 'content-type': 'application/json' });
    return res.end('{"code":8,"message":"payload too large"}');
  }
  try {
    if (ct.includes('application/x-protobuf') || ct.includes('application/protobuf')) {
      route.proto(body);
      // An empty ExportServiceResponse serializes to zero bytes.
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      return res.end();
    }
    // Default to JSON: it is the tolerant reader's choice, and OTLP/JSON
    // omits the charset as often as it sends it.
    route.json(JSON.parse(body.toString('utf8') || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' });
    // An empty response message means full success - no partial_success,
    // so no exporter retries a delivery the bench already took.
    return res.end('{}');
  } catch (e) {
    // Malformed input is a 400, never a crash. The exporter learns its
    // payload was rejected and does not retry the same bytes forever.
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ code: 3, message: String(e.message ?? e).slice(0, 200) }));
  }
});

server.listen(port, bind, () => {
  console.error(`superlog-otlp: OTLP/HTTP on ${bind}:${port} ` +
    `(/v1/logs, /v1/metrics, /v1/traces) -> ${topicPrefix}.<service> -> ${hubUrl}`);
  if (bind === '0.0.0.0' || bind === '::')
    console.error('superlog-otlp: WARNING - listening on all interfaces. ' +
      'The hub has no auth; anyone who can reach this port can write to the bench.');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE')
    console.error(`superlog-otlp: ${bind}:${port} is in use - a real OTel collector may ` +
      'already own it. Move ours (--port) or theirs.');
  else console.error(`superlog-otlp: ${e.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => { await drain(); process.exit(0); });
