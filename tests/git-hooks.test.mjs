//
//  tests/git-hooks.test.mjs - superlog git install-hooks + recall.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The other half of the git story from git.test.mjs (which drives the
//  watcher). Here the producer is a post-commit hook: install it, make a real
//  commit in a hermetic repo, and prove the git.commit frame lands on a live
//  hub with the right shape - subject, sha, author, branch - stamped by the
//  hook the instant the commit happened, not noticed by a poller later.
//
//  A post-commit hook runs synchronously inside `git commit`, and our hook
//  waits for the POST, so once `commit` returns the frame is already on its
//  way - the test needs no sleep, only waitFor.
//
//  recall is tested for what is hermetic: that it resolves a commit, computes
//  the window and drives superlog-search to a clean exit. It reads
//  ./superlog-journal relative to its cwd, so with the temp workdir as cwd the
//  journal is empty and the test never touches the operator's real one.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertValidEvent, removeDir, run, startHub, tempDir, waitFor } from './harness.mjs';

let hub, work, repo, gitEnv;

const TOPIC = 'git.';                      // prefix: one topic per repo basename
const HOOK = () => join(repo, '.git', 'hooks', 'post-commit');

function git(args, cwd = repo) {
  const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

function commit(name, body, subject) {
  writeFileSync(join(repo, name), body);
  assert.equal(git(['add', '-A']).status, 0);
  const c = git(['commit', '-q', '-m', subject]);
  assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);
}

const markerCount = (s) => (s.match(/super-log post-commit hook/g) || []).length;

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-githooks-');
  repo = join(work, 'repo');
  mkdirSync(repo);

  gitEnv = {
    HOME: work,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Bench Tester',
    GIT_AUTHOR_EMAIL: 'bench@example.invalid',
    GIT_COMMITTER_NAME: 'Bench Tester',
    GIT_COMMITTER_EMAIL: 'bench@example.invalid',
  };

  assert.equal(git(['-c', 'init.defaultBranch=main', 'init', '-q', repo], work).status, 0);
  commit('README.md', '# scratch\n', 'initial commit');
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

describe('superlog git install-hooks', () => {
  it('installs a post-commit hook and stamps a git.commit frame at commit time', async () => {
    const r = await run('git-hooks.mjs', ['install-hooks', '--repo', repo],
                        { url: hub.url, cwd: work, env: gitEnv });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(HOOK()), 'the post-commit hook file exists');
    const hook = readFileSync(HOOK(), 'utf8');
    assert.match(hook, /super-log post-commit hook/);
    assert.match(hook, /commit-frame/);

    commit('feature.txt', 'one\n', 'add the feature flag');

    const recs = await waitFor(
      hub.url,
      (rs) => rs.some((x) => x.event?.fields?.change === 'commit'
                          && x.event?.msg === 'add the feature flag'),
      { topic: TOPIC, timeoutMs: 20000 },
    );
    const rec = recs.find((x) => x.event.msg === 'add the feature flag');
    assert.ok(rec.topic.startsWith('git.') && rec.topic.endsWith('.repo'),
              `topic is git.<host>.repo, got ${rec.topic}`);
    const c = assertValidEvent(rec.event, 'commit');

    assert.equal(c.level, 'INFO');
    assert.equal(c.tag, 'git');
    assert.equal(c.origin.app, 'git-hook', 'the hook is the producer, not the watcher');
    assert.equal(c.fields.change, 'commit');
    assert.equal(c.fields.branch, 'main');
    assert.equal(c.fields.author, 'Bench Tester');
    assert.equal(c.fields.sha.length, 12);
    assert.match(c.fields.when, /^\d{4}-\d\d-\d\dT/);
    assert.equal(c.fields.dirty, '0', 'a clean commit reports a clean tree');
  });

  it('is idempotent - a reinstall does not duplicate the block', async () => {
    await run('git-hooks.mjs', ['install-hooks', '--repo', repo],
              { url: hub.url, cwd: work, env: gitEnv });
    assert.equal(markerCount(readFileSync(HOOK(), 'utf8')), 2,
                 'one block has exactly its >>> and <<< markers');
  });

  it('preserves a foreign hook and appends beside it', async () => {
    // Simulate someone else owning the hook, then reinstall over it.
    writeFileSync(HOOK(), '#!/bin/sh\necho "mine" >/dev/null\n');
    await run('git-hooks.mjs', ['install-hooks', '--repo', repo],
              { url: hub.url, cwd: work, env: gitEnv });
    const hook = readFileSync(HOOK(), 'utf8');
    assert.match(hook, /echo "mine"/, 'the pre-existing hook is kept');
    assert.match(hook, /super-log post-commit hook/, 'ours is appended beside it');
  });

  it('uninstall-hooks removes only our block', async () => {
    const r = await run('git-hooks.mjs', ['uninstall-hooks', '--repo', repo],
                        { url: hub.url, cwd: work, env: gitEnv });
    assert.equal(r.code, 0, r.stderr);
    const hook = readFileSync(HOOK(), 'utf8');
    assert.ok(!hook.includes('super-log post-commit hook'), 'our block is gone');
    assert.match(hook, /echo "mine"/, 'the foreign hook survives');
  });
});

describe('superlog git recall', () => {
  it('replays the logs the bench saw behind a commit', async () => {
    // A hermetic journal with one frame whose arrival (now) is at/after HEAD's
    // committer time, so it falls inside recall's [commit, now] window and
    // recall has something real to find. cwd=work makes ./superlog-journal this.
    const jdir = join(work, 'superlog-journal');
    mkdirSync(jdir, { recursive: true });
    const payload = JSON.stringify({
      v: 1, ts: new Date().toISOString(), seq: 1, session: 'test', level: 'INFO',
      origin: { runtime: 'node', app: 'test', platform: 'test', device: 'test' },
      tag: 'test', msg: 'a log behind the commit', fields: {},
    });
    const frame = JSON.stringify({ epoch: 1, seq: 1, ts_ms: Date.now(), topic: 'git.test.repo', payload });
    writeFileSync(join(jdir, 'superlog-test.ndjson'), frame + '\n');

    const r = await run('git-hooks.mjs', ['recall', 'HEAD', '--repo', repo],
                        { url: hub.url, cwd: work, env: gitEnv, timeoutMs: 30000 });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /logs (since|behind) [0-9a-f]{12}/);
    assert.match(r.stdout, /a log behind the commit/, 'recall printed the in-window log');
  });

  it('rejects an unknown commit with a non-zero exit', async () => {
    const r = await run('git-hooks.mjs', ['recall', 'no-such-ref', '--repo', repo],
                        { url: hub.url, cwd: work, env: gitEnv });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no such commit/);
  });
});
