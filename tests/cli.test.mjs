// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The `superlog` CLI is the first thing a new user types, so its contract is
// worth a guard: help and list work without a hub, an unknown command fails
// cleanly, a tailer name is redirected to `start`, and a read command emits
// valid NDJSON (so `| jq` works) against a real hub.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BIN, REPO, startHub, hubBuilt } from './harness.mjs';

const CLI = join(BIN, 'superlog.mjs');
const run = (args, env = {}) => execFileSync('node', [CLI, ...args],
  { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
const runFail = (args) => {
  try { execFileSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return 0; }
  catch (e) { return e.status ?? 1; }
};

describe('superlog CLI', () => {
  it('help works without a hub and names its sections', () => {
    const out = run(['--help']);
    assert.match(out, /USAGE/);
    assert.match(out, /READ THE BENCH/);
    assert.match(out, /superlog tee/);
  });

  it('list names real tailers, and --version matches package.json', () => {
    assert.match(run(['list']), /\bvitals\b/);
    const v = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
    assert.equal(run(['--version']).trim(), v);
  });

  it('an unknown command exits 2; a tailer name is redirected to start', () => {
    assert.equal(runFail(['definitely-not-a-command']), 2);
    // `serial` is a tailer, not a read command - it should point at `start`.
    let out = '';
    try { execFileSync('node', [CLI, 'serial'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { out = (e.stderr ?? '') + (e.stdout ?? ''); assert.equal(e.status, 2); }
    assert.match(out, /start serial/);
  });

  describe('reading the bench emits NDJSON for jq', { skip: !hubBuilt() }, () => {
    let hub;
    before(async () => { hub = await startHub(); });
    after(async () => { await hub?.stop?.(); });

    it('`superlog alarms` piped is one valid JSON object per line', async () => {
      await fetch(`${hub.url}/ingest/alert.smoke`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' },
        body: JSON.stringify({ v: 1, level: 'ERROR', msg: 'smoke alarm', fields: { key: 'smoke-1' } }),
      });
      await new Promise((r) => setTimeout(r, 200));
      const out = run(['alarms'], { SUPER_LOG_URL: hub.url });     // piped => NDJSON
      const lines = out.trim().split('\n').filter(Boolean);
      assert.ok(lines.length >= 1, 'at least the alarm we posted');
      const rows = lines.map((l) => JSON.parse(l));                // throws if not valid JSON
      assert.ok(rows.some((r) => r.topic === 'alert.smoke' && r.msg === 'smoke alarm'));
    });
  });
});
