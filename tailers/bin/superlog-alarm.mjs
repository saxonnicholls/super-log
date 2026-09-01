#!/usr/bin/env node
//
//  superlog-alarm - the inbound half: production's way to reach the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Production systems here are deliberately mute - every SDK's PRODUCTION
//  mode ships nothing, and that is the security posture, not a gap. But an
//  ALARM is not logging: it is a deliberate, rare, operational act - "the
//  KEK is not loaded", "settlement failed" - and production must be able
//  to say it. This is the door: a token-guarded webhook the bench exposes
//  through a tunnel, whose accepted POSTs become alert.inbound.* events -
//  the viewers' alarm BLOTTER, sparse by construction, far from the
//  firehose.
//
//  Shaped by a real 4.7-day outage that was detected in 600 seconds and
//  ignored for 113 re-fires, because the alert had nowhere to go and no
//  shape when it got there. Hence the contract:
//
//    - DEDUP KEYS with repeat counts. The same key firing hourly is ONE
//      alarm with repeat=113, not 113 alarms. Humans are re-notified at
//      most every --renotify seconds ("still firing, repeat=41").
//    - RECOVERY closes the loop: {key, recovered:true} publishes
//      "RECOVERED after 4.7d (fired 113x)" and clears the key - resolved
//      and forgotten stop looking identical.
//    - HEARTBEATS make silence impossible: a checker POSTs
//      /heartbeat/<name> on every run; miss 3 intervals and the gateway
//      itself raises monitor_dead:<name> at CRITICAL, and says so again
//      when the checker returns. The watcher being dead is the one alarm
//      the watcher cannot send.
//    - DELIVERY IS OBSERVED: POST /selftest makes the bench call itself
//      through its own PUBLIC url and reports every step - the viewers'
//      Test button - and a POST whose hub write fails returns 502, so the
//      caller knows the alarm did NOT land instead of assuming it did.
//
//    superlog-alarm                        # gateway :7336, Cloudflare quick tunnel
//    superlog-alarm --tunnel ngrok         # or ngrok, or zrok, or --tunnel none
//    superlog-alarm --hostname alarm.example.com
//                                          # a NAMED Cloudflare tunnel, provisioned
//                                          # via the API (CLOUDFLARE_API_TOKEN,
//                                          # _ACCOUNT_ID, _ZONE_ID in .env)
//
//  What production calls (one curl, any language, no SDK):
//
//    curl -X POST https://<public>/alarm/kms \
//         -H "x-superlog-token: $TOKEN" -H "content-type: application/json" \
//         -d '{"key":"kek_not_loaded","level":"CRITICAL",
//              "msg":"KEK not loaded - run scripts/kms_kek_load.sh"}'
//    ...and when it heals:
//    curl ... -d '{"key":"kek_not_loaded","recovered":true}'
//    ...and on every checker run, regardless of findings:
//    curl -X POST https://<public>/heartbeat/kms-checker \
//         -H "x-superlog-token: $TOKEN" -d '{"interval":60}'
//
//  Severity convention: P0=CRITICAL, P1=ERROR, P2=WARN. Human delivery
//  goes through the notify.mjs channel registry (--notify desktop,telegram
//  ...); the hub gets every occurrence with fields.key and fields.repeat.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { readFileSync, watchFile, writeFileSync } from 'node:fs';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';
import { channelRoster, deliver, makeChannels } from './notify.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-alarm - a token-guarded public webhook that lands on the bench

  superlog-alarm [--port 7336] [--tunnel cloudflare|ngrok|zrok|none]
                 [--hostname alarm.example.com] [--token SECRET]
                 [--notify desktop,telegram,...] [--renotify SECONDS] [--url HUB]
                 [--provision endpoints.json]

POST /alarm/<name>      {key?, level?, msg, fields?, recovered?} - deduped by
                        key with repeat counts; recovery closes the loop
POST /heartbeat/<name>  {interval?} - miss 3 intervals and the gateway raises
                        monitor_dead:<name> CRITICAL itself
GET  /healthz           tunnel, hub, firing keys, heartbeats, channel roster
POST /selftest          loopback only: the whole public path, step by step

--hostname provisions a NAMED Cloudflare tunnel via the API. --provision
reads a declarative manifest of endpoints (see the manifest section in the
source) and keeps it applied as the file changes. Severity: P0=CRITICAL,
P1=ERROR, P2=WARN.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const port = Number(opt('port', env.SUPER_LOG_ALARM_PORT ?? '7336'));
const tunnelKind = opt('tunnel', env.SUPER_LOG_ALARM_TUNNEL ?? 'cloudflare');
const wantHostname = opt('hostname', env.SUPER_LOG_ALARM_HOSTNAME ?? '');
const renotifyMs = Number(opt('renotify', env.SUPER_LOG_ALARM_RENOTIFY ?? '1800')) * 1000;
const notifyNames = (opt('notify', env.SUPER_LOG_ALARM_NOTIFY ?? 'desktop') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const token = opt('token', env.SUPER_LOG_ALARM_TOKEN ?? '') || randomBytes(16).toString('hex');
// Gateways compose like hubs do: whatever this one accepts is re-POSTed
// upstream when configured - a site gateway feeding a central one. The
// x-superlog-hop header caps the chain at 4, so two gateways pointed at
// each other bicker briefly instead of forever.
const forwardUrl = opt('forward', env.SUPER_LOG_ALARM_FORWARD ?? '');
const forwardToken = env.SUPER_LOG_ALARM_FORWARD_TOKEN ?? token;

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._:-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 64) || 'alarm';
const device = sanitize(hostname().split('.')[0]);
const channels = makeChannels({}, env);
const channelsSaid = new Set();

