#!/usr/bin/env node
//
//  superlog-rpc - the RPC node endpoints, watched: block height and health.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A chain watcher, a gas checker, an oracle - all of them are only as
//  alive as the RPC endpoint behind them, and a dead or STALLED provider
//  fails quietly: the calls just start erroring, or worse, keep answering
//  with a block height that stopped advancing. In production you run more
//  than one provider per chain (a QuickNode and an Alchemy, say) precisely
//  so one can die without taking you with it - but only if you can SEE
//  which one died. This polls each endpoint on its own clock, prints the
//  latest block, and turns "healthy" into an edge-triggered fact:
//
//    - the block height each poll as a DEBUG metric (rpc.<chain>.<provider>
//      .block) - a chart that flatlines is a stalled provider even while it
//      still answers 200.
//    - DOWN (no answer, or an error) after two consecutive misses: ERROR,
//      recovery announced.
//    - STALLED (answering, but the block has not advanced in --stall
//      seconds): WARN, because a frozen height is the failure a naive
//      health check misses entirely.
//    - latency as a reading, so a provider degrading before it dies shows.
//
//  Config is rpc.json (gitignored - an RPC URL usually carries a provider
//  key, which IS a credential): per chain, per provider, a url. Four wire
//  dialects, one health discipline, matching superlog-gas:
//
//    { "interval": 60, "stall": 120, "endpoints": [
//        { "chain": "ethereum", "provider": "quicknode", "url": "https://..." },
//        { "chain": "ethereum", "provider": "alchemy",   "url": "https://..." },
//        { "chain": "solana",   "provider": "public", "kind": "solana",
//          "url": "https://api.mainnet-beta.solana.com" },
//        { "chain": "bitcoin",  "provider": "mempool", "kind": "bitcoin",
//          "url": "https://mempool.space/api" } ] }
//
//  kind: evm (default) | solana | tron | bitcoin. The block-height call is
//  the dialect's cheapest: eth_blockNumber, getSlot, /wallet/getnowblock,
//  /blocks/tip/height. Publishes to rpc.<chain>; the viewers' RPC board
//  renders one row per endpoint with chain, url, provider, block, latency,
//  last-seen and health.
//
//  Node >= 18, zero dependencies.
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
  console.error(`superlog-rpc - RPC node endpoints watched: block height and health

  superlog-rpc [--config rpc.json] [--interval 60] [--stall 120]
               [--once] [--url HUB]

Publishes to rpc.<chain>: block height as a metric, DOWN after two misses
(ERROR), STALLED when the block stops advancing (WARN), recovery announced.
Config rpc.json (gitignored - RPC URLs carry provider keys): endpoints
[{chain, provider, url, kind?}], kind evm|solana|tron|bitcoin.`);
  process.exit(0);
}

const env = loadEnv();
const configPath = opt('config', env.SUPER_LOG_RPC_CONFIG ?? 'rpc.json');
if (!existsSync(configPath)) {
  console.error(`superlog-rpc: no ${configPath}. Copy rpc.json.example there and edit -`);
  console.error('it is gitignored on purpose: an RPC URL usually carries a provider key.');
  process.exit(2);
}
let cfg;
try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); }
catch (e) { console.error(`superlog-rpc: cannot read ${configPath}: ${e.message}`); process.exit(2); }

const hubUrl = opt('url', cfg.url ?? env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const once = args.includes('--once');
const intervalS = Math.max(5, Number(opt('interval', cfg.interval ?? 60)) || 60);
const stallS = Number(opt('stall', cfg.stall ?? 120)) || 120;
const endpoints = (cfg.endpoints ?? []).filter((e) => e?.chain && e?.url);
if (!endpoints.length) {
  console.error(`superlog-rpc: ${configPath} defines no endpoints`);
  process.exit(2);
}

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 48) || 'x';

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();
let seq = 0;

function publish(topic, level, msg, fields, metric) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'rpc', platform: 'chain', device: sanitize(configPath.split('/').pop()) },
    tag: 'rpc', msg,
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
    } catch { /* hub down; the next batch counts again */ }
  }
}

// ---- the block-height call per dialect - the cheapest each chain offers.

