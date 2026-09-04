//
//  tests/otlp.test.mjs - the OpenTelemetry inlet, against a real hub.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The inlet runs as a subprocess and real HTTP crosses the wire, per the
//  house bar. The protobuf payloads are HAND-ENCODED here, byte by byte -
//  the decoder is proven without adding a protobuf dependency to a repo
//  whose whole point is not having one. The severity table, topic
//  sanitization, trace propagation, metric mapping, the oversize
//  rejection and both success-response shapes are all asserted.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertValidEvent, start, startHub, waitFor } from './harness.mjs';

let hub, inlet;
const PORT = 43181;
const otlp = (p) => `http://127.0.0.1:${PORT}${p}`;

const postJson = async (path, body) => {
  const r = await fetch(otlp(path), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text(), ct: r.headers.get('content-type') };
};

before(async () => {
  hub = await startHub();
  inlet = start('superlog-otlp.mjs', ['--port', String(PORT), '--url', hub.url], {});
  await inlet.waitForStderr(/OTLP\/HTTP on 127\.0\.0\.1:43181/);
});

after(async () => {
  await inlet?.stop();
  await hub?.stop();
});

// ---- protobuf encoding helpers: the other half of the proof ------------

const varint = (n) => {
  const out = [];
  let v = BigInt(n);
  do { const b = Number(v & 0x7fn); v >>= 7n; out.push(v ? b | 0x80 : b); } while (v);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
const ld = (field, payload) => {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
};
const vi = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const f64 = (field, buf8) => Buffer.concat([tag(field, 1), buf8]);
const dbl = (field, x) => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return f64(field, b); };
const u64 = (field, n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return f64(field, b); };

const kv = (key, anyValue) => Buffer.concat([ld(1, key), ld(2, anyValue)]); // KeyValue message
const strVal = (s) => ld(1, s);                       // AnyValue.string_value = 1
const resource = (svc) => ld(1, kv('service.name', strVal(svc)));   // Resource.attributes = 1

