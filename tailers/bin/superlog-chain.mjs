#!/usr/bin/env node
//
//  superlog-chain - blockchain events for watched addresses.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  A wallet's transaction appears on the same screen as the app code that
//  sent it and the server that signed it. That interleaving is the whole
//  point: block explorers show chain data better than this ever will, but
//  they cannot show it next to the render that failed, ordered by hub seq.
//
//    superlog-chain                                   # chains + addresses from .env
//    superlog-chain --chain base --watch treasury=0xabc…
//    superlog-chain --chain ethereum --watch a=0x1,b=0x2 --confirmations 2
//
//  Endpoints come from .env using this repo's convention -
//  <CHAIN>_RPC_URL, then <CHAIN>_QUICKNODE_RPC_URL as the second provider.
//  A wss:// endpoint is subscribed to; an https:// endpoint is polled, and
//  the difference is invisible downstream. Nothing is watched unless it is
//  configured, so a fresh clone with no .env is a working bench with no
//  chain streams rather than a broken one.
//
//  Topic: chain.<network>.<label>, so a watched address reads as a name on
//  the bench rather than as forty hex characters.
//
//  Zero dependency on purpose (the house rule): this speaks JSON-RPC over
//  the global WebSocket and fetch. It decodes the handful of event
//  signatures worth naming and publishes the rest with topic0 intact - the
//  tolerant-reader rule applies to chains too.
//
//  Node >= 22 (global WebSocket).
//

import { loadEnv, redactUrl } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-chain - watch addresses on a chain, onto the bench

  superlog-chain [--chain NAME] [--watch label=0xaddr,...] [--url HUB]
                 [--confirmations N] [--poll SECONDS] [--topic OVERRIDE]

Reads .env (see .env.example): <CHAIN>_RPC_URL, <CHAIN>_QUICKNODE_RPC_URL,
<CHAIN>_EXPLORER_URL, SUPER_LOG_CHAINS, SUPER_LOG_WATCH.
Publishes to chain.<network>.<label>.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const pollSeconds = Number(opt('poll', env.SUPER_LOG_CHAIN_POLL ?? '12'));
// A reorg can un-mine a block. Waiting a couple of blocks before calling
// something confirmed is cheaper than retracting it, but retraction still
// exists for the cases where waiting was not enough.
const confirmations = Math.max(0, Number(opt('confirmations', '2')));

