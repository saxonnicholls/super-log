//
//  tests/watch.test.mjs - superlog-watch over a real temp tree.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Real files, real fs.watch, real debounce. The three things worth holding
//  the tool to are all about restraint rather than about noticing: a delete
//  outranks a create because a file appearing is usually you and a file
//  vanishing usually is not; node_modules and build are never events,
//  because a watcher that reports a compile is a watcher you turn off; and a
//  burst collapses to one line, because ten thousand events would drown
//  every other stream on the bench.
//
//  Each case gets its own directory, its own topic and its own watcher, so
//  nothing here can see anything another case did.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, recent, removeDir, start, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub;
const running = [];
const dirs = [];

before(async () => { hub = await startHub(); });

after(async () => {
  for (const t of running) await t.stop();
  for (const d of dirs) removeDir(d);
  await hub?.stop();
});

/** A watcher on a directory of its own, already watching by the time this
 *  resolves - the tool announces the tree it seeded from inside the same
 *  turn that registers the watch. */
async function watcher(name, extra = []) {
  const dir = tempDir(`superlog-watch-${name}-`);
  dirs.push(dir);
  const topic = `fs.test.${name}`;
  const tool = start('superlog-watch.mjs',
                     ['--dir', dir, '--topic', topic, '--debounce', '150', ...extra],
                     { url: hub.url });
  running.push(tool);
  await tool.waitForStderr(new RegExp(`-> ${topic.replace(/\./g, '\\.')}`));
  return { dir, topic, tool };
}

const change = (kind) => (rs) => rs.some((r) => r.event?.fields?.change === kind);
const of = (recs, kind) => recs.filter((r) => r.event.fields.change === kind).map((r) => r.event);

