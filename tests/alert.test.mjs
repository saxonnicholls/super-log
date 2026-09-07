//
//  tests/alert.test.mjs - the combo rule: correlation, said once.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A deploy alone is routine and an error alone is routine; the two inside
//  one window are the alarm. The assertion that earns this file: neither
//  condition alone fires, both together fire ONCE (cooldown, not per
//  event), and the alert lands back on the hub as alert.<name> beside its
//  causes.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertValidEvent, removeDir, start, startHub, tempDir, waitFor } from './harness.mjs';

let hub, work, alert;

const publish = (topic, ev) =>
  fetch(`${hub.url}/ingest/${topic}`, {
    method: 'POST', headers: { 'content-type': 'application/x-ndjson' },
    body: JSON.stringify({ v: 1, ts: new Date().toISOString(), level: 'INFO',
                           origin: { runtime: 'node' }, msg: 'x', ...ev }),
  });

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-alert-');
  const cfg = join(work, 'alerts.json');
  writeFileSync(cfg, JSON.stringify({
    notify: ['hub'],
    rules: [{
      name: 'deploy went bad',
      combo: { all: [{ topic: 'git.', contains: 'pushed' },
                     { topic: 'app.', level: 'ERROR' }], window: 60 },
      cooldown: 300,
    }],
  }));
  alert = start('superlog-alert.mjs', ['--config', cfg, '--url', hub.url], {});
  await alert.waitForStderr(/watching .* 1 rule/);
});

after(async () => {
  await alert?.stop();
  await hub?.stop();
  removeDir(work);
});

describe('superlog-alert combo rules', () => {
  it('fires only when ALL conditions land inside the window, and only once', async () => {
    // One half of the correlation: nothing may fire.
    await publish('git.repo', { msg: 'pushed 3 commits to main' });
    await new Promise((r) => setTimeout(r, 800));
    const early = await fetch(`${hub.url}/recent?topic=alert.deploy-went-bad`).then((r) => r.json());
    assert.equal(early.events.length, 0, 'half a combo must not fire');

    // The other half arrives - now it is a correlation, and it fires once
    // despite two matching errors (cooldown owns the quiet period).
    await publish('app.web1.api', { level: 'ERROR', msg: 'boom after deploy' });
    await publish('app.web1.api', { level: 'ERROR', msg: 'boom again' });
    const recs = await waitFor(hub.url, (rs) => rs.length >= 1,
                               { topic: 'alert.deploy-went-bad', timeoutMs: 10000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `alert[${i}]`));
    assert.equal(recs.length, 1, 'a combo fires once per crossing, not per event');
    assert.match(recs[0].event.msg, /all 2 conditions met within 60s/);
  });
});
