//
//  tests/hostile-corpus.test.mjs - attacker-shaped input against a real hub.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Log content is attacker-writable by definition: anyone who can make any
//  system emit a log line is writing into this pipeline without ever
//  touching it. The security posture's claim is that such content is data,
//  never instructions - the hub relays bytes, indexes two fields by
//  targeted scan, and evaluates nothing. This suite is that claim run
//  against a real superlogd: every line of tests/fixtures/hostile-corpus.
//  ndjson is POSTed at /ingest, and the assertions are that the hub stays
//  up, stays bounded, answers /recent with parseable JSON, and hands every
//  hostile line back as inert, byte-faithful data.
//
//  The corpus is a checked-in file on purpose: every attack class we learn
//  of becomes a line in it, and the suite grows teeth without growing code.
//  Log4Shell-era lookups, spreadsheet formulas, prototype-pollution probes,
//  ANSI and BIDI abuse, prompt injection - if a new one lands, add the
//  line, not a bespoke test.
//
//  What is asserted, per line:
//    - a line that is a JSON object comes back VERBATIM (the tolerant
//      reader embeds it as-is);
//    - anything else comes back as {"msg": "<the raw line>"} - degraded to
//      TEXT, which is the whole point: malformed input gets less
//      machinery, never more;
//    - and reading it all back pollutes nothing (JSON.parse of hub output
//      must never modify Object.prototype).
//
//  Oversize, deeply nested, and binary cases are generated rather than
//  checked in - a megabyte line in git is dead weight, and binary junk in
//  a text fixture invites editors to "fix" it. Generation is seeded, so a
//  failure reproduces.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURES, recent, startHub, waitFor } from './harness.mjs';

const CORPUS = readFileSync(join(FIXTURES, 'hostile-corpus.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0);

/** What the hub should hand back for one corpus line: a JSON *object* line
 *  is embedded verbatim; everything else is wrapped the way PROTOCOL.md's
 *  tolerant-reader rule says - {"msg": "<the raw line>"}. */
function expectedEvent(line) {
  if (line.startsWith('{')) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* not JSON: falls through to the wrap */ }
  }
  return { msg: line };
}

async function post(url, topic, body) {
  return fetch(`${url}/ingest/${topic}`, { method: 'POST', body });
}

let hub;

before(async () => { hub = await startHub(); });
after(async () => { await hub?.stop(); });

