//
//  tests/gas.test.mjs - superlog-gas against a stand-in JSON-RPC node.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The chain is played by a local HTTP server whose balances this file
//  mutates between polls - the only way to exercise the part that matters,
//  which is not reading a balance but SAYING things at the right moments:
//  CRITICAL once when a key crosses the fund-now line, not every five
//  minutes until someone funds it; INFO once when it recovers; and an
//  ERC-20 balance read through balanceOf with its own decimals, because
//  6-decimal USDC at 18-decimal math is off by a trillion.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import {
  assertValidEvent, removeDir, run, start, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub, work, rpc, rpcPort;

// address (lowercased) -> balance in wei-hex; balanceOf calls are answered
// from the same table keyed by the caller-encoded holder address.
const balances = new Map();
const weiHex = (eth) => '0x' + BigInt(Math.round(eth * 1e6) * 1e12).toString(16);

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-gas-');
  await new Promise((res) => {
    rpc = createServer((req, resp) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const calls = JSON.parse(body);
        const out = (Array.isArray(calls) ? calls : [calls]).map((c) => {
          const holder = c.method === 'eth_getBalance'
            ? c.params[0].toLowerCase()
            : '0x' + c.params[0].data.slice(-40).toLowerCase();
          return { jsonrpc: '2.0', id: c.id,
                   result: balances.get(holder) ?? '0x0' };
        });
        resp.setHeader('content-type', 'application/json');
        resp.end(JSON.stringify(out));
      });
    });
    rpc.listen(0, '127.0.0.1', () => { rpcPort = rpc.address().port; res(); });
  });
});

after(async () => {
  rpc?.close();
  await hub?.stop();
  removeDir(work);
});

const ORACLE = '0x00000000000000000000000000000000000000aa';
const DESK = '0x00000000000000000000000000000000000000bb';

function config() {
  const p = join(work, 'gas.json');
  writeFileSync(p, JSON.stringify({
    chains: {
      testnet: {
        rpc: `http://127.0.0.1:${rpcPort}`,
        coin: 'ETH',
        keys: [
          { label: 'oracle', address: ORACLE, crit: 0.002, warn: 0.01 },
          { label: 'desk-usdc', address: DESK, crit: 100, warn: 1000,
            token: { address: '0x00000000000000000000000000000000000000cc',
                     decimals: 6, symbol: 'USDC' } },
        ],
      },
    },
  }));
  return p;
}

const of = (recs, change) => recs.filter((r) => r.event.fields?.change === change).map((r) => r.event);
const metric = (recs, name) => recs.filter((r) => r.event.metric?.name === name).map((r) => r.event);

