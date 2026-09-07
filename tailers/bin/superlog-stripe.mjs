#!/usr/bin/env node
//
//  superlog-stripe - Stripe events on the bench, redacted by default.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A failed payment is a support ticket you have not received yet, and it
//  happens in a dashboard nobody is watching. This puts it beside the Worker
//  that took the request and the service that timed out, in one order.
//
//    superlog-stripe                              # test mode, default account
//    superlog-stripe --live                       # real money
//    superlog-stripe --account acme --account beta  # several at once
//
//  Publishes to stripe.<account>.<mode>.
//
//  REDACTED BY DEFAULT, and this is the whole design.
//
//  A payment_intent.payment_failed carries the customer's email, name,
//  phone, full billing address, card brand, last four, fingerprint and
//  country. That is not log data - it is a customer record, and this bench
//  has no authentication and is read by anyone who can reach it. So the
//  default is an allowlist, not a blocklist: only the fields named in SAFE
//  below ever leave this process, and everything else is dropped before an
//  event is built rather than filtered afterwards.
//
//  --unsafe-full turns that off. It prints a warning saying what it is about
//  to do, because someone will reach for it while debugging and should not
//  be able to do it absent-mindedly.
//
//  MULTIPLE ACCOUNTS: --account may be repeated. Each needs a Stripe CLI
//  profile of the same name (`stripe login --project-name acme`), and each
//  gets its own process and its own topic, so one account's firehose cannot
//  bury another's.
//
//  Node >= 18. Needs the Stripe CLI.
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
const optAll = (name) =>
  args.reduce((a, x, i) => (x === `--${name}` && args[i + 1] && !args[i + 1].startsWith('--')
    ? [...a, args[i + 1]] : a), []);

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-stripe - Stripe events, redacted by default

  superlog-stripe [--account NAME]... [--live] [--events a,b] [--unsafe-full]
                  [--topic NAME] [--url HUB]

  superlog-stripe                                 test mode, default account
  superlog-stripe --live --account acme --account beta

Publishes to stripe.<account>.<mode>. Only an allowlist of non-identifying
fields is published; --unsafe-full disables that and says so loudly.

