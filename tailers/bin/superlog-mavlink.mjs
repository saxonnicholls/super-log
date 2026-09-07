#!/usr/bin/env node
//
//  superlog-mavlink - a drone's telemetry on the bench, decoded.
//
//  Copyright 2026 Saxon Nicholls
//  SPDX-License-Identifier: MIT
//
//  ArduPilot and PX4 speak MAVLink: a small binary frame carrying the
//  vehicle's whole nervous system - heartbeat, battery, GPS fix, mode
//  changes, and the autopilot's own STATUSTEXT log lines ("EKF failsafe",
//  "PreArm: ...", "Battery failsafe"). The failures that end a flight are
//  in there and nowhere else, and a ground station shows them for one
//  second before the next frame scrolls them away. This binds the UDP
//  stream a GCS/SITL forwards (or replays a .tlog capture) and turns it
//  into bench events with the discipline every watcher here keeps: battery
//  and satellites are DEBUG metric readings, a low battery or a lost 3D fix
//  is an edge-triggered WARN/ERROR that announces recovery, a mode change
//  or an arm is one INFO when it happens, and the FC's own STATUSTEXT rides
//  through at the severity it was sent with.
//
//    superlog-mavlink --udp 14550        # what a GCS/SITL forwards here
//    superlog-mavlink --tlog flight.tlog # replay a telemetry capture
//
//  Publishes to mavlink.<sysid>. No config: MAVLink is self-describing.
//  Decodes both v1 (0xFE) and v2 (0xFD) frames and validates each with the
//  real MAVLink CRC, so a byte that merely looks like a start-of-frame does
//  not become a phantom message. Node >= 18, zero dependencies.
//

import dgram from 'node:dgram';
import { createReadStream } from 'node:fs';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const num = (name, dflt) => { const v = opt(name); return v === undefined ? dflt : Number(v); };

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-mavlink - a drone's MAVLink telemetry on the bench

  superlog-mavlink --udp PORT   [--bind ADDR] [--topic PREFIX] [--url HUB]
  superlog-mavlink --tlog FILE  [--topic PREFIX] [--url HUB]

Decodes MAVLink v1/v2 (CRC-checked). Battery/sats are DEBUG metrics; a low
battery (--batt-warn %, --batt-crit %) or a lost 3D GPS fix is an edge WARN/
ERROR with recovery; mode/arm changes are one INFO; STATUSTEXT rides through
at its own severity. A vehicle that stops heart-beating for --link-timeout s
is a WARN (link lost), recovered when it beats again.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const prefix = opt('topic', 'mavlink');
const BATT_WARN = num('batt-warn', 30);
const BATT_CRIT = num('batt-crit', 15);
const LINK_TIMEOUT = num('link-timeout', 5) * 1000;

const device = hostname().split('.')[0].toLowerCase();
const session = randomBytes(4).toString('hex');
let seq = 0;

// One buffer per topic: a single UDP link can carry several sysids (a
// vehicle, a companion computer, a gimbal), and each is its own stream.
const buffers = new Map();
function publish(topic, level, msg, fields, metric) {
  const ev = {
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'mavlink', app: 'mavlink', platform: 'host', device },
    tag: 'mavlink', msg,
    ...(fields && Object.keys(fields).length
      ? { fields: Object.fromEntries(Object.entries(fields)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, String(v).slice(0, 256)])) }
      : {}),
    ...(metric ? { metric } : {}),
  };
  if (!buffers.has(topic)) buffers.set(topic, []);
  buffers.get(topic).push(JSON.stringify(ev));
}

async function flush() {
  for (const [topic, lines] of buffers) {
    if (!lines.length) continue;
    const body = lines.join('\n');
    buffers.set(topic, []);
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
      });
    } catch { /* hub down; the next batch counts again */ }
  }
}

// ---------------------------------------------------------- the MAVLink CRC
//
// CRC-16/MCRF4XX over the frame from the length byte through the payload,
// then the message's CRC_EXTRA byte folded in. Getting this right is what
// lets the decoder trust a frame instead of guessing - a random 0xFD in a
// payload will not pass.
function crcAccumulate(b, crc) {
  let tmp = b ^ (crc & 0xff);
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}
function crc16(bytes, extra) {
  let crc = 0xffff;
  for (const b of bytes) crc = crcAccumulate(b, crc);
  return crcAccumulate(extra, crc);
}

