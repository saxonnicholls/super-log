// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// `superlog login` is the MIT door to super-log Cloud: it prints a URL and
// opens a browser, and makes NO network call of its own (the whole point). These
// tests hold that contract - the URL is shown, the command exits rather than
// hanging (the bug that started this: `superlog` is the tee, so `superlog login`
// used to be read as a filename and wait on stdin forever), and the source
// imports nothing that could reach the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const tee = join(repo, 'tailers', 'bin', 'superlog-tee.mjs');
const door = join(repo, 'tailers', 'bin', 'superlog-login.mjs');
const URL_RE = /https:\/\/app\.super-log\.com\/login/;

// --print so the test never actually launches a browser. stdin is /dev/null and
// the 5s timeout is the safety net: a regression that read stdin would either
// print no URL (caught by the assertion) or hang (caught by the timeout).
const run = (bin, args) => execFileSync('node', [bin, ...args],
  { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });

test('`superlog login` prints the cloud URL and exits without hanging', () => {
  assert.match(run(tee, ['login', '--print']), URL_RE);
});

test('the door is reachable directly and prints the same URL', () => {
  assert.match(run(door, ['--print']), URL_RE);
});

test('the login door makes no network call - it imports nothing that could', () => {
  const src = readFileSync(door, 'utf8');
  for (const bad of ['fetch(', 'node:http', 'node:https', 'node:net',
                     'node:tls', 'node:dgram', 'XMLHttpRequest', 'WebSocket'])
    assert.ok(!src.includes(bad), `the login door must not use ${bad}`);
});
