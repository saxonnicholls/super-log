//
//  tests/crash.test.mjs - superlog-crash against synthetic crash reports.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A hermetic report directory (--dir), hand-written reports, and the real
//  tool run against a real hub. macOS .ips shapes are used because that is
//  where the rich parse lives; --dir makes that path portable, so the loop,
//  the --include filter and the event shape are exercised on any platform.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertValidEvent, removeDir, run, startHub, tempDir, waitFor } from './harness.mjs';

let hub, dir;
const TOPIC = 'crash.';

// A minimal but realistic .ips: a one-line JSON header, then the payload JSON.
function writeIps(name, proc, { signal = 'SIGSEGV', type = 'EXC_BAD_ACCESS' } = {}) {
  const header = { app_name: proc, timestamp: '2026-09-27 08:19:14.00 +1000', bug_type: '309' };
  const payload = {
    procName: proc,
    exception: { type, signal, subtype: 'KERN_INVALID_ADDRESS at 0x0' },
    termination: { indicator: 'Segmentation fault: 11' },
    faultingThread: 0,
    threads: [{ frames: [
      { imageIndex: 0, symbol: 'crash_here' },
      { imageIndex: 1, imageOffset: 1234 },   // 0x4d2
    ] }],
    usedImages: [{ name: `/tmp/${proc}` }, { name: '/usr/lib/libSystem.dylib' }],
  };
  writeFileSync(join(dir, name), `${JSON.stringify(header)}\n${JSON.stringify(payload)}`);
}

before(async () => {
  hub = await startHub();
  dir = tempDir('superlog-crash-');
});

after(async () => {
  await hub?.stop();
  removeDir(dir);
});

describe('superlog-crash', () => {
  it('publishes one ERROR per crash with signal, exception and faulting frames', async () => {
    writeIps('boomapp-2026-09-27-081914.ips', 'boomapp');

    const r = await run('superlog-crash.mjs', ['--dir', dir, '--once', '--backfill', '5'],
                        { url: hub.url });
    assert.equal(r.code, 0, r.stderr);

    const recs = await waitFor(hub.url, (rs) => rs.some((x) => x.topic.endsWith('.boomapp')),
                               { topic: TOPIC, timeoutMs: 15000 });
    const rec = recs.find((x) => x.topic.endsWith('.boomapp'));
    assert.ok(rec.topic.startsWith('crash.'), `topic is crash.<host>.boomapp, got ${rec.topic}`);
    const e = assertValidEvent(rec.event, 'crash');

    assert.equal(e.level, 'ERROR');
    assert.equal(e.tag, 'crash');
    assert.equal(e.fields.change, 'crash');
    assert.equal(e.fields.process, 'boomapp');
    assert.equal(e.fields.signal, 'SIGSEGV');
    assert.equal(e.fields.exception, 'EXC_BAD_ACCESS');
    assert.equal(e.fields.thread, '0');
    assert.match(e.fields.frames, /boomapp:crash_here/);
    assert.match(e.fields.frames, /libSystem\.dylib:0x4d2/);
    assert.match(e.msg, /boomapp crashed: SIGSEGV \(EXC_BAD_ACCESS\)/);
    assert.ok(e.fields.report.endsWith('.ips'), 'the report path rides along');
  });

  it('--include filters by process name', async () => {
    writeIps('keepme-2026-09-27-090000.ips', 'keepme');
    writeIps('dropme-2026-09-27-090001.ips', 'dropme');

    const r = await run('superlog-crash.mjs',
      ['--dir', dir, '--once', '--backfill', '10', '--include', 'keepme'], { url: hub.url });
    assert.equal(r.code, 0, r.stderr);

    const recs = await waitFor(hub.url, (rs) => rs.some((x) => x.topic.endsWith('.keepme')),
                               { topic: TOPIC, timeoutMs: 15000 });
    assert.ok(recs.some((x) => x.topic.endsWith('.keepme')), 'the matching crash is published');
    assert.ok(!recs.some((x) => x.topic.endsWith('.dropme')), 'the filtered-out crash is not');
  });
});