// CRC_EXTRA per message id (from the MAVLink common dialect), for the
// messages this tailer decodes. An id absent here is skipped structurally
// (advanced by its length) but never emitted - honest about what it knows.
const EXTRA = {
  0: 50,    // HEARTBEAT
  1: 124,   // SYS_STATUS
  24: 24,   // GPS_RAW_INT
  30: 39,   // ATTITUDE
  33: 104,  // GLOBAL_POSITION_INT
  74: 20,   // VFR_HUD
  77: 143,  // COMMAND_ACK
  253: 83,  // STATUSTEXT
};

// MAV_STATE (HEARTBEAT.system_status) and mode/severity vocab.
const MAV_STATE = ['UNINIT', 'BOOT', 'CALIBRATING', 'STANDBY', 'ACTIVE',
                   'CRITICAL', 'EMERGENCY', 'POWEROFF', 'FLIGHT_TERMINATION'];
const MAV_TYPE = { 1: 'fixed-wing', 2: 'quadrotor', 13: 'hexarotor', 14: 'octorotor',
                   10: 'ground-rover', 12: 'submarine' };
// MAV_SEVERITY -> bench level (syslog-shaped).
const SEV = ['CRITICAL', 'CRITICAL', 'ERROR', 'ERROR', 'WARN', 'INFO', 'INFO', 'DEBUG'];
const CMD_RESULT = { 0: 'ACCEPTED', 1: 'TEMPORARILY_REJECTED', 2: 'DENIED',
                     3: 'UNSUPPORTED', 4: 'FAILED', 5: 'IN_PROGRESS', 6: 'CANCELLED' };

// ------------------------------------------------------ per-vehicle state
//
// Everything here is edge-triggered: a reading is DEBUG, and only a CHANGE
// - a crossed battery line, a lost fix, a new mode, a link that went quiet -
// becomes a louder event, said once, with recovery announced.
const vehicles = new Map();
function veh(sysid) {
  if (!vehicles.has(sysid))
    vehicles.set(sysid, { battBand: 'ok', gps3d: null, armed: null, mode: null,
                          state: null, lastBeat: 0, linkDown: false });
  return vehicles.get(sysid);
}

