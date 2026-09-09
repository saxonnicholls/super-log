//
//  tests/versions.test.mjs - superlog-versions against stand-in tools.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A test host's toolchain is whatever is installed, so `node`/`python3` are
//  played by shell scripts on PATH (the technique tests/gpu.test.mjs uses).
//  What earns this file: the wire contract the commercial advisor consumes -
//  a version with its purl, scheme, provenance, scope and explicit state - is
//  emitted; a CHANGE carries before AND after; a tool not installed is an
//  explicit `absent`, never omitted; and --check-conflicts reads a list and
//  matches LOCALLY (no versions leave), stamping the hit "as of".
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { removeDir, run, startHub, tempDir, waitFor } from './harness.mjs';

let hub, work;
let binSeq = 0;

function bench(tools) {
  const dir = join(work, `bin${binSeq += 1}`);
  mkdirSync(dir);
  // `which` must find the stubs on the replaced PATH, so include it + a shell.
  for (const u of ['sh', 'echo', 'cat', 'which', 'head', 'tr', 'sw_vers', 'uname']) {
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

async function versionsRaw(argv, { timeoutMs = 8000, path }) {
  await run('superlog-versions.mjs', argv, { url: hub.url, timeoutMs, env: { PATH: path } });
  return waitFor(hub.url, (r) => r.length > 0, { topic: 'host.', timeoutMs: 12000 });
}
async function inventory(argv, opts) {
  const recs = await versionsRaw(argv, opts);
  const inv = recs.find((r) => r.event?.fields?.versions);
  return inv ? JSON.parse(inv.event.fields.versions) : [];
}

before(async () => { hub = await startHub(); work = tempDir('superlog-ver-'); });
after(async () => { await hub?.stop(); removeDir(work); });

describe('superlog-versions', () => {
  it('emits the wire-contract fact shape the advisor consumes', async () => {
    const path = bench({ node: 'echo v20.5.0', python3: 'echo "Python 3.11.4"' });
    const facts = await inventory(['--once'], { path });
    const node = facts.find((f) => f.tool === 'node');
    assert.ok(node, 'node fact present');
    assert.equal(node.version, '20.5.0');
    assert.equal(node.raw, 'v20.5.0');
    assert.equal(node.purl, 'pkg:generic/node@20.5.0');
    assert.equal(node.scheme, 'semver');
    assert.equal(node.provenance, '--version');
    assert.equal(node.state, 'present');
    assert.ok(node.scope, 'scope is set');
    const py = facts.find((f) => f.tool === 'python');
    assert.equal(py.version, '3.11.4');
    assert.equal(py.scheme, 'pep440', 'python declares pep440 ordering');
  });

  it('marks a tool that is not installed as explicitly absent, never omitted', async () => {
    const path = bench({ node: 'echo v20.5.0' });   // no gcc stub
    const facts = await inventory(['--once'], { path });
    const gcc = facts.find((f) => f.tool === 'gcc');
    assert.ok(gcc, 'gcc is still IN the watched set - absence is a positive fact');
    assert.equal(gcc.state, 'absent');
    assert.equal(gcc.version, undefined, 'absent must not carry a version');
  });

  it('reports a version change carrying BOTH before and after', async () => {
    const counter = join(work, 'poll');
    const path = bench({
      node: `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}\n` +
            'if [ "$n" -lt 1 ]; then echo v20.5.0; else echo v21.0.0; fi',
    });
    const recs = await versionsRaw(['--interval', '1'], { timeoutMs: 6000, path });
    const change = recs.find((r) => r.event?.fields?.change === 'changed' && r.event.fields.tool === 'node');
    assert.ok(change, 'a version change must be an event');
    assert.equal(change.event.fields.before, '20.5.0');
    assert.equal(change.event.fields.after, '21.0.0');
    assert.equal(change.event.level, 'WARN', 'a major bump is a WARN');
  });

  it('--check-conflicts matches a downloaded list LOCALLY and stamps it "as of"', async () => {
    const list = join(work, 'conflicts.json');
    writeFileSync(list, JSON.stringify({
      as_of: '2026-09-01',
      conflicts: [{ id: 'demo1', message: 'node 20 and python 3.11 do not get along here',
        tools: [{ tool: 'node', range: '>=20.0.0' }, { tool: 'python', range: '>=3.11.0' }] }],
    }));
    const path = bench({ node: 'echo v20.5.0', python3: 'echo "Python 3.11.4"' });
    const recs = await versionsRaw(['--once', '--check-conflicts', '--conflicts-url', list], { path });
    const hit = recs.find((r) => r.event?.fields?.change === 'conflict');
    assert.ok(hit, 'a matching conflict must be reported');
    assert.equal(hit.event.level, 'WARN');
    assert.match(hit.event.msg, /do not get along/);
    assert.match(hit.event.msg, /as of 2026-09-01/, 'stamped with the list date');
  });
});
