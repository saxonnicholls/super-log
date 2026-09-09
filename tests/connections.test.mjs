//
//  tests/connections.test.mjs - superlog-connections against a stand-in ss.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A test host's connections are whatever happens to be open, so `ss` is played
//  by a shell script on PATH (the technique tests/gpu.test.mjs uses for
//  nvidia-smi). Two properties earn this file: the outbound connections become
//  a process -> endpoint TREE, and the failure a developer actually loses time
//  to - a socket stuck in SYN-SENT because the port is filtered/dropped - is an
//  edge-triggered WARN, and only after two checks so one poll never cries wolf.
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
  for (const u of ['sh', 'echo', 'cat']) {
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

async function conns(argv, { timeoutMs = 8000, path }) {
  await run('superlog-connections.mjs', ['--no-dns', ...argv],
    { url: hub.url, timeoutMs, env: { PATH: path } });
  const recs = await waitFor(hub.url, (r) => r.length > 0, { topic: 'net.', timeoutMs: 12000 });
  recs.forEach((r, i) => assertValidEvent(r.event, `net[${i}]`));
  return recs;
}
const treeOf = (recs) => {
  const r = recs.find((e) => e.topic.includes('.connections') && e.event?.fields?.tree);
  return r ? JSON.parse(r.event.fields.tree) : null;
};
const flatten = (n, out = []) => { out.push(n.name); (n.children ?? []).forEach((c) => flatten(c, out)); return out; };

before(async () => { hub = await startHub(); work = tempDir('superlog-conn-'); });
after(async () => { await hub?.stop(); removeDir(work); });

describe('superlog-connections', () => {
  it('renders outbound connections as a process -> endpoint tree', async () => {
    const path = bench({
      ss: `echo 'ESTAB 0 0 192.168.1.5:54321 93.184.216.34:443 users:(("curl",pid=123,fd=5))'`,
    });
    const recs = await conns(['--once'], { path });
    const tree = treeOf(recs);
    assert.ok(tree, 'a connections tree must be published');
    const lines = flatten(tree);
    assert.ok(lines.some((l) => /curl \(123\)/.test(l)), 'the owning process is a node');
    assert.ok(lines.some((l) => /93\.184\.216\.34:443\s+ESTABLISHED/.test(l)),
      'its remote endpoint and state hang under it');
  });

  it('warns when a connection is stuck in SYN-SENT - once, after two checks', async () => {
    const path = bench({
      ss: `echo 'SYN-SENT 0 1 192.168.1.5:54322 10.9.9.9:5432 users:(("psql",pid=456,fd=3))'`,
    });
    const recs = await conns(['--interval', '1'], { timeoutMs: 7000, path });
    const stuck = recs.filter((r) => r.event?.fields?.change === 'stuck');
    assert.ok(stuck.length >= 1, 'a stuck connection must say so');
    const warn = stuck.find((r) => r.event.level === 'WARN');
    assert.ok(warn, 'a filtered/dropped port is a WARN');
    assert.match(warn.event.msg, /cannot reach 10\.9\.9\.9:5432/);
    assert.match(warn.event.msg, /SYN-SENT/);
    assert.equal(stuck.filter((r) => r.event.level === 'WARN').length, 1,
      'it says so once, not every poll');
  });
});