describe('superlog-watch', () => {
  it('reports created, modified and deleted at the levels they deserve', async () => {
    const { dir, topic } = await watcher('lifecycle');
    const file = join(dir, 'a.txt');

    writeFileSync(file, 'hello\n');                        // 6 bytes
    let recs = await waitFor(hub.url, change('created'), { topic });
    const created = of(recs, 'created')[0];
    assertValidEvent(created, topic);
    assert.equal(created.level, 'INFO');
    assert.equal(created.msg, 'created a.txt');
    assert.equal(created.fields.path, 'a.txt');
    assert.equal(created.fields.size, '6');
    assert.equal(created.fields.dir, dir);
    assert.equal(created.origin.app, 'fs-watcher');

    appendFileSync(file, 'more content\n');                // +13 bytes
    recs = await waitFor(hub.url, change('modified'), { topic });
    const modified = of(recs, 'modified')[0];
    assertValidEvent(modified, topic);
    assert.equal(modified.level, 'INFO');
    assert.equal(modified.msg, 'modified a.txt');
    assert.equal(modified.fields.size, '19');
    assert.equal(modified.fields.delta, '+13', 'a modification says by how much');

    unlinkSync(file);
    recs = await waitFor(hub.url, change('deleted'), { topic });
    const deleted = of(recs, 'deleted')[0];
    assertValidEvent(deleted, topic);
    assert.equal(deleted.level, 'WARN', 'a file vanishing is usually not you');
    assert.equal(deleted.msg, 'deleted a.txt');
  });

  it('says whether it is watching recursively or only the top level', async () => {
    const { tool } = await watcher('recursive');
    assert.match(tool.stderr(), /\(\d+ files, (recursive|top level only)\)/);
  });

  it('never reports node_modules or build', async () => {
    const { dir, topic } = await watcher('ignored');

    mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n');
    mkdirSync(join(dir, 'build'), { recursive: true });
    writeFileSync(join(dir, 'build', 'app.o'), 'ELF\n');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    // A sentinel written last: once ITS event is here, anything the ignored
    // writes were going to produce has had its chance to arrive too.
    writeFileSync(join(dir, 'sentinel.txt'), 'x\n');
    const recs = await waitFor(hub.url, change('created'), { topic });

    const paths = recs.map((r) => r.event.fields.path ?? r.event.msg);
    assert.deepEqual(paths, ['sentinel.txt'],
                     `something ignored got through: ${JSON.stringify(paths)}`);
  });

  it('collapses a burst over --max-burst into one summary event', async () => {
    // A long debounce so the writes below are unambiguously one window: the
    // thing under test is the collapse, not fs.watch's delivery timing.
    const { dir, topic } = await watcher('burst', ['--max-burst', '5', '--debounce', '400']);

    const n = 40;
    for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);

    const recs = await waitFor(hub.url, change('burst'), { topic });
    const bursts = of(recs, 'burst');
    assert.equal(bursts.length, 1, 'one summary, not one per window');
    assertValidEvent(bursts[0], topic);

    assert.equal(bursts[0].level, 'INFO');
    assert.equal(bursts[0].fields.count, String(n));
    assert.match(bursts[0].msg, new RegExp(`^${n} changes in `));
    assert.equal(recs.length, 1,
                 `${n} files must not become ${recs.length} events:\n` +
                 recs.map((r) => `  ${r.event.msg}`).join('\n'));

    // The tree is still tracked after a burst: the next single change is a
    // modification, not a second creation.
    appendFileSync(join(dir, 'f0.txt'), 'again\n');
    const after2 = await waitFor(hub.url, change('modified'), { topic });
    assert.equal(of(after2, 'modified')[0].fields.path, 'f0.txt');
  });

  it('publishes nothing at all for a tree nobody touches', async () => {
    const { topic, dir } = await watcher('quiet');
    // Prove the watcher is live by making one change elsewhere in its own
    // tree, then checking nothing else was invented.
    writeFileSync(join(dir, 'only.txt'), 'x\n');
    const recs = await waitFor(hub.url, change('created'), { topic });
    assert.equal(recs.length, 1);
    assert.equal((await recent(hub.url, { topic })).length, 1);
  });

  it('--diff: the changed lines once, trace-correlated, and a no-op rewrite never', async () => {
    const { dir, topic } = await watcher('diff', ['--diff']);
    const file = join(dir, 'config.yaml');

    writeFileSync(file, 'name: bench\nport: 7333\nmode: dev\n');
    await waitFor(hub.url, change('created'), { topic });

    // One line edited: one hunk with BOTH sides in it, sharing a trace with
    // its modified anchor, so /recent?trace= returns the edit whole.
    writeFileSync(file, 'name: bench\nport: 9999\nmode: dev\n');
    let recs = await waitFor(hub.url, change('diff'), { topic });
    const hunk = of(recs, 'diff')[0];
    assertValidEvent(hunk, topic);
    assert.match(hunk.msg, /^config\.yaml:2\n/);
    assert.match(hunk.msg, /- port: 7333/);
    assert.match(hunk.msg, /\+ port: 9999/);
    const anchor = of(recs, 'modified')[0];
    assert.ok(anchor.trace && anchor.trace === hunk.trace, 'hunk and anchor must share a trace');
    assert.equal(anchor.fields.hunks, '1');

    // A rewrite with identical bytes settles alone and must publish NOTHING
    // - then two separated edits in one save must still arrive, as TWO
    // hunks, proving the silence was judgement rather than death.
    writeFileSync(file, 'name: bench\nport: 9999\nmode: dev\n');
    await new Promise((r) => setTimeout(r, 500));            // its own debounce window
    writeFileSync(file, 'name: BENCH\nport: 9999\nmode: prod\n');
    recs = await waitFor(hub.url, (rs) => of(rs, 'diff').length >= 3, { topic });
    assert.equal(of(recs, 'modified').length, 2,
      'a rewrite with identical bytes became a modified event');
    const second = of(recs, 'modified')[1];
    assert.equal(second.fields.hunks, '2');
    const hunks = of(recs, 'diff').slice(1);
    assert.match(hunks[0].msg, /- name: bench/);
    assert.match(hunks[0].msg, /\+ name: BENCH/);
    assert.match(hunks[1].msg, /- mode: dev/);
    assert.match(hunks[1].msg, /\+ mode: prod/);
    assert.equal(hunks[0].trace, hunks[1].trace, 'hunks of one save must share a trace');
    assert.notEqual(hunks[0].trace, hunk.trace, 'different saves must not share one');
  });

  it('--diff refuses to pretend about binaries', async () => {
    const { dir, topic } = await watcher('diffbin', ['--diff']);
    const file = join(dir, 'blob.bin');
    writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    await waitFor(hub.url, change('created'), { topic });
    writeFileSync(file, Buffer.from([0, 9, 9, 9]));
    const recs = await waitFor(hub.url, change('modified'), { topic });
    assert.equal(of(recs, 'modified')[0].fields.undiffable, 'binary');
    assert.equal(of(recs, 'diff').length, 0, 'a binary produced line hunks');
  });
});
