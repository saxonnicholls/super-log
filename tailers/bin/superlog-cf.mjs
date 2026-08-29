#!/usr/bin/env node
//
//  superlog-cf - Cloudflare Workers on the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A Worker's logs live in a browser tab you have to remember to open, on a
//  machine you cannot attach a debugger to, and they scroll away. Which is
//  the same problem as everything else here, so it gets the same answer.
//
//    superlog-cf --worker token-pooler-api
//    superlog-cf --worker api --status error        # only failed invocations
//    superlog-cf --worker api --search E_SENDER     # only matching logs
//
//  Publishes to cf.<worker>.
//
//  It drives `wrangler tail --format json`, so it needs no code inside the
//  Worker and no API token - wrangler's own login is enough. One invocation
//  becomes several events, because that is what it is: the request itself,
//  every console line the handler wrote, and every exception it threw. They
//  share a trace, so `/recent?trace=` returns one invocation end to end.
//
//  Levels come from the Worker, not from guesswork. console.error is ERROR,
//  console.warn is WARN, an uncaught exception is ERROR, and an invocation
//  whose outcome is not "ok" is ERROR even when it logged nothing - a Worker
//  that exceeded CPU says nothing on its way out.
//
//  LIVE ONLY. `wrangler tail` is a live stream: it shows what happens from
//  the moment it connects, and nothing from before. For "what happened at
//  13:32" you want the Workers Observability API, which needs an API token -
//  see --since, which is not implemented yet and says so rather than
//  pretending.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h') || !opt('worker')) {
  console.error(`superlog-cf - a Cloudflare Worker's logs, live

  superlog-cf --worker NAME [--env ENV] [--status ok|error|canceled]
              [--method GET,POST] [--search TEXT] [--sampling-rate N]
              [--topic NAME] [--url HUB] [--config PATH]

  superlog-cf --worker token-pooler-api
  superlog-cf --worker api --status error

Publishes to cf.<worker>. Drives \`wrangler tail --format json\`, so it needs
no code in the Worker and no API token - wrangler's own login is enough.

Live only: tail shows what happens from now on, never the past.`);
  process.exit(opt('worker') ? 0 : 2);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const worker = opt('worker');
const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 48) || 'worker';
const host = sanitize(hostname().split('.')[0]);
const topic = opt('topic', `cf.${sanitize(worker)}`);

if (opt('since')) {
  // Better to refuse than to quietly tail from now and let someone believe
  // they are looking at 13:32.
  console.error(
    'superlog-cf: --since needs the Workers Observability API, which is not wired up yet.\n' +
    '  `wrangler tail` is a live stream and cannot reach backwards.\n' +
    '  For now: start this before reproducing, or read the Observability tab.');
  process.exit(2);
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;

function publish(level, msg, fields, trace, metric) {
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'cloudflare', app: worker, platform: 'edge', device: host },
    tag: 'cf', msg: String(msg).slice(0, 4000),
    ...(trace ? { trace } : {}),
    ...(fields ? { fields } : {}),
    ...(metric ? { metric } : {}),
  }));
  if (buf.length >= 256) void flush();
}

