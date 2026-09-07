//
//  tests/protocol.test.mjs - one sweep over everything, against the contract.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Each tool has its own test file for what it means; this one asks the
//  question that spans all of them: does everything they emit actually
//  satisfy docs/PROTOCOL.md? Six producers are driven, and then EVERY event
//  on the hub - not a sample - goes through the validator.
//
//  Two things are checked here that no single tool's file would think to
//  check. The event lines must be compact JSON, because the hub reads
//  `level` and `trace` out of them by targeted scan rather than by parsing:
//  a pretty-printed event still arrives, it simply cannot be filtered, and
//  nothing looks broken when that happens. And every line must be relayable
//  as JSON - if the hub has to wrap one as a string, some producer emitted
//  something that was not an object per line.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FIXTURES, LEVELS, assertCompactJson, assertValidEvent, embeddedEventText,
  freeUdpPort, recent, recentText, removeDir, run, start, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub, work, all;

// Which producer each topic family came from, so a failure names the tool.
const FAMILIES = ['build.', 'tee.', 'syslog.', 'socket.', 'fs.', 'ros.', 'git.'];

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-protocol-');

  // ---- build: compiler diagnostics, a folded snippet and a verdict
  await run('superlog-build.mjs',
            ['--topic', 'build.conformance.cc', '--quiet', '--', 'cat', join(FIXTURES, 'build-clang.txt')],
            { url: hub.url, timeoutMs: 20000 });

  // ---- tee: the plainest producer there is
  await run('superlog-tee.mjs', ['--topic', 'tee.conformance', '--classify'],
            { url: hub.url, stdin: 'deploy starting\nerror: rollout failed\nwarning: retrying\n' });

  // ---- socket: syslog and a plain line, over a real datagram
  const udp = await freeUdpPort();
  const sock = start('superlog-socket.mjs', ['--udp', String(udp)], { url: hub.url });
  await sock.waitForStderr(new RegExp(`syslog/udp on 127\\.0\\.0\\.1:${udp}`));
  await new Promise((res, rej) => {
    const s = createSocket('udp4');
    const msgs = [
      '<34>1 2026-08-24T04:12:00.003Z fw01 sshd 1234 ID47 - Failed password for root',
      '<86>Aug 24 04:12:02 router01 dhcpd[901]: lease renewed',
      'a plain line from something that speaks no syslog',
    ];
    let left = msgs.length;
    s.bind(0, '127.0.0.1', () => {
      for (const m of msgs)
        s.send(Buffer.from(m), udp, '127.0.0.1', (e) => {
          if (e) { s.close(); rej(e); return; }
          if (--left === 0) s.close(res);
        });
    });
  });
  await waitFor(hub.url, (rs) => rs.some((r) => r.topic.startsWith('socket.')) &&
                                 rs.some((r) => r.topic.startsWith('syslog.')),
                { topic: '*', timeoutMs: 20000 });
  await sock.stop();

  // ---- watch: a filesystem change, which is the only producer with a
  //      `delta` field and so the one most likely to emit a number by mistake
  const tree = join(work, 'tree');
  mkdirSync(tree);
  const fsTool = start('superlog-watch.mjs',
                       ['--dir', tree, '--topic', 'fs.conformance.tree', '--debounce', '120'],
                       { url: hub.url });
  await fsTool.waitForStderr(/-> fs\.conformance\.tree/);
  writeFileSync(join(tree, 'a.txt'), 'hello\n');
  await waitFor(hub.url, (rs) => rs.length > 0, { topic: 'fs.conformance.tree', timeoutMs: 20000 });
  await fsTool.stop();

  // ---- ros: the console format, read out of files
  const runDir = join(work, 'roslog', 'run_1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'talker_1_2.log'),
    "[INFO] [1755831845.123456789] [talker]: Publishing: 'Hello World: 1'\n" +
    '[FATAL] [1755831848.000000000] [motor_driver]: watchdog fired\n');
  await run('superlog-ros.mjs', ['--files', join(work, 'roslog')],
            { url: hub.url, timeoutMs: 20000 });

  // ---- git: a repository's state, in one shot
  const repo = join(work, 'repo');
  mkdirSync(repo);
  const gitEnv = {
    HOME: work, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Bench Tester', GIT_AUTHOR_EMAIL: 'bench@example.invalid',
    GIT_COMMITTER_NAME: 'Bench Tester', GIT_COMMITTER_EMAIL: 'bench@example.invalid',
  };
  const g = (args, cwd = repo) => spawnSync('git', args, { cwd, env: { ...process.env, ...gitEnv } });
  g(['-c', 'init.defaultBranch=main', 'init', '-q', repo], work);
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'initial commit']);
  await run('superlog-git.mjs', ['--repo', repo, '--once', '--topic', 'git.conformance.repo'],
            { url: hub.url, cwd: work, env: gitEnv, timeoutMs: 20000 });

  all = await recent(hub.url, { topic: '*', limit: 1000 });
  chmodSync(work, 0o755);                       // rm -rf needs it back on some systems
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

