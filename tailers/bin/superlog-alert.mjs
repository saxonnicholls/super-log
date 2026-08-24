#!/usr/bin/env node
//
//  superlog-alert - the part that reaches you when you are not looking.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Everything else here assumes someone is watching a screen. This is the
//  piece that is useful at 3am: it subscribes to the firehose, evaluates
//  rules, and tells a human - or an agent - when something matches.
//
//    superlog-alert                     # rules from ./alerts.json
//    superlog-alert --config a.json --dry-run
//
//  Three rule shapes, because production breaks in three ways:
//
//    level    something bad was logged            (an ERROR appeared)
//    rate     too much of something               (20 errors in a minute)
//    silence  something STOPPED being logged      (a stream went quiet)
//
//  The third is the one most tools miss and the one that matters most on a
//  server: a box that stops logging looks exactly like a box with nothing
//  to say, and the difference is an outage. Rate and silence rules also
//  report RECOVERY, because "it cleared" is half of what you needed.
//
//  Alerts are themselves published back to the hub as alert.<name>, so the
//  viewers show them in line with the events that caused them and the
//  journal keeps them. Rules never match alert.* - a rule that alerts on
//  its own alerts is a loop, and it would find itself immediately.
//
//  Node >= 22 (global WebSocket).
//

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-alert - rules that reach you when nobody is watching

  superlog-alert [--config alerts.json] [--url HUB] [--dry-run] [--test]

Rule shapes: level (something bad happened), rate (too much of it),
silence (a stream stopped - the one that catches a dead server).
See tailers/alerts.example.json.`);
  process.exit(0);
}

const env = loadEnv();
const configPath = opt('config', 'alerts.json');
const dryRun = args.includes('--dry-run');

let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`superlog-alert: cannot read ${configPath}: ${e.message}`);
  console.error('Copy tailers/alerts.example.json to alerts.json and edit it.');
  process.exit(2);
}

const hubUrl = opt('url', cfg.url ?? env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const webhook = cfg.webhook ?? env.SUPER_LOG_WEBHOOK ?? '';
const defaultNotify = cfg.notify ?? ['console', 'hub'];
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
const rank = (l) => {
  const i = LEVELS.indexOf(String(l ?? 'INFO').toUpperCase());
  return i < 0 ? 2 : i;
};

const rules = (cfg.rules ?? []).map((r, i) => ({
  name: r.name ?? `rule-${i}`,
  topic: r.topic ?? '*',
  level: r.level ? rank(r.level) : null,
  contains: r.contains ? String(r.contains).toLowerCase() : null,
  trace: r.trace ?? null,
  rate: r.rate ?? null,               // { count, window } seconds
  silence: r.silence ?? null,         // seconds without a matching event
  cooldown: (r.cooldown ?? 300) * 1000,
  notify: r.notify ?? defaultNotify,
  command: r.command ?? cfg.command ?? '',
  // state
  hits: [], lastFired: 0, firing: false, lastSeen: Date.now(),
}));

if (!rules.length) {
  console.error(`superlog-alert: ${configPath} defines no rules`);
  process.exit(2);
}

const topicMatches = (want, name) =>
  !want || want === '*' || want === name ||
  (want.endsWith('.') && name.length > want.length && name.startsWith(want));

// ------------------------------------------------------------ delivering

async function notifyDesktop(title, body) {
  if (platform() === 'darwin') {
    // Via osascript's own quoting rather than the shell's: an alert body is
    // log text, and log text contains quotes.
    const script = `display notification ${JSON.stringify(body).slice(0, 400)} with title ${JSON.stringify(title)}`;
    spawn('osascript', ['-e', script], { stdio: 'ignore' });
  } else {
    spawn('notify-send', [title, body.slice(0, 400)], { stdio: 'ignore' })
      .on('error', () => {});
  }
}

async function notifyWebhook(title, body, ev) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `text` is what Slack, Discord and Mattermost all read, so one shape
      // works for the common cases without a per-service adapter.
      body: JSON.stringify({ text: `*${title}*\n${body}`, title, body, event: ev }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error(`superlog-alert: webhook failed: ${e.message}`);
  }
}

function notifyCommand(cmd, title, body) {
  if (!cmd) return;
  // The alert is passed in the environment, not interpolated into the
  // command, so a log line containing a backtick cannot become a shell.
  spawn('sh', ['-c', cmd], {
    stdio: 'ignore',
    env: { ...process.env, SUPERLOG_ALERT_TITLE: title, SUPERLOG_ALERT_BODY: body },
  }).on('error', () => {});
}

let hubBuf = [];
function notifyHub(rule, level, title, body, ev) {
  hubBuf.push({
    topic: `alert.${rule.name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`,
    line: JSON.stringify({
      v: 1, ts: new Date().toISOString(), level,
      origin: { runtime: 'node', app: 'alert', platform: 'alert' },
      tag: 'alert', msg: `${title}: ${body}`.slice(0, 500),
      ...(ev?.trace ? { trace: ev.trace } : {}),
      fields: { rule: rule.name, source_topic: ev?.__topic ?? '', level },
    }),
  });
}

async function flushHub() {
  if (!hubBuf.length) return;
  const batch = hubBuf;
  hubBuf = [];
  const byTopic = new Map();
  for (const { topic, line } of batch) {
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(line);
  }
  await Promise.all([...byTopic].map(([t, lines]) =>
    fetch(`${hubUrl}/ingest/${t}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' },
      body: lines.join('\n'),
    }).catch(() => {})));
}

