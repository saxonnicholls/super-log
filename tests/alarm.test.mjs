//
//  tests/alarm.test.mjs - the inbound gateway, held to the 4.7-day lesson.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Three promises earn this file, each the negation of a real failure: a
//  key that fires 113 times is ONE alarm with a count (the pager lesson);
//  recovery closes the loop so resolved and forgotten look different; and
//  a checker that stops heartbeating becomes a CRITICAL raised by the
//  GATEWAY - the one alarm the dead watcher cannot send. Plus the boring
//  one that guards the door: no token, no entry.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertValidEvent, removeDir, start, startHub, tempDir, waitFor } from './harness.mjs';

let hub, gw, work, manifest;
const PORT = 7391;
const TOKEN = 'test-alarm-token';
const T = { 'x-superlog-token': TOKEN, 'content-type': 'application/json' };
const gwUrl = (p) => `http://127.0.0.1:${PORT}${p}`;

const post = async (path, body, headers = T) => {
  const r = await fetch(gwUrl(path), { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-alarm-');
  manifest = join(work, 'endpoints.json');
  // A watch-only manifest entry and an env-declared route, both pointed at
  // the hub itself - real URLs that answer, no cloudflared in the loop.
  writeFileSync(manifest, JSON.stringify(
    [{ name: 'partner', url: `${hub.url}/healthz`, interval_s: 60 }]));
  gw = start('superlog-alarm.mjs',
    ['--tunnel', 'none', '--port', String(PORT), '--token', TOKEN,
     '--notify', '', '--url', hub.url, '--provision', manifest,
     '--endpoints-file', join(work, 'endpoints.env')],
    { env: { SUPER_LOG_TUNNEL_FAKE: `${hub.url}/healthz|60` } });
  await gw.waitForStderr(/gateway on :7391/);
});

after(async () => {
  await gw?.stop();
  await hub?.stop();
  removeDir(work);
});

describe('superlog-alarm', () => {
  it('no token, no entry; a bad body is tolerated, not fatal', async () => {
    assert.equal((await post('/alarm/kms', { msg: 'x' }, { 'content-type': 'application/json' })).status, 401);
    const r = await fetch(gwUrl('/alarm/kms'), { method: 'POST', headers: T, body: 'not json{' });
    assert.equal(r.status, 200, 'a mangled body is still an alarm - tolerant-reader rule');
  });

  it('dedups by key with repeat counts, and recovery closes the loop', async () => {
    for (let i = 1; i <= 3; i++) {
      const { status, body } = await post('/alarm/kms',
        { key: 'kek_not_loaded', level: 'CRITICAL', msg: 'KEK not loaded' });
      assert.equal(status, 200);
      assert.equal(body.repeat, i, 'each re-fire increments ONE counter');
    }
    const rec = await post('/alarm/kms', { key: 'kek_not_loaded', recovered: true });
    assert.equal(rec.body.recovered, 'kek_not_loaded');

    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => /RECOVERED: kek_not_loaded/.test(r.event?.msg ?? '')),
      { topic: 'alert.inbound.kms', timeoutMs: 10000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `alarm[${i}]`));
    const evs = recs.map((r) => r.event);
    assert.deepEqual(evs.filter((e) => e.level === 'CRITICAL').map((e) => e.fields.repeat),
                     ['1', '2', '3']);
    const recovered = evs.find((e) => /RECOVERED/.test(e.msg));
    assert.equal(recovered.level, 'INFO');
    assert.match(recovered.msg, /fired 3x/);

    // And the gateway's own books agree: this key is no longer firing.
    // (The tolerant-body test above left 'kms' itself firing, correctly.)
    const h = await fetch(gwUrl('/healthz')).then((r) => r.json());
    assert.ok(!h.firing.some((f) => f.key === 'kek_not_loaded'),
              'a recovered key must leave the firing list');
  });

  it('a checker that stops heartbeating becomes CRITICAL monitor_dead', async () => {
    await post('/heartbeat/peg-checker', { interval: 1 });
    // Miss 3 intervals; the sweep runs every 15s, so this is patience, not
    // polling - the dead-man exists precisely for when nothing arrives.
    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => /monitor_dead:peg-checker/.test(r.event?.msg ?? '')),
      { topic: 'alert.inbound.monitor-dead', timeoutMs: 30000 });
    const dead = recs.map((r) => r.event).find((e) => /monitor_dead/.test(e.msg));
    assert.equal(dead.level, 'CRITICAL');
    assert.equal(dead.fields.key, 'monitor_dead:peg-checker');

    // The checker returns; the gateway says so.
    await post('/heartbeat/peg-checker', { interval: 60 });
    const rec2 = await waitFor(hub.url,
      (rs) => rs.some((r) => /RECOVERED: monitor_dead:peg-checker/.test(r.event?.msg ?? '')),
      { topic: 'alert.inbound.monitor-dead', timeoutMs: 10000 });
    assert.ok(rec2.length);
  });

  it('every watched route gets its own selftest verdict, and the manifest is declarative', async () => {
    // Both routes - env-declared and manifest-declared - are on the books.
    const h = await fetch(gwUrl('/healthz')).then((r) => r.json());
    const names = h.tunnels.map((t) => t.name);
    assert.ok(names.includes('FAKE'), 'SUPER_LOG_TUNNEL_FAKE joins the roster');
    assert.ok(names.includes('PARTNER'), 'a manifest url entry joins the roster');

    // The test button tests ALL of them, not just the flagship tunnel.
    const st = await fetch(gwUrl('/selftest'), { method: 'POST' }).then((r) => r.json());
    for (const route of ['route FAKE', 'route PARTNER']) {
      const s = st.steps.find((x) => x.name === route);
      assert.ok(s, `selftest must include ${route}`);
      assert.equal(s.ok, true, `${route}: ${s?.detail}`);
    }

    // Declarative means deletion: empty the file, the route disappears -
    // but only the file's own entries; the env-declared one stays.
    writeFileSync(manifest, '[]');
    const gone = await (async () => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const now = await fetch(gwUrl('/healthz')).then((r) => r.json());
        if (!now.tunnels.some((t) => t.name === 'PARTNER'))
          return now.tunnels.map((t) => t.name);
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    assert.ok(gone, 'a manifest entry removed from the file must leave the roster');
    assert.ok(gone.includes('FAKE'), 'env-declared routes are not the manifest\'s to kill');
  });

  it('selftest reports steps even with the tunnel off, and healthz lists channels', async () => {
    const st = await fetch(gwUrl('/selftest'), { method: 'POST' }).then((r) => r.json());
    const names = st.steps.map((s) => s.name);
    assert.ok(names.includes('hub reachable'));
    assert.ok(names.includes('local delivery (tunnel bypassed)'),
              'no tunnel must still prove local delivery rather than skipping silently');
    const h = await fetch(gwUrl('/healthz')).then((r) => r.json());
    assert.ok(Array.isArray(h.channels) && h.channels.some((c) => c.name === 'telegram'),
              'the channel roster is part of the diagnostics');
  });
});