describe('the wire protocol', () => {
  it('drove every producer it claims to have driven', () => {
    for (const family of FAMILIES)
      assert.ok(all.some((r) => r.topic.startsWith(family)),
                `no events on ${family}* - the sweep below would be vacuous`);
    assert.ok(all.length >= 15, `only ${all.length} events, which is too few to mean anything`);
  });

  it('accepts every event every producer emitted', () => {
    for (const r of all) assertValidEvent(r.event, `${r.topic}#${r.id}`);
  });

  it('uses only the six level names', () => {
    const seen = new Set(all.map((r) => r.event.level));
    for (const l of seen) assert.ok(LEVELS.includes(l), `unknown level ${l}`);
    // A feed where everything is INFO would pass the validator and be
    // useless, so the sweep must have produced a spread.
    assert.ok(seen.size >= 4, `only ${[...seen].join(' ')} - the levels are not being used`);
  });

  it('names its topics the way PROTOCOL.md says', () => {
    for (const r of all)
      assert.match(r.topic, /^[a-z0-9._-]+$/, `topic ${JSON.stringify(r.topic)}`);
  });

  it('gives every event an origin that says who is speaking', () => {
    for (const r of all) {
      const o = r.event.origin;
      assert.equal(typeof o.runtime, 'string', `${r.topic}: origin.runtime`);
      assert.ok(o.runtime.length, `${r.topic}: origin.runtime is empty`);
      for (const [k, v] of Object.entries(o))
        assert.equal(typeof v, 'string', `${r.topic}: origin.${k} must be a string`);
    }
  });

  it('writes compact JSON, which is what makes the hub able to filter it', async () => {
    const body = await recentText(hub.url, { topic: '*', limit: 1000 });
    const found = embeddedEventText(body);
    assert.equal(found.length, all.length, 'the raw body and the parsed body disagree');

    for (const f of found) {
      // A line the hub could not relay as JSON is a producer that emitted
      // something other than one object per line.
      assert.ok(f.embedded, 'an event line had to be wrapped as a string by the hub');
      assertCompactJson(f.text, 'event line');
      assert.doesNotMatch(f.text.replace(/"(\\.|[^"\\])*"/g, '""'), /, |: /,
                          'a JSON separator carries whitespace');
    }
  });

  it('advances the /recent cursor without missing or repeating an event', async () => {
    const first = JSON.parse(await recentText(hub.url, { topic: '*', limit: 1000 }));
    assert.ok(first.count > 0);
    assert.equal(first.missed, false);

    const nothing = JSON.parse(await recentText(hub.url, { topic: '*', since: first.next }));
    assert.equal(nothing.count, 0, 'polling from `next` must return nothing new');

    await run('superlog-tee.mjs', ['--topic', 'tee.conformance.cursor'],
              { url: hub.url, stdin: 'one more line\n' });
    const more = await waitFor(hub.url, (rs) => rs.length > 0,
                               { topic: '*', since: first.next, timeoutMs: 15000 });
    assert.equal(more.length, 1, 'exactly the one event published since the cursor');
    assert.equal(more[0].event.msg, 'one more line');
  });

  it('filters by minimum level the way a script would ask it to', async () => {
    const warned = await recent(hub.url, { topic: '*', level: 'WARN', limit: 1000 });
    assert.ok(warned.length > 0, 'the sweep produced no WARN or worse to filter for');
    for (const r of warned)
      assert.ok(['WARN', 'ERROR', 'CRITICAL'].includes(r.event.level),
                `level=WARN returned a ${r.event.level}`);

    const errors = await recent(hub.url, { topic: '*', level: 'ERROR', limit: 1000 });
    assert.ok(errors.length > 0);
    assert.ok(errors.length <= warned.length);
    for (const r of errors)
      assert.ok(['ERROR', 'CRITICAL'].includes(r.event.level));
  });

  it('filters by topic prefix', async () => {
    const builds = await recent(hub.url, { topic: 'build.', limit: 1000 });
    assert.ok(builds.length > 0);
    for (const r of builds) assert.ok(r.topic.startsWith('build.'), r.topic);

    const exact = await recent(hub.url, { topic: 'build.conformance.cc', limit: 1000 });
    assert.deepEqual(exact.map((r) => r.id), builds.map((r) => r.id));
  });
});
