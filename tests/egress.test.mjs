//
//  tests/egress.test.mjs - the per-topic egress policy (the "scalpel").
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A named topic under SUPER_LOG_NO_EGRESS is a security control: the hub
//  accepts it but SERVES IT TO NOTHING - never on /ws, never from /recent, so
//  it cannot leave the machine. This proves that, and it proves the test can
//  tell: a control hub with no policy serves the same topic, so an assertion
//  that "it did not appear" would fail if the cut were not working - the
//  failing-then-passing pair in one file.
//
//  It also proves the two ways the leak could sneak back: a NEW subscriber's
//  replay-on-connect (a no-egress topic never enters the WS ring, so it never
//  replays), and /recent as well as /ws.
//
//  Honest limitation, and the whole of today's claim: "served to nothing" -
//  NOT "journaled locally", because the on-disk journal is itself a /ws
//  subscriber, so a no-egress topic reaches no journal either. Hub-internal
//  journaling is the scheduled follow-up.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { recentText, startHub } from './harness.mjs';

const SECRET = 'secrets.token';
const NORMAL = 'normal.info';
const noWs = typeof WebSocket === 'undefined' ? 'needs global WebSocket (Node >= 22)' : null;

const line = (topic, msg) => JSON.stringify({
  v: 1, ts: new Date().toISOString(), seq: 0, session: 'test', level: 'INFO',
  origin: { runtime: 'test', app: 't', platform: 'host', device: 'd' }, tag: 't', msg,
});
const post = (url, topic, msg) => fetch(`${url}/ingest/${topic}`, {
  method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: line(topic, msg),
});

// Open /ws?topic=*, optionally run `act` once connected, collect the topics of
// every frame seen in the window, then close. Returns the topics list.
async function wsTopics(url, { act, ms = 800 } = {}) {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws?topic=*');
  const topics = [];
  ws.addEventListener('message', (ev) => {
    try {
      const f = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (f && f.topic) topics.push(f.topic);
    } catch { /* not a frame we care about */ }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
    setTimeout(() => rej(new Error('ws open timeout')), 5000).unref?.();
  });
  if (act) await act();
  await new Promise((r) => setTimeout(r, ms));
  ws.close();
  return topics;
}

let hubOpen, hubCut, hubAll;

before(async () => {
  hubOpen = await startHub();                                           // no policy
  hubCut = await startHub({ env: { SUPER_LOG_NO_EGRESS: 'secrets.*,vault.*' } });
  hubAll = await startHub({ env: { SUPER_LOG_NO_EGRESS: '*' } });       // the fire alarm
});
after(async () => { await hubOpen?.stop(); await hubCut?.stop(); await hubAll?.stop(); });

describe('egress: the per-topic scalpel', () => {
  it('CONTROL: with no policy, the secret topic IS served on /recent (the test can see a leak)', async () => {
    await post(hubOpen.url, SECRET, 'CONTROL');
    await post(hubOpen.url, NORMAL, 'CONTROL');
    await new Promise((r) => setTimeout(r, 200));
    const txt = await recentText(hubOpen.url);
    assert.ok(txt.includes(NORMAL), 'a normal topic is served');
    assert.ok(txt.includes(SECRET),
      'without a policy the secret topic IS served - so the treatment assertions below are real');
  });

  it('with SUPER_LOG_NO_EGRESS, the no-egress topic is served to NOTHING on /recent', async () => {
    await post(hubCut.url, SECRET, 'MUST-NOT-LEAK');
    await post(hubCut.url, NORMAL, 'ok');
    await new Promise((r) => setTimeout(r, 200));
    const txt = await recentText(hubCut.url);
    assert.ok(txt.includes(NORMAL), 'a normal topic is still served');
    assert.ok(!txt.includes(SECRET), '/recent must never return a no-egress topic');
    assert.ok(!txt.includes('MUST-NOT-LEAK'), '/recent must not carry the no-egress payload either');
  });

  it('CONTROL: with no policy, the secret topic IS broadcast on /ws', async (t) => {
    if (noWs) return t.skip(noWs);
    const topics = await wsTopics(hubOpen.url, {
      act: async () => { await post(hubOpen.url, SECRET, 'C'); await post(hubOpen.url, NORMAL, 'C'); },
    });
    assert.ok(topics.includes(NORMAL));
    assert.ok(topics.includes(SECRET), 'without a policy the secret topic IS broadcast - the WS assertion is real');
  });

  it('with SUPER_LOG_NO_EGRESS, the no-egress topic NEVER reaches a /ws subscriber', async (t) => {
    if (noWs) return t.skip(noWs);
    const topics = await wsTopics(hubCut.url, {
      act: async () => { await post(hubCut.url, SECRET, 'x'); await post(hubCut.url, NORMAL, 'ok'); },
    });
    assert.ok(topics.includes(NORMAL), 'a normal topic is still broadcast');
    assert.ok(!topics.includes(SECRET), 'a no-egress topic must never be broadcast on /ws');
  });

  it('holds across a reconnect: a NEW subscriber never replays the no-egress topic', async (t) => {
    if (noWs) return t.skip(noWs);
    // publish both, let them settle into the WS ring, then connect fresh
    await post(hubCut.url, SECRET, 'y');
    await post(hubCut.url, NORMAL, 'again');
    await new Promise((r) => setTimeout(r, 300));
    const replay = await wsTopics(hubCut.url, { ms: 800 });   // no new posts: only replay-on-connect
    assert.ok(replay.includes(NORMAL), 'a normal topic replays to a fresh subscriber');
    assert.ok(!replay.includes(SECRET),
      'a no-egress topic never entered the WS ring, so it cannot replay to a reconnecting subscriber');
  });

  it('the fire alarm (SUPER_LOG_NO_EGRESS=*) rebroadcasts NOTHING - composability off', async (t) => {
    if (noWs) return t.skip(noWs);
    const topics = await wsTopics(hubAll.url, {
      act: async () => { await post(hubAll.url, NORMAL, 'z'); await post(hubAll.url, SECRET, 'z'); },
    });
    assert.equal(topics.length, 0, 'with a whole-hub cut, /ws must carry nothing at all');
    const txt = await recentText(hubAll.url);
    assert.ok(!txt.includes(NORMAL) && !txt.includes(SECRET), '/recent must be empty under a whole-hub cut');
  });
});
