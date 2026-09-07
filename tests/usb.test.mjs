//
//  tests/usb.test.mjs - the device tree watcher, on the real machine.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Nothing mocked: --once reads THIS machine's real USB plane (ioreg on
//  macOS, lsusb on Linux) and the tree event must land on a real hub with
//  a parseable fields.tree. Hotplug diffing cannot be tested without a
//  hand plugging things in - that path is live-verified on the bench.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostname, platform } from 'node:os';

import { assertValidEvent, start, startHub, waitFor } from './harness.mjs';

// The skip check runs the collector, not merely finds it: a CI runner VM
// has lsusb on PATH and no USB subsystem behind it, which is a machine
// without the toolchain, not a failing test.
const probe = platform() === 'darwin'
  ? spawnSync('ioreg', ['-p', 'IOUSB', '-w0'], { encoding: 'utf8' })
  : spawnSync('lsusb', [], { encoding: 'utf8' });
const collector = platform() === 'darwin' ? 'ioreg' : 'lsusb';
const have = probe.status === 0 && (probe.stdout ?? '').trim().length > 0;

let hub;
const topic = `usb.${hostname().split('.')[0].toLowerCase()}`;

before(async () => { hub = await startHub(); });
after(async () => { await hub?.stop(); });

describe('superlog-usb', () => {
  it('--once publishes the real tree, parseable, with a device count',
     { skip: !have && `no ${collector}` }, async () => {
    const tail = start('superlog-usb.mjs', ['--once', '--url', hub.url], {});
    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => /usb tree: \d+ device/.test(r.event?.msg ?? '')),
      { topic, timeoutMs: 30000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `usb[${i}]`));
    const e = recs.map((r) => r.event).find((x) => x.fields?.tree);
    assert.ok(e, 'the tree rides the event');
    const tree = JSON.parse(e.fields.tree);
    assert.ok(Array.isArray(tree.children), 'the tree has a children array');
    assert.match(e.msg, new RegExp(`usb tree: \\d+ device`));
    await tail.stop();
  });
});
