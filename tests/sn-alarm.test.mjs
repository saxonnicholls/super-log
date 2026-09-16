//
//  tests/sn-alarm.test.mjs - SN_ALARM: a code alarm reaches the Alarms panel.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The C++ demo clock raises SN_ALARM_KEY on the 5-tick mark and SN_ALARM_CLEAR
//  ten ticks later. Nothing mocked: the real demo binary against a real hub,
//  proving the SDK primitive lands a first-class alarm on alert.native.* - the
//  same alert.* the viewers' Alarms panel reads - at CRITICAL with a dedup key,
//  and closes it with an INFO recovery. This is the C++ reference for the
//  cross-language alarm contract in docs/PROTOCOL.md; each SDK mirrors it.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { assertValidEvent, startHub, waitFor } from './harness.mjs';

const CLOCK = 'build/demo/cpp/superlog_clock_cpp';

describe('SN_ALARM - native code alarms reach the Alarms panel',
  { skip: existsSync(CLOCK) ? false : 'C++ demo not built (build target superlog_clock_cpp)' },
  () => {
    let hub, clock;

    before(async () => {
      hub = await startHub();
      clock = spawn(CLOCK, [],
        { env: { ...process.env, SUPER_LOG_URL: hub.url, SUPER_LOG_DEVICE: 'test' }, stdio: 'ignore' });
    });

    after(async () => { clock?.kill(); await hub?.stop(); });

    it('SN_ALARM_KEY fires a CRITICAL on alert.native.* with a dedup key', async () => {
      const recs = await waitFor(hub.url,
        (rs) => rs.some((r) => r.topic === 'alert.native.cpp.demo' && r.event?.level === 'CRITICAL'),
        { topic: 'alert.', timeoutMs: 25000 });
      const fire = recs.find((r) => r.topic === 'alert.native.cpp.demo' && r.event.level === 'CRITICAL');
      assertValidEvent(fire.event, 'alarm');
      assert.equal(fire.topic.startsWith('alert.'), true);   // the blotter's own filter
      assert.equal(fire.event.tag, 'alarm');
      assert.equal(fire.event.fields.key, 'cpp.demo');
      assert.match(fire.event.msg, /settlement lag/);
    });

    it('SN_ALARM_CLEAR closes it with an INFO recovery on the same key', async () => {
      const recs = await waitFor(hub.url,
        (rs) => rs.some((r) => r.topic === 'alert.native.cpp.demo'
          && r.event?.level === 'INFO' && /RECOVERED/.test(r.event?.msg ?? '')),
        { topic: 'alert.', timeoutMs: 25000 });
      const clear = recs.find((r) => r.topic === 'alert.native.cpp.demo' && r.event.level === 'INFO');
      assert.equal(clear.event.fields.key, 'cpp.demo');
      assert.match(clear.event.msg, /RECOVERED/);
    });
  });