// ------------------------------------------------------------- publishing

const started = Date.now();
const session = randomBytes(4).toString('hex');
let seq = 0;
const dur = (ms) => ms >= 86400000 ? `${(ms / 86400000).toFixed(1)}d`
  : ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h`
  : ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;

async function publishAlert(topicName, level, msg, fields) {
  const line = JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'alarm', platform: 'alert', device },
    tag: 'alarm', msg: String(msg).slice(0, 1000),
    fields: Object.fromEntries(Object.entries(fields ?? {})
      .slice(0, 24).map(([k, v]) => [String(k).slice(0, 64), String(v).slice(0, 500)])),
  });
  const r = await fetch(`${hubUrl}/ingest/alert.inbound.${sanitize(topicName)}`, {
    method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: line,
    signal: AbortSignal.timeout(5000),
  });
  return r.ok || r.status === 202;
}

const notifyHumans = (title, body, level) =>
  deliver(channels, notifyNames, { title, body, level }, channelsSaid);

// ------------------------------------------------------ alarms, by dedup key
//
// The state that turns 113 re-fires into one row that says repeat=113. Keys
// are the caller's own (kek_not_loaded, peg_below:base:0x09bb); a POST
// without one dedups per alarm name, which is the right default for a
// caller too simple to have keys.

const firing = new Map();   // key -> { name, level, msg, count, firstAt, lastAt, notifiedAt }
let inboundCount = 0;
let lastInbound = null;

function forwardOn(path, bodyStr, hops) {
  if (!forwardUrl || hops >= 4) return;
  fetch(`${forwardUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'x-superlog-token': forwardToken,
               'x-superlog-hop': String(hops + 1) },
    body: bodyStr, signal: AbortSignal.timeout(10000),
  }).catch((e) => console.error(`superlog-alarm: forward failed: ${e.message}`));
}

async function onAlarm(name, body, hops = 0) {
  const key = sanitize(body.key ?? name);
  const now = Date.now();
  const isTest = key === 'test' || body._test === true;

  if (body.recovered === true || body.recovered === 'true') {
    const st = firing.get(key);
    if (!st) return { ok: true, note: `nothing firing under key '${key}'` };
    firing.delete(key);
    const msg = `RECOVERED: ${key} after ${dur(now - st.firstAt)} (fired ${st.count}x)`;
    const ok = await publishAlert(name, 'INFO', msg,
      { key, kind: 'recovered', repeat: st.count, first_at: new Date(st.firstAt).toISOString() });
    if (ok) void notifyHumans(`RECOVERED: ${key}`, msg, 'INFO');
    return { ok, published: ok ? `alert.inbound.${sanitize(name)}` : undefined, recovered: key };
  }

  const level = LEVELS.includes(String(body.level ?? '').toUpperCase())
    ? String(body.level).toUpperCase() : 'ERROR';
  const msg = String(body.msg ?? 'alarm (no message given)');
  const st = firing.get(key) ?? { name, level, msg, count: 0, firstAt: now, notifiedAt: 0 };
  st.count += 1;
  st.lastAt = now;
  st.level = level;
  st.msg = msg;
  firing.set(key, st);

  const ok = await publishAlert(name, level, st.count > 1 ? `${msg} (repeat ${st.count})` : msg, {
    ...(body.fields ?? {}), key, repeat: st.count,
    first_at: new Date(st.firstAt).toISOString(),
  });
  if (!ok) return { ok: false, error: 'hub unreachable - alarm NOT delivered' };

  inboundCount += 1;
  lastInbound = { key, level, at: new Date().toISOString(), repeat: st.count };
  // Humans hear the first firing, then at most one reminder per renotify
  // window - the difference between a page and a pager going off 113
  // times. A TEST alarm bypasses that entirely: its whole job is proving
  // the notification arrives, every single time the button is pressed.
  if (isTest || st.count === 1 || now - st.notifiedAt >= renotifyMs) {
    st.notifiedAt = now;
    void notifyHumans(`ALARM: ${key}`,
      st.count > 1 && !isTest
        ? `still firing since ${dur(now - st.firstAt)} ago (repeat ${st.count}): ${msg}` : msg,
      level);
  }
  if (isTest) firing.delete(key);               // tests never accumulate as incidents
  forwardOn(`/alarm/${sanitize(name)}`, JSON.stringify(body), hops);
  console.error(`superlog-alarm: [${level}] ${key} repeat=${st.count}: ${msg.slice(0, 120)}`);
  return { ok: true, published: `alert.inbound.${sanitize(name)}`, key, repeat: st.count };
}

// -------------------------------------------------- heartbeats / dead-man
//
// Every checker POSTs /heartbeat/<name> each run, findings or not. Miss
// three intervals and the gateway raises monitor_dead:<name> CRITICAL
// itself - the one alarm the dead watcher cannot send, and the feature
// that makes a silent 4.7 days structurally impossible.

const heartbeats = new Map();   // name -> { lastSeen, intervalMs, dead }

function beat(name, intervalS) {
  const hb = heartbeats.get(name) ?? { lastSeen: 0, intervalMs: 60000, dead: false };
  hb.lastSeen = Date.now();
  if (intervalS > 0) hb.intervalMs = intervalS * 1000;
  const wasDead = hb.dead;
  hb.dead = false;
  heartbeats.set(name, hb);
  if (wasDead) {
    void publishAlert('monitor-dead', 'INFO',
      `RECOVERED: monitor_dead:${name} - the checker is reporting again`,
      { key: `monitor_dead:${name}`, kind: 'recovered' });
    void notifyHumans(`RECOVERED: monitor ${name}`, 'the checker is reporting again', 'INFO');
  }
  return { ok: true, name, interval_s: hb.intervalMs / 1000 };
}

