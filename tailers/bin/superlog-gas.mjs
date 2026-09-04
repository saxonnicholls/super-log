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
//  Four wire dialects, one discipline - a chain entry's `kind` picks it:
//    (default)  EVM JSON-RPC: eth_getBalance / balanceOf, batched.
//    "solana"   Solana JSON-RPC: getBalance (lamports/1e9), batched;
//               token {mint, symbol} sums SPL accounts via
//               getTokenAccountsByOwner.
//    "tron"     TronGrid-style REST: /wallet/getaccount (SUN/1e6);
//               token {address, decimals, symbol} is a TRC-20 balanceOf
//               via /wallet/triggerconstantcontract (base58 decoded here,
//               ~20 lines, because one dependency for one alphabet is not
//               a bargain). An account Tron has never seen IS zero -
//               unactivated and empty pay for gas equally badly.
//    "bitcoin"  any Esplora-style REST (mempool.space by default, your own
//               node's electrs works): funded minus spent, sats/1e8.
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
// The non-EVM kinds have sane public defaults, overridable per chain in
// gas.json or bench-wide in .env - so a chain entry can be nothing but
// kind and keys.
const RPC_FALLBACK = {
  solana: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  tron: env.TRON_API_URL || 'https://api.trongrid.io',
  bitcoin: env.BITCOIN_API_URL || 'https://mempool.space/api',
};
const chains = Object.entries(cfg.chains ?? {})
  .map(([n, c]) => [n, { ...c, rpc: c?.rpc ?? RPC_FALLBACK[c?.kind] }])
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

// ---------------------------------------------------- the wire dialects
//
// Each returns [{bal, err?}] aligned with chain.keys; the threshold and
// edge machinery below neither knows nor cares which chain spoke.

async function balancesEvm(chain) {
  const calls = chain.keys.map((k, i) => callFor(k, i));
  const r = await fetch(chain.rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls), signal: AbortSignal.timeout(20000),
  });
  const results = await r.json();
  const byId = new Map((Array.isArray(results) ? results : [results]).map((x) => [x.id, x]));
  return chain.keys.map((key, i) => {
    const res = byId.get(i);
    const bal = res?.result ? toUnits(res.result, key.token?.decimals ?? 18) : undefined;
    return { bal, err: res?.error?.message };
  });
}

async function balancesSolana(chain) {
  const calls = chain.keys.map((k, i) => k.token?.mint
    ? { jsonrpc: '2.0', id: i, method: 'getTokenAccountsByOwner',
        params: [k.address, { mint: k.token.mint }, { encoding: 'jsonParsed' }] }
    : { jsonrpc: '2.0', id: i, method: 'getBalance', params: [k.address] });
  const r = await fetch(chain.rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls), signal: AbortSignal.timeout(20000),
  });
  const results = await r.json();
  const byId = new Map((Array.isArray(results) ? results : [results]).map((x) => [x.id, x]));
  return chain.keys.map((key, i) => {
    const res = byId.get(i);
    if (res?.error) return { bal: undefined, err: res.error.message };
    if (key.token?.mint) {
      const accounts = res?.result?.value;
      if (!Array.isArray(accounts)) return { bal: undefined, err: 'no result' };
      // Several token accounts for one mint is normal; the key's worth
      // is their sum.
      return { bal: accounts.reduce((s, a) =>
        s + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0) };
    }
    const lamports = res?.result?.value;
    return typeof lamports === 'number'
      ? { bal: lamports / 1e9 } : { bal: undefined, err: 'no result' };
  });
}

// Base58 decode, the one alphabet Bitcoin gave the world and Tron kept.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58ToHex(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  return n.toString(16);
}
// A Tron base58check address decodes to 41 + 20 address bytes + 4 checksum.
const tronHex20 = (addr) => {
  const h = base58ToHex(addr);
  return h && h.length >= 50 ? h.slice(-48, -8) : null;
};

async function balancesTron(chain) {
  const headers = { 'content-type': 'application/json' };
  if (env.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRON_API_KEY;
  const out = [];
  for (const key of chain.keys) {
    try {
      if (key.token?.address) {
        const hex20 = tronHex20(key.address);
        if (!hex20) { out.push({ bal: undefined, err: 'bad base58 address' }); continue; }
        const r = await fetch(`${chain.rpc}/wallet/triggerconstantcontract`, {
          method: 'POST', headers, signal: AbortSignal.timeout(20000),
          body: JSON.stringify({
            owner_address: key.address, contract_address: key.token.address,
            function_selector: 'balanceOf(address)',
            parameter: hex20.padStart(64, '0'), visible: true,
          }),
        });
        const j = await r.json();
        const hex = j?.constant_result?.[0];
        out.push(hex ? { bal: toUnits('0x' + hex, key.token.decimals ?? 6) }
                     : { bal: undefined, err: j?.result?.message ?? 'no result' });
      } else {
        const r = await fetch(`${chain.rpc}/wallet/getaccount`, {
          method: 'POST', headers, signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ address: key.address, visible: true }),
        });
        const j = await r.json();
        // {} means Tron has never seen the account - which pays for gas
        // exactly as badly as an activated empty one: zero, honestly.
        out.push({ bal: (j?.balance ?? 0) / 1e6 });
      }
    } catch (e) {
      out.push({ bal: undefined, err: String(e.message ?? e) });
    }
  }
  return out;
}

async function balancesBitcoin(chain) {
  const out = [];
  for (const key of chain.keys) {
    try {
      const r = await fetch(`${chain.rpc}/address/${key.address}`,
                            { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      const c = j?.chain_stats;
      if (!c) { out.push({ bal: undefined, err: 'no chain_stats' }); continue; }
      out.push({ bal: (c.funded_txo_sum - c.spent_txo_sum) / 1e8 });
    } catch (e) {
      out.push({ bal: undefined, err: String(e.message ?? e) });
    }
  }
  return out;
}

const DIALECTS = { evm: balancesEvm, solana: balancesSolana,
                   tron: balancesTron, bitcoin: balancesBitcoin };
const COIN_DEFAULT = { evm: 'ETH', solana: 'SOL', tron: 'TRX', bitcoin: 'BTC' };

// Edge-triggered, the vitals discipline: a crossing is news, the same
// crossing five minutes later is not, and refunding a key is news too.
const state = new Map();

async function pollChain(name, chain) {
  const topic = opt('topic', `gas.${sanitize(name)}`);
  const kind = DIALECTS[chain.kind] ? chain.kind : 'evm';
  let balances;
  try {
    balances = await DIALECTS[kind](chain);
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

  for (let i = 0; i < chain.keys.length; i++) {
    const key = chain.keys[i];
    const label = sanitize(key.label ?? key.address.slice(0, 10));
    const coin = key.token?.symbol ?? chain.coin ?? COIN_DEFAULT[kind];
    const { bal, err } = balances[i] ?? {};
    const skey = `${name}:${label}`;
    if (bal === undefined) {
      if (state.get(skey) !== 'unreadable') {
        state.set(skey, 'unreadable');
        publish(topic, 'WARN', `${key.label ?? label}: balance unreadable (${err ?? 'no result'})`,
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
