//
//  tests/otlp-export.test.mjs - the OpenTelemetry OUTLET, against a real hub.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Nothing mocked but the far end: a real hub, the real superlog-otlp-export
//  process reading it over /ws, and a throwaway HTTP server standing in for an
//  OTLP backend. A bench event must arrive there as a well-formed OTLP/JSON
//  LogRecord (severity, body, service.name, trace id, attributes), and a bench
//  `metric` event as an OTLP gauge point - the exact inverse of what the inlet
//  accepts, so the round trip is honest.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { start, startHub } from './harness.mjs';

describe('superlog-otlp-export - bench -> OTLP/HTTP JSON', () => {
  let hub, exporter, backend, port;
  const captured = [];

  const ingest = (topic, ev) =>
    fetch(`${hub.url}/ingest/${topic}`, { method: 'POST', body: `${JSON.stringify(ev)}\n` });

  async function waitForCap(pred, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = captured.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error('no matching OTLP delivery captured');
  }

  before(async () => {
    hub = await startHub();

    backend = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; }).on('end', () => {
        let body = null;
        try { body = JSON.parse(b); } catch { /* leave null */ }
        captured.push({ path: req.url, ct: req.headers['content-type'], auth: req.headers.authorization || '', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((r) => backend.listen(0, '127.0.0.1', r));
    port = backend.address().port;

    exporter = start('superlog-otlp-export.mjs',
      ['--endpoint', `http://127.0.0.1:${port}`, '--header', 'authorization: Bearer T', '--flush-ms', '250'],
      { url: hub.url });
    await exporter.waitForStderr(/subscribed/);
  });

  after(async () => {
    try { exporter?.child.kill('SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => backend.close(r));
    await hub?.stop();
  });

  it('exports a bench event as a well-formed OTLP LogRecord', async () => {
    await ingest('app.pay', {
      v: 1, ts: new Date().toISOString(), seq: 0, session: 't', level: 'ERROR',
      origin: { runtime: 'node', app: 'pay', platform: 'macos', device: 'box' },
      tag: 'x', msg: 'db connection refused',
      trace: '0123456789abcdef0123456789abcdef', fields: { host: 'db1' },
    });

    const cap = await waitForCap((c) => c.path === '/v1/logs' && c.body?.resourceLogs);
    assert.equal(cap.ct, 'application/json');
    assert.equal(cap.auth, 'Bearer T', 'the --header auth reaches the backend');

    const rl = cap.body.resourceLogs[0];
    assert.equal(rl.resource.attributes.find((a) => a.key === 'service.name').value.stringValue, 'pay');
    const rec = rl.scopeLogs[0].logRecords[0];
    assert.equal(rec.severityText, 'ERROR');
    assert.equal(rec.severityNumber, 17);                 // ERROR band start
    assert.equal(rec.traceId, '0123456789abcdef0123456789abcdef');
    assert.equal(rec.body.stringValue, 'db connection refused');
    assert.ok(rec.attributes.some((a) => a.key === 'host' && a.value.stringValue === 'db1'),
      'a bench field becomes a log attribute');
    assert.ok(rec.attributes.some((a) => a.key === 'superlog.topic' && a.value.stringValue === 'app.pay'));
  });

  it('exports a bench metric as an OTLP gauge point', async () => {
    await ingest('app.pay', {
      v: 1, ts: new Date().toISOString(), seq: 1, session: 't', level: 'INFO',
      origin: { app: 'pay' }, tag: 'm', msg: 'queue.depth =17',
      metric: { name: 'queue.depth', value: 17 },
    });

    const cap = await waitForCap((c) => c.path === '/v1/metrics' && c.body?.resourceMetrics);
    const m = cap.body.resourceMetrics[0].scopeMetrics[0].metrics.find((x) => x.name === 'queue.depth');
    assert.ok(m, 'the queue.depth gauge is present');
    assert.equal(m.gauge.dataPoints[0].asDouble, 17);
  });

  it('a short bench trace id (not 16 bytes) rides as an attribute, not traceId', async () => {
    await ingest('app.pay', {
      v: 1, ts: new Date().toISOString(), seq: 2, session: 't', level: 'INFO',
      origin: { app: 'pay' }, tag: 'x', msg: 'short trace', trace: 'deadbeefcafef00d',
    });
    const cap = await waitForCap((c) => c.path === '/v1/logs'
      && c.body?.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.some((r) => r.body.stringValue === 'short trace'));
    const rec = cap.body.resourceLogs[0].scopeLogs[0].logRecords.find((r) => r.body.stringValue === 'short trace');
    assert.equal(rec.traceId, undefined, 'a 16-hex id does not fit OTLP traceId');
    assert.ok(rec.attributes.some((a) => a.key === 'superlog.trace' && a.value.stringValue === 'deadbeefcafef00d'));
  });
});
