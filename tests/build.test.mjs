//
//  tests/build.test.mjs - superlog-build against real compiler output.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The whole value of this tool is the folding: a Swift error is one finding
//  spread over six lines and an ASan report is one bug spread over ninety,
//  and a wrapper that turns them into six and ninety events has made the
//  feed worse than the terminal it replaced. So most of what is asserted
//  here is a COUNT - one event, not six - alongside the level and the
//  file:line that make the row worth having.
//
//  The build is played by `cat` on a fixture, which is the honest way to
//  test a text pipeline: the tool cannot tell the difference, and the
//  fixtures are then diffable when a compiler changes its punctuation.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  FIXTURES, assertValidEvent, recent, run, startHub, waitFor,
} from './harness.mjs';

let hub;

before(async () => { hub = await startHub(); });
after(async () => { await hub?.stop(); });

/** Run a build over a fixture and return its events, oldest first. Every
 *  event is validated on the way past - the protocol check is not a separate
 *  test, it applies to everything every tool emits. */
async function build(topicName, argv) {
  const topic = `build.test.${topicName}`;
  const r = await run('superlog-build.mjs', ['--topic', topic, ...argv],
                      { url: hub.url, timeoutMs: 25000 });
  // The verdict is the last thing published, so its arrival means the whole
  // run is on the hub - no other synchronisation is needed or safe.
  const records = await waitFor(hub.url, (recs) => recs.some((x) => x.event?.fields?.result),
                                { topic, timeoutMs: 15000 });
  const evs = records.map((x) => x.event);
  evs.forEach((e, i) => assertValidEvent(e, `${topic}[${i}]`));
  return { evs, proc: r, started: evs[0], verdict: evs[evs.length - 1], diags: evs.slice(1, -1) };
}

const cat = (fixture) => ['--quiet', '--', 'cat', join(FIXTURES, fixture)];