describe('the hostile corpus', () => {
  it('is accepted line by line and handed back inert and byte-faithful', async () => {
    for (const line of CORPUS) {
      const res = await post(hub.url, 'hostile.corpus', line);
      assert.equal(res.status, 202, `ingest rejected: ${line.slice(0, 60)}`);
    }
    // recent() JSON.parses the entire /recent body, so every call in this
    // file is itself the assertion that hostile content cannot corrupt the
    // hub's own response framing.
    const got = await waitFor(hub.url, (rs) => rs.length >= CORPUS.length,
                              { topic: 'hostile.corpus', limit: 1000 });
    assert.equal(got.length, CORPUS.length, 'every line arrives exactly once');
    for (let i = 0; i < CORPUS.length; i++)
      assert.deepEqual(got[i].event, expectedEvent(CORPUS[i]),
                       `line ${i + 1} was transformed: ${CORPUS[i].slice(0, 80)}`);
  });

  it('survives the corpus as one NDJSON batch, the way real producers send it', async () => {
    const res = await post(hub.url, 'hostile.batch', CORPUS.join('\n'));
    assert.equal(res.status, 202);
    const got = await waitFor(hub.url, (rs) => rs.length >= CORPUS.length,
                              { topic: 'hostile.batch', limit: 1000 });
    assert.equal(got.length, CORPUS.length);
    for (let i = 0; i < CORPUS.length; i++)
      assert.deepEqual(got[i].event, expectedEvent(CORPUS[i]));
  });

  it('reading it all back polluted no prototype', () => {
    // The corpus carries __proto__/constructor probes; the previous tests
    // parsed every byte of them out of hub responses. If any reader on
    // this path merged rather than parsed, this is where it shows.
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });

  it('wraps absurd nesting as text rather than relaying it', async () => {
    // Valid JSON, 96 levels deep. The hub's embed check refuses depth like
    // this (a relay is not obliged to hand a stack-shaped payload to every
    // consumer), so it must come back as a plain string wrap - degraded,
    // not evaluated, not crashed.
    const deep = '{"a":'.repeat(96) + '1' + '}'.repeat(96);
    assert.equal((await post(hub.url, 'hostile.deep', deep)).status, 202);
    const got = await waitFor(hub.url, (rs) => rs.length >= 1, { topic: 'hostile.deep' });
    assert.deepEqual(got[0].event, { msg: deep });
  });

  it('round-trips a quarter-megabyte line intact', async () => {
    const big = JSON.stringify({ level: 'INFO', msg: 'A'.repeat(256 * 1024) });
    assert.equal((await post(hub.url, 'hostile.big', big)).status, 202);
    const got = await waitFor(hub.url, (rs) => rs.length >= 1,
                              { topic: 'hostile.big', limit: 10 });
    assert.equal(got[0].event.msg.length, 256 * 1024);
    assert.equal(got[0].event.msg, 'A'.repeat(256 * 1024));
  });

  it('survives a two-megabyte line, accepted or refused', async () => {
    // The bound is the assertion here, not the verdict: the hub may accept
    // or reject a body this size, but it must still be standing either way,
    // and a normal event posted afterwards must flow.
    try { await post(hub.url, 'hostile.huge', '{"msg":"' + 'B'.repeat(2 * 1024 * 1024) + '"}'); }
    catch { /* a dropped connection is a legal refusal */ }
    const health = await fetch(`${hub.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await post(hub.url, 'hostile.after', '{"msg":"still alive"}')).status, 202);
    const got = await waitFor(hub.url, (rs) => rs.length >= 1, { topic: 'hostile.after' });
    assert.equal(got[0].event.msg, 'still alive');
  });

  it('survives seeded binary junk and keeps /recent parseable', async () => {
    // xorshift32, fixed seed: the same junk every run, so a failure is a
    // repro rather than an anecdote. Newlines are excluded only so the
    // blob stays one event; everything else, NUL included, is fair game.
    let s = 0xdecafbad >>> 0;
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      bytes[i] = (s & 0xff) === 0x0a ? 0x0b : s & 0xff;
    }
    const res = await post(hub.url, 'hostile.binary', bytes);
    assert.equal(res.status, 202);
    // Byte equality is deliberately NOT asserted: the reader decodes UTF-8
    // and this blob is not UTF-8, so replacement characters are the
    // documented, lossy-at-the-reader boundary. What must hold is that the
    // hub neither died nor produced a response JSON.parse refuses.
    const got = await waitFor(hub.url, (rs) => rs.length >= 1, { topic: 'hostile.binary' });
    assert.equal(typeof got[0].event.msg, 'string');
    assert.ok(got[0].event.msg.length > 0);
  });

  it('shrugs at hostile topic names', async () => {
    for (const topic of ['..%2f..%2f..%2fetc%2fpasswd',
                         'evil%0d%0aInjected-Header:1',
                         'A'.repeat(2048)]) {
      let status = null;
      try { status = (await post(hub.url, topic, '{"msg":"topic probe"}')).status; }
      catch { /* refusal by dropped connection is acceptable */ }
      assert.ok(status === null || (status >= 200 && status < 500),
                `topic ${topic.slice(0, 40)}: unexpected ${status}`);
    }
    // Whatever the router did with those paths, the hub is standing and
    // its response framing still parses with the strange topics in the
    // ring - recent() would throw here if a topic broke the JSON.
    assert.equal((await fetch(`${hub.url}/healthz`)).status, 200);
    await recent(hub.url, { topic: '*', limit: 1000 });
  });
});
