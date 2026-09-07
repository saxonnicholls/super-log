//
//  tests/tee.test.mjs - superlog-tee, which must behave exactly like tee(1).
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  This tool gets dropped into somebody's pipeline, and the moment it alters
//  the stream, swallows it, or changes an exit status, nobody leaves it in.
//  So the property that matters more than any parsing is transparency:
//  stdin reaches stdout byte for byte, files are written the way tee writes
//  them, and a hub that is not there changes nothing at all.
//
//  The classifier is deliberately narrow and off by default, because a false
//  ERROR is worse than a missing one - `0 errors, 0 warnings` and `Error: 0`
//  are the lines that catch a naive implementation out.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, freePort, recent, removeDir, run, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub, work;

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-tee-');
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

/** Deterministic, and awkward on purpose: every byte value including NUL,
 *  a CR that is not part of a CRLF, multi-byte UTF-8, and a tail with no
 *  trailing newline. A pipeline carries whatever it carries. */
function payload() {
  const rand = Buffer.alloc(2048);
  let x = 0x2545f491;
  for (let i = 0; i < rand.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    rand[i] = (x >>> 24) & 0xff;
  }
  return Buffer.concat([
    Buffer.from('plain line one\n'),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.from('\n'),
    Buffer.from('café ✓ \u{1F600}\r\n', 'utf8'),
    rand,
    Buffer.from('\nno trailing newline here'),
  ]);
}

const lines = (...ls) => `${ls.join('\n')}\n`;

