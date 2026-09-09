//
//  tests/epoch.test.mjs - the hub lifetime id, so a restart is detectable.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The hub's seq (and /recent's id cursor) reset to zero on restart. A consumer
//  that saved a cursor across a restart would find it above every new frame and
//  read the whole stream as already-seen replay - connected, healthy, silently
//  discarding everything. That happened on this bench and dropped an uplink for
//  five hours. The fix the hub owns is to make the restart DETECTABLE: a fresh
//  epoch per lifetime, on /healthz and on every /recent envelope, so a consumer
//  can see "different hub" on the first response and reset its cursor.
//
//  This proves the hub half: the epoch is present, the two surfaces agree, it
//  is stable within a run, and two hub lifetimes never share one.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startHub } from './harness.mjs';

const healthz = async (url) => (await fetch(`${url}/healthz`)).json();
const recentEnvelope = async (url) => (await fetch(`${url}/recent?topic=*`)).json();
const post = (url, topic, body) => fetch(`${url}/ingest/${topic}`, {
  method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
});

describe('hub epoch (restart detection)', () => {
  let a, b;
  before(async () => { a = await startHub(); b = await startHub(); });
  after(async () => { await a?.stop(); await b?.stop(); });

  it('appears on /healthz and /recent, and the two agree', async () => {
    await post(a.url, 'epoch.x', JSON.stringify({ v: 1, msg: 'hi' }));
    await new Promise((r) => setTimeout(r, 150));
    const h = await healthz(a.url);
    const rec = await recentEnvelope(a.url);
    assert.match(h.epoch ?? '', /^[0-9a-f]{16}$/, '/healthz carries a 16-hex epoch');
    assert.equal(rec.epoch, h.epoch, '/recent and /healthz must report the same epoch');
  });

  it('is distinct per hub lifetime', async () => {
    const [ha, hb] = [await healthz(a.url), await healthz(b.url)];
    assert.notEqual(ha.epoch, hb.epoch,
      'two hub lifetimes must have different epochs - that is how a restart is seen');
  });

  it('is stable within one lifetime', async () => {
    const [h1, h2] = [await healthz(a.url), await healthz(a.url)];
    assert.equal(h1.epoch, h2.epoch, 'the epoch must not change without a restart');
  });
});