async function fire(rule, level, title, body, ev) {
  const now = Date.now();
  if (now - rule.lastFired < rule.cooldown) return;   // still inside the quiet period
  rule.lastFired = now;
  const line = `[${level}] ${title} - ${body}`;
  console.error(`superlog-alert: ${line}`);
  if (dryRun) return;
  for (const how of rule.notify) {
    if (how === 'desktop') await notifyDesktop(title, body);
    else if (how === 'webhook') await notifyWebhook(title, body, ev);
    else if (how === 'command') notifyCommand(rule.command, title, body);
    else if (how === 'hub') notifyHub(rule, level, title, body, ev);
  }
  await flushHub();
}

// ------------------------------------------------------------ evaluating

function matches(rule, topic, ev) {
  if (!topicMatches(rule.topic, topic)) return false;
  if (rule.level !== null && rank(ev.level) < rule.level) return false;
  if (rule.trace && ev.trace !== rule.trace) return false;
  if (rule.contains && !JSON.stringify(ev).toLowerCase().includes(rule.contains)) return false;
  return true;
}

async function onEvent(topic, ev) {
  // Never match our own output, or a rule finds its own alert and fires
  // forever - the loop would be immediate and self-sustaining.
  if (topic.startsWith('alert.')) return;
  ev.__topic = topic;
  const now = Date.now();

  for (const rule of rules) {
    if (!matches(rule, topic, ev)) continue;
    rule.lastSeen = now;

    if (rule.silence) {
      // A matching event means the stream is alive; if it was previously
      // reported dead, say it came back.
      if (rule.firing) {
        rule.firing = false;
        rule.lastFired = 0;                       // recovery is always worth hearing
        await fire(rule, 'INFO', `RECOVERED: ${rule.name}`,
                   `${topic} is reporting again`, ev);
      }
      continue;
    }

    if (rule.rate) {
      const windowMs = (rule.rate.window ?? 60) * 1000;
      rule.hits.push(now);
      rule.hits = rule.hits.filter((t) => now - t <= windowMs);
      if (rule.hits.length >= (rule.rate.count ?? 10)) {
        await fire(rule, 'ERROR', rule.name,
                   `${rule.hits.length} matching events in ${windowMs / 1000}s on ${topic} - latest: ${ev.msg ?? ''}`.slice(0, 400), ev);
        rule.hits = [];                           // start the next window clean
      }
      continue;
    }

    await fire(rule, ev.level ?? 'WARN', rule.name,
               `${topic}: ${ev.msg ?? ''}`.slice(0, 400), ev);
  }
}

// Silence is checked on a timer rather than on arrival, because the whole
// point is that nothing is arriving.
setInterval(async () => {
  const now = Date.now();
  for (const rule of rules) {
    if (!rule.silence || rule.firing) continue;
    if (now - rule.lastSeen > rule.silence * 1000) {
      rule.firing = true;
      await fire(rule, 'ERROR', `SILENT: ${rule.name}`,
                 `no events matching ${rule.topic} for ${Math.round((now - rule.lastSeen) / 1000)}s`, null);
    }
  }
}, 5000).unref?.();

// ---------------------------------------------------------------- listen

let ws;
let closed = false;
function connect() {
  const wsUrl = hubUrl.replace(/^http/, 'ws') + '/ws?topic=*';
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.error(`superlog-alert: watching ${wsUrl} with ${rules.length} rule(s)`);
  ws.onmessage = (e) => {
    let env2;
    try {
      env2 = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
    } catch {
      return;
    }
    if (typeof env2?.payload !== 'string') return;
    for (const line of env2.payload.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        ev = { msg: t };                          // tolerant-reader rule
      }
      void onEvent(env2.topic ?? '', ev);
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (!closed) setTimeout(connect, 2000);
  };
}

if (args.includes('--test')) {
  // Prove the delivery path without waiting for something to break.
  const r = rules[0];
  await fire(r, 'ERROR', `TEST: ${r.name}`, 'this is a test alert from superlog-alert', null);
  await flushHub();
  process.exit(0);
}

connect();
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    closed = true;
    try { ws?.close(); } catch { /* already gone */ }
    void flushHub().then(() => process.exit(0));
  });
