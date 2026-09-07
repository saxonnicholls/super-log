//
//  tests/mavlink.test.mjs - superlog-mavlink against hand-built MAVLink.
//
//  Copyright 2026 Saxon Nicholls
//  SPDX-License-Identifier: MIT
//
//  No drone, and none needed. MAVLink is a documented binary frame with a
//  known CRC (CRC-16/MCRF4XX plus a per-message CRC_EXTRA), so the frames
//  here are the real wire format - correct field offsets, correct CRCs -
//  encoded independently of the tailer and sent over a real UDP socket to a
//  real hub. This is the same bargain the OTLP test makes: the encoder is
//  the fixture, the decoder, levelling and edge logic under test are the
//  shipping ones.
//
//  What is worth asserting is the judgment, not the parsing: a low battery
//  crosses to WARN then ERROR then recovers, a lost 3D GPS fix is a WARN, an
//  EMERGENCY system status is an ERROR, the autopilot's own STATUSTEXT rides
//  through at its severity - and a frame whose CRC does not check produces
//  NO event, because a byte that merely looks like a start-of-frame must not
//  become a phantom message.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { assertValidEvent, recent, start, startHub, waitFor, freeUdpPort } from './harness.mjs';

// ---- an independent MAVLink encoder (the fixture) ----
const EXTRA = { 0: 50, 1: 124, 24: 24, 33: 104, 74: 20, 77: 143, 253: 83 };
function crcAcc(b, crc) {
  let t = b ^ (crc & 0xff);
  t = (t ^ (t << 4)) & 0xff;
  return ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
}
function crc16(bytes, extra) {
  let crc = 0xffff;
  for (const b of bytes) crc = crcAcc(b, crc);
  return crcAcc(extra, crc);
}
let SEQ = 0;
function v2(msgid, payload, { sysid = 1, compid = 1, badCrc = false } = {}) {
  const head = Buffer.from([0xFD, payload.length, 0, 0, SEQ++ & 0xff, sysid, compid,
                            msgid & 0xff, (msgid >> 8) & 0xff, (msgid >> 16) & 0xff]);
  const noCrc = Buffer.concat([head, payload]);
  let crc = crc16(noCrc.subarray(1), EXTRA[msgid]);
  if (badCrc) crc ^= 0xffff;                    // corrupt it on purpose
  return Buffer.concat([noCrc, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}
function v1(msgid, payload, { sysid = 1, compid = 1 } = {}) {
  const head = Buffer.from([0xFE, payload.length, SEQ++ & 0xff, sysid, compid, msgid & 0xff]);
  const noCrc = Buffer.concat([head, payload]);
  const crc = crc16(noCrc.subarray(1), EXTRA[msgid]);
  return Buffer.concat([noCrc, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}
// payload builders at MAVLink wire offsets (size-descending field order)
function heartbeat({ custom = 0, type = 2, base = 0, state = 3 } = {}) {
  const p = Buffer.alloc(9);
  p.writeUInt32LE(custom, 0); p.writeUInt8(type, 4); p.writeUInt8(3, 5);
  p.writeUInt8(base, 6); p.writeUInt8(state, 7); p.writeUInt8(3, 8);
  return p;
}
function sysStatus({ volt = 11100, remaining = 100 } = {}) {
  const p = Buffer.alloc(31);
  p.writeUInt16LE(volt, 14); p.writeInt16LE(-1, 16); p.writeInt8(remaining, 30);
  return p;
}
function gpsRaw({ fix = 3, sats = 12 } = {}) {
  const p = Buffer.alloc(30);
  p.writeUInt8(fix, 28); p.writeUInt8(sats, 29);
  return p;
}
function statusText(severity, text) {
  const p = Buffer.alloc(51);
  p.writeUInt8(severity, 0);
  Buffer.from(text).copy(p, 1, 0, 49);
  return p;
}
function commandAck(command, result) {
  const p = Buffer.alloc(3);
  p.writeUInt16LE(command, 0); p.writeUInt8(result, 2);
  return p;
}

const BADTEXT = 'CORRUPTED-MUST-NOT-APPEAR';
const DONE = 'MAVLINK-TEST-DONE';
let hub, tool, port, events;

before(async () => {
  hub = await startHub();
  port = await freeUdpPort();
  tool = start('superlog-mavlink.mjs', ['--udp', String(port), '--batt-warn', '30', '--batt-crit', '15'],
               { url: hub.url });
  await tool.waitForStderr(/listening for MAVLink/);

  const sock = dgram.createSocket('udp4');
  const send = (b) => new Promise((res, rej) => sock.send(b, port, '127.0.0.1', (e) => (e ? rej(e) : res())));
  const gap = () => new Promise((r) => setTimeout(r, 15));

  // A flight, in frames. Baselines first (silent), then the crossings.
  // sysid 1 over v2; sysid 2 over v1 at the end to prove both versions.
  const flight = [
    heartbeat({ base: 0x00, state: 3 }),                         // disarmed, STANDBY (baseline)
    gpsRaw({ fix: 3, sats: 12 }),                                // 3D fix (baseline, silent)
    sysStatus({ remaining: 100 }),                               // full battery (baseline band ok)
    heartbeat({ base: 0x80, state: 4 }),                         // ARMED, ACTIVE
    sysStatus({ remaining: 25, volt: 11000 }),                   // battery -> WARN (<=30)
    gpsRaw({ fix: 1, sats: 4 }),                                 // lose 3D fix -> WARN
    statusText(3, 'EKF failsafe: bad variance'),                 // severity ERROR
    sysStatus({ remaining: 10, volt: 10500 }),                   // battery -> ERROR (<=15)
    statusText(0, 'CRASH: attitude control lost'),               // severity EMERGENCY -> CRITICAL
    commandAck(400, 2),                                          // MAV_CMD 400 (arm) DENIED -> ERROR
    heartbeat({ base: 0x80, custom: 4, state: 6 }),              // mode change + EMERGENCY -> ERROR
    sysStatus({ remaining: 50, volt: 11500 }),                   // battery recovered -> INFO
    gpsRaw({ fix: 3, sats: 10 }),                                // regain 3D fix -> INFO
    v2(253, statusText(4, BADTEXT), { badCrc: true }),           // bad CRC: must yield NO event
    v1(0, heartbeat({ base: 0x80, state: 4 }), { sysid: 2 }),    // v1 frame, sysid 2 -> mavlink.2
    statusText(6, DONE),                                         // sentinel (INFO)
  ];
  // Frames 0..12 and 15 are payloads to wrap in v2; 13 and 14 are already
  // full frames. Wrap the raw payloads, leave the pre-framed ones as-is.
  const framed = flight.map((f, i) =>
    (i === 13 || i === 14) ? f
      : v2(msgidFor(i), f));

  for (const b of framed) { await send(b); await gap(); }
  sock.close();

  const recs = await waitFor(hub.url,
    (rs) => rs.some((r) => r.event?.msg === DONE),
    { topic: 'mavlink.1', timeoutMs: 20000 });
  events = recs.map((r) => r.event);
  events.forEach((e, i) => assertValidEvent(e, `mavlink[${i}]`));
});

// Which msgid each raw payload in `flight` belongs to (the pre-framed
// entries 13/14 are skipped by the caller).
function msgidFor(i) {
  return [0, 24, 1, 0, 1, 24, 253, 1, 253, 77, 0, 1, 24, null, null, 253][i];
}

after(async () => {
  await tool?.stop();
  await hub?.stop();
});

const find = (pred) => events.find(pred);
const all2 = async () => (await recent(hub.url, { topic: 'mavlink.2' })).map((r) => r.event);

describe('superlog-mavlink', () => {
  it('announces an arm as one INFO', () => {
    const armed = find((e) => e.fields?.change === 'armed');
    assert.ok(armed, 'expected an ARMED event');
    assert.equal(armed.level, 'INFO');
    assert.match(armed.msg, /ARMED/);
  });

  it('crosses the battery to WARN, then ERROR, then announces recovery - once each', () => {
    const batt = events.filter((e) => e.fields?.change === 'battery' || e.fields?.change === 'battery_ok');
    const warns = batt.filter((e) => e.level === 'WARN');
    const errs = batt.filter((e) => e.level === 'ERROR');
    const recs = batt.filter((e) => e.level === 'INFO');
    assert.equal(warns.length, 1, 'exactly one battery WARN');
    assert.equal(errs.length, 1, 'exactly one battery ERROR (critical)');
    assert.equal(recs.length, 1, 'exactly one battery recovery INFO');
    assert.match(errs[0].msg, /critical/);
  });

  it('reports battery percent as a DEBUG metric reading', () => {
    const m = find((e) => e.metric?.name?.endsWith('.battery_pct'));
    assert.ok(m, 'expected a battery_pct metric');
    assert.equal(m.level, 'DEBUG');
    assert.equal(typeof m.metric.value, 'number');
  });

  it('makes a lost 3D GPS fix a WARN and its return an INFO', () => {
    const lost = find((e) => e.fields?.change === 'gps_lost');
    const ok = find((e) => e.fields?.change === 'gps_ok');
    assert.equal(lost.level, 'WARN');
    assert.match(lost.msg, /lost 3D fix/);
    assert.equal(ok.level, 'INFO');
  });

  it('gives an EMERGENCY system status an ERROR', () => {
    const emerg = find((e) => e.fields?.change === 'system_status' && /EMERGENCY/.test(e.msg));
    assert.ok(emerg, 'expected an EMERGENCY system status event');
    assert.equal(emerg.level, 'ERROR');
  });

  it("carries the autopilot's STATUSTEXT through at its own severity", () => {
    const ekf = find((e) => /EKF failsafe/.test(e.msg));
    assert.equal(ekf.level, 'ERROR', 'MAV_SEVERITY 3 -> ERROR');
    const crash = find((e) => /CRASH/.test(e.msg));
    assert.equal(crash.level, 'CRITICAL', 'MAV_SEVERITY 0 -> CRITICAL');
  });

  it('levels a denied COMMAND_ACK as ERROR', () => {
    const ack = find((e) => e.fields?.command === '400');
    assert.equal(ack.level, 'ERROR');
    assert.match(ack.msg, /DENIED/);
  });

  it('NEVER emits a frame whose CRC does not check', () => {
    for (const e of events) assert.doesNotMatch(e.msg, new RegExp(BADTEXT),
      'a bad-CRC frame became a phantom event');
  });

  it('decodes a v1 frame and separates sysids into their own topics', async () => {
    const two = await all2();
    assert.ok(two.length, 'expected events on mavlink.2 from the v1 frame');
    assert.ok(two.some((e) => e.fields?.change === 'armed'),
      'the v1 sysid-2 heartbeat should announce its arm');
    for (const e of events) assert.equal(e.fields?.sysid, '1', 'mavlink.1 carries only sysid 1');
  });
});

