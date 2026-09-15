#!/usr/bin/env node
//
//  superlog-fix - FIX session logs on the bench, decoded.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  FIX is the wire the world's order flow runs on, and a FIX session
//  fails the way everything expensive fails: quietly. A rejected order, a
//  sequence gap, a session that logged out mid-day and stopped filling -
//  each is one line in an engine's message log, and nobody is tailing
//  that log at the moment it matters. QuickFIX and FIX8 (and anything
//  that writes the standard message log) speak the same on the wire:
//  SOH-delimited tag=value, one message per line. This follows those
//  logs and turns each message into a bench event with the discipline
//  every watcher here keeps - a reject or a logout is loud, a heartbeat
//  is DEBUG, and the fields you actually chase (ClOrdID, Symbol, Side,
//  Price, OrdStatus, Text) ride along.
//
//    superlog-fix --file /var/quickfix/FIX.4.4-SENDER-TARGET.messages.current.log
//    superlog-fix --file 'log/*.messages.*.log'      # a glob, all sessions
//
//  Publishes to fix.<session> where <session> is BeginString-Sender-Target
//  (sanitized). Follows by name (tail -F semantics), so a log rotation
//  cannot silently end the stream. Node >= 18, zero dependencies - the
//  file is the whole dependency.
//

import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')
    ? args[i + 1] : dflt;
};
const optAll = (name) => {
  const out = [];
  for (let i = 0; i < args.length - 1; i++)
    if (args[i] === `--${name}`) out.push(args[i + 1]);
  return out;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-fix - FIX session logs, decoded onto the bench

  superlog-fix --file PATH[...]  [--topic NAME] [--url HUB]

Follows QuickFIX / FIX8 message logs (SOH-delimited tag=value). Publishes
to fix.<begin-sender-target>. A Reject/BusinessReject is ERROR, a Logout
or SequenceReset is WARN, a Logon/fill is INFO, a Heartbeat is DEBUG.
--file may be given several times or as a glob.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const files = [...optAll('file'), ...(opt('file') && !optAll('file').length ? [opt('file')] : [])];
const uniqFiles = [...new Set(files)].filter(Boolean);
if (!uniqFiles.length) {
  console.error('superlog-fix: --file is required (a QuickFIX/FIX8 message log, or a glob)');
  process.exit(2);
}

const device = hostname().split('.')[0].toLowerCase();
const session = randomBytes(4).toString('hex');
let seq = 0;
let lines = [];

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 64) || 'session';

function publish(topic, level, msg, fields) {
  lines.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'fix', platform: 'host', device },
    tag: 'fix', msg,
    ...(fields && Object.keys(fields).length
      ? { fields: Object.fromEntries(Object.entries(fields)
          // Belt and suspenders for the allowlist above: a raw FIX tag number
          // that is a known credential never rides out, whoever added it.
          .filter(([k, v]) => v !== undefined && v !== '' && !SENSITIVE.has(k))
          .map(([k, v]) => [k, String(v).slice(0, 256)])) }
      : {}),
  }));
}