Each --account needs a Stripe CLI profile: stripe login --project-name NAME`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const live = args.includes('--live');
const full = args.includes('--unsafe-full');
const accounts = optAll('account').length ? optAll('account')
  : (env.SUPER_LOG_STRIPE_ACCOUNTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const wanted = (opt('events', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'default';
const host = sanitize(hostname().split('.')[0]);

if (full) {
  console.error(
    '\n  !! --unsafe-full: customer emails, names, addresses and card details\n' +
    '     will be published to a hub that has NO AUTHENTICATION.\n' +
    '     Anyone who can reach it can read them. Ctrl-C now if that is not\n' +
    '     what you meant.\n');
}

// ------------------------------------------------------------- redaction
//
// An ALLOWLIST. A blocklist is the wrong shape here: Stripe adds fields, and
// a blocklist silently starts leaking the day they do. Anything not named
// here never reaches an event at all.

const SAFE = new Set([
  'id', 'object', 'type', 'status', 'amount', 'amount_due', 'amount_paid',
  'amount_received', 'amount_refunded', 'currency', 'created', 'livemode',
  'paid', 'refunded', 'disputed', 'attempt_count', 'failure_code',
  'failure_message', 'decline_code', 'network_status', 'reason', 'seller_message',
  'risk_level', 'risk_score', 'cancel_reason', 'collection_method',
  'billing_reason', 'subscription', 'invoice', 'payment_intent', 'charge',
  'customer', 'plan', 'price', 'product', 'quantity', 'interval', 'nickname',
]);

/** Pull only allowlisted scalars, one level deep. Nested objects are where
 *  the customer record lives, so they are summarised as a type rather than
 *  walked. */
function safeFields(obj, out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 1) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!SAFE.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      // `customer` may be an id string or an expanded object; only the id is
      // ever useful here and only the id is ever safe.
      if (v.id) out[k] = String(v.id);
      continue;
    }
    out[k] = String(v);
  }
  return out;
}

// ---------------------------------------------------------------- levels
//
// What the event MEANS, not what it is called. A dispute is money already
// gone plus a deadline; a failed payment is a customer who tried to pay you
// and could not.

function levelFor(type) {
  if (/dispute\.(created|funds_withdrawn)|review\.opened|early_fraud_warning/.test(type))
    return 'CRITICAL';
  if (/\.failed$|payment_failed|\.payment_action_required$|dispute|\.expired$/.test(type))
    return 'ERROR';
  if (/\.refunded$|\.canceled$|\.deleted$|will_be_deleted|\.paused$|_overdue/.test(type))
    return 'WARN';
  return 'INFO';
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();
let seq = 0;

function publish(topic, level, msg, fields, metric) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'stripe', app: 'stripe', platform: 'saas', device: host },
    tag: 'stripe', msg: String(msg).slice(0, 2000),
    ...(fields ? { fields } : {}), ...(metric ? { metric } : {}),
  }));
}

async function flush() {
  for (const [topic, lines] of buf) {
    if (!lines.length) continue;
    const body = lines.join('\n');
    buf.set(topic, []);
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
      });
    } catch { /* hub down; the next batch counts again */ }
  }
}
setInterval(() => void flush(), 250).unref?.();

// ------------------------------------------------------------------ run

function handle(topic, account, ev) {
  const type = ev.type ?? 'unknown';
  if (wanted.length && !wanted.some((w) => type === w || type.startsWith(w.replace(/\*$/, ''))))
    return;

  const data = ev.data?.object ?? {};
  const fields = full
    ? { account, type, ...safeFields(data), raw: JSON.stringify(data).slice(0, 3000) }
    : { account, type, ...safeFields(data) };
  fields.event = String(ev.id ?? '');
  if (ev.livemode !== undefined) fields.livemode = String(ev.livemode);

  // A human sentence, because "invoice.payment_failed" is not one.
  const amount = data.amount ?? data.amount_due ?? data.amount_received;
  const money = amount !== undefined && data.currency
    ? ` ${(Number(amount) / 100).toFixed(2)} ${String(data.currency).toUpperCase()}`
    : '';
  const why = data.failure_message ?? data.decline_code ?? data.reason ?? '';
  publish(topic, levelFor(type), `${type}${money}${why ? ` - ${why}` : ''}`, fields);

  // Money as a metric, so failures and volume can be charted rather than
  // counted by eye.
  if (amount !== undefined && Number.isFinite(Number(amount)))
    publish(topic, 'DEBUG', 'stripe.amount', { account, type },
            { name: 'stripe.amount', value: Number(amount) / 100 });
}

function listen(account) {
  const mode = live ? 'live' : 'test';
  const topic = opt('topic', `stripe.${sanitize(account)}.${mode}`);
  const argv = ['listen', '--print-json'];
  if (live) argv.push('--live');
  if (account !== 'default') argv.push('--project-name', account);

  console.error(`superlog-stripe: ${account} (${mode}) -> ${topic}` +
                `${full ? '  [UNSAFE-FULL]' : '  [redacted]'}`);

  const child = spawn('stripe', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let carry = '';
  child.stdout.on('data', (chunk) => {
    const lines = (carry + chunk.toString()).split('\n');
    carry = lines.pop() ?? '';
    for (const l of lines) {
      const t = l.trim();
      if (!t.startsWith('{')) continue;
      try { handle(topic, account, JSON.parse(t)); } catch { /* partial */ }
    }
  });
  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (!s) return;
    if (/not logged in|Unauthorized|no API key|invalid/i.test(s))
      publish(topic, 'ERROR', `stripe cli: ${s.slice(0, 400)}`, { account });
    else process.stderr.write(`superlog-stripe[${account}]: ${s}\n`);
  });
  child.on('error', (e) => {
    publish(topic, 'CRITICAL', `cannot run the stripe CLI: ${e.message}`, { account });
    void flush();
  });
  child.on('close', (code) => {
    publish(topic, code === 0 ? 'INFO' : 'WARN',
            `stripe listen ended for ${account} (exit ${code})`, { account });
    void flush();
  });
  return child;
}

// One process per account, so a busy account cannot delay a quiet one and a
// dead CLI profile takes only its own stream down.
const children = (accounts.length ? accounts : ['default']).map(listen);

const bye = async (code) => {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  await flush();
  process.exit(code);
};
process.on('SIGINT', () => void bye(130));
process.on('SIGTERM', () => void bye(143));
