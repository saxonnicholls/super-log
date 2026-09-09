//
//  tests/topology.test.mjs - superlog-topology against stand-in network tools.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A test host has no fixed network, so the tools are played by shell scripts
//  on PATH emitting captured output - the same technique tests/gpu.test.mjs
//  uses for nvidia-smi. That exercises the whole path a real network takes:
//  the platform command selection (ip/arp/route on Linux, arp/route on macOS),
//  the tolerant parsers, the tree building and the route edge discipline. It
//  is also how the Linux code paths get verified at all - CI runs this on
//  Ubuntu, where the macOS bench never does.
//
//  Two properties earn this file. The LAN becomes a TREE rooted at this host
//  with the gateway and its neighbours under it. And a route is watched with
//  the house discipline: per-hop RTT is a DEBUG reading, but a target that
//  stops answering is an edge-triggered ERROR - and only after two checks, so
//  one unlucky poll never cries wolf.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertValidEvent, removeDir, run, startHub, tempDir, waitFor } from './harness.mjs';

let hub, work;
let binSeq = 0;

/** A PATH containing ONLY the tools named plus a shell and the utilities the
 *  stand-ins use - so the real ip/arp/route/traceroute are genuinely absent
 *  and the tailer runs against the stand-ins on both macOS and Linux. */
function bench(tools) {
  const dir = join(work, `bin${binSeq += 1}`);
  mkdirSync(dir);
  for (const u of ['sh', 'cat', 'sed', 'head', 'tr', 'grep', 'echo', 'printf']) {
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

// Gateway 192.168.9.1, one neighbour 192.168.9.10 - in the formats macOS and
// Linux each produce, so the same stand-ins serve the tailer on either OS.
const NET_TOOLS = {
  ip: 'case "$*" in\n' +
      '  "neigh") echo "192.168.9.10 dev eth0 lladdr aa:bb:cc:dd:ee:10 REACHABLE" ;;\n' +
      '  "route show default") echo "default via 192.168.9.1 dev eth0 proto dhcp" ;;\n' +
      'esac',
  arp: 'echo "? (192.168.9.10) at aa:bb:cc:dd:ee:10 on en0 ifscope [ethernet]"',
  route: '# macOS: route -n get default\n' +
         'echo "   gateway: 192.168.9.1"\n echo "  interface: en0"',
  ping: 'exit 0',
};
const traceOK = { traceroute: 'echo " 1  192.168.9.1  1.20 ms"\n' +
                              'echo " 2  10.0.0.1  5.50 ms"\n' +
                              'echo " 3  93.184.216.34  20.10 ms"' };
const traceDead = { traceroute: 'echo " 1  * * *"\n echo " 2  * * *"\n echo " 3  * * *"' };

before(async () => { hub = await startHub(); work = tempDir('superlog-topo-'); });
after(async () => { await hub?.stop(); removeDir(work); });

async function topo(argv, { timeoutMs = 8000, path }) {
  // --no-dns keeps the test hermetic: reverse-DNS reaches the real system
  // resolver, whose latency under load once made the route ticks flaky. Names
  // are not what these tests check; structure and edges are.
  await run('superlog-topology.mjs', ['--no-dns', ...argv], { url: hub.url, timeoutMs, env: { PATH: path } });
  const recs = await waitFor(hub.url, (r) => r.length > 0, { topic: 'net.', timeoutMs: 12000 });
  recs.forEach((r, i) => assertValidEvent(r.event, `net[${i}]`));
  return recs;
}
const treeOf = (recs, needle) => {
  const r = recs.find((e) => e.topic.includes(needle) && e.event?.fields?.tree);
  return r ? JSON.parse(r.event.fields.tree) : null;
};
const flatten = (node, out = []) => { out.push(node.name); (node.children ?? []).forEach((c) => flatten(c, out)); return out; };

describe('superlog-topology', () => {
  it('builds the LAN as a tree: this host, its gateway, the devices under it', async () => {
    const path = bench({ ...NET_TOOLS });
    const recs = await topo(['--once'], { path });
    const tree = treeOf(recs, '.topology');
    assert.ok(tree, 'a topology tree must be published');
    const lines = flatten(tree);
    assert.match(lines[0], /this machine/, 'the root is this host');
    assert.ok(lines.some((l) => /gateway 192\.168\.9\.1/.test(l)), 'the gateway is a node');
    assert.ok(lines.some((l) => /192\.168\.9\.10/.test(l)), 'a neighbour hangs under it');
  });

  it('watches a route: the hops as a tree, and per-hop RTT as DEBUG readings', async () => {
    const path = bench({ ...NET_TOOLS, ...traceOK });
    const recs = await topo(['--interval', '1', '--route-interval', '1', '--to', '93.184.216.34'],
                            { timeoutMs: 9000, path });
    const tree = treeOf(recs, '.route.');
    assert.ok(tree, 'a route tree must be published');
    assert.ok(flatten(tree).some((l) => /93\.184\.216\.34/.test(l)), 'the target is the last hop');

    const rtts = recs.filter((r) => r.event?.metric?.name === 'net.route.hop_rtt_ms');
    assert.ok(rtts.length > 0, 'each responding hop publishes an RTT reading');
    assert.equal(rtts[0].event.level, 'DEBUG', 'readings stay out of a default INFO view');
  });

  it('says a route went unreachable - once, and only after two checks', async () => {
    const path = bench({ ...NET_TOOLS, ...traceDead });
    const recs = await topo(['--interval', '1', '--route-interval', '1', '--to', '10.9.9.9'],
                            { timeoutMs: 11000, path });
    const reach = recs.filter((r) => r.event?.fields?.change === 'reachability');
    assert.ok(reach.length >= 1, 'an unreachable target must say so');
    const err = reach.find((r) => r.event.level === 'ERROR');
    assert.ok(err, 'unreachable is an ERROR');
    assert.match(err.event.msg, /UNREACHABLE/);
    assert.equal(reach.filter((r) => r.event.level === 'ERROR').length, 1,
                 'it says so once, not every poll');
  });
});
