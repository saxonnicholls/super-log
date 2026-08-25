//
//  tests/git.test.mjs - superlog-git against a scratch repository.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A real repo, built by real git commands, watched by the real tool. The
//  repo is hermetic on purpose: its own HOME, no global or system config,
//  fixed identity - otherwise the operator's commit template, gpg signing or
//  default branch name decides whether the suite passes.
//
//  Synchronising with a watcher whose first poll is deliberately SILENT is
//  the awkward part, and the trick is the second repo. A path that is not a
//  repository reports itself once, during that same first round, and the
//  round flushes only after every repo in it has been polled - so seeing the
//  sentinel's ERROR proves the scratch repo's baseline has been taken and
//  every later change will be reported as a change.
//
//  One assertion here is load-bearing beyond what it looks like. "merge in
//  progress" is found by testing for MERGE_HEAD inside `rev-parse
//  --absolute-git-dir`; with plain `--git-dir` the answer is the relative
//  `.git`, which resolves against the WATCHER's working directory rather
//  than the repo's. The watcher is therefore run from the parent directory,
//  so that regression fails this test instead of passing it by accident.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, removeDir, run, start, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub, work, repo, missing, tool, gitEnv;

const TOPIC = 'git.';                     // prefix: one topic per repo basename

function git(args, cwd = repo) {
  const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

/** Commit a file, and only return once git says it worked. */
function commit(name, body, subject) {
  writeFileSync(join(repo, name), body);
  assert.equal(git(['add', '-A']).status, 0);
  const c = git(['commit', '-q', '-m', subject]);
  assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);
}

const isChange = (kind) => (rs) => rs.some((r) => r.event?.fields?.change === kind);
const changed = (recs, kind) => recs.filter((r) => r.event.fields.change === kind).map((r) => r.event);
const onRepo = (recs) => recs.filter((r) => r.topic.endsWith('.repo'));

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-git-');
  repo = join(work, 'repo');
  missing = join(work, 'missing');       // deliberately never created
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

  // cwd is the PARENT of the repo, so a relative .git would resolve to
  // nothing - see the note at the top of this file.
  tool = start('superlog-git.mjs',
               ['--repo', repo, '--repo', missing, '--interval', '1'],
               { url: hub.url, cwd: work, env: gitEnv });

  await waitFor(hub.url, (rs) => rs.some((r) => r.topic.endsWith('.missing')),
                { topic: TOPIC, timeoutMs: 20000 });
});

after(async () => {
  await tool?.stop();
  await hub?.stop();
  removeDir(work);
});

