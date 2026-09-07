//
//  tests/prs.test.mjs - the PR watcher, against real GitHub.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  gh carries the wire, so this runs only where gh is authenticated
//  (skipped in CI, run on the bench - like cobol needing cobc). The
//  waiting-on-us judgment was verified live the day this shipped: the
//  first real pass found a PR 48 days silent and fired ERROR through
//  the gateway. This test guards the plumbing: a --once pass completes,
//  and any rows it publishes are valid events with the fields the
//  viewers' PRs board renders.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { assertValidEvent, start, startHub } from './harness.mjs';

const authed = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status === 0;

let hub;
before(async () => { hub = await startHub(); });
after(async () => { await hub?.stop(); });

describe('superlog-prs', () => {
  it('a --once pass completes and its rows carry the board fields',
     { skip: !authed && 'gh not authenticated' }, async () => {
    const tail = start('superlog-prs.mjs',
      ['--once', '--repo', 'saxonnicholls/super-log', '--no-alarm',
       '--url', hub.url], {});
    await tail.waitForStderr(/one pass over/);
    const got = await fetch(`${hub.url}/recent?limit=200`).then((r) => r.json());
    const rows = (got.events ?? [])
      .map((r) => r.event ?? r)
      .filter((e) => e?.tag === 'pr');
    for (const [i, e] of rows.entries()) {
      assertValidEvent(e, `pr[${i}]`);
      if (e.fields?.state === 'open') {
        assert.ok(e.fields.repo && e.fields.number && e.fields.url,
                  'board rows carry repo/number/url');
        assert.ok(['us', 'them'].includes(e.fields.waiting_on),
                  'whose move it is must be decided');
      }
    }
    await tail.stop();
  });
});