setInterval(() => {
  const now = Date.now();
  for (const [name, hb] of heartbeats) {
    if (hb.dead || now - hb.lastSeen <= hb.intervalMs * 3) continue;
    hb.dead = true;
    const msg = `monitor_dead:${name} - no heartbeat for ${dur(now - hb.lastSeen)} ` +
                `(expected every ${dur(hb.intervalMs)}). The checker itself is down; ` +
                'every alarm it owns is now blind.';
    void publishAlert('monitor-dead', 'CRITICAL', msg,
      { key: `monitor_dead:${name}`, monitor: name });
    void notifyHumans(`MONITOR DEAD: ${name}`, msg, 'CRITICAL');
    console.error(`superlog-alarm: ${msg}`);
  }
}, 15000).unref?.();

// ----------------------------------------------- watched tunnels/webhooks
//
// "Up" is a measurement, not a memory. Every endpoint declared as
// SUPER_LOG_TUNNEL_<NAME>=url[|interval_s] in the environment - plus this
// gateway's own tunnel, automatically - is pinged on its own clock
// (default 120s; |300 for the ones that can wait five minutes). ANY HTTP
// answer counts as reachable (a 404 from the far end still proves the
// tunnel), two consecutive failures is DOWN, and up/down rides the same
// dedup machinery as every other alarm: tunnel_down:<name>, repeats
// counted, recovery closing the loop. The pings use the same DoH+SNI
// fallback as the selftest, so a filtering local resolver cannot fake an
// outage.

const watched = new Map();  // name -> {url, intervalMs, healthy, fails, lastOk, lastMs, checks}

for (const [k, v] of Object.entries(env)) {
  const m = /^SUPER_LOG_TUNNEL_([A-Z0-9_]+)$/.exec(k);
  if (!m || !v) continue;
  const [url, iv] = String(v).split('|');
  watched.set(m[1], { url: url.trim(), intervalMs: (Number(iv) || 120) * 1000,
                      healthy: null, fails: 0, lastOk: null, lastMs: null, checks: 0 });
}

async function pingEndpoint(name, w) {
  const t0 = Date.now();
  w.lastChecked = new Date().toISOString();
  let ok = false;
  try {
    const got = await publicFetch('GET', w.url, {});
    ok = typeof got.status === 'number';        // any answer proves the wire
  } catch { /* unreachable */ }
  w.checks += 1;
  w.lastMs = Date.now() - t0;
  if (ok) {
    w.lastOk = new Date().toISOString();
    w.fails = 0;
    if (w.healthy === false)
      void onAlarm('tunnels', { key: `tunnel_down:${name.toLowerCase()}`, recovered: true });
    w.healthy = true;
  } else {
    w.fails += 1;
    if (w.fails >= 2 && w.healthy !== false) {
      w.healthy = false;
      void onAlarm('tunnels', {
        key: `tunnel_down:${name.toLowerCase()}`, level: 'ERROR',
        msg: `${name} unreachable at ${w.url} (2 consecutive ping failures)`,
        fields: { url: w.url },
      });
    } else if (w.fails >= 2) {
      void onAlarm('tunnels', {
        key: `tunnel_down:${name.toLowerCase()}`, level: 'ERROR',
        msg: `${name} still unreachable at ${w.url}`,
        fields: { url: w.url },
      });
    }
  }
}

function startPingFor(name) {
  const w = watched.get(name);
  if (!w || w._looping) return;
  w._looping = true;
  const loop = () => {
    // The map is the roster: an entry deleted (or replaced) since this
    // clock started means this clock is the stale one - let it die.
    if (stopping || watched.get(name) !== w) return;
    void pingEndpoint(name, w).finally(() =>
      setTimeout(loop, w.intervalMs).unref?.());
  };
  setTimeout(loop, 3000).unref?.();
}

function startPings() {
  for (const name of watched.keys()) startPingFor(name);
}

// ------------------------------------------------- provisioned endpoints
//
// One button, one new public URL. Two kinds: FORWARD hands the internet a
// local port (a dev server, a service under test), CAPTURE points the
// tunnel back at this gateway, whose /hook/<name> route turns every
// delivery into a wh.<name> event on the bench - which is exactly what
// testing a Stripe webhook wants: paste the URL into the dashboard and
// watch the deliveries arrive as rows. Capture URLs carry no token on
// purpose (Stripe cannot send ours); the unguessable hostname is the
// secrecy, the bench is the audit trail. Ephemeral by design - they are
// quick tunnels and die with the gateway; anything permanent belongs in
// env config.

const provisioned = new Map();  // name -> {kind, target, url, child, state}

// Every URL this gateway owns, as an env file other tools can source -
// scripts, agents, the next terminal over. Rewritten whenever an endpoint
// appears or dies; gitignored, because the URLs are ephemeral and
// semi-sensitive. ALARM_URL is the gateway's own front door.
const endpointsFile = opt('endpoints-file', env.SUPER_LOG_ENDPOINTS_FILE ?? 'endpoints.env');