describe('superlog-git', () => {
  it('reports a path that is not a repository, once, as ERROR', async () => {
    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.topic.endsWith('.missing')),
                               { topic: TOPIC });
    const gone = recs.filter((r) => r.topic.endsWith('.missing')).map((r) => r.event);
    assert.equal(gone.length, 1, 'a deleted checkout must not be an error every poll');
    assertValidEvent(gone[0], 'missing');
    assert.equal(gone[0].level, 'ERROR');
    assert.match(gone[0].msg, /is not a git repository \(moved, deleted, or never was\)/);
    assert.equal(gone[0].fields.change, 'missing');
  });

  it('reports a commit at INFO with its subject and shortstat', async () => {
    commit('feature.txt', 'one\n', 'add the feature flag');

    const recs = await waitFor(hub.url, isChange('commit'), { topic: TOPIC, timeoutMs: 20000 });
    const commits = changed(onRepo(recs), 'commit');
    assert.equal(commits.length, 1);
    const c = assertValidEvent(commits[0], 'commit');

    assert.equal(c.level, 'INFO');
    assert.equal(c.msg, 'add the feature flag', 'the subject is the message');
    assert.equal(c.fields.branch, 'main');
    assert.equal(c.fields.author, 'Bench Tester');
    assert.equal(c.fields.sha.length, 12);
    assert.match(c.fields.stat, /1 file changed, 1 insertion\(\+\)/);
    assert.match(c.fields.when, /^\d{4}-\d\d-\d\dT/);
    assert.equal(c.tag, 'git');
  });

  it('reports a branch switch', async () => {
    assert.equal(git(['switch', '-q', '-c', 'feature']).status, 0);

    const recs = await waitFor(hub.url, isChange('branch'), { topic: TOPIC, timeoutMs: 20000 });
    const b = assertValidEvent(changed(onRepo(recs), 'branch')[0], 'branch');

    assert.equal(b.level, 'INFO');
    assert.equal(b.msg, 'switched branch main -> feature');
    assert.equal(b.fields.from, 'main');
    assert.equal(b.fields.to, 'feature');
  });

  it('calls an amend rewritten history, at WARN', async () => {
    commit('feature.txt', 'two\n', 'work in progress');
    await waitFor(hub.url,
      (rs) => onRepo(rs).some((r) => r.event.msg === 'work in progress'),
      { topic: TOPIC, timeoutMs: 20000 });

    const before2 = git(['rev-parse', 'HEAD']).stdout.trim();
    assert.equal(git(['commit', '-q', '--amend', '-m', 'work, properly described']).status, 0);
    const after2 = git(['rev-parse', 'HEAD']).stdout.trim();
    assert.notEqual(before2, after2);

    const recs = await waitFor(hub.url, isChange('rewrite'), { topic: TOPIC, timeoutMs: 20000 });
    const w = assertValidEvent(changed(onRepo(recs), 'rewrite')[0], 'rewrite');

    assert.equal(w.level, 'WARN', 'unremarkable on your own branch, the worst news on a shared one');
    assert.match(w.msg, /^history rewritten on feature: [0-9a-f]{8} is no longer an ancestor of [0-9a-f]{8}$/);
    assert.equal(w.fields.was, before2.slice(0, 12));
    assert.equal(w.fields.now, after2.slice(0, 12));
  });

  it('reports an add/add conflict and the merge it left in progress', async () => {
    assert.equal(git(['switch', '-q', '-c', 'other', 'main']).status, 0);
    commit('conflict.txt', 'from other\n', 'other adds conflict.txt');
    assert.equal(git(['switch', '-q', 'main']).status, 0);
    commit('conflict.txt', 'from main\n', 'main adds conflict.txt');

    const merge = git(['merge', 'other']);
    assert.notEqual(merge.status, 0, 'the merge was supposed to conflict');

    const recs = await waitFor(hub.url,
      (rs) => isChange('conflict')(rs) && isChange('state')(rs),
      { topic: TOPIC, timeoutMs: 25000 });

    const conflict = assertValidEvent(changed(onRepo(recs), 'conflict')[0], 'conflict');
    assert.equal(conflict.level, 'WARN');
    assert.equal(conflict.msg, 'merge conflicts in 1 file(s)');
    assert.equal(conflict.fields.files, 'conflict.txt');

    // This one only works because the tool asks for --absolute-git-dir.
    const state = assertValidEvent(changed(onRepo(recs), 'state')[0], 'state');
    assert.equal(state.level, 'WARN');
    assert.equal(state.msg, 'merge in progress',
                 'a relative --git-dir would resolve against the watcher\'s cwd and find nothing');
    assert.equal(state.fields.state, 'MERGE_HEAD');
  });

  it('--once prints the state of the repo and exits', async () => {
    const topic = 'git.test.once';
    const r = await run('superlog-git.mjs', ['--repo', repo, '--once', '--topic', topic],
                        { url: hub.url, cwd: work, env: gitEnv, timeoutMs: 20000 });
    assert.equal(r.code, 0);

    const recs = await waitFor(hub.url, (rs) => rs.length > 0, { topic, timeoutMs: 15000 });
    assert.equal(recs.length, 1, '--once says one thing per repo');
    const e = assertValidEvent(recs[0].event, topic);

    assert.equal(e.level, 'WARN', 'the tree is mid-merge, which the next command will find surprising');
    assert.match(e.msg, /^repo: main at [0-9a-f]{8}, \d+ uncommitted, 1 conflicted, MERGE_HEAD$/);
    assert.equal(e.fields.branch, 'main');
    assert.equal(e.fields.repo, repo);
  });
});
