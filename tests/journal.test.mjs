// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// superlog-journal is the bench's durable record, and it is a /ws subscriber
// that dedups on the hub's seq. The hub's seq resets to 0 when it restarts, so a
// cursor carried across that restart sits above every new frame and the journal
// drops the whole new lifetime as "replay" - going silently dead exactly when
// the hub bounced, which is when its evidence matters most (observed live: 11
// hours of nothing while launchd still reported the service healthy). The fix is
// the epoch the hub already mints per lifetime: read it on /healthz before
// subscribing, and reset the cursor when it changes. This proves that.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { startHub, start, freePort, tempDir, removeDir, hubBuilt } from './harness.mjs';

const post = (url, topic, body) => fetch(`${url}/ingest/${topic}`, {
  method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const journalText = (dir) => readdirSync(dir)
  .filter((f) => f.endsWith('.ndjson'))
  .map((f) => readFileSync(join(dir, f), 'utf8')).join('');
async function waitForText(dir, needle, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (journalText(dir).includes(needle)) return true;
    await sleep(100);
  }
  return false;
}

describe('superlog-journal survives a hub restart (epoch cursor reset)', { skip: !hubBuilt() }, () => {
  let hub, journal, out, port;

  before(async () => {
    port = await freePort();
    out = tempDir('superlog-journal-test-');
    hub = await startHub({ port });
    journal = start('superlog-journal.mjs', ['--out', out, '--rotate-mb', '64'], { url: hub.url });
    await journal.waitForStderr(/subscribed/);
  });

  after(async () => {
    try { journal?.child?.kill('SIGKILL'); } catch { /* already gone */ }
    await hub?.stop?.();
    removeDir(out);
  });

  it('records the new hub lifetime after a restart on the same port', async () => {
    await post(hub.url, 'journal.x', JSON.stringify({ v: 1, msg: 'before-restart-UNIQ1' }));
    assert.ok(await waitForText(out, 'before-restart-UNIQ1'),
      'the first hub lifetime is journaled');

    // Restart on the SAME port: a fresh lifetime whose seq resets to 0. A cursor
    // held from the first hub now sits above every frame the new one emits.
    await hub.stop();
    await sleep(300);                       // let the port free
    hub = await startHub({ port });
    // Reconnect is on a 1s timer; the journal must notice the new epoch on
    // /healthz and reset its cursor. That log line is the readiness signal.
    await journal.waitForStderr(/cursor reset/, { timeoutMs: 15000 });

    await post(hub.url, 'journal.x', JSON.stringify({ v: 1, msg: 'after-restart-UNIQ2' }));
    assert.ok(await waitForText(out, 'after-restart-UNIQ2', 12000),
      'the post-restart lifetime is journaled - without the epoch reset this frame ' +
      'is dropped as replay because its seq is at or below the dead hub\'s cursor');
  });
});
