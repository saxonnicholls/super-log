#!/usr/bin/env node
//
//  superlog-gas - key balances on chain, with the alarm built in.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  An operational key that runs out of gas stops a production system as
//  surely as a crashed server, and it fails politely: the oracle just stops
//  pushing, the keeper just stops keeping, and nothing anywhere says why.
//  A balance is not a log line until something makes it one. This polls the
//  balances that matter and applies the discipline every watcher here has:
//  readings are DEBUG metric events for the chart, and a threshold crossing
//  is said ONCE - CRITICAL below the fund-now line, WARN below the low
//  line, INFO again on recovery.
//
//    superlog-gas                        # ./gas.json, every 5 minutes
//    superlog-gas --once                 # one reading of every key, then exit
//    superlog-gas --config /path/gas.json
//
//  Publishes to gas.<chain>. The config is JSON (copy
//  tailers/gas.example.json to gas.json - GITIGNORED, because a labelled
//  list of your operational keys is a map for an attacker even when every
//  address is public on chain):
//
//    { "chains": { "arbitrum": {
//        "rpc": "https://arbitrum-one-rpc.publicnode.com",
//        "coin": "ETH",
//        "keys": [ { "label": "FX-pusher (oracle)", "address": "0x...",
//                    "crit": 0.002, "warn": 0.01 } ] } } }
//
//  Per key: below `crit` is CRITICAL, below `warn` is WARN, at or above
//  `warn` is a reading and nothing more. A key with a `token` entry
//  ({address, decimals, symbol}) is an ERC-20 balance via balanceOf;
//  otherwise it is the native gas coin via eth_getBalance. One POST per
//  chain per poll - the calls ride a JSON-RPC batch, because a public RPC's
//  rate limit is part of the design surface.
//
//  Node >= 18.
//

import { existsSync, readFileSync } from 'node:fs';
import { loadEnv, redactUrl } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-gas - operational key balances, with edge-triggered alarms

  superlog-gas [--once] [--config PATH] [--interval SECONDS] [--url HUB]