describe('superlog-tee', () => {
  it('copies stdin to stdout byte for byte', async () => {
    const body = payload();
    const r = await run('superlog-tee.mjs', ['--topic', 'tee.test.bytes'],
                        { url: hub.url, stdin: body, timeoutMs: 20000 });

    assert.equal(r.code, 0);
    assert.equal(r.stdoutBuf.length, body.length, 'stdout is a different length from stdin');
    assert.ok(r.stdoutBuf.equals(body), 'stdout is not byte-identical to stdin');
  });

  it('writes the files it is given, exactly as tee does', async () => {
    const body = payload();
    const out = join(work, 'out.log');
    const r = await run('superlog-tee.mjs', ['--topic', 'tee.test.files', out],
                        { url: hub.url, stdin: body, timeoutMs: 20000 });

    assert.equal(r.code, 0);
    assert.ok(readFileSync(out).equals(body), 'the file copy is not byte-identical to stdin');
    assert.ok(r.stdoutBuf.equals(body), 'the terminal copy is not byte-identical either');
  });

  it('truncates by default and appends with -a, as tee does', async () => {
    const out = join(work, 'append.log');
    await run('superlog-tee.mjs', ['--topic', 'tee.test.append', out],
              { url: hub.url, stdin: 'first\n' });
    await run('superlog-tee.mjs', ['--topic', 'tee.test.append', '-a', out],
              { url: hub.url, stdin: 'second\n' });
    assert.equal(readFileSync(out, 'utf8'), 'first\nsecond\n');

    await run('superlog-tee.mjs', ['--topic', 'tee.test.append', out],
              { url: hub.url, stdin: 'third\n' });
    assert.equal(readFileSync(out, 'utf8'), 'third\n');
  });

  it('publishes one event per non-blank line, at INFO, without --classify', async () => {
    const topic = 'tee.test.plain';
    await run('superlog-tee.mjs', ['--topic', topic], {
      url: hub.url,
      stdin: lines('Building target app', '', '   ', "error: cannot open file 'main.o'",
                   'no trailing newline follows').replace(/\n$/, '\nlast line, unterminated'),
    });

    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event.msg === 'last line, unterminated'),
                               { topic });
    const evs = recs.map((r) => r.event);
    evs.forEach((e, i) => assertValidEvent(e, `${topic}[${i}]`));

    assert.deepEqual(evs.map((e) => e.msg), [
      'Building target app',
      "error: cannot open file 'main.o'",
      'no trailing newline follows',
      'last line, unterminated',
    ], 'blank and whitespace-only lines are not events');

    // Off by default: "error" appears in plenty of prose, and the default
    // must not decide what a line means.
    for (const e of evs) assert.equal(e.level, 'INFO');
    assert.equal(evs[0].origin.app, 'tee');
    assert.equal(evs[0].tag, 'tee');
  });

  it('reads the level from the line under --classify, and only then', async () => {
    const topic = 'tee.test.classify';
    await run('superlog-tee.mjs', ['--topic', topic, '--classify'], {
      url: hub.url,
      stdin: lines(
        'Building target app',
        "error: cannot open file 'main.o'",
        "warning: deprecated API 'foo'",
        'Tests failed: 3',
        '0 errors, 0 warnings',
        'Error: 0',
        'the last line'),
    });

    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event.msg === 'the last line'),
                               { topic });
    const by = new Map(recs.map((r) => [r.event.msg, r.event]));
    recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));

    assert.equal(by.get("error: cannot open file 'main.o'").level, 'ERROR');
    assert.equal(by.get('Tests failed: 3').level, 'ERROR');
    assert.equal(by.get("warning: deprecated API 'foo'").level, 'WARN');
    assert.equal(by.get('Building target app').level, 'INFO');

    // The two that catch a naive matcher: a tally of zero is not a finding.
    assert.equal(by.get('0 errors, 0 warnings').level, 'INFO',
                 'a clean summary line must not become an ERROR');
    assert.equal(by.get('Error: 0').level, 'INFO',
                 'the negative lookahead exists for exactly this line');
  });

  // A verification framework glues the severity to its own prefix, and
  // underscore is a word character - so the boundary that finds "error" in
  // prose does not find it in UVM_ERROR. A testbench reporting a mismatch is
  // the most important line in the run and it was arriving as INFO.
  it('reads a severity that is glued to a framework prefix', async () => {
    const topic = 'tee.test.tagged';
    await run('superlog-tee.mjs', ['--topic', topic, '--classify'], {
      url: hub.url,
      stdin: lines('UVM_ERROR @ 12400ns: [SCB] payload mismatch',
                   'UVM_FATAL @ 12401ns: [SCB] giving up',
                   'UVM_WARNING @ 12402ns: [SCB] late',
                   '** Error: assertion failed',
                   '** Fatal: aborted at 9000 ns',
                   'the last line'),
    });
    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event.msg === 'the last line'),
                               { topic });
    const by = new Map(recs.map((r) => [r.event.msg, r.event]));
    recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));
    const lvl = (frag) => [...by.entries()].find(([k]) => k.includes(frag))?.[1]?.level;

    assert.equal(lvl('payload mismatch'), 'ERROR');
    assert.equal(lvl('giving up'), 'CRITICAL');
    assert.equal(lvl('late'), 'WARN');
    // Fatal is not the same fact as error and should survive a filter that
    // error does not: the run stopped.
    assert.equal(lvl('assertion failed'), 'ERROR');
    assert.equal(lvl('aborted at 9000'), 'CRITICAL');
  });

  it('honours --level for the whole stream', async () => {
    const topic = 'tee.test.level';
    await run('superlog-tee.mjs', ['--topic', topic, '--level', 'WARN'],
              { url: hub.url, stdin: lines('something worth noticing') });

    const recs = await waitFor(hub.url, (rs) => rs.length > 0, { topic });
    assert.equal(assertValidEvent(recs[0].event, topic).level, 'WARN');
  });

  it('refuses a level that is not one of the six', async () => {
    const r = await run('superlog-tee.mjs', ['--level', 'LOUD'],
                        { url: hub.url, stdin: 'x\n' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown level 'LOUD'/);
  });

  it('passes everything through and exits 0 with the hub down', async () => {
    // A port nothing is listening on: the tool must be no worse than tee.
    const dead = `http://127.0.0.1:${await freePort()}`;
    const body = payload();
    const r = await run('superlog-tee.mjs', ['--topic', 'tee.test.nohub'],
                        { url: dead, stdin: body, timeoutMs: 20000 });

    assert.equal(r.code, 0, 'a missing hub must not fail the pipeline');
    assert.ok(r.stdoutBuf.equals(body), 'stdout changed because the hub was down');
    // Counted and said out loud, never hidden.
    assert.match(r.stderr, /line\(s\) not delivered/);

    const stray = await recent(hub.url, { topic: 'tee.test.nohub' });
    assert.equal(stray.length, 0, 'nothing should have reached the live hub');
  });

  it('is silent on stdout under --quiet but still publishes', async () => {
    const topic = 'tee.test.quiet';
    const r = await run('superlog-tee.mjs', ['--topic', topic, '--quiet'],
                        { url: hub.url, stdin: lines('still logged') });

    assert.equal(r.stdoutBuf.length, 0);
    const recs = await waitFor(hub.url, (rs) => rs.length > 0, { topic });
    assert.equal(recs[0].event.msg, 'still logged');
  });

  it('carries a --trace onto every event', async () => {
    const topic = 'tee.test.trace';
    await run('superlog-tee.mjs', ['--topic', topic, '--trace', '9f1c0a2b7d4e5f60'],
              { url: hub.url, stdin: lines('one', 'two') });

    const recs = await waitFor(hub.url, (rs) => rs.length >= 2, { topic });
    for (const r of recs) assert.equal(assertValidEvent(r.event, topic).trace, '9f1c0a2b7d4e5f60');
  });
});
