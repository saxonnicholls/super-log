#!/usr/bin/env node
//
//  superlog-starlink - the dish, watched: readings, alerts, and outages.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Starlink's dish speaks gRPC on 192.168.100.1:9200 (LAN-only,
//  unauthenticated, with server reflection). grpcurl carries the wire -
//  the same bargain curl, psql and gh make elsewhere on this bench - and
//  reflection is the point: SpaceX shifts the protobuf across firmware,
//  and a reflection client heals where baked field numbers break.
//
//  (Rolling our own was weighed: a unary gRPC call is just a 5-byte
//  frame over HTTP/2 - libcurl or node:http2 can carry it in ~150
//  lines - but the get_status response is a deep nested message whose
//  hand-decode is the real weight, and it drifts. If the grpcurl
//  dependency ever chafes, that narrow client is the road; see the
//  session notes in CHANGELOG.)
//
//  What it publishes, on starlink.dishy:
//    - READINGS each poll: pop ping latency and drop rate, up/down
//      throughput, obstruction fraction, GPS satellites, uptime.
//    - EDGES: currently obstructed WARN/recovery; each alert flag
//      (thermal throttle, motors stuck, ...) WARN when it appears,
//      recovery when it clears; dish unreachable ERROR after two misses,
//      recovery announced; a firmware version change and an uptime
//      reset (reboot) each get one INFO.
//
//  Paired with superlog-netstate's gateway watch, three failures that
//  look identical from a spinning browser separate cleanly: the dish is
//  down, the router is down, or the path is merely degraded.
//
//    superlog-starlink                     # 15s poll against the dish
//    superlog-starlink --once              # one reading, then exit
//

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { loadEnv } from './env.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-starlink - the dish, watched

  superlog-starlink [--dish 192.168.100.1:9200] [--interval 15]
                    [--once] [--url HUB]