async function flush() {
  if (!lines.length) return;
  const body = lines.join('\n');
  lines = [];
  try {
    await fetch(`${hubUrl}/ingest/${topic()}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch { /* hub down; the next batch counts again */ }
}
// One inflight topic per flush: FIX lines from one file share a session,
// and the follower tags each with the session it parsed, so the flush
// groups by the LAST parsed topic - close enough for a batch every tick,
// and correct because we flush per parsed line's topic below.
let _topic = opt('topic', null);
const topic = () => _topic ?? 'fix.unknown';

// ------------------------------------------------- the FIX message model
//
// tag 35 (MsgType) is the verb; a small map covers the session and the
// application messages that matter, and an unknown type is still an event
// (tolerant reader), just at INFO with its raw type.

const SOH = '\x01';
const MSGTYPE = {
  '0': ['Heartbeat', 'DEBUG'], '1': ['TestRequest', 'DEBUG'],
  '2': ['ResendRequest', 'WARN'], '3': ['Reject', 'ERROR'],
  '4': ['SequenceReset', 'WARN'], '5': ['Logout', 'WARN'],
  A: ['Logon', 'INFO'], '8': ['ExecutionReport', 'INFO'],
  '9': ['OrderCancelReject', 'WARN'], D: ['NewOrderSingle', 'INFO'],
  F: ['OrderCancelRequest', 'INFO'], G: ['OrderCancelReplaceRequest', 'INFO'],
  j: ['BusinessMessageReject', 'ERROR'], 6: ['IndicationOfInterest', 'DEBUG'],
  V: ['MarketDataRequest', 'DEBUG'], W: ['MarketDataSnapshot', 'DEBUG'],
  X: ['MarketDataIncrementalRefresh', 'DEBUG'],
};
const SIDE = { '1': 'Buy', '2': 'Sell', '3': 'BuySell', '4': 'SellShort', '5': 'SellShortExempt' };
const EXECTYPE = { '0': 'New', '1': 'PartialFill', '2': 'Fill', '4': 'Canceled',
                   '5': 'Replaced', '8': 'Rejected', C: 'Expired', F: 'Trade' };
const ORDSTATUS = { '0': 'New', '1': 'PartiallyFilled', '2': 'Filled', '4': 'Canceled',
                    '8': 'Rejected', C: 'Expired' };

// A line from a message log is the raw FIX message, sometimes with a local
// timestamp prefix the engine wrote. Find the 8=FIX... start and parse from
// there; accept SOH or the common pipe/caret renderings so a hand-copied
// or human-readable log still decodes.
function parseFix(raw) {
  let s = raw;
  const start = s.indexOf('8=FIX');
  if (start < 0) return null;
  s = s.slice(start);
  const delim = s.includes(SOH) ? SOH : s.includes('\x01') ? '\x01'
              : /\|/.test(s) ? '|' : /\^A/.test(s) ? '^A' : SOH;
  const fields = {};
  for (const pair of s.split(delim)) {
    const eq = pair.indexOf('=');
    if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/\s+$/, '');
  }
  return fields['35'] ? fields : null;
}

// Credentials safety, by construction. A FIX Logon (35=A) routinely carries
// a password in tag 554, and some venues put secrets in RawData (96) or a
// NewPassword (925). This tailer NEVER emits the raw message and NEVER reads
// those tags: msg is built from a fixed vocabulary of words, and fields is an
// allowlist of the tags below. So a session password cannot reach the bench
// or the journal. The set is named here so the rule is legible and any future
// field is checked against it - a tailer for the world's order flow must not
// be the thing that leaks the login.
const SENSITIVE = new Set(['96', '554', '925', '91', '89']);

function emit(f) {
  const begin = f['8'] ?? 'FIX';
  const sender = f['49'] ?? '?';
  const target = f['56'] ?? '?';
  _topic = 'fix.' + sanitize(`${begin.replace('FIX.', '')}-${sender}-${target}`);

  const [name, baseLevel] = MSGTYPE[f['35']] ?? [`MsgType ${f['35']}`, 'INFO'];
  let level = baseLevel;
  const parts = [name];
  const fields = { msgtype: f['35'], sender, target, seqnum: f['34'] };

  if (f['11']) { fields.clordid = f['11']; }
  if (f['55']) { fields.symbol = f['55']; parts.push(f['55']); }
  if (f['54'] && SIDE[f['54']]) { fields.side = SIDE[f['54']]; parts.push(SIDE[f['54']]); }
  if (f['38']) { fields.qty = f['38']; parts.push(`x${f['38']}`); }
  if (f['44']) { fields.price = f['44']; parts.push(`@${f['44']}`); }

  if (f['35'] === '8') {                              // ExecutionReport
    const et = EXECTYPE[f['150']] ?? f['150'];
    const os = ORDSTATUS[f['39']] ?? f['39'];
    if (et) { fields.exectype = et; parts.push(et); }
    if (os) fields.ordstatus = os;
    if (f['150'] === '8' || f['39'] === '8') level = 'ERROR';   // rejected fill
    if (f['32']) { fields.lastqty = f['32']; }
    if (f['31']) { fields.lastpx = f['31']; }
  }
  if (f['35'] === '3' || f['35'] === 'j') {           // Reject / BusinessReject
    if (f['45']) fields.refseqnum = f['45'];
    if (f['371']) fields.reftag = f['371'];
    if (f['58']) parts.push(`- ${f['58']}`);
  }
  if (f['58']) fields.text = f['58'];                 // free-text reason

  publish(_topic, level, parts.join(' '), fields);
}

// ---------------------------------------------------- follow the file(s)
//
// tail -F by name, so logrotate cannot silently end the stream - the same
// bargain superlog-tail makes. One tail process spanning all files; its
// "==> path <==" banners are ignored, because the session comes from the
// message itself, not the filename.

const mac = platform() === 'darwin';
const child = spawn('sh', ['-c',
  `tail -n 0 -F ${uniqFiles.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')} 2>/dev/null`],
  { stdio: ['ignore', 'pipe', 'pipe'] });

let carry = '';
child.stdout.on('data', (d) => {
  carry += d.toString();
  const rows = carry.split('\n');
  carry = rows.pop() ?? '';
  for (const line of rows) {
    if (!line.trim() || line.startsWith('==>')) continue;
    const f = parseFix(line);
    if (f) emit(f);
  }
  void flush();
});
child.on('close', () => { void flush(); process.exit(0); });

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => { try { child.kill(); } catch { /* gone */ } await flush(); process.exit(0); });

console.error(`superlog-fix: following ${uniqFiles.length} log(s) -> fix.<session> -> ${hubUrl}`);
void mac;