const chains = (opt('chain', env.SUPER_LOG_CHAINS ?? '') || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const watches = (opt('watch', env.SUPER_LOG_WATCH ?? '') || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((pair) => {
    const [label, addr] = pair.includes('=') ? pair.split('=') : [pair.slice(0, 8), pair];
    return { label: label.toLowerCase().replace(/[^a-z0-9._-]/g, '-'), address: addr.toLowerCase() };
  })
  .filter((w) => /^0x[0-9a-f]{40}$/.test(w.address));

if (!chains.length) {
  console.error('superlog-chain: no chains configured. Set SUPER_LOG_CHAINS in .env (e.g. ethereum,base) or pass --chain.');
  process.exit(2);
}
if (!watches.length) {
  console.error('superlog-chain: no addresses to watch. Set SUPER_LOG_WATCH=label=0xaddress,... in .env or pass --watch.');
  process.exit(2);
}

// ------------------------------------------------------------- decoding
//
// topic0 is keccak256 of the event signature. Hashing here would mean
// implementing keccak, so the well-known ones are listed by their known
// hashes and anything else publishes with topic0 intact - a reader can
// still recognise it, and naming every event was never the goal.

const EVENTS = {
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': 'Transfer',
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': 'Approval',
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1': 'Sync',
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822': 'Swap',
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f': 'Mint',
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496': 'Burn',
  '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c': 'Deposit',
  '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65': 'Withdrawal',
};

const addrFromTopic = (t) => (typeof t === 'string' && t.length === 66 ? '0x' + t.slice(26) : undefined);
const hexToBig = (h) => { try { return BigInt(h ?? '0x0'); } catch { return 0n; } };
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

// A token's decimals are a property of the contract, not a constant: USDC
// is 6, WBTC is 8, most ERC-20s are 18. Assuming 18 made a real USDC
// transfer print as 0.000000, which is worse than printing nothing - so
// decimals are asked for once per contract and cached, and a value is only
// formatted when they are known.
const decimalsCache = new Map();
const DECIMALS_SELECTOR = '0x313ce567';        // decimals()

async function decimalsOf(url, contract) {
  const key = `${url}|${contract}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  let d;
  try {
    const r = await rpc(url, 'eth_call', [{ to: contract, data: DECIMALS_SELECTOR }, 'latest']);
    const n = Number(hexToBig(r));
    d = Number.isFinite(n) && n >= 0 && n <= 36 ? n : undefined;
  } catch {
    d = undefined;                             // not an ERC-20, or the node said no
  }
  decimalsCache.set(key, d);
  return d;
}

/** Wei to a readable decimal without a bignum library: a float would
 *  quietly lie about the last several digits of an 18-decimal amount. */
function formatUnits(v, decimals = 18) {
  const neg = v < 0n;
  let s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  let frac = s.slice(-decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac.slice(0, 6) : ''}`;
}

// ------------------------------------------------------------ the batcher
// Same contract as every other producer here: never block, bounded, drops
// counted rather than hidden.

const session = Math.random().toString(16).slice(2, 10);
const buffers = new Map();
let seq = 0;
let posted = 0, failed = 0;

function publish(topic, level, msg, fields) {
  const ev = {
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'chain-watcher', platform: 'chain' },
    tag: 'chain', msg, fields,
  };
  let b = buffers.get(topic);
  if (!b) buffers.set(topic, (b = []));
  b.push(JSON.stringify(ev));
  if (b.length >= 256) void flushTopic(topic);
}

async function flushTopic(t) {
  const lines = buffers.get(t);
  if (!lines?.length) return;
  buffers.set(t, []);
  try {
    await fetch(`${hubUrl}/ingest/${t}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' },
      body: lines.join('\n'),
    });
    posted++;
  } catch {
    failed++;
  }
}
const flushAll = () => Promise.all([...buffers.keys()].map(flushTopic));
setInterval(() => void flushAll(), 250).unref?.();

// ------------------------------------------------------------- JSON-RPC

function endpointFor(chain) {
  const up = chain.toUpperCase();
  return env[`${up}_RPC_URL`] || env[`${up}_QUICKNODE_RPC_URL`] || '';
}
const explorerFor = (chain) => env[`${chain.toUpperCase()}_EXPLORER_URL`] || '';

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1e6, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

// ------------------------------------------------------------ the watcher

async function emitLog(chain, log, byAddress, rpcUrl) {
  const name = EVENTS[log.topics?.[0]] ?? null;
  const from = addrFromTopic(log.topics?.[1]);
  const to = addrFromTopic(log.topics?.[2]);
  // Which watched address does this concern? The emitter, or a party to it.
  const hit = byAddress.get((log.address ?? '').toLowerCase())
    ?? byAddress.get((from ?? '').toLowerCase())
    ?? byAddress.get((to ?? '').toLowerCase());
  if (!hit) return;

  const fields = {
    chain,
    tx: log.transactionHash ?? '',
    block: String(hexToBig(log.blockNumber)),
    contract: log.address ?? '',
    event: name ?? 'unknown',
    topic0: log.topics?.[0] ?? '',
  };
  if (from) fields.from = from;
  if (to) fields.to = to;
  // Transfer/Approval carry an amount in data; anything else keeps data raw
  // rather than pretending to know its shape.
  if ((name === 'Transfer' || name === 'Approval') && log.data && log.data !== '0x') {
    const raw = hexToBig(log.data);
    fields.value_raw = raw.toString();         // always exact, always present
    const dp = rpcUrl ? await decimalsOf(rpcUrl, log.address) : undefined;
    if (dp !== undefined) {
      fields.value = formatUnits(raw, dp);
      fields.decimals = String(dp);
    }
    // No decimals means no `value` field. Better a reader asks than is told
    // a number that is wrong by six orders of magnitude.
  }
  const explorer = explorerFor(chain);
  if (explorer && log.transactionHash) fields.link = `${explorer}/tx/${log.transactionHash}`;

  const direction = to && byAddress.has(to) ? 'in' : from && byAddress.has(from) ? 'out' : '';
  if (direction) fields.direction = direction;

  const amount = fields.value ?? `${fields.value_raw ?? '?'} (raw)`;
  const human = name === 'Transfer'
    ? `${direction === 'in' ? 'received' : direction === 'out' ? 'sent' : 'transfer'} ` +
      `${amount} (${short(from)} → ${short(to)})`
    : `${name ?? 'log'} on ${short(log.address)}`;

  publish(`chain.${chain}.${hit.label}`, log.removed ? 'WARN' : 'INFO',
          log.removed ? `RETRACTED (reorg): ${human}` : human, fields);
}

async function watchChain(chain) {
  const url = endpointFor(chain);
  if (!url) {
    console.error(`superlog-chain: ${chain} has no endpoint - set ${chain.toUpperCase()}_RPC_URL in .env`);
    return;
  }
  const byAddress = new Map(watches.map((w) => [w.address, w]));
  const addresses = watches.map((w) => w.address);
  console.error(`superlog-chain: ${chain} ${redactUrl(url)} watching ` +
                watches.map((w) => `${w.label}(${short(w.address)})`).join(', '));

  for (const w of watches)
    publish(`chain.${chain}.${w.label}`, 'INFO',
            `watching ${w.address} on ${chain}`, { chain, address: w.address });

  // A watched address is usually a party to an event rather than its
  // emitter, so ask for both: logs FROM the address, and logs where it is
  // an indexed party (topic1/topic2 of a Transfer).
  const padded = addresses.map((a) => '0x' + a.slice(2).padStart(64, '0'));
  const filters = [
    { address: addresses },
    { topics: [Object.keys(EVENTS)[0], padded] },
    { topics: [Object.keys(EVENTS)[0], null, padded] },
  ];

  if (url.startsWith('wss://') || url.startsWith('ws://')) {
    await subscribe(chain, url, filters, byAddress);
  } else {
    await poll(chain, url, filters, byAddress);
  }
}

/** websocket: eth_subscribe, which is cheaper on quota and lower latency. */
async function subscribe(chain, url, filters, byAddress) {
  let backoff = 1000;
  for (;;) {
    const done = await new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        console.error(`superlog-chain: ${chain} cannot open websocket: ${e.message}`);
        return resolve(false);
      }
      let id = 1;
      const subs = new Set();
      ws.onopen = () => {
        backoff = 1000;
        for (const f of filters) ws.send(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'eth_subscribe', params: ['logs', f] }));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'eth_subscribe', params: ['newHeads'] }));
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
        if (m.result && typeof m.result === 'string') { subs.add(m.result); return; }
        const p = m.params?.result;
        if (!p) return;
        if (p.topics) void emitLog(chain, p, byAddress, url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
        // newHeads arrive too; they are the heartbeat that says the
        // subscription is alive, and are deliberately not published - a
        // block every few seconds on every chain is noise, not signal.
      };
      ws.onerror = () => {};
      ws.onclose = () => resolve(false);
    });
    if (done) return;
    console.error(`superlog-chain: ${chain} websocket closed; reconnecting in ${backoff / 1000}s`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30000);
  }
}

/** http: poll eth_getLogs. Many endpoints - especially free tiers - have no
 *  websocket at all, and a bench that only works on the paid plan is not
 *  much of a bench. */
async function poll(chain, url, filters, byAddress) {
  let from;
  try {
    from = hexToBig(await rpc(url, 'eth_blockNumber'));
  } catch (e) {
    console.error(`superlog-chain: ${chain} cannot reach the endpoint: ${e.message}`);
    return;
  }
  console.error(`superlog-chain: ${chain} polling from block ${from} every ${pollSeconds}s`);
  for (;;) {
    await new Promise((r) => setTimeout(r, pollSeconds * 1000));
    try {
      const head = hexToBig(await rpc(url, 'eth_blockNumber'));
      const safe = head - BigInt(confirmations);
      if (safe <= from) continue;
      // Bounded window: after an outage, catching up on a month of blocks
      // would blow the provider's range limit and the bench's patience.
      const to = safe - from > 500n ? from + 500n : safe;
      for (const f of filters) {
        const logs = await rpc(url, 'eth_getLogs', [{
          ...f, fromBlock: '0x' + (from + 1n).toString(16), toBlock: '0x' + to.toString(16),
        }]);
        for (const log of logs ?? []) await emitLog(chain, log, byAddress, url);
      }
      from = to;
    } catch (e) {
      // A provider hiccup is not a reason to stop watching, but it IS worth
      // saying: silence here would look exactly like a quiet address.
      console.error(`superlog-chain: ${chain} poll failed: ${e.message}`);
      publish(`chain.${chain}.${watches[0].label}`, 'WARN',
              `rpc poll failed: ${e.message}`, { chain, error: e.message });
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    void flushAll().then(() => {
      console.error(`superlog-chain: ${posted} batches posted, ${failed} failed`);
      process.exit(0);
    });
  });

console.error(`superlog-chain: ${chains.length} chain(s) -> ${hubUrl}` +
              (env.__envFile ? ` (env ${env.__envFile})` : ''));
await Promise.all(chains.map((c) => watchChain(c).catch((e) =>
  console.error(`superlog-chain: ${c} stopped: ${e.message}`))));