function onMessage(sysid, compid, msgid, view) {
  const topic = `${prefix}.${sysid}`;
  const v = veh(sysid);
  v.lastBeat = Date.now();
  if (v.linkDown) { v.linkDown = false; publish(topic, 'INFO', `link recovered: sysid ${sysid} is heart-beating again`, { sysid, change: 'link_up' }); }

  switch (msgid) {
    case 0: {                                    // HEARTBEAT
      const custom = view.getUint32(0, true);
      const type = view.getUint8(4);
      const base = view.getUint8(6);
      const stateN = view.getUint8(7);
      const armed = (base & 0x80) !== 0;         // MAV_MODE_FLAG_SAFETY_ARMED
      const stateName = MAV_STATE[stateN] ?? `state ${stateN}`;
      if (v.armed !== armed) {
        publish(topic, 'INFO', `${armed ? 'ARMED' : 'DISARMED'}: sysid ${sysid}`,
                { sysid, change: armed ? 'armed' : 'disarmed', vehicle: MAV_TYPE[type] });
        v.armed = armed;
      }
      if (v.mode !== custom) {                    // custom_mode is the flight mode
        if (v.mode !== null) publish(topic, 'INFO', `mode changed: ${custom}`, { sysid, change: 'mode', custom_mode: custom });
        v.mode = custom;
      }
      if (v.state !== stateN) {
        // CRITICAL/EMERGENCY are the autopilot declaring a failsafe.
        const lvl = stateN >= 6 ? 'ERROR' : stateN === 5 ? 'WARN' : 'INFO';
        if (v.state !== null || lvl !== 'INFO')
          publish(topic, lvl, `system status: ${stateName}`, { sysid, change: 'system_status', status: stateName });
        v.state = stateN;
      }
      break;
    }
    case 1: {                                    // SYS_STATUS
      const volt = view.getUint16(14, true);     // mV
      const curr = view.getInt16(16, true);      // cA, -1 unknown
      const rem = view.getInt8(30);              // %, -1 unknown
      if (rem >= 0) {
        publish(topic, 'DEBUG', `battery ${rem}%`, { sysid },
                { name: `${topic}.battery_pct`, value: rem });
        const band = rem <= BATT_CRIT ? 'crit' : rem <= BATT_WARN ? 'warn' : 'ok';
        if (band !== v.battBand) {
          if (band === 'crit') publish(topic, 'ERROR', `battery critical: ${rem}% (${(volt / 1000).toFixed(2)}V)`, { sysid, battery_pct: rem, change: 'battery' });
          else if (band === 'warn') publish(topic, 'WARN', `battery low: ${rem}% (${(volt / 1000).toFixed(2)}V)`, { sysid, battery_pct: rem, change: 'battery' });
          else publish(topic, 'INFO', `battery recovered: ${rem}%`, { sysid, battery_pct: rem, change: 'battery_ok' });
          v.battBand = band;
        }
      }
      if (volt > 0) publish(topic, 'DEBUG', `battery ${(volt / 1000).toFixed(2)}V`, { sysid }, { name: `${topic}.voltage`, value: volt / 1000 });
      void curr;
      break;
    }
    case 24: {                                   // GPS_RAW_INT
      const fix = view.getUint8(28);
      const sats = view.getUint8(29);
      publish(topic, 'DEBUG', `gps sats ${sats}, fix ${fix}`, { sysid, fix_type: fix },
              { name: `${topic}.satellites`, value: sats });
      const has3d = fix >= 3;
      if (v.gps3d !== has3d) {
        if (v.gps3d !== null || !has3d)
          publish(topic, has3d ? 'INFO' : 'WARN',
                  has3d ? `gps: 3D fix (${sats} sats)` : `gps: lost 3D fix (fix_type ${fix})`,
                  { sysid, fix_type: fix, sats, change: has3d ? 'gps_ok' : 'gps_lost' });
        v.gps3d = has3d;
      }
      break;
    }
    case 33: {                                   // GLOBAL_POSITION_INT
      const relAlt = view.getInt32(16, true) / 1000; // mm -> m
      publish(topic, 'DEBUG', `alt ${relAlt.toFixed(1)}m`, { sysid },
              { name: `${topic}.rel_alt_m`, value: relAlt });
      break;
    }
    case 74: {                                   // VFR_HUD
      const airspeed = view.getFloat32(0, true);
      const ground = view.getFloat32(4, true);
      const alt = view.getFloat32(8, true);
      publish(topic, 'DEBUG', `spd ${ground.toFixed(1)}m/s alt ${alt.toFixed(1)}m`, { sysid, airspeed: airspeed.toFixed(1) },
              { name: `${topic}.groundspeed`, value: ground });
      break;
    }
    case 77: {                                   // COMMAND_ACK
      const cmd = view.getUint16(0, true);
      const result = view.getUint8(2);
      const name = CMD_RESULT[result] ?? `result ${result}`;
      const lvl = result === 0 || result === 5 ? 'INFO' : result === 1 ? 'WARN' : 'ERROR';
      publish(topic, lvl, `command ${cmd} ${name}`, { sysid, command: cmd, result: name });
      break;
    }
    case 253: {                                  // STATUSTEXT - the FC's own words
      const sev = view.getUint8(0);
      let text = '';
      for (let i = 1; i < view.byteLength; i++) {
        const c = view.getUint8(i);
        if (c === 0) break;
        text += String.fromCharCode(c);
      }
      publish(topic, SEV[sev] ?? 'INFO', text.trim() || '(empty statustext)', { sysid, severity: sev });
      break;
    }
    default: /* known-length skip already handled by the framer */ break;
  }
}