describe('superlog-build', () => {
  it('turns a clang/gcc error into ERROR with file:line', async () => {
    const { diags, verdict } = await build('clang', cat('build-clang.txt'));

    const err = diags.find((e) => e.msg.includes("no member named 'quote'"));
    assert.ok(err, 'the clang error was not published');
    assert.equal(err.level, 'ERROR');
    assert.equal(err.src, 'src/main.cpp:42');

    const warn = diags.find((e) => e.msg.includes("unused variable 'scratch'"));
    assert.equal(warn.level, 'WARN');
    assert.equal(warn.src, 'src/util.cpp:7');

    // The make failure is an error too, so the verdict must count two.
    assert.equal(verdict.fields.errors, '2');
    assert.equal(verdict.fields.warnings, '1');
  });

  it('folds a Swift source gutter into fields.snippet, not into six events', async () => {
    const { diags } = await build('swift', cat('build-swift.txt'));

    assert.equal(diags.length, 1,
                 `expected one event for one diagnostic, got ${diags.length}:\n` +
                 diags.map((e) => `  ${e.level} ${e.msg}`).join('\n'));
    const [d] = diags;
    assert.equal(d.level, 'ERROR');
    assert.equal(d.src, '/tmp/App/Sources/App/Model.swift:12');
    assert.match(d.msg, /cannot convert value of type 'String'/);

    const snippet = d.fields.snippet.split('\n');
    assert.equal(snippet.length, 5, 'all five gutter lines belong to the diagnostic');
    assert.match(d.fields.snippet, /let s: Int = "nope"/);
    assert.match(d.fields.snippet, /\^~~~~~/);

    // The point of the fold: no gutter row ever became an event of its own.
    for (const e of diags)
      assert.doesNotMatch(e.msg, /^\s*(\d+\s*)?\|/, 'a gutter line escaped as its own event');
  });

  it('folds a rustc arrow/note block the same way', async () => {
    const { diags } = await build('rustc', cat('build-rustc.txt'));

    assert.equal(diags.length, 1,
                 `expected one event, got ${diags.length}:\n` +
                 diags.map((e) => `  ${e.level} ${e.msg}`).join('\n'));
    const [d] = diags;
    assert.equal(d.level, 'ERROR');
    assert.equal(d.msg, 'error[E0308]: mismatched types');
    assert.match(d.fields.snippet, /--> src\/main\.rs:4:18/);
    assert.match(d.fields.snippet, /= note: expected type `i32`/);
    assert.match(d.fields.snippet, /= help: try removing the quotes/);
  });

  it('captures an AddressSanitizer report whole, at CRITICAL, with src from SUMMARY', async () => {
    const { diags } = await build('asan', cat('build-asan.txt'));

    const reports = diags.filter((e) => e.fields?.report);
    assert.equal(reports.length, 1, 'a sanitizer report is one event');
    const [r] = reports;
    assert.equal(r.level, 'CRITICAL');
    assert.equal(r.fields.tool, 'AddressSanitizer');
    assert.match(r.msg, /AddressSanitizer: heap-use-after-free/);

    // The tool names the offending line itself; that is what `src` must be,
    // not whichever stack frame happened to be on top.
    assert.equal(r.src, 'main.cpp:10');

    for (const want of ['READ of size 4', 'freed by thread T0 here:',
                        'previously allocated by thread T0 here:',
                        'SUMMARY: AddressSanitizer', 'Shadow byte legend'])
      assert.ok(r.fields.report.includes(want), `report is missing: ${want}`);

    // Only the leading rule, the report and the closing verdict: no stack
    // frame leaked out as an event of its own.
    assert.equal(diags.filter((e) => /^\s+#\d /.test(e.msg)).length, 0);
  });

  it('separates valgrind findings from its tallies, and levels them differently', async () => {
    const { diags } = await build('valgrind', cat('build-valgrind.txt'));

    const vg = diags.filter((e) => e.fields?.tool === 'valgrind');
    assert.equal(vg.length, 4, 'two findings and two summaries, each captured whole');

    const invalid = vg.find((e) => e.msg.includes('Invalid read'));
    assert.equal(invalid.level, 'ERROR');
    assert.equal(invalid.src, 'main.c:10');
    assert.match(invalid.fields.report, /Address 0x4a4d040 is 0 bytes inside/);

    const leak = vg.find((e) => e.msg.includes('definitely lost'));
    assert.equal(leak.level, 'ERROR');
    assert.notEqual(leak, invalid);

    // HEAP/LEAK SUMMARY restate findings already counted at their own level.
    // Counting them again would make the verdict claim more errors than the
    // run found, which is why they are INFO.
    for (const kind of ['HEAP SUMMARY', 'LEAK SUMMARY']) {
      const s = vg.find((e) => e.msg.includes(kind));
      assert.ok(s, `${kind} was not captured`);
      assert.equal(s.level, 'INFO', `${kind} must not be counted as an error`);
    }

    // valgrind's own banner is worth keeping and not worth a level.
    const banner = diags.find((e) => e.msg.includes('Memcheck, a memory error detector'));
    assert.equal(banner.level, 'DEBUG');
  });

  it('gives a UBSan runtime error ERROR, not INFO', async () => {
    const { diags } = await build('ubsan', cat('build-ubsan.txt'));

    const errs = diags.filter((e) => e.level === 'ERROR');
    assert.equal(errs.length, 1);
    assert.match(errs[0].msg, /runtime error: signed integer overflow/);
    assert.equal(errs[0].src, 'main.cpp:5');
  });

  it('calls a zero exit with errors in the output suspect, not success', async () => {
    const { verdict, proc } = await build('despite', cat('build-clang.txt'));

    assert.equal(proc.code, 0, 'cat exited 0, so the wrapper must too');
    assert.equal(verdict.level, 'WARN');
    assert.match(verdict.msg, /exited 0 DESPITE 2 error\(s\)/);
    assert.equal(verdict.fields.result, 'suspect');
    assert.equal(verdict.fields.exit, '0');
  });

  it('calls a clean build a success', async () => {
    const { verdict, diags } = await build('clean', cat('build-clean.txt'));

    assert.equal(verdict.level, 'INFO');
    assert.match(verdict.msg, /build succeeded in \d+\.\ds - 0 error\(s\), 0 warning\(s\)/);
    assert.equal(verdict.fields.result, 'success');
    for (const d of diags) assert.equal(d.level, 'INFO');
  });

  it('is transparent: same exit status, output still printed', async () => {
    const script = `cat ${JSON.stringify(join(FIXTURES, 'build-clang.txt'))} >&2; exit 2`;
    const { verdict, proc } = await build('failed', ['--', 'sh', '-c', script]);

    assert.equal(proc.code, 2, 'the wrapper must exit with the build\'s own status');
    assert.match(proc.stderr, /no member named 'quote'/,
                 'without --quiet the build output still reaches the terminal');
    assert.equal(verdict.level, 'ERROR');
    assert.match(verdict.msg, /build FAILED \(exit 2\)/);
    assert.equal(verdict.fields.result, 'failure');
  });

  it('publishes a started event naming the command', async () => {
    const { started } = await build('started', cat('build-clean.txt'));

    assert.equal(started.level, 'INFO');
    assert.match(started.msg, /^build started: cat /);
    assert.equal(started.fields.where, 'local');
    assert.equal(started.origin.app, 'build');
  });
});

it('publishes nothing to a topic no build used', async () => {
  // A cheap guard against the tests leaking into each other's topics.
  const stray = await recent(hub.url, { topic: 'build.test.nobody' });
  assert.equal(stray.length, 0);
});
