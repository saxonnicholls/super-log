// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// B2 regression: superlog-alarm's webhook door computed the HMAC correctly and
// then relayed a FORGED body to the operator's handler anyway, published it, and
// returned the handler's real response. And an unprovisioned name injected a
// wh.<name> event from anywhere. This proves both are now enforced: a bad
// signature is rejected BEFORE the relay, a good one still passes (the control
// that proves the path works), and an unprovisioned endpoint 404s.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { start, startHub, freePort, tempDir, removeDir } from './harness.mjs';

const SECRET = 'whsec_testsecret_do_not_relay_forgeries';
const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
});
const stripeSig = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('B2: the webhook door enforces its signature check', () => {
  let gw, hub, recorder, gwPort, recPort, dir, hits;

  before(async () => {
    hits = [];
    hub = await startHub();
    recPort = await freePort();
    recorder = createServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hits.push(b); res.writeHead(200); res.end('RELAYED-TO-OPERATOR'); });
    });
    await new Promise((r) => recorder.listen(recPort, '127.0.0.1', r));

    gwPort = await freePort();
    dir = tempDir('superlog-alarm-test-');
    const manifest = join(dir, 'endpoints.json');
    writeFileSync(manifest, JSON.stringify([
      { name: 'hooktest', local: true, secret: SECRET, relay: `http://127.0.0.1:${recPort}` },
    ]));
    // hub pointed at a dead port so publishes fail silently - we test the door.
    gw = start('superlog-alarm.mjs', ['--port', String(gwPort), '--provision', manifest],
      { url: hub.url });
    await gw.waitForStderr(/gateway on 127\.0\.0\.1/);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => {
    try { gw?.child?.kill('SIGKILL'); } catch { /* gone */ }
    recorder?.close();
    await hub?.stop?.();
    removeDir(dir);
  });

  const hook = (name) => `http://127.0.0.1:${gwPort}/hook/${name}`;

  it('rejects a FORGED signature with 401 and does NOT relay it', async () => {
    const body = JSON.stringify({ id: 'evt_forged', type: 'payout.paid' });
    const r = await post(hook('hooktest'), body, { 'stripe-signature': stripeSig(body, 'the-wrong-secret') });
    assert.equal(r.status, 401, 'a forged webhook is rejected, not answered');
    assert.equal(hits.length, 0, 'the forged body NEVER reached the operator handler');
  });

  it('accepts a VALID signature and relays it (control - the path works)', async () => {
    const body = JSON.stringify({ id: 'evt_real', type: 'payout.paid' });
    const r = await post(hook('hooktest'), body, { 'stripe-signature': stripeSig(body) });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.equal(text, 'RELAYED-TO-OPERATOR', 'a genuine webhook reaches the handler');
    assert.equal(hits.length, 1);
  });

  it('404s an unprovisioned endpoint (no arbitrary-topic injection)', async () => {
    const r = await post(hook('never-provisioned'), '{"x":1}');
    assert.equal(r.status, 404);
  });
});