function writeEndpointsFile() {
  const kv = [];
  if (tunnel.url) kv.push(['ALARM_URL', tunnel.url]);
  for (const [name, ep] of provisioned)
    if (ep.url) kv.push([`${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`, ep.url]);
  for (const [name, w] of watched)
    if (!kv.some(([k]) => k === `${name}_URL`) && name !== 'ALARM')
      kv.push([`${name.replace(/[^A-Z0-9]/g, '_')}_URL`, w.url]);
  try {
    writeFileSync(endpointsFile,
      '# Written by superlog-alarm - the URLs this gateway currently owns.\n' +
      '# Source it (`. endpoints.env`) or read it; rewritten on every change.\n' +
      kv.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  } catch (e) {
    console.error(`superlog-alarm: cannot write ${endpointsFile}: ${e.message}`);
  }
}

function provisionEndpoint(name, target, intervalS) {
  return new Promise((resolve) => {
    const kind = target ? 'forward' : 'capture';
    const to = target ?? `http://127.0.0.1:${port}`;
    const child = spawn('cloudflared', ['tunnel', '--url', to, '--no-autoupdate'],
                        { stdio: ['ignore', 'pipe', 'pipe'] });
    const ep = { kind, target: to, url: null, child, state: 'starting' };
    provisioned.set(name, ep);
    let carry = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; ep.state = 'timeout'; resolve(ep); }
    }, 30000);
    timer.unref?.();
    const scan = (d) => {
      carry = (carry + d.toString()).slice(-8192);
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(carry)?.[0];
      if (url && !ep.url) {
        ep.url = kind === 'capture' ? `${url}/hook/${name}` : url;
        ep.state = 'up';
        watched.set(name.toUpperCase(), {
          url: kind === 'capture' ? `${url}/healthz` : url,
          intervalMs: (intervalS || 120) * 1000,
          healthy: null, fails: 0, lastOk: null, lastMs: null, checks: 0,
        });
        startPingFor(name.toUpperCase());
        void publishAlert('gateway', 'INFO',
          `endpoint '${name}' provisioned (${kind}) at ${ep.url}`,
          { endpoint: name, kind, url: ep.url });
        writeEndpointsFile();
        console.error(`superlog-alarm: endpoint '${name}' (${kind}) -> ${ep.url}`);
        if (!settled) { settled = true; clearTimeout(timer); resolve(ep); }
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('close', () => {
      ep.state = 'down';
      if (!settled) { settled = true; clearTimeout(timer); resolve(ep); }
    });
    child.on('error', () => {
      ep.state = 'unavailable';
      if (!settled) { settled = true; clearTimeout(timer); resolve(ep); }
    });
  });
}

function deleteEndpoint(name) {
  const ep = provisioned.get(name);
  if (!ep) return false;
  try { ep.child?.kill('SIGTERM'); } catch { /* already gone */ }
  provisioned.delete(name);
  watched.delete(name.toUpperCase());
  writeEndpointsFile();
  return true;
}

// ------------------------------------------------ the endpoints manifest
//
// One button scales to one endpoint; a bench with many lives in a file.
// --provision endpoints.json (or SUPER_LOG_PROVISION) is DECLARATIVE: the
// file is applied at startup and re-applied whenever it changes - new
// names appear, and names removed from the file are torn down, but only
// names the file created; the button's endpoints are not the file's to
// kill. Three shapes, one entry each, interval_s tuning the ping clock:
//
//   {"name":"stripe"}                        capture -> wh.stripe events
//   {"name":"webapp","port":5173}            forward a local port
//   {"name":"partner","url":"https://..."}   watch-only: just the light
//
// The file is config like alerts.json - gitignored, because names and
// ports describe the bench.

const provisionFile = opt('provision', env.SUPER_LOG_PROVISION ?? null);
let applyingManifest = false;

async function applyProvisionFile(path) {
  if (applyingManifest) return;                 // a slow apply outlives a fast save
  applyingManifest = true;
  try {
    let entries;
    try {
      const j = JSON.parse(readFileSync(path, 'utf8'));
      entries = Array.isArray(j) ? j : j?.endpoints;
      if (!Array.isArray(entries)) throw new Error('expected an array or {"endpoints":[...]}');
    } catch (e) {
      console.error(`superlog-alarm: ${path}: ${e.message}`);
      return;
    }
    const wanted = new Set();
    for (const e of entries) {
      if (!e?.name) continue;
      const name = sanitize(String(e.name)).toLowerCase();
      wanted.add(name);
      const iv = Number(e.interval_s) || 0;
      if (e.url) {
        const key = name.toUpperCase();
        if (watched.get(key)?.url === String(e.url)) continue;
        watched.set(key, { url: String(e.url), intervalMs: (iv || 120) * 1000,
                           healthy: null, fails: 0, lastOk: null, lastMs: null,
                           checks: 0, fromFile: true });
        startPingFor(key);
        writeEndpointsFile();
      } else if (!provisioned.has(name)) {
        const target = e.target ? String(e.target)
                     : e.port ? `http://127.0.0.1:${Number(e.port)}` : null;
        const ep = await provisionEndpoint(name, target, iv);
        ep.fromFile = true;
        if (!ep.url)
          console.error(`superlog-alarm: ${path}: endpoint '${name}' failed (${ep.state})`);
      }
    }
    // Declarative includes deletion - for the names this file created.
    for (const [name, ep] of [...provisioned])
      if (ep.fromFile && !wanted.has(name)) deleteEndpoint(name);
    for (const [key, w] of [...watched])
      if (w.fromFile && !wanted.has(key.toLowerCase())) {
        watched.delete(key);
        writeEndpointsFile();
      }
  } finally {
    applyingManifest = false;
  }
}

// ---------------------------------------------------------------- tunnels
//
// One child, watched, killed on the way out; the public URL is a fact the
// gateway learns from the tunnel's own output rather than assumes.

