//
//  tests/pcap.test.mjs - superlog-pcap against a stand-in tcpdump.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Live capture needs a raw socket, so `tcpdump` is played by a shell script on
//  PATH emitting captured tcpdump text (the technique tests/gpu.test.mjs uses).
//  What earns this file is the connection-diagnostic verdicts a developer needs:
//  a SYN that got a RST is REFUSED, a SYN that completed is reached, and a SYN
//  that got no reply at all is FILTERED - the hang. Metadata only throughout; no
//  payload is ever read because tcpdump -q never prints one.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertValidEvent, removeDir, run, startHub, tempDir, waitFor } from './harness.mjs';

let hub, work;
let binSeq = 0;

function bench(tools) {
  const dir = join(work, `bin${binSeq += 1}`);
  mkdirSync(dir);
  for (const u of ['sh', 'echo', 'sleep']) {
    for (const d of ['/bin', '/usr/bin']) {
      if (existsSync(join(d, u))) { symlinkSync(join(d, u), join(dir, u)); break; }
    }
  }
  for (const [name, body] of Object.entries(tools)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

before(async () => { hub = await startHub(); work = tempDir('superlog-pcap-'); });
after(async () => { await hub?.stop(); removeDir(work); });

describe('superlog-pcap', () => {
  it('turns handshakes into refused / reached / filtered verdicts', async () => {
    // 10.1.1.1 is "us" (via --local). Three attempts: one refused (RST), one
    // reached (SYN-ACK), one that never answers (SYN then silence -> filtered).
    const path = bench({
      tcpdump:
        "echo 'IP 10.1.1.1.50000 > 10.9.9.9.5432: Flags [S], length 0'\n" +
        "echo 'IP 10.1.1.1.50001 > 10.9.9.10.443: Flags [S], length 0'\n" +
        "echo 'IP 10.9.9.10.443 > 10.1.1.1.50001: Flags [R.], length 0'\n" +
        "echo 'IP 10.1.1.1.50002 > 10.9.9.11.80: Flags [S], length 0'\n" +
        "echo 'IP 10.9.9.11.80 > 10.1.1.1.50002: Flags [S.], length 0'\n" +
        'sleep 5',
    });
    await run('superlog-pcap.mjs', ['--local', '10.1.1.1', '--timeout', '2'],
      { url: hub.url, timeoutMs: 7000, env: { PATH: path } });
    const recs = await waitFor(hub.url, (r) => r.length > 0, { topic: 'pcap.', timeoutMs: 12000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `pcap[${i}]`));
    const evs = recs.map((r) => r.event);

    const refused = evs.find((e) => /10\.9\.9\.10:443 REFUSED/.test(e.msg ?? ''));
    assert.ok(refused, 'a RST to our SYN must read as REFUSED');
    assert.equal(refused.level, 'WARN');

    const reached = evs.find((e) => /reached 10\.9\.9\.11:80/.test(e.msg ?? ''));
    assert.ok(reached, 'a completed handshake must recover');
    assert.equal(reached.level, 'INFO');

    const filtered = evs.find((e) => /10\.9\.9\.9:5432 not answering/.test(e.msg ?? ''));
    assert.ok(filtered, 'a SYN with no reply at all must read as filtered/dropped');
    assert.equal(filtered.level, 'WARN');
  });

  it('reports packets/sec and MB/sec per port with --all', async () => {
    // Two packets to :443 and one to :22, all length 1000, over --all.
    const path = bench({
      tcpdump:
        "echo 'IP 10.1.1.1.50000 > 10.9.9.10.443: Flags [P.], length 1000'\n" +
        "echo 'IP 10.9.9.10.443 > 10.1.1.1.50000: Flags [P.], length 1000'\n" +
        "echo 'IP 10.1.1.1.50001 > 10.9.9.11.22: Flags [P.], length 1000'\n" +
        'sleep 5',
    });
    await run('superlog-pcap.mjs', ['--local', '10.1.1.1', '--all'],
      { url: hub.url, timeoutMs: 6000, env: { PATH: path } });
    // Wait for the cumulative reading that has counted all three packets, not
    // merely the first per-port tick: the piped lines arrive one at a time and
    // under load the interval timer can fire between them, so an early total_mb
    // carries fewer than three - correct, but it has not seen every packet yet.
    // Gate on the fact the assertions below need, then read the LATEST reading.
    const recs = await waitFor(hub.url,
      (r) => r.some((x) => x.event?.metric?.name === 'pcap.total_mb'
        && Number(x.event.fields?.total_pkts) >= 3),
      { topic: 'pcap.', timeoutMs: 12000 });
    const evs = recs.map((r) => r.event);
    const latest = (pred) => evs.filter(pred).at(-1);
    const p443 = latest((e) => e.fields?.port === '443' && e.metric);
    assert.ok(p443, 'a per-port rate for 443 must be published');
    assert.equal(p443.level, 'DEBUG', 'rates are readings, out of a default INFO view');
    assert.ok(Number(p443.fields.pps) > 0, 'packets/sec is measured');
    assert.ok(p443.metric.value > 0, 'MB/s is measured');
    assert.ok(Number(p443.fields.total_pkts) >= 2, 'cumulative total packets since start is carried');
    assert.ok(Number(p443.fields.total_mb) > 0, 'cumulative total MB since start is carried');

    const total = latest((e) => e.metric?.name === 'pcap.total_mb');
    assert.ok(total, 'a grand-total-since-start reading must be published');
    assert.ok(Number(total.fields.total_pkts) >= 3, 'the grand total counts every port');
  });
});
