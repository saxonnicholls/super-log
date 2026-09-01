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
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { assertValidEvent, removeDir, start, startHub, tempDir, waitFor } from './harness.mjs';

let hub, gw, work, manifest, app;
const PORT = 7391;
const APP_PORT = 7397;
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
  // the hub itself - real URLs that answer, no cloudflared in the loop -
  // plus two LOCAL webhook endpoints: one verifying Stripe signatures, one
  // relaying deliveries to a stand-in app.
  writeFileSync(manifest, JSON.stringify([
    { name: 'partner', url: `${hub.url}/healthz`, interval_s: 60 },
    { name: 'sig', local: true, secret: 'whsec_test' },
    { name: 'rly', local: true, relay: `http://127.0.0.1:${APP_PORT}/webhook` },
  ]));
  // The stand-in webhook handler: answers 201 and echoes what it saw.
  app = createServer((rq, rs) => {
    let b = '';
    rq.on('data', (d) => (b += d));
    rq.on('end', () => {
      rs.writeHead(201, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ path: rq.url, bytes: b.length }));
    });
  });
  await new Promise((r) => app.listen(APP_PORT, r));
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
  app?.close();
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

  it('webhook testing: Stripe signatures verified on arrival, relay hands back the app\'s answer', async () => {
    // A correctly signed delivery, the way Stripe signs: HMAC of "t.body".
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
    const good = await fetch(gwUrl('/hook/sig'), {
      method: 'POST', body: payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
    });
    assert.equal(good.status, 200);
    const seen = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.fields?.sig === 'verified'),
      { topic: 'wh.sig', timeoutMs: 10000 });
    seen.forEach((r, i) => assertValidEvent(r.event, `wh[${i}]`));
    const ok = seen.map((r) => r.event).find((e) => e.fields.sig === 'verified');
    assert.equal(ok.level, 'INFO');
    assert.ok(ok.fields.body.includes('payment_intent'), 'the payload rides along');

    // A tampered one: same shape, wrong mac - WARN, said plainly.
    await fetch(gwUrl('/hook/sig'), {
      method: 'POST', body: payload,
      headers: { 'content-type': 'application/json',
                 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` },
    });
    const bad = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.fields?.sig === 'FAILED'),
      { topic: 'wh.sig', timeoutMs: 10000 });
    assert.equal(bad.map((r) => r.event).find((e) => e.fields.sig === 'FAILED').level, 'WARN');

    // GitHub's scheme too: x-hub-signature-256 = sha256=<hmac of raw body>.
    const gh = 'sha256=' + createHmac('sha256', 'whsec_test').update(payload).digest('hex');
    await fetch(gwUrl('/hook/sig'), {
      method: 'POST', body: payload,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': gh },
    });
    const both = await waitFor(hub.url,
      (rs) => rs.filter((r) => r.event?.fields?.sig === 'verified').length >= 2,
      { topic: 'wh.sig', timeoutMs: 10000 });
    assert.ok(both.length, 'both HMAC schemes verify against the same secret');

    // Relay: the sender gets the HANDLER's response, the bench gets the record.
    const relayed = await fetch(gwUrl('/hook/rly'), {
      method: 'POST', body: '{"x":1}', headers: { 'content-type': 'application/json' },
    });
    assert.equal(relayed.status, 201, "the app's status passes through, not the gateway's");
    assert.equal((await relayed.json()).path, '/webhook', 'delivered to the configured path');
    const rec = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.fields?.relay_status === '201'),
      { topic: 'wh.rly', timeoutMs: 10000 });
    assert.ok(rec.length, 'every relayed delivery still lands on the bench');
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