let tunnel = { kind: tunnelKind, state: tunnelKind === 'none' ? 'disabled' : 'starting', url: null, child: null };
let stopping = false;

function watchTunnelOutput(child, extract) {
  let carry = '';
  const scan = (d) => {
    carry = (carry + d.toString()).slice(-8192);
    const url = extract(carry);
    if (url && tunnel.url !== url) {
      tunnel.url = url;
      tunnel.state = 'up';
      console.error(`superlog-alarm: public url ${url}`);
      console.error(`superlog-alarm: production fires alarms with:`);
      console.error(`  curl -X POST ${url}/alarm/<name> -H "x-superlog-token: ${token}" -d '{"key":"...","msg":"..."}'`);
      void publishAlert('gateway', 'INFO',
        `webhook alarm gateway reachable at ${url}/alarm/<name>`, { tunnel: tunnel.kind, url });
      // Our own front door joins the watch list - reachable is a
      // measurement here too, on the default two-minute clock.
      if (!watched.has('ALARM'))
        watched.set('ALARM', { url: `${url}/healthz`, intervalMs: 120000,
                               healthy: null, fails: 0, lastOk: null, lastMs: null, checks: 0 });
      else watched.get('ALARM').url = `${url}/healthz`;
      startPingFor('ALARM');
      writeEndpointsFile();
    }
  };
  child.stdout?.on('data', scan);
  child.stderr?.on('data', scan);
  child.on('close', (code) => {
    if (stopping) return;
    tunnel.state = 'down';
    tunnel.url = null;
    console.error(`superlog-alarm: tunnel exited (${code}); restarting in 5s`);
    setTimeout(startTunnel, 5000).unref?.();
  });
  child.on('error', (e) => {
    tunnel.state = 'unavailable';
    console.error(`superlog-alarm: cannot run ${tunnel.kind} tunnel: ${e.message}`);
  });
}

// The Cloudflare API, three idempotent calls: find-or-create the tunnel by
// name, point its ingress at us, point DNS at it. Provisioning is the part
// people script badly by hand; given a token it is thirty seconds of API.
async function provisionCloudflare() {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const zone = env.CLOUDFLARE_ZONE_ID;
  if (!apiToken || !account || !zone) {
    console.error('superlog-alarm: --hostname needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ZONE_ID in .env');
    process.exit(2);
  }
  const cf = async (method, path, body) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method, headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    if (!j.success) throw new Error(`${method} ${path}: ${JSON.stringify(j.errors).slice(0, 300)}`);
    return j.result;
  };

  const name = `superlog-alarm-${device}`;
  const existing = await cf('GET', `/accounts/${account}/cfd_tunnel?name=${name}&is_deleted=false`);
  const tun = existing?.[0] ??
    await cf('POST', `/accounts/${account}/cfd_tunnel`, { name, config_src: 'cloudflare' });

  await cf('PUT', `/accounts/${account}/cfd_tunnel/${tun.id}/configurations`, {
    config: { ingress: [
      { hostname: wantHostname, service: `http://127.0.0.1:${port}` },
      { service: 'http_status:404' },
    ] },
  });

  // DNS: CNAME hostname -> tunnel. Tolerate it already existing; when the
  // token cannot edit DNS at all, say EXACTLY what is missing - a 10000
  // "Authentication error" names nothing and costs an hour.
  try {
    await cf('POST', `/zones/${zone}/dns_records`, {
      type: 'CNAME', name: wantHostname, content: `${tun.id}.cfargotunnel.com`, proxied: true,
    });
  } catch (e) {
    if (!/already exists|81053|81057/.test(e.message)) {
      let routed = false;
      try {
        const recs = await cf('GET', `/zones/${zone}/dns_records?type=CNAME&name=${wantHostname}`);
        routed = (recs?.length ?? 0) > 0;       // someone created it by hand - good enough
      } catch { /* cannot even read - definitely not routed */ }
      if (!routed) {
        // Proceed anyway: the operator may have added the CNAME by hand
        // (we cannot even READ this zone to check), and the endpoint watch
        // pings the hostname on its own clock - the light tells the truth
        // within two minutes either way. Measurement over assumption.
        console.error(
          `superlog-alarm: cannot create OR verify DNS for ${wantHostname} ` +
          `(token lacks Zone -> DNS on this zone). Running the named tunnel anyway - ` +
          `if https://${wantHostname} stays red, add the record: ` +
          `CNAME ${wantHostname} -> ${tun.id}.cfargotunnel.com (proxied), or grant ` +
          `the token Zone -> DNS -> Edit including this zone.`);
      }
    }
  }

  const t = await cf('GET', `/accounts/${account}/cfd_tunnel/${tun.id}/token`);
  console.error(`superlog-alarm: cloudflare tunnel '${name}' provisioned -> https://${wantHostname}`);
  return t;                                     // the connector token cloudflared runs with
}