async function blockEvm(url) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? 'rpc error');
  return Number(BigInt(j.result));
}
async function blockSolana(url) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? 'rpc error');
  return Number(j.result);
}
async function blockTron(url) {
  const r = await fetch(`${url}/wallet/getnowblock`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  const n = j?.block_header?.raw_data?.number;
  if (n === undefined) throw new Error('no block in response');
  return Number(n);
}
async function blockBitcoin(url) {
  const r = await fetch(`${url}/blocks/tip/height`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return Number(await r.text());
}
const DIALECTS = { evm: blockEvm, solana: blockSolana, tron: blockTron, bitcoin: blockBitcoin };

// ---- per-endpoint health, edge-triggered, the vitals discipline.

const state = new Map();   // key -> {misses, phase:'ok'|'down'|'stalled', lastBlock, lastAdvance}

async function pollEndpoint(e) {
  const key = `${e.chain}/${e.provider ?? 'default'}`;
  const topic = `rpc.${sanitize(e.chain)}`;
  const kind = DIALECTS[e.kind] ? e.kind : 'evm';
  const s = state.get(key) ?? { misses: 0, phase: 'ok', lastBlock: null, lastAdvance: Date.now() };
  const t0 = Date.now();
  let block;
  try {
    block = await DIALECTS[kind](e.url);
  } catch (err) {
    s.misses += 1;
    if (s.misses >= 2 && s.phase !== 'down') {
      s.phase = 'down';
      publish(topic, 'ERROR',
        `${e.chain}/${e.provider ?? 'default'} DOWN - ${String(err.message ?? err).slice(0, 120)}`,
        { chain: e.chain, provider: e.provider, url: redactUrl(e.url), health: 'down' });
    }
    state.set(key, s);
    return;
  }
  const ms = Date.now() - t0;
  s.misses = 0;

  // The row the board renders, every poll - block, latency, and the truth.
  publish(topic, 'DEBUG',
    `${e.chain}/${e.provider ?? 'default'} block ${block} (${ms}ms)`,
    { chain: e.chain, provider: e.provider ?? 'default', url: redactUrl(e.url),
      block: String(block), latency_ms: String(ms), health: 'up' },
    { name: `rpc.${sanitize(e.chain)}.${sanitize(e.provider ?? 'default')}.block`, value: block });
  publish(topic, 'DEBUG', `${key} latency ${ms}ms`,
    { chain: e.chain, provider: e.provider ?? 'default' },
    { name: `rpc.${sanitize(e.chain)}.${sanitize(e.provider ?? 'default')}.latency_ms`, value: ms });

  const advanced = s.lastBlock === null || block > s.lastBlock;
  if (advanced) { s.lastBlock = block; s.lastAdvance = Date.now(); }

  const stalled = !advanced && Date.now() - s.lastAdvance > stallS * 1000;
  const nextPhase = stalled ? 'stalled' : 'ok';
  if (nextPhase !== s.phase) {
    if (nextPhase === 'stalled')
      publish(topic, 'WARN',
        `${e.chain}/${e.provider ?? 'default'} STALLED at block ${block} - ` +
        `no advance in ${Math.round((Date.now() - s.lastAdvance) / 1000)}s (still answering)`,
        { chain: e.chain, provider: e.provider, url: redactUrl(e.url), block: String(block), health: 'stalled' });
    else
      publish(topic, 'INFO',
        `recovered: ${e.chain}/${e.provider ?? 'default'} advancing again (block ${block})`,
        { chain: e.chain, provider: e.provider, health: 'up' });
    s.phase = nextPhase;
  } else if (s.phase === 'down') {
    // came back from a hard DOWN straight to answering
    s.phase = 'ok';
    publish(topic, 'INFO', `recovered: ${e.chain}/${e.provider ?? 'default'} answering again (block ${block})`,
      { chain: e.chain, provider: e.provider, health: 'up' });
  }
  state.set(key, s);
}

console.error(`superlog-rpc: ${endpoints.length} endpoint(s) across ` +
  `${new Set(endpoints.map((e) => e.chain)).size} chain(s)` +
  (once ? ' (once)' : ` every ${intervalS}s, stall ${stallS}s`) + ` -> rpc.<chain>`);

for (;;) {
  await Promise.all(endpoints.map((e) => pollEndpoint(e)));
  await flush();
  if (once) break;
  await new Promise((r) => setTimeout(r, intervalS * 1000));
}
