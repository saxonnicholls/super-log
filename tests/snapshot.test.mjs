//
//  tests/snapshot.test.mjs - /recent?snapshot=1 is a FAIR board seed.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The ring is per-topic so a firehose is expensive only to itself - but a
//  plain global `limit=N` read gives that fairness straight back: it returns
//  the newest N events across all topics, and a loud neighbour crowds a quiet
//  state stream out of every wildcard read. That is exactly what left the
//  viewers' Versions/Devices/Topology windows blank behind a busy bench.
//  snapshot=1 hands over each topic's own newest slice instead, so a viewer
//  that just loaded is populated at once. This proves the difference.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { recent, recentText, startHub } from './harness.mjs';

async function ingest(url, topic, obj) {
  const r = await fetch(`${url}/ingest/${encodeURIComponent(topic)}`, {
    method: 'POST', body: `${JSON.stringify(obj)}\n`,
  });
  if (r.status !== 202) throw new Error(`ingest ${topic}: ${r.status}`);
}

describe('recent snapshot - the fair per-topic board seed', () => {
  let hub;

  before(async () => {
    hub = await startHub();
    // The quiet state event FIRST, so it holds the lowest id and a global
    // newest-N read is guaranteed to crowd it out.
    await ingest(hub.url, 'state.quiet',
      { level: 'INFO', msg: 'the quiet one', fields: { versions: 'x' } });
    // ...then a firehose from a single loud topic.
    for (let i = 0; i < 120; i++)
      await ingest(hub.url, 'noise.fire', { level: 'INFO', msg: `noise ${i}` });
  });

  after(async () => { await hub?.stop?.(); });

  it('a global limit=50 read is crushed by the firehose', async () => {
    const topics = new Set((await recent(hub.url, { limit: 50 })).map((r) => r.topic));
    assert.equal(topics.has('noise.fire'), true);
    assert.equal(topics.has('state.quiet'), false,
      'the firehose should have crowded the quiet topic out of a global read');
  });

  it('snapshot returns every topic, the quiet one included and intact', async () => {
    const rows = await recent(hub.url, { snapshot: true, limit: 5 });
    const byTopic = {};
    for (const r of rows) byTopic[r.topic] = (byTopic[r.topic] || 0) + 1;

    assert.equal('state.quiet' in byTopic, true, 'snapshot must keep the quiet topic');
    assert.ok(byTopic['noise.fire'] <= 5, 'per-topic cap bounds even the firehose');

    const quiet = rows.find((r) => r.topic === 'state.quiet');
    assert.equal(quiet.event.fields.versions, 'x', 'the seeded event survives end to end');
  });

  it('snapshot is a seed, not a tail: a live cursor and no truncation', async () => {
    const body = JSON.parse(await recentText(hub.url, { snapshot: true, limit: 5 }));
    assert.equal(body.truncated, false);
    assert.equal(body.missed, false);
    assert.equal(body.next, body.newest, 'next is the live edge to poll from');
  });
});
