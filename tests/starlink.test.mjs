//
//  tests/starlink.test.mjs - the dish watcher, against the real dish.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Runs only where a dish answers (skipped in CI, real on the bench,
//  like cobol needing cobc): --once must land the baseline line and at
//  least one reading on a real hub. A missing reading staying absent is
//  part of the contract - the drop rate is often unreported and must
//  never appear as zero.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { assertValidEvent, start, startHub, waitFor } from './harness.mjs';

const dish = process.env.SUPER_LOG_STARLINK_DISH ?? '192.168.100.1:9200';
const probe = spawnSync('grpcurl',
  ['-plaintext', '-max-time', '5', dish, 'list'], { encoding: 'utf8' });
const have = probe.status === 0 && /SpaceX/.test(probe.stdout ?? '');

let hub;
before(async () => { hub = await startHub(); });
after(async () => { await hub?.stop(); });

describe('superlog-starlink', () => {
  it('--once publishes the baseline and real readings',
     { skip: !have && 'no dish answering (grpcurl/reachability)' }, async () => {
    const tail = start('superlog-starlink.mjs', ['--once', '--url', hub.url], {});
    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => /watching the dish/.test(r.event?.msg ?? '')) &&
              rs.some((r) => r.event?.metric?.name === 'starlink.pop_latency_ms'),
      { topic: 'starlink.dishy', timeoutMs: 30000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `dish[${i}]`));
    const lat = recs.map((r) => r.event)
      .find((e) => e.metric?.name === 'starlink.pop_latency_ms');
    assert.ok(lat.metric.value > 0 && lat.metric.value < 5000,
              'latency is a real measurement, not a placeholder');
    await tail.stop();
  });
});