describe('superlog-gas', () => {
  it('reads native and ERC-20 balances, and levels them by the config thresholds', async () => {
    balances.set(ORACLE, weiHex(0.000007));                     // below crit
    balances.set(DESK, '0x' + BigInt(550 * 1e6).toString(16));  // 550 USDC: below warn
    const cfg = config();
    await run('superlog-gas.mjs', ['--once', '--config', cfg, '--topic', 'gas.t1', '--url', hub.url], {});
    const recs = await waitFor(hub.url, (r) => r.length >= 4, { topic: 'gas.t1', timeoutMs: 15000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `gas.t1[${i}]`));

    const oracleReading = metric(recs, 'gas.oracle')[0];
    assert.equal(oracleReading.metric.value, 0.000007);
    const crit = recs.map((r) => r.event).find((e) => e.level === 'CRITICAL');
    assert.ok(crit, 'no CRITICAL for a key below the fund-now line');
    assert.match(crit.msg, /oracle on testnet: 0.000007 ETH - below 0.002, FUND NOW/);

    // 550 raw at 6 decimals is 550 USDC, not 5.5e-16 of anything.
    const usdc = metric(recs, 'gas.desk-usdc')[0];
    assert.equal(usdc.metric.value, 550);
    const warn = recs.map((r) => r.event)
      .find((e) => e.level === 'WARN' && /desk-usdc/.test(e.msg));
    assert.ok(warn, 'no WARN for the low USDC desk');
    assert.match(warn.msg, /below 1000, running low/);
  });

  it('speaks the Solana, Tron and Bitcoin dialects against stand-in nodes', async () => {
    // One local server plays all three chains, routed by path/method -
    // the same bargain as the EVM stand-in above: real HTTP, real
    // parsing, fake ledger.
    let dialects;
    await new Promise((res) => {
      dialects = createServer((req, resp) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          resp.setHeader('content-type', 'application/json');
          if (req.url === '/wallet/getaccount')
            return resp.end(JSON.stringify({ balance: 89_000_000 })); // 89 TRX in SUN
          if (req.url === '/wallet/triggerconstantcontract')
            return resp.end(JSON.stringify({
              constant_result: [BigInt(1_250 * 1e6).toString(16)] }));  // 1250 USDT
          if (req.url?.startsWith('/address/'))
            return resp.end(JSON.stringify({
              chain_stats: { funded_txo_sum: 6_000_000, spent_txo_sum: 4_500_000 } })); // 0.015 BTC
          const calls = JSON.parse(body);
          const out = (Array.isArray(calls) ? calls : [calls]).map((c) =>
            c.method === 'getBalance'
              ? { jsonrpc: '2.0', id: c.id, result: { value: 2_500_000_000 } } // 2.5 SOL
              : { jsonrpc: '2.0', id: c.id, result: { value: [
                  { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 40.5 } } } } } },
                  { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 9.5 } } } } } },
                ] } });
          resp.end(JSON.stringify(out));
        });
      });
      dialects.listen(0, '127.0.0.1', res);
    });
    const dp = dialects.address().port;
    const p = join(work, 'gas-dialects.json');
    writeFileSync(p, JSON.stringify({ chains: {
      sol: { kind: 'solana', rpc: `http://127.0.0.1:${dp}`, keys: [
        { label: 'fee-payer', address: 'FeePayer1111111111111111111111111111111111', crit: 3, warn: 5 },
        { label: 'usdc-spl', address: 'FeePayer1111111111111111111111111111111111',
          token: { mint: 'Mint111', symbol: 'USDC' }, warn: 100 } ] },
      trx: { kind: 'tron', rpc: `http://127.0.0.1:${dp}`, keys: [
        { label: 'energy', address: 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs', warn: 100 },
        { label: 'usdt', address: 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs',
          token: { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT' },
          crit: 2000 } ] },
      btc: { kind: 'bitcoin', rpc: `http://127.0.0.1:${dp}`, keys: [
        { label: 'settlement', address: 'bc1qtest', warn: 0.01 } ] },
    } }));
    await run('superlog-gas.mjs', ['--once', '--config', p, '--url', hub.url], {});

    const sol = await waitFor(hub.url, (r) => r.length >= 2, { topic: 'gas.sol', timeoutMs: 15000 });
    assert.equal(metric(sol, 'gas.fee-payer')[0].metric.value, 2.5);
    assert.ok(sol.some((r) => r.event.level === 'CRITICAL' && /fee-payer/.test(r.event.msg)),
              '2.5 SOL under a crit of 3 must be CRITICAL');
    assert.equal(metric(sol, 'gas.usdc-spl')[0].metric.value, 50,
                 'several SPL token accounts for one mint are summed');

    const trx = await waitFor(hub.url, (r) => r.length >= 2, { topic: 'gas.trx', timeoutMs: 15000 });
    assert.equal(metric(trx, 'gas.energy')[0].metric.value, 89);
    assert.match(trx.map((r) => r.event).find((e) => e.level === 'WARN' && /energy/.test(e.msg)).msg,
                 /below 100, running low/);
    assert.equal(metric(trx, 'gas.usdt')[0].metric.value, 1250,
                 'TRC-20 balanceOf decodes through the hand-rolled base58 path');

    const btc = await waitFor(hub.url, (r) => r.length >= 1, { topic: 'gas.btc', timeoutMs: 15000 });
    assert.equal(metric(btc, 'gas.settlement')[0].metric.value, 0.015,
                 'funded minus spent, in BTC not sats');
    dialects.close();
  });

  it('a crossing is said once, and a refund is announced once', async () => {
    balances.set(ORACLE, weiHex(0.05));
    balances.set(DESK, '0x' + BigInt(5000 * 1e6).toString(16)); // healthy
    const cfg = config();
    const h = start('superlog-gas.mjs',
      ['--config', cfg, '--interval', '15', '--topic', 'gas.t2', '--url', hub.url], {});
    // The runtime clamps --interval to 15s; three polls fit inside the test
    // budget only because the clamp is the floor.
    await waitFor(hub.url, (r) => metric(r, 'gas.oracle').length >= 1, { topic: 'gas.t2', timeoutMs: 20000 });

    balances.set(ORACLE, weiHex(0.0001));                       // drain it
    await waitFor(hub.url, (r) => r.some((x) => x.event.level === 'CRITICAL'),
                  { topic: 'gas.t2', timeoutMs: 40000 });

    balances.set(ORACLE, weiHex(0.08));                         // fund it
    const recs = await waitFor(hub.url, (r) => of(r, 'recovered').length >= 1,
                               { topic: 'gas.t2', timeoutMs: 40000 });
    await h.stop();

    const crits = recs.map((r) => r.event).filter((e) => e.level === 'CRITICAL');
    assert.equal(crits.length, 1, 'CRITICAL must fire once per crossing, not per poll');
    const rec = of(recs, 'recovered')[0];
    assert.match(rec.msg, /recovered: oracle on testnet funded to 0.08/);
  });
});
