// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// B8 regression: a non-finite metric emitted "value":nan - invalid JSON - and
// the hub's structural embed-check let it through verbatim, so ONE diverged
// number from ONE producer broke every consumer's parse of the WHOLE /recent
// response. This proves the hub now refuses to embed a line carrying a bare
// nan/inf (it wraps it as a string instead), so the whole response still parses.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startHub, hubBuilt } from './harness.mjs';

const postRaw = (url, topic, body) => fetch(`${url}/ingest/${topic}`, {
  method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
});

describe('B8: a bare nan/inf metric cannot break the whole /recent response', { skip: !hubBuilt() }, () => {
  let hub;
  before(async () => { hub = await startHub(); });
  after(async () => { await hub?.stop?.(); });

  it('/recent stays valid JSON when a producer emits value:nan / value:inf', async () => {
    // Exactly what %.17g of a non-finite double produces - invalid JSON.
    await postRaw(hub.url, 'metric.nan', '{"v":1,"level":"DEBUG","metric":{"name":"diverged","value":nan}}');
    await postRaw(hub.url, 'metric.inf', '{"v":1,"level":"DEBUG","metric":{"name":"overflow","value":inf}}');
    await postRaw(hub.url, 'metric.ok', '{"v":1,"level":"DEBUG","msg":"CONTROL-OK","metric":{"name":"healthy","value":1.5}}');
    await new Promise((r) => setTimeout(r, 200));

    const text = await fetch(`${hub.url}/recent?topic=*&limit=50`).then((r) => r.text());
    // The whole response must parse - the blast radius of B8 was ALL readers.
    const parsed = JSON.parse(text);   // throws if the nan line was embedded verbatim
    assert.ok(text.includes('CONTROL-OK'), 'the control metric is served (the hub is live)');
    assert.ok(Array.isArray(parsed.events), 'the response is well-formed');
    // The nan line must not appear as a bare token; if present it is wrapped as a string.
    assert.ok(!/"value":\s*nan/.test(text) && !/"value":\s*inf/.test(text),
      'a bare nan/inf is never relayed verbatim');
  });
});
