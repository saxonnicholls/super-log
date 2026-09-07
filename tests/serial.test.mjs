//
//  tests/serial.test.mjs - superlog-serial against a pseudo-terminal.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A pty is a character device in every way the tailer cares about: stty
//  configures it, open(2) opens it, and bytes arrive a line at a time. So
//  the board is played by one, and the only thing being faked is which side
//  of the wire the bytes came from - the stty call, the reopen loop and the
//  parser are all the real ones.
//
//  What is worth asserting is the levelling. An RTOS console is a wall of
//  boot banner with three lines in it that matter, and a panic that arrives
//  at INFO is a panic nobody will ever filter for.
//
//  Windows has no pty, so this file skips there rather than pretending.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

import { assertValidEvent, recent, start, startHub, waitFor } from './harness.mjs';

// Decided once, at load, so every test can say why it is not running.
const unsupported = (() => {
  if (platform() === 'win32') return 'needs a POSIX pty';
  const p = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
  if (p.error || p.status !== 0) return 'needs python3 with the pty module to create the device';
  return null;
})();

const TOPIC = 'serial.test.board';

// What the common RTOS loggers actually put on the wire. \r\n because a
// serial console does, and stripping the CR is part of the job.
const CONSOLE = [
  'ets Jul 29 2019 12:21:46',
  'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)',
  'I (312) wifi: connected to bench-ap',
  'D (555) sched: tick',
  'W (402) power: battery low: 3.41V',
  'E (501) mqtt: connect failed rc=-1',
  '[00:00:12.345,678] <err> net_if: no route to host',
  '[00:00:13.001,000] <wrn> bt: pairing rejected',
  '[WARN] flash almost full',
  'ERROR: sensor read failed',
  "Guru Meditation Error: Core 0 panic'ed (LoadProhibited)",
  'assert failed: xQueueSend queue.c:1234 (uxItemSize > 0)',
];

const FEEDER = `
import os, pty, sys, time
master, slave = pty.openpty()
sys.stdout.write(os.ttyname(slave) + "\\n"); sys.stdout.flush()
sys.stdin.readline()                      # wait until the tailer has it open
for line in ${JSON.stringify(CONSOLE)}:
    os.write(master, (line + "\\r\\n").encode()); time.sleep(0.04)
sys.stdin.readline()                      # hold the master open until told
`;

let hub, tool, feeder, events;

before(async () => {
  if (unsupported) return;
  hub = await startHub();

  feeder = spawn('python3', ['-c', FEEDER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const port = await new Promise((res, rej) => {
    feeder.stdout.once('data', (d) => res(d.toString().trim()));
    feeder.once('error', rej);
    setTimeout(() => rej(new Error('python3 did not name a pty')), 10000).unref?.();
  });

  tool = start('superlog-serial.mjs', ['--port', port, '--topic', TOPIC], { url: hub.url });

  // The tailer says so on the hub once stty has run and the device is open.
  // Only then is it safe to write: bytes sent before that would sit in the
  // line discipline and this test would be measuring luck.
  await waitFor(hub.url, (rs) => rs.some((r) => r.event?.fields?.change === 'open'),
                { topic: TOPIC, timeoutMs: 20000 });
  feeder.stdin.write('go\n');

  const recs = await waitFor(hub.url,
    (rs) => rs.some((r) => r.event?.msg?.includes('uxItemSize')),
    { topic: TOPIC, timeoutMs: 20000 });
  events = recs.map((r) => r.event);
  events.forEach((e, i) => assertValidEvent(e, `${TOPIC}[${i}]`));
});

after(async () => {
  try { feeder?.stdin.write('stop\n'); } catch { /* already gone */ }
  await tool?.stop();
  try { feeder?.kill('SIGKILL'); } catch { /* already gone */ }
  await hub?.stop();
});

const line = (fragment) => events.find((e) => e.msg.includes(fragment));

describe('superlog-serial', () => {
  it('reads ESP-IDF lines with their tag, level and uptime', (t) => {
    if (unsupported) return t.skip(unsupported);

    const wifi = line('connected to bench-ap');
    assert.equal(wifi.level, 'INFO');
    assert.equal(wifi.tag, 'wifi');
    assert.equal(wifi.msg, 'connected to bench-ap');
    assert.equal(wifi.fields.uptime_ms, '312');
    assert.equal(wifi.origin.runtime, 'serial');

    const power = line('battery low');
    assert.equal(power.level, 'WARN');
    assert.equal(power.tag, 'power');
    assert.equal(power.fields.uptime_ms, '402');
    assert.equal(power.msg, 'battery low: 3.41V', 'the tag is stripped, the colon in the message is not');

    const mqtt = line('connect failed rc=-1');
    assert.equal(mqtt.level, 'ERROR');
    assert.equal(mqtt.tag, 'mqtt');
    assert.equal(mqtt.fields.uptime_ms, '501');

    const sched = line('tick');
    assert.equal(sched.level, 'DEBUG');
    assert.equal(sched.tag, 'sched');
  });

  it('reads Zephyr lines', (t) => {
    if (unsupported) return t.skip(unsupported);

    const net = line('no route to host');
    assert.equal(net.level, 'ERROR');
    assert.equal(net.tag, 'net_if');
    assert.equal(net.msg, 'no route to host');

    const bt = line('pairing rejected');
    assert.equal(bt.level, 'WARN');
    assert.equal(bt.tag, 'bt');
  });

  it('reads bracketed and prefixed levels from a homemade logger', (t) => {
    if (unsupported) return t.skip(unsupported);

    const bracketed = line('flash almost full');
    assert.equal(bracketed.level, 'WARN');
    assert.equal(bracketed.msg, 'flash almost full');
    assert.ok(!('tag' in bracketed), 'a bracketed level carries no tag to take');

    const prefixed = line('sensor read failed');
    assert.equal(prefixed.level, 'ERROR');
    assert.equal(prefixed.msg, 'sensor read failed');
  });

  it('gives a panic and a failed assert CRITICAL', (t) => {
    if (unsupported) return t.skip(unsupported);

    const panic = line('Guru Meditation');
    assert.equal(panic.level, 'CRITICAL');
    assert.match(panic.msg, /Core 0 panic'ed \(LoadProhibited\)/);

    const failed = line('uxItemSize');
    assert.equal(failed.level, 'CRITICAL',
                 'a failed assert is what you scroll back looking for');
  });

  it('marks a boot banner as a reset without calling it a failure', (t) => {
    if (unsupported) return t.skip(unsupported);

    const ets = line('ets Jul 29 2019');
    assert.equal(ets.level, 'INFO');
    assert.equal(ets.fields.change, 'boot');

    const rst = line('POWERON_RESET');
    assert.equal(rst.level, 'INFO');
    assert.equal(rst.fields.change, 'boot');
  });

  it('strips the carriage return the wire put there', (t) => {
    if (unsupported) return t.skip(unsupported);
    for (const e of events) assert.doesNotMatch(e.msg, /[\r\n]/, JSON.stringify(e.msg));
  });

  it('publishes every line it read and nothing it did not', async (t) => {
    if (unsupported) return t.skip(unsupported);

    const recs = await recent(hub.url, { topic: TOPIC });
    // One "console open" event plus one per line: nothing invented, nothing
    // silently dropped.
    const open = recs.filter((r) => r.event.fields?.change === 'open');
    assert.equal(open.length, 1);
    assert.equal(recs.length, CONSOLE.length + 1,
                 recs.map((r) => `${r.event.level} ${r.event.msg}`).join('\n'));
  });
});