Publishes to gas.<chain>. Readings are DEBUG metric events (gas.<label>);
below a key's \`crit\` is CRITICAL said once, below \`warn\` is WARN said
once, recovery is INFO. Config: copy tailers/gas.example.json to gas.json
(gitignored - a labelled key list is a map for an attacker).`);
  process.exit(0);
}

const env = loadEnv();
const configPath = opt('config', env.SUPER_LOG_GAS_CONFIG ?? 'gas.json');
if (!existsSync(configPath)) {
  console.error(`superlog-gas: no ${configPath}. Copy tailers/gas.example.json there and edit -`);
  console.error('it is gitignored on purpose: a labelled list of operational keys does not belong in a repo.');
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`superlog-gas: cannot read ${configPath}: ${e.message}`);
  process.exit(2);
}

const hubUrl = opt('url', cfg.url ?? env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const once = args.includes('--once');
const intervalMs = Math.max(15000, Number(opt('interval', cfg.interval ?? '300')) * 1000);
const chains = Object.entries(cfg.chains ?? {})
  .filter(([, c]) => c?.rpc && Array.isArray(c.keys) && c.keys.length);
if (!chains.length) {
  console.error(`superlog-gas: ${configPath} defines no chains with keys`);
  process.exit(2);
}

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 48) || 'key';

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();
let seq = 0;

function publish(topic, level, msg, fields, metric) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'gas', platform: 'chain', device: sanitize(configPath.split('/').pop()) },
    tag: 'gas', msg,
    ...(metric ? { metric } : {}),
    ...(fields ? { fields: Object.fromEntries(Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)])) } : {}),
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
    } catch {
      /* hub down; the next batch counts again */
    }
  }
}

// ---------------------------------------------------------------- polling
//
// One JSON-RPC batch per chain per poll. balanceOf is a bare eth_call:
// selector 0x70a08231 plus the address left-padded to 32 bytes - no ABI
// library for one function that has not changed since 2015.

function callFor(key, id) {
  if (key.token?.address) {
    const data = '0x70a08231' + key.address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    return { jsonrpc: '2.0', id, method: 'eth_call',
             params: [{ to: key.token.address, data }, 'latest'] };
  }
  return { jsonrpc: '2.0', id, method: 'eth_getBalance', params: [key.address, 'latest'] };
}

function toUnits(hex, decimals) {
  try {
    // Number after BigInt division keeps enough precision for a threshold;
    // this is telemetry, not accounting.
    const wei = BigInt(hex);
    const milli = wei / BigInt(10) ** BigInt(Math.max(0, decimals - 6));
    return Number(milli) / 1e6;
  } catch {
    return undefined;
  }
}

// Edge-triggered, the vitals discipline: a crossing is news, the same
// crossing five minutes later is not, and refunding a key is news too.
const state = new Map();

async function pollChain(name, chain) {
  const topic = opt('topic', `gas.${sanitize(name)}`);
  const calls = chain.keys.map((k, i) => callFor(k, i));
  let results;
  try {
    const r = await fetch(chain.rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls), signal: AbortSignal.timeout(20000),
    });
    results = await r.json();
  } catch (e) {
    if (state.get(`rpc:${name}`) !== 'down') {
      state.set(`rpc:${name}`, 'down');
      publish(topic, 'WARN', `cannot reach ${name} rpc (${redactUrl(chain.rpc)}): ${e.message}`,
              { chain: name, change: 'rpc-down' });
    }
    return;
  }
  if (state.get(`rpc:${name}`) === 'down') {
    state.set(`rpc:${name}`, 'up');
    publish(topic, 'INFO', `recovered: ${name} rpc reachable again`, { chain: name, change: 'recovered' });
  }
  const byId = new Map((Array.isArray(results) ? results : [results]).map((r) => [r.id, r]));

  for (let i = 0; i < chain.keys.length; i++) {
    const key = chain.keys[i];
    const label = sanitize(key.label ?? key.address.slice(0, 10));
    const coin = key.token?.symbol ?? chain.coin ?? 'ETH';
    const res = byId.get(i);
    const bal = res?.result ? toUnits(res.result, key.token?.decimals ?? 18) : undefined;
    const skey = `${name}:${label}`;
    if (bal === undefined) {
      if (state.get(skey) !== 'unreadable') {
        state.set(skey, 'unreadable');
        publish(topic, 'WARN', `${key.label ?? label}: balance unreadable (${res?.error?.message ?? 'no result'})`,
                { chain: name, label, address: key.address, change: 'unreadable' });
      }
      continue;
    }

    publish(topic, 'DEBUG', `${key.label ?? label}: ${bal.toFixed(6)} ${coin}`,
            { chain: name, label, address: key.address, coin,
              ...(key.crit !== undefined ? { crit: key.crit } : {}),
              ...(key.warn !== undefined ? { warn: key.warn } : {}) },
            { name: `gas.${label}`, value: Number(bal.toFixed(6)) });

    const now = key.crit !== undefined && bal < key.crit ? 'crit'
              : key.warn !== undefined && bal < key.warn ? 'warn' : 'ok';
    const before = state.get(skey) ?? 'ok';
    if (now !== before) {
      state.set(skey, now);
      const f = { chain: name, label, address: key.address, coin,
                  balance: bal.toFixed(6), change: 'threshold' };
      if (now === 'crit')
        publish(topic, 'CRITICAL',
                `${key.label ?? label} on ${name}: ${bal.toFixed(6)} ${coin} - below ${key.crit}, FUND NOW`,
                f, { name: `gas.${label}`, value: Number(bal.toFixed(6)) });
      else if (now === 'warn')
        publish(topic, 'WARN',
                `${key.label ?? label} on ${name}: ${bal.toFixed(6)} ${coin} - below ${key.warn}, running low`,
                f, { name: `gas.${label}`, value: Number(bal.toFixed(6)) });
      else
        publish(topic, 'INFO',
                `recovered: ${key.label ?? label} on ${name} funded to ${bal.toFixed(6)} ${coin}`,
                { ...f, change: 'recovered' });
    }
  }
}

// ------------------------------------------------------------------- run

const nKeys = chains.reduce((n, [, c]) => n + c.keys.length, 0);
console.error(`superlog-gas: ${nKeys} key(s) across ${chains.length} chain(s)` +
              (once ? ' (once)' : ` every ${intervalMs / 1000}s`) + ` -> gas.<chain>`);

for (;;) {
  await Promise.all(chains.map(([name, chain]) => pollChain(name, chain)));
  await flush();
  if (once) break;
  await new Promise((r) => setTimeout(r, intervalMs));
}