// ------------------------------------------------------------- the framer
//
// Feed bytes; it finds frames, CRC-checks them, and calls onMessage for the
// ones it can decode. Resyncs by one byte on a bad CRC, so a corrupt or
// mis-aligned stream self-heals rather than derailing.
let buf = Buffer.alloc(0);
function feed(chunk) {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  let i = 0;
  while (i < buf.length) {
    const magic = buf[i];
    const v2 = magic === 0xFD;
    const v1 = magic === 0xFE;
    if (!v1 && !v2) { i++; continue; }
    const headerLen = v2 ? 10 : 6;
    if (i + 1 >= buf.length) break;              // need the length byte
    const payloadLen = buf[i + 1];
    const frameLen = headerLen + payloadLen + 2; // + CRC
    if (i + frameLen > buf.length) break;        // wait for the rest

    let sysid, compid, msgid, payloadOff;
    if (v2) {
      const incompat = buf[i + 2];
      sysid = buf[i + 5]; compid = buf[i + 6];
      msgid = buf[i + 7] | (buf[i + 8] << 8) | (buf[i + 9] << 16);
      payloadOff = i + 10;
      if (incompat & 0x01) { /* signed: 13 extra bytes follow the CRC */ }
    } else {
      sysid = buf[i + 3]; compid = buf[i + 4]; msgid = buf[i + 5];
      payloadOff = i + 6;
    }
    const extra = EXTRA[msgid];
    // Only CRC-check messages we know the extra for; an unknown message we
    // cannot verify, so we advance past it (its length is trusted from the
    // header) without emitting. A signed v2 frame carries 13 more bytes.
    const signed = v2 && (buf[i + 2] & 0x01);
    const total = frameLen + (signed ? 13 : 0);
    if (i + total > buf.length) break;

    if (extra !== undefined) {
      const crcBytes = buf.subarray(i + 1, payloadOff + payloadLen);
      const want = crc16(crcBytes, extra);
      const got = buf[payloadOff + payloadLen] | (buf[payloadOff + payloadLen + 1] << 8);
      if (want !== got) { i++; continue; }       // bad CRC: not really a frame, resync
      const payload = buf.subarray(payloadOff, payloadOff + payloadLen);
      // A short payload (trailing zeros trimmed by the sender) is padded, so
      // reads at fixed offsets stay in range.
      const padded = Buffer.alloc(Math.max(payloadLen, 64));
      payload.copy(padded);
      try { onMessage(sysid, compid, msgid, new DataView(padded.buffer, padded.byteOffset, padded.byteLength)); }
      catch { /* a malformed known message is not worth crashing the bench */ }
    }
    i += total;
  }
  buf = buf.subarray(i);
  void flush();
}

// A vehicle that goes quiet is the failure a frame-by-frame view hides: the
// last heartbeat looked fine. Check on a timer and say so, once.
setInterval(() => {
  const now = Date.now();
  for (const [sysid, v] of vehicles) {
    if (!v.linkDown && v.lastBeat && now - v.lastBeat > LINK_TIMEOUT) {
      v.linkDown = true;
      publish(`${prefix}.${sysid}`, 'WARN', `link lost: no MAVLink from sysid ${sysid} for ${Math.round((now - v.lastBeat) / 1000)}s`, { sysid, change: 'link_down' });
      void flush();
    }
  }
}, 1000).unref?.();

// --------------------------------------------------------------- sources
const udpPort = opt('udp');
const tlog = opt('tlog');
if (!udpPort && !tlog) {
  console.error('superlog-mavlink: give it a source - --udp PORT or --tlog FILE');
  process.exit(2);
}

if (udpPort) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (m) => feed(m));
  sock.on('error', (e) => { console.error(`superlog-mavlink: udp error ${e.message}`); process.exit(1); });
  sock.bind(Number(udpPort), opt('bind', '0.0.0.0'), () => {
    console.error(`superlog-mavlink: listening for MAVLink on udp/${udpPort} -> ${prefix}.<sysid> -> ${hubUrl}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, async () => { try { sock.close(); } catch { /* gone */ } await flush(); process.exit(0); });
}

if (tlog) {
  // A .tlog is a sequence of [uint64 BE microseconds][raw MAVLink frame].
  // The frames are contiguous once the timestamps are stripped, but the
  // framer is tolerant, so feeding the file whole (timestamps and all) still
  // decodes - the 8-byte stamps simply fail to look like frames and are
  // skipped. Simplicity over a second parser.
  console.error(`superlog-mavlink: replaying ${tlog} -> ${prefix}.<sysid> -> ${hubUrl}`);
  const rs = createReadStream(tlog);
  rs.on('data', (c) => feed(c));
  rs.on('end', async () => { await flush(); process.exit(0); });
  rs.on('error', (e) => { console.error(`superlog-mavlink: ${e.message}`); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, async () => { await flush(); process.exit(0); });
}