async function flush() {
  if (!buf.length) return;
  const body = buf.join('\n');
  buf = [];
  try {
    await fetch(`${hubUrl}/ingest/${topic}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch {
    /* hub down; the next batch counts again */
  }
}
setInterval(() => void flush(), 250).unref?.();

// ---------------------------------------------------------------- mapping

// console.log's level names, and what they mean here. A Worker that calls
// console.log for an error is not this tool's problem to second-guess.
const LEVEL = { debug: 'DEBUG', log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };

// An outcome that is not "ok" is a failure even when nothing was logged -
// exceededCpu in particular kills the isolate with no output at all, which
// is exactly the failure you cannot see from inside the Worker.
const OUTCOME = {
  ok: null, exception: 'ERROR', exceededCpu: 'ERROR', exceededMemory: 'ERROR',
  scriptNotFound: 'CRITICAL', canceled: 'WARN', unknown: 'WARN',
};

const flat = (m) => (Array.isArray(m) ? m : [m])
  .map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()))
  .join(' ');

function describe(ev) {
  // One invocation is a request, a cron tick, a queue batch or an email.
  const r = ev?.request;
  if (r) {
    let path = r.url ?? '';
    try { path = new URL(r.url).pathname; } catch { /* keep it whole */ }
    return { what: `${r.method ?? 'GET'} ${r.url ?? ''}`, kind: 'request',
             method: r.method, path, cf: r.cf };
  }
  if (ev?.cron) return { what: `cron ${ev.cron}`, kind: 'scheduled' };
  if (ev?.queue) return { what: `queue ${ev.queue} (${ev.batchSize ?? '?'} messages)`, kind: 'queue' };
  if (ev?.mailFrom) return { what: `email from ${ev.mailFrom}`, kind: 'email' };
  return { what: 'invocation', kind: 'unknown' };
}

function handle(inv) {
  // One trace per invocation, so the request line, every console line it
  // wrote and any exception it threw are one story rather than neighbours.
  const trace = (inv.scriptName ? '' : '') +
    Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-8);
  const d = describe(inv.event);
  const status = inv.event?.response?.status;
  const outcome = inv.outcome ?? 'unknown';

  const base = { worker: inv.scriptName ?? worker, kind: d.kind, outcome };
  if (d.method) base.method = d.method;
  if (d.path) base.path = d.path;
  if (status) base.status = String(status);
  if (d.cf?.colo) base.colo = d.cf.colo;
  if (d.cf?.country) base.country = d.cf.country;

  // The invocation line. Its level is the worst thing that happened: a 500
  // is an error whether or not the handler said so.
  const level = OUTCOME[outcome] ??
    (status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO');
  publish(level, `${d.what}${status ? ` -> ${status}` : ''}`, base, trace);

  for (const l of inv.logs ?? [])
    publish(LEVEL[l.level] ?? 'INFO', flat(l.message),
            { worker: base.worker, ...(d.path ? { path: d.path } : {}) }, trace);

  for (const e of inv.exceptions ?? [])
    publish('ERROR', `${e.name ?? 'Error'}: ${e.message ?? ''}`.trim(),
            { worker: base.worker, where: 'uncaught',
              ...(e.stack ? { stack: String(e.stack) } : {}) }, trace);

  // Wall time is what Cloudflare bills and what a timeout hits.
  if (typeof inv.wallTime === 'number')
    publish('DEBUG', 'cf.wall_ms', { worker: base.worker }, trace,
            { name: 'cf.wall_ms', value: inv.wallTime });
  if (typeof inv.cpuTime === 'number')
    publish('DEBUG', 'cf.cpu_ms', { worker: base.worker }, trace,
            { name: 'cf.cpu_ms', value: inv.cpuTime });
}

// ------------------------------------------------------------------- run

const wranglerArgs = ['wrangler', 'tail', worker, '--format', 'json'];
for (const [flag, val] of [['env', opt('env')], ['config', opt('config')],
                           ['search', opt('search')], ['sampling-rate', opt('sampling-rate')]])
  if (val) wranglerArgs.push(`--${flag}`, val);
for (const flag of ['status', 'method'])
  for (const v of (opt(flag, '') || '').split(',').filter(Boolean))
    wranglerArgs.push(`--${flag}`, v);

console.error(`superlog-cf: tailing ${worker} -> ${topic} (live from now on)`);

const child = spawn('npx', wranglerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

let carry = '';
child.stdout.on('data', (chunk) => {
  const lines = (carry + chunk.toString()).split('\n');
  carry = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    // wrangler prints a human preamble before the stream starts; anything
    // that is not an object is its chatter, not an invocation.
    if (!t.startsWith('{')) continue;
    try { handle(JSON.parse(t)); } catch { /* a partial or unknown shape */ }
  }
});

child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (!s) return;
  // wrangler talks to stderr for both progress and failure. Not being logged
  // in is the common one and is worth saying loudly, because the symptom is
  // otherwise just silence.
  if (/not logged in|authentication|Unauthorized|10000/i.test(s))
    publish('ERROR', `wrangler: ${s.slice(0, 500)}`, { worker, where: 'wrangler' });
  else
    process.stderr.write(`superlog-cf: ${s}\n`);
});

child.on('error', async (e) => {
  publish('CRITICAL', `cannot run wrangler: ${e.message}`, { worker });
  await flush();
  process.exit(127);
});

child.on('close', async (code) => {
  publish(code === 0 ? 'INFO' : 'WARN', `wrangler tail ended (exit ${code})`, { worker });
  await flush();
  process.exit(code ?? 0);
});

process.on('SIGINT', async () => { child.kill(); await flush(); process.exit(130); });
process.on('SIGTERM', async () => { child.kill(); await flush(); process.exit(143); });