Publishes to starlink.dishy: latency/throughput/obstruction readings as
metric events, alert flags and obstruction as edge-triggered WARN with
recovery, unreachable as ERROR after two misses. Needs grpcurl on PATH
(brew install grpcurl); the dish must be reachable (Starlink router in
bypass mode, or a route to 192.168.100.1).`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const dish = opt('dish', env.SUPER_LOG_STARLINK_DISH ?? '192.168.100.1:9200');
const intervalS = Number(opt('interval', 15)) || 15;
const once = args.includes('--once');

const session = randomBytes(4).toString('hex');
let seq = 0;
let lines = [];

function publish(level, msg, fields, metric) {
  lines.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'starlink', platform: 'device', device: 'dishy' },
    tag: 'starlink', msg,
    ...(metric ? { metric } : {}),
    ...(fields && Object.keys(fields).length
      ? { fields: Object.fromEntries(Object.entries(fields)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, String(v)])) }
      : {}),
  }));
}

async function flush() {
  if (!lines.length) return;
  const body = lines.join('\n');
  lines = [];
  try {
    await fetch(`${hubUrl}/ingest/starlink.dishy`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch { /* hub down; the next batch counts again */ }
}

async function getStatus() {
  const { stdout } = await run('grpcurl',
    ['-plaintext', '-max-time', '10', '-d', '{"get_status":{}}',
     dish, 'SpaceX.API.Device.Device/Handle'],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout).dishGetStatus ?? {};
}

// ------------------------------------------------------------- the poll

let misses = 0;
let down = false;
let firstDone = false;
let lastAlerts = new Set();
let lastObstructed = false;
let lastSoftware = '';
let lastUptime = 0;

async function poll() {
  let s;
  try {
    s = await getStatus();
  } catch (e) {
    misses += 1;
    if (misses === 2 && !down) {
      down = true;
      publish('ERROR', `dish unreachable at ${dish} (2 consecutive misses) - ` +
        'if the gateway is also down it is the router; if not, it is the dish',
        { dish, error: String(e.message ?? e).slice(0, 120) });
    }
    await flush();
    if (once) { console.error(`superlog-starlink: dish unreachable at ${dish}`); process.exit(1); }
    return;
  }
  misses = 0;
  if (down) {
    down = false;
    publish('INFO', 'RECOVERED: dish is answering again', { dish });
  }

  const info = s.deviceInfo ?? {};
  const uptime = Number(s.deviceState?.uptimeS ?? 0);
  const alerts = new Set(Object.entries(s.alerts ?? {})
    .filter(([, v]) => v === true).map(([k]) => k));
  const obstructed = s.obstructionStats?.currentlyObstructed === true;

  if (!firstDone) {
    firstDone = true;
    publish('INFO', `watching the dish - ${info.hardwareVersion ?? '?'} ` +
      `sw ${info.softwareVersion ?? '?'} (${info.countryCode ?? '?'}), ` +
      `up ${(uptime / 3600).toFixed(1)}h` +
      (alerts.size ? `; active alerts: ${[...alerts].join(', ')}` : ''),
      { hardware: info.hardwareVersion, software: info.softwareVersion,
        country: info.countryCode, dish });
  } else {
    if (lastSoftware && info.softwareVersion && info.softwareVersion !== lastSoftware)
      publish('INFO', `dish firmware updated: ${lastSoftware} -> ${info.softwareVersion}`,
              { was: lastSoftware, now: info.softwareVersion });
    if (uptime && lastUptime && uptime < lastUptime)
      publish('INFO', `dish rebooted (uptime reset to ${uptime}s)`, { uptime_s: uptime });
    for (const a of alerts)
      if (!lastAlerts.has(a))
        publish('WARN', `dish alert: ${a}`, { alert: a });
    for (const a of lastAlerts)
      if (!alerts.has(a))
        publish('INFO', `RECOVERED: dish alert cleared: ${a}`, { alert: a });
    if (obstructed && !lastObstructed)
      publish('WARN', 'dish is currently obstructed - the sky just got smaller', {});
    else if (!obstructed && lastObstructed)
      publish('INFO', 'RECOVERED: obstruction cleared', {});
  }
  lastAlerts = alerts;
  lastObstructed = obstructed;
  lastSoftware = info.softwareVersion ?? lastSoftware;
  lastUptime = uptime;

  // Readings. A missing reading stays absent - a dish that reports no
  // drop rate did not report zero drops.
  const m = (name, value, unit = '') => {
    if (value === undefined || value === null || Number.isNaN(Number(value))) return;
    publish('DEBUG', `${name} =${Number(value).toFixed(2)}${unit}`, undefined,
            { name, value: Number(Number(value).toFixed(3)) });
  };
  m('starlink.pop_latency_ms', s.popPingLatencyMs, 'ms');
  m('starlink.pop_drop_rate', s.popPingDropRate);
  m('starlink.down_mbps', s.downlinkThroughputBps !== undefined
      ? s.downlinkThroughputBps / 1e6 : undefined, 'Mbps');
  m('starlink.up_mbps', s.uplinkThroughputBps !== undefined
      ? s.uplinkThroughputBps / 1e6 : undefined, 'Mbps');
  m('starlink.obstruction_pct', s.obstructionStats?.fractionObstructed !== undefined
      ? s.obstructionStats.fractionObstructed * 100 : undefined, '%');
  m('starlink.gps_sats', s.gpsStats?.gpsSats);
  m('starlink.uptime_s', uptime || undefined, 's');

  await flush();
}

const main = async () => {
  try { await run('grpcurl', ['--version'], { timeout: 10000 }); }
  catch {
    console.error('superlog-starlink: grpcurl not on PATH - brew install grpcurl');
    process.exit(1);
  }
  await poll();
  if (once) {
    console.error('superlog-starlink: one reading published');
    process.exit(0);
  }
  setInterval(() => void poll(), intervalS * 1000);
  console.error(`superlog-starlink: starlink.dishy <- ${dish} every ${intervalS}s -> ${hubUrl}`);
};

void main();