describe('superlog-otlp', () => {
  it('OTLP/JSON logs: the severity table, topic sanitization, trace and fields', async () => {
    const rec = (sev, msg, extra = {}) => ({
      severityNumber: sev, body: { stringValue: msg }, ...extra });
    const { status, body, ct } = await postJson('/v1/logs', {
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'My Checkout API!' } }] },
        scopeLogs: [{ logRecords: [
          rec(3, 'a trace line'),
          rec(7, 'a debug line'),
          rec(10, 'an info line'),
          rec(14, 'a warn line'),
          rec(18, 'an error line', {
            traceId: 'a1b2c3d4e5f60718a1b2c3d4e5f60718',
            spanId: '0102030405060708',
            attributes: [{ key: 'http.status_code', value: { intValue: '500' } }],
            droppedAttributesCount: 3,
          }),
          rec(24, 'a fatal line'),
          { body: { stringValue: 'says nothing about severity' } },
          { severityText: 'WARNING', body: { stringValue: 'text-only severity' } },
        ] }],
      }],
    });
    assert.equal(status, 200);
    assert.equal(body, '{}', 'OTLP/JSON success is an empty object, so exporters do not retry');
    assert.match(ct, /application\/json/);

    const recs = await waitFor(hub.url, (rs) => rs.length >= 8,
      { topic: 'otlp.my-checkout-api', timeoutMs: 15000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `otlp[${i}]`));
    const lvl = (m) => recs.map((r) => r.event).find((e) => e.msg === m)?.level;
    assert.equal(lvl('a trace line'), 'TRACE');
    assert.equal(lvl('a debug line'), 'DEBUG');
    assert.equal(lvl('an info line'), 'INFO');
    assert.equal(lvl('a warn line'), 'WARN');
    assert.equal(lvl('an error line'), 'ERROR');
    assert.equal(lvl('a fatal line'), 'CRITICAL');
    assert.equal(lvl('says nothing about severity'), 'INFO', 'absent severity is INFO');
    assert.equal(lvl('text-only severity'), 'WARN', 'severityText is the fallback');

    const err = recs.map((r) => r.event).find((e) => e.msg === 'an error line');
    assert.equal(err.trace, 'a1b2c3d4e5f60718a1b2c3d4e5f60718',
      'the OTel trace id IS the bench trace id');
    assert.equal(err.fields.span_id, '0102030405060708');
    assert.equal(err.fields['http.status_code'], '500');
    assert.equal(err.fields.dropped_attributes, '3', 'dropped attributes are surfaced');
    assert.equal(err.fields['service.name'], 'My Checkout API!',
      'resource attributes ride every record');
  });

  it('OTLP/JSON metrics: gauge and sum become readings; histograms are summarized', async () => {
    await postJson('/v1/metrics', {
      resourceMetrics: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'meter' } }] },
        scopeMetrics: [{ metrics: [
          { name: 'queue.depth', gauge: { dataPoints: [{ asInt: '17' }] } },
          { name: 'http.requests', sum: { dataPoints: [{ asDouble: 1234.5 }] } },
          { name: 'http.latency', histogram: { dataPoints: [{ count: '42', sum: 630.5 }] } },
        ] }],
      }],
    });
    const recs = await waitFor(hub.url, (rs) => rs.length >= 3,
      { topic: 'otlp.meter', timeoutMs: 15000 });
    const m = (name) => recs.map((r) => r.event).find((e) => e.metric?.name === name);
    assert.equal(m('queue.depth').metric.value, 17);
    assert.equal(m('http.requests').metric.value, 1234.5);
    const h = m('http.latency.count');
    assert.equal(h.metric.value, 42);
    assert.match(h.msg, /summarized/, 'histograms say they are summarized, never invented');
  });

  it('OTLP/JSON traces: spans arrive as trace-carrying events with duration', async () => {
    await postJson('/v1/traces', {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'tracer' } }] },
        scopeSpans: [{ spans: [{
          traceId: 'deadbeefdeadbeefdeadbeefdeadbeef',
          spanId: 'cafebabecafebabe',
          name: 'GET /checkout',
          startTimeUnixNano: '1757000000000000000',
          endTimeUnixNano: '1757000000250000000',
          status: { code: 2, message: 'boom' },
        }] }],
      }],
    });
    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => /GET \/checkout/.test(r.event?.msg ?? '')),
      { topic: 'otlp.tracer', timeoutMs: 15000 });
    const span = recs.map((r) => r.event).find((e) => /GET \/checkout/.test(e.msg));
    assert.equal(span.trace, 'deadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(span.fields.duration_ms, '250');
    assert.equal(span.level, 'WARN', 'an error-status span is worth a WARN');
    assert.equal(span.fields.status, 'boom');
  });

  it('rejects the oversized and the malformed without dying', async () => {
    const big = await fetch(otlp('/v1/logs'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(9 * 1024 * 1024, 0x20),
    }).then((r) => r.status).catch(() => 413);
    assert.equal(big, 413);
    const bad = await fetch(otlp('/v1/logs'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: 'not json{',
    });
    assert.equal(bad.status, 400);
    const badPb = await fetch(otlp('/v1/logs'), {
      method: 'POST', headers: { 'content-type': 'application/x-protobuf' },
      body: Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x7f]),   // length far past the end
    });
    assert.equal(badPb.status, 400, 'malformed protobuf is a 400, never a crash');
    // And the server is still alive to say so.
    const ok = await postJson('/v1/logs', { resourceLogs: [] });
    assert.equal(ok.status, 200);
  });

  it('OTLP/protobuf logs and metrics, hand-encoded: the decoder proven byte by byte', async () => {
    // LogRecord: severity 17, text ERROR, body, one attribute, trace+span.
    const logRecord = Buffer.concat([
      u64(1, 1757000001000000000n),                    // time_unix_nano
      vi(2, 17),                                       // severity_number = ERROR band
      ld(3, 'ERROR'),                                  // severity_text
      ld(5, strVal('protobuf says hello')),            // body
      ld(6, kv('k8s.pod', strVal('checkout-7f'))),     // attribute (KeyValue)
      vi(7, 2),                                        // dropped_attributes_count
      ld(9, Buffer.from('a1b2c3d4e5f60718a1b2c3d4e5f60718', 'hex')), // trace_id
      ld(10, Buffer.from('0102030405060708', 'hex')),  // span_id
    ]);
    const req = ld(1, Buffer.concat([                  // resource_logs
      ld(1, resource('pb-service')),                   // resource
      ld(2, ld(2, logRecord)),                         // scope_logs { log_records }
    ]));
    const r = await fetch(otlp('/v1/logs'), {
      method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: req,
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /x-protobuf/);
    assert.equal((await r.arrayBuffer()).byteLength, 0,
      'an empty protobuf response message is zero bytes, and that is success');

    const recs = await waitFor(hub.url,
      (rs) => rs.some((x) => /protobuf says hello/.test(x.event?.msg ?? '')),
      { topic: 'otlp.pb-service', timeoutMs: 15000 });
    const e = recs.map((x) => x.event).find((x) => /protobuf says hello/.test(x.msg));
    assertValidEvent(e, 'pb-log');
    assert.equal(e.level, 'ERROR');
    assert.equal(e.trace, 'a1b2c3d4e5f60718a1b2c3d4e5f60718');
    assert.equal(e.fields.span_id, '0102030405060708');
    assert.equal(e.fields['k8s.pod'], 'checkout-7f');
    assert.equal(e.fields.dropped_attributes, '2');
    assert.equal(e.ts, '2025-09-04T15:33:21.000Z', 'timeUnixNano becomes the ts');

    // A gauge (as_double) and a histogram (count + sum), same wire.
    const gaugePoint = dbl(4, 58.9);                   // NumberDataPoint.as_double
    const histPoint = Buffer.concat([u64(4, 42n), dbl(5, 630.5)]); // count, sum
    const metricsReq = ld(1, Buffer.concat([           // resource_metrics
      ld(1, resource('pb-meter')),
      ld(2, Buffer.concat([                            // scope_metrics
        ld(2, Buffer.concat([ld(1, 'fps'), ld(5, ld(1, gaugePoint))])),        // gauge = 5
        ld(2, Buffer.concat([ld(1, 'latency'), ld(9, ld(1, histPoint))])),     // histogram = 9
      ])),
    ]));
    const mr = await fetch(otlp('/v1/metrics'), {
      method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: metricsReq,
    });
    assert.equal(mr.status, 200);
    const mrecs = await waitFor(hub.url, (rs) => rs.length >= 2,
      { topic: 'otlp.pb-meter', timeoutMs: 15000 });
    const mm = (n) => mrecs.map((x) => x.event).find((x) => x.metric?.name === n);
    assert.equal(mm('fps').metric.value, 58.9);
    assert.equal(mm('latency.count').metric.value, 42);
    assert.match(mm('latency.count').msg, /sum 630.5.*summarized/);
  });
});
