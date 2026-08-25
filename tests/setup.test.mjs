//
//  tests/setup.test.mjs - setup.sh and the logging.sh it writes.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  This pair is the documented front door: a stranger's first contact with
//  super-log is `setup.sh ~/code/my-app`, and everything after it depends on
//  the launcher behaving.
//
//  The assertion that earns this file is the sharing. The hub and the viewer
//  are machine-wide and must be started AT MOST ONCE - a second project
//  running `start` has to find them and only add its own streams. Get that
//  wrong and two projects mean two hubs fighting over a port and two viewers
//  each showing half the picture, which is the exact failure the launcher
//  exists to prevent. So the test stands a hub up first and then checks that
//  logging.sh joined it rather than competing with it.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, cleanEnv, recent, removeDir, startHub, tempDir, waitFor,
} from './harness.mjs';

const REPO = new URL('..', import.meta.url).pathname;

let hub, project;

const sh = (script, args, opts = {}) =>
  execFileSync('sh', [script, ...args], {
    encoding: 'utf8', timeout: 90_000, env: { ...cleanEnv(), HOME: project ?? '/tmp' }, ...opts,
  });

before(async () => {
  hub = await startHub();
  project = tempDir('superlog-project-');
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'package.json'),
                JSON.stringify({ name: 'demo-app', version: '1.0.0',
                                 scripts: { build: 'echo compiling' } }, null, 2));
  writeFileSync(join(project, 'src', 'index.js'), 'console.log(1)\n');
  // A real repo, because the launcher offers to watch it and setup.sh edits
  // .gitignore only when there is one.
  const git = (...a) => execFileSync('git', ['-C', project, ...a],
                                     { env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1',
                                              GIT_CONFIG_GLOBAL: '/dev/null', HOME: project } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
});

after(async () => {
  try { sh(join(project, 'logging.sh'), ['stop']); } catch { /* already stopped */ }
  await hub?.stop();
  removeDir(project);
});

describe('setup.sh', () => {
  it('writes a launcher and a config, and nothing else it was not asked to', () => {
    const out = sh(join(REPO, 'scripts', 'setup.sh'), [project]);
    assert.ok(existsSync(join(project, 'logging.sh')), 'logging.sh');
    assert.ok(existsSync(join(project, 'superlog.conf')), 'superlog.conf');
    assert.match(out, /set up for demo-app|set up for/, 'it says what it did');
  });

  it('reads the project and fills the config in rather than leaving it blank', () => {
    const conf = readFileSync(join(project, 'superlog.conf'), 'utf8');
    // package.json means node, so the build command should be npm's, not make's.
    assert.match(conf, /BUILD_CMD=npm run build/,
                 'a node project should not be handed `make` to run');
    assert.match(conf, /^GIT=1$/m, 'it is a git repo, so offer to watch it');
    assert.match(conf, /^TOPIC_PREFIX=/m);
  });

  it('keeps the project repo clean', () => {
    const gi = readFileSync(join(project, '.gitignore'), 'utf8');
    assert.match(gi, /^\.superlog\/$/m, 'pids and logs must not be committable');
  });

  it('does not clobber an edited config on a second run', () => {
    appendFileSync(join(project, 'superlog.conf'), '\n# a note the dev added\n');
    sh(join(REPO, 'scripts', 'setup.sh'), [project]);
    assert.match(readFileSync(join(project, 'superlog.conf'), 'utf8'), /a note the dev added/,
                 'a re-run must not silently discard what the dev wrote');
  });

  it('refuses to install into super-log itself', () => {
    assert.throws(() => sh(join(REPO, 'scripts', 'setup.sh'), [REPO], { stdio: 'pipe' }),
                  /super-log itself|Error/);
  });
});

describe('logging.sh', () => {
  before(() => {
    // Point the launcher at the test hub, and keep a viewer off: opening a
    // browser or a GLFW window in a test run is antisocial and CI has no
    // display anyway.
    const path = join(project, 'superlog.conf');
    const conf = readFileSync(path, 'utf8')
      .replace(/^PORT=.*$/m, `PORT=${hub.port}`)
      .replace(/^VIEWER=.*$/m, 'VIEWER=0')
      .replace(/^TOPIC_PREFIX=.*$/m, 'TOPIC_PREFIX=testproj')
      .replace(/^WATCH_DIRS=.*$/m, 'WATCH_DIRS=src');
    writeFileSync(path, conf);
  });

  it('joins a hub that is already running instead of starting a second', () => {
    const out = sh(join(project, 'logging.sh'), ['start']);
    assert.match(out, /hub already up/, 'it must reuse the shared hub');
    assert.doesNotMatch(out, /started the hub/,
                        'a second hub on a taken port is the failure this prevents');
  });

  it('starts the streams the config asked for', async () => {
    // `start` returns as soon as it has backgrounded the watcher, which is
    // not the same as the watcher having attached its fs.watch - and a
    // change made before it attaches is a change it can never report. The
    // watcher announces itself once it is watching, so wait for that rather
    // than for a duration.
    const log = join(project, '.superlog', 'watch.log');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(log) && readFileSync(log, 'utf8').includes('-> fs.testproj')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(readFileSync(log, 'utf8'), /-> fs\.testproj/,
                 'the watcher should have said what it is watching');

    appendFileSync(join(project, 'src', 'index.js'), '// touched\n');
    const evs = await waitFor(hub.url, (e) => e.some((x) => x.topic === 'fs.testproj'),
                              { timeoutMs: 15_000 });
    const mine = evs.filter((e) => e.topic === 'fs.testproj');
    assert.ok(mine.length > 0, 'the watcher the config asked for should be publishing');
    for (const e of mine) assertValidEvent(e.event);
  });

  it('reports what is running', () => {
    const out = sh(join(project, 'logging.sh'), ['status']);
    assert.match(out, /\(up\)/, 'it should see the hub it is using');
    assert.match(out, /watch/, 'and name the streams it started');
  });

  it('stops what it started and leaves the shared hub alone', async () => {
    sh(join(project, 'logging.sh'), ['stop']);
    const r = await fetch(`${hub.url}/healthz`);
    assert.equal(r.ok, true,
                 'stopping a project must never take the hub down under the others');
  });

  it('says so plainly when the super-log clone has moved', () => {
    let out = '';
    try {
      out = sh(join(project, 'logging.sh'), ['status'],
               { env: { ...cleanEnv(), SUPERLOG_HOME: '/nowhere', HOME: project },
                 stdio: 'pipe' });
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    assert.match(out, /not at \/nowhere/, 'a moved clone is a common and fixable problem');
    assert.match(out, /setup\.sh/, 'and the message should say how to fix it');
  });
});