async function startTunnel() {
  if (stopping) return;
  try {
    if (tunnel.kind === 'none') return;
    if (tunnel.kind === 'cloudflare' && wantHostname) {
      const connector = await provisionCloudflare();
      tunnel.child = spawn('cloudflared', ['tunnel', 'run', '--token', connector],
                           { stdio: ['ignore', 'pipe', 'pipe'] });
      // A named tunnel's URL is the hostname we provisioned, known up front.
      watchTunnelOutput(tunnel.child, () => `https://${wantHostname}`);
    } else if (tunnel.kind === 'cloudflare') {
      tunnel.child = spawn('cloudflared',
        ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      watchTunnelOutput(tunnel.child,
        (s) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(s)?.[0] ?? null);
    } else if (tunnel.kind === 'ngrok') {
      tunnel.child = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'],
                           { stdio: ['ignore', 'pipe', 'pipe'] });
      watchTunnelOutput(tunnel.child,
        (s) => /"url":"(https:\/\/[^"]+)"/.exec(s)?.[1] ?? null);
    } else if (tunnel.kind === 'zrok') {
      tunnel.child = spawn('zrok', ['share', 'public', `http://127.0.0.1:${port}`, '--headless'],
                           { stdio: ['ignore', 'pipe', 'pipe'] });
      watchTunnelOutput(tunnel.child,
        (s) => /https:\/\/[a-z0-9]+\.share\.zrok\.io/.exec(s)?.[0] ?? null);
    } else {
      console.error(`superlog-alarm: unknown tunnel '${tunnel.kind}' (cloudflare|ngrok|zrok|none)`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`superlog-alarm: tunnel setup failed: ${e.message}`);
    if (tunnel.kind === 'cloudflare' && wantHostname) {
      // A bench with no public URL at all is worse than one with an
      // ephemeral one: fall back to a quick tunnel so alarms still land,
      // and keep saying what would make the stable hostname work.
      console.error('superlog-alarm: falling back to a QUICK tunnel until the named one is fixable - production configs should wait for the stable hostname');
      tunnel.child = spawn('cloudflared',
        ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      watchTunnelOutput(tunnel.child,
        (s) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(s)?.[0] ?? null);
      return;
    }
    tunnel.state = 'failed';
  }
}

// ------------------------------------------------------------- self-test
//
// POST to our own public URL the way production would - and when THIS
// machine's resolver refuses the tunnel's name (home routers and DNS
// filters block *.trycloudflare.com surprisingly often), resolve it at
// 1.1.1.1 over DoH and connect to the IP with SNI instead. The diagnosis
// matters as much as the result: "your DNS is the problem, production's
// is not" is the answer that saves an hour.

async function publicFetch(method, urlStr, headers, bodyStr) {
  try {
    const r = await fetch(urlStr, { method, headers, body: bodyStr,
                                    signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json().catch(() => ({})), via: 'system dns' };
  } catch (e) {
    if (e.cause?.code !== 'ENOTFOUND') throw e;
    const u = new URL(urlStr);
    const doh = await fetch(
      `https://1.1.1.1/dns-query?name=${u.hostname}&type=A`,
      { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) }
    ).then((r) => r.json());
    const ip = doh?.Answer?.find((a) => a.type === 1)?.data;
    if (!ip) throw new Error('name does not resolve even at 1.1.1.1 - the tunnel is not up globally');
    const got = await new Promise((resolve, reject) => {
      const req = httpsRequest(
        { host: ip, servername: u.hostname, path: u.pathname, method,
          headers: { ...headers, host: u.hostname }, timeout: 15000 },
        (res) => { let b = ''; res.on('data', (d) => (b += d));
                   res.on('end', () => resolve({ status: res.statusCode, raw: b })); });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
    let body = {};
    try { body = JSON.parse(got.raw); } catch { /* not json */ }
    return { status: got.status, body,
             via: `1.1.1.1 -> ${ip} - THIS machine's DNS refuses the tunnel name ` +
                  '(a filtering resolver); production resolves it via public DNS' };
  }
}

// One route, one verdict. What "tested" means depends on what the route
// is FOR: a capture endpoint exists to land deliveries on the bench, so
// only a probe that comes back as a wh.<name> event counts; a forward
// endpoint exists to reach a local service, so a 502 from the tunnel edge
// is the truth "tunnel up, your service is not"; a watch-only URL is
// someone else's endpoint, where any HTTP answer proves the wire.
async function checkRoute(name, w) {
  const t0 = Date.now();
  const ep = provisioned.get(name.toLowerCase());
  const done = (ok, detail) => ({ name: `route ${name}`, ok, ms: Date.now() - t0, detail });
  // The flagship's patience applies here too: a freshly minted tunnel name
  // takes a few seconds to reach DNS at all, and a route provisioned
  // moments ago must not be reported dead for being young.
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 3000));
    try {
      return await tryRoute(name, w, ep, done);
    } catch (e) {
      lastErr = e;
    }
  }
  return done(false, String(lastErr?.message ?? lastErr));
}

async function tryRoute(name, w, ep, done) {
  {
    if (ep?.kind === 'capture' && ep.url) {
      const probe = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const got = await publicFetch('POST', ep.url,
        { 'content-type': 'application/json' }, JSON.stringify({ _probe: probe }));
      if (typeof got.status !== 'number')
        throw new Error('no answer through the tunnel');
      const topic = `wh.${name.toLowerCase()}`;
      const deadline = Date.now() + 8000;
      for (;;) {
        const r = await fetch(`${hubUrl}/recent?topic=${topic}`,
          { signal: AbortSignal.timeout(3000) }).then((x) => x.json()).catch(() => null);
        if (r && JSON.stringify(r).includes(probe))
          return done(true, `delivery captured on the bench as ${topic} (via ${got.via})`);
        if (Date.now() > deadline)
          throw new Error(`tunnel answered ${got.status} but no ${topic} event landed on the hub`);
        await new Promise((r2) => setTimeout(r2, 500));
      }
    }
    const got = await publicFetch('GET', w.url, {});
    if (typeof got.status !== 'number') throw new Error('no answer');
    if (ep?.kind === 'forward' && [502, 503, 504].includes(got.status))
      throw new Error(`tunnel up, but nothing is answering on ${ep.target} - is the service running?`);
    return done(true, `answered ${got.status} (via ${got.via})`);
  }
}

