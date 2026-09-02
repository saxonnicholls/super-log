//
//  tests/netstate.test.mjs - the network state watcher, on the real network.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Nothing mocked: the inventory test reads THIS machine's real
//  interfaces, gateway and resolvers; the degradation test pings
//  192.0.2.1 (TEST-NET-1, reserved never-routable space) and requires the
//  edge alarm to fire with its traceroute diagnosis on the same trace id.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertValidEvent, start, startHub, waitFor } from './harness.mjs';
import { hostname } from 'node:os';

let hub;
const topic = `net.${hostname().split('.')[0].toLowerCase()}.state`;

before(async () => { hub = await startHub(); });
after(async () => { await hub?.stop(); });

describe('superlog-netstate', () => {
  it('--once publishes a real inventory: interfaces, gateway, resolvers', async () => {
    const tail = start('superlog-netstate.mjs', ['--once', '--url', hub.url], {});
    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => /default gateway|NO default gateway/.test(r.event?.msg ?? '')) &&
              rs.some((r) => /DNS resolvers:/.test(r.event?.msg ?? '')) &&
              rs.some((r) => /device\(s\) in the ARP table/.test(r.event?.msg ?? '')),
      { topic, timeoutMs: 20000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `net[${i}]`));
    await tail.stop();
  });

  it('a dead path is an edge with a traceroute on the same trace', async () => {
    // TEST-NET-1 never routes; two 1s polls at 100% loss cross the edge.
    const tail = start('superlog-netstate.mjs',
      ['--ping', '192.0.2.1|1', '--interval', '3600', '--url', hub.url], {});
    await tail.waitForStderr(/pinging .*192\.0\.2\.1/);

    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => /path to 192\.0\.2\.1 is DOWN/.test(r.event?.msg ?? '')),
      { topic, timeoutMs: 45000 });
    const edge = recs.map((r) => r.event).find((e) => /is DOWN/.test(e.msg));
    assert.equal(edge.level, 'ERROR');
    assert.ok(edge.trace, 'the edge carries a trace id for its diagnosis');

    // Readings arrived as metrics even while the path was dead.
    assert.ok(recs.some((r) => r.event?.metric?.name === 'net.loss_pct' &&
                               r.event.metric.value === 100),
              'loss is a reading, not just an alarm');

    // The diagnosis lands beside the alarm, same trace - traceroute to
    // unroutable space can take a while; patience, not polling.
    const diag = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.trace === edge.trace &&
                             /captured at failure/.test(r.event?.msg ?? '')),
      { topic, timeoutMs: 90000 });
    assert.ok(diag.length, 'the alarm arrives carrying its own traceroute');
    await tail.stop();
  });
});