async function selftest() {
  const steps = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
      return true;
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message ?? e) });
      return false;
    }
  };

  await step('hub reachable', async () => {
    const r = await fetch(`${hubUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`healthz ${r.status}`);
    return hubUrl;
  });
  const up = await step('tunnel up', async () => {
    if (tunnel.kind === 'none') throw new Error('tunnel disabled (--tunnel none)');
    if (tunnel.state !== 'up' || !tunnel.url) throw new Error(`tunnel ${tunnel.state}`);
    return tunnel.url;
  });
  if (up) {
    await step('public round-trip', async () => {
      // A freshly minted tunnel name takes a few seconds to reach DNS at
      // all; patience here is not optimism, it is how the edge works.
      let lastErr;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const got = await publicFetch('POST', `${tunnel.url}/test`, { 'x-superlog-token': token });
          if (got.status !== 200 || !got.body?.ok)
            throw new Error(`status ${got.status} ${JSON.stringify(got.body).slice(0, 200)} (via ${got.via})`);
          return `alarm landed on the bench through ${new URL(tunnel.url).host} (via ${got.via})`;
        } catch (e) {
          lastErr = e;
          if (attempt < 4) await new Promise((r) => setTimeout(r, 3000));
        }
      }
      throw lastErr;
    });
  } else {
    await step('local delivery (tunnel bypassed)', async () => {
      const got = await onAlarm('test', { level: 'WARN', msg: 'test alarm (local only - no tunnel)', key: 'test' });
      if (!got.ok) throw new Error(got.error ?? 'hub refused the event');
      return 'alert.inbound.test published directly';
    });
  }
  await step('notification channels', async () => {
    const roster = channelRoster(channels);
    const active = roster.filter((c) => notifyNames.includes(c.name));
    const dead = active.filter((c) => !c.configured);
    if (dead.length)
      throw new Error(dead.map((c) => `${c.name}: ${c.why}`).join('; '));
    return `delivering to ${active.map((c) => c.name).join(', ') || '(none selected)'}`;
  });
  // Every route answers for itself - the flagship tunnel proved the wire
  // above; the rest run in parallel so one dead route cannot make the
  // others wait. Capture endpoints get the only test that means anything
  // for them: a delivery through the public URL that LANDS on the bench.
  const routes = [...watched.entries()].filter(([n]) => n !== 'ALARM');
  if (routes.length)
    steps.push(...await Promise.all(routes.map(([n, w]) => checkRoute(n, w))));
  return { ok: steps.every((s) => s.ok), steps,
           tunnel: { kind: tunnel.kind, state: tunnel.state, url: tunnel.url },
           channels: channelRoster(channels) };
}

// ------------------------------------------------------------ the server

const tokenOk = (req, url) => {
  const got = req.headers['x-superlog-token'] ?? url.searchParams.get('token') ?? '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const json = (res, code, obj) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',          // the React viewer's Test button
    'access-control-allow-headers': 'content-type, x-superlog-token',
  });
  res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
  req.on('end', () => resolve(body));
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true, uptime_s: Math.round((Date.now() - started) / 1000),
      tunnel: { kind: tunnel.kind, state: tunnel.state, url: tunnel.url },
      inbound: { count: inboundCount, last: lastInbound },
      firing: [...firing.entries()].map(([key, s]) =>
        ({ key, level: s.level, repeat: s.count, since: new Date(s.firstAt).toISOString() })),
      heartbeats: [...heartbeats.entries()].map(([name, hb]) =>
        ({ name, dead: hb.dead, last_seen: new Date(hb.lastSeen).toISOString(),
           interval_s: hb.intervalMs / 1000 })),
      channels: channelRoster(channels).map((c) =>
        ({ ...c, active: notifyNames.includes(c.name) })),
      tunnels: [...watched.entries()].map(([name, w]) => {
        // Enough per route for a viewer to build a full diagnostics tree -
        // and the gateway's own front door carries the same shape as
        // everything else, because it IS a route like everything else.
        const ep = provisioned.get(name.toLowerCase());
        // url is what the watchdog pings; public_url is the route itself -
        // the address you paste somewhere. They differ for capture
        // endpoints (ping /healthz, deliver to /hook/<name>) and for the
        // front door (ping /healthz, alarm at the bare hostname).
        return { name, url: w.url, interval_s: w.intervalMs / 1000,
                 public_url: name === 'ALARM' ? (tunnel.url ?? w.url) : (ep?.url ?? w.url),
                 healthy: w.healthy, checks: w.checks, fails: w.fails,
                 last_ok: w.lastOk, last_ms: w.lastMs, last_checked: w.lastChecked ?? null,
                 kind: name === 'ALARM' ? `gateway (${tunnel.kind})` : ep ? ep.kind : 'watch',
                 target: ep?.kind === 'forward' ? ep.target : null,
                 state: ep?.state ?? null, deletable: !!ep };
      }),
      endpoints: [...provisioned.entries()].map(([name, e]) =>
        ({ name, kind: e.kind, url: e.url, state: e.state })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/selftest') {
    // The bench asking about itself: loopback callers only, and the token
    // never has to leave the machine to run the full public round-trip.
    const from = req.socket.remoteAddress ?? '';
    if (!/^(::1|127\.|::ffff:127\.)/.test(from))
      return json(res, 403, { ok: false, error: 'selftest is for the bench itself (loopback only)' });
    return json(res, 200, await selftest());
  }

  // The capture half of a provisioned endpoint: any method, no token
  // (Stripe cannot send ours - the unguessable URL is the secrecy), every
  // delivery a wh.<name> event with method, a few headers and a capped
  // body. Answer 200 fast; webhook senders retry slow endpoints.
  const hookMatch = /^\/hook\/([A-Za-z0-9._-]{1,48})$/.exec(url.pathname);
  if (hookMatch) {
    const name = hookMatch[1];
    const body = await readBody(req);
    const keep = ['content-type', 'user-agent', 'stripe-signature', 'x-github-event'];
    const heads = Object.fromEntries(keep.filter((h) => req.headers[h])
      .map((h) => [h, String(req.headers[h]).slice(0, 200)]));
    const line = JSON.stringify({
      v: 1, ts: new Date().toISOString(), seq: seq++, session, level: 'INFO',
      origin: { runtime: 'node', app: 'webhook', platform: 'alert', device },
      tag: 'hook', msg: `${req.method} /hook/${name} (${body.length}b)`,
      fields: { ...heads, method: req.method,
                body: body.slice(0, 4000) },
    });
    await fetch(`${hubUrl}/ingest/wh.${sanitize(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: line,
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
    forwardOn(`/hook/${name}`, body, Number(req.headers['x-superlog-hop']) || 0);
    return json(res, 200, { ok: true });
  }

  // One button, one new public URL - loopback only, like /selftest.
  if (req.method === 'POST' && url.pathname === '/provision') {
    const from = req.socket.remoteAddress ?? '';
    if (!/^(::1|127\.|::ffff:127\.)/.test(from))
      return json(res, 403, { ok: false, error: 'provisioning is for the bench itself (loopback only)' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* tolerant */ }
    const name = sanitize(body.name ?? `hook-${Date.now().toString(36)}`);
    if (provisioned.has(name))
      return json(res, 409, { ok: false, error: `endpoint '${name}' already exists` });
    const target = body.port ? `http://127.0.0.1:${Number(body.port)}` : null;
    const ep = await provisionEndpoint(name, target, Number(body.interval_s) || 0);
    return json(res, ep.url ? 200 : 502,
      { ok: !!ep.url, name, kind: ep.kind, url: ep.url,
        ...(ep.url ? {} : { error: `tunnel ${ep.state} - is cloudflared installed?` }) });
  }
  if (req.method === 'DELETE' && /^\/provision\//.test(url.pathname)) {
    const from = req.socket.remoteAddress ?? '';
    if (!/^(::1|127\.|::ffff:127\.)/.test(from))
      return json(res, 403, { ok: false, error: 'loopback only' });
    const name = sanitize(url.pathname.slice('/provision/'.length));
    if (!deleteEndpoint(name))
      return json(res, 404, { ok: false, error: `no endpoint '${name}'` });
    return json(res, 200, { ok: true, removed: name });
  }

  const hbMatch = /^\/heartbeat\/([A-Za-z0-9._:-]{1,64})$/.exec(url.pathname);
  if (req.method === 'POST' && hbMatch) {
    if (!tokenOk(req, url)) return json(res, 401, { ok: false, error: 'bad or missing x-superlog-token' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* tolerant */ }
    return json(res, 200, beat(hbMatch[1], Number(body.interval) || 0));
  }

  const alarmMatch = /^\/alarm\/([A-Za-z0-9._:-]{1,48})$/.exec(url.pathname);
  if (req.method === 'POST' && (alarmMatch || url.pathname === '/test')) {
    if (!tokenOk(req, url)) return json(res, 401, { ok: false, error: 'bad or missing x-superlog-token' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* tolerant reader */ }
    if (url.pathname === '/test') {
      body.level ??= 'WARN';
      body.msg ??= 'test alarm - the public path works';
      body.key ??= 'test';
    }
    const out = await onAlarm(alarmMatch?.[1] ?? 'test', body,
                              Number(req.headers['x-superlog-hop']) || 0).catch((e) =>
      ({ ok: false, error: String(e.message ?? e) }));
    return json(res, out.ok ? 200 : 502, out);
  }

  return json(res, 404, { ok: false, error: 'POST /alarm/<name>, /heartbeat/<name>, /test, /selftest or GET /healthz' });
});

server.listen(port, '0.0.0.0', () => {
  console.error(`superlog-alarm: gateway on :${port} (tunnel: ${tunnel.kind}, notify: ${notifyNames.join(',') || 'none'}) -> ${hubUrl}`);
  if (!env.SUPER_LOG_ALARM_TOKEN && !opt('token'))
    console.error(`superlog-alarm: generated token ${token} - set SUPER_LOG_ALARM_TOKEN to keep it stable`);
  void startTunnel();
  startPings();
  if (provisionFile) {
    const apply = () => void applyProvisionFile(provisionFile);
    apply();
    watchFile(provisionFile, { interval: 2000 }, apply);
    console.error(`superlog-alarm: provisioning from ${provisionFile} (declarative, watched)`);
  }
  if (watched.size)
    console.error(`superlog-alarm: watching ${watched.size} endpoint(s): ` +
      [...watched.entries()].map(([n, w]) => `${n}=${w.url} every ${w.intervalMs / 1000}s`).join(', '));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    try { tunnel.child?.kill('SIGTERM'); } catch { /* already gone */ }
    for (const ep of provisioned.values()) {
      try { ep.child?.kill('SIGTERM'); } catch { /* already gone */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  });
}
process.on('exit', () => {
  try { tunnel.child?.kill('SIGTERM'); } catch { /* already gone */ }
});
