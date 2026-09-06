//
//  tests/rpc.test.mjs - the RPC health watcher, against stand-in nodes.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  One local server plays several chains, routed by method/path, so the
//  part that matters is exercised without spending anyone's RPC quota:
//  the block height becomes a reading, an endpoint that stops answering
//  goes DOWN, and an endpoint that keeps answering with a FROZEN block
//  goes STALLED - the failure a naive up/down check misses. Nothing
//  mocked in the tailer; real HTTP, a real hub.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { assertValidEvent, removeDir, start, startHub, tempDir, waitFor } from './harness.mjs';

let hub, work, node, nodePort;
// A block the test advances and freezes at will.
let ethBlock = 0x100;
let alive = true;

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-rpc-');
  await new Promise((res) => {
    node = createServer((req, resp) => {
      if (!alive) { resp.destroy(); return; }
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        resp.setHeader('content-type', 'application/json');
        if (req.url === '/blocks/tip/height') return resp.end('842000');
        const c = JSON.parse(body || '{}');
        if (c.method === 'eth_blockNumber')
          return resp.end(JSON.stringify({ jsonrpc: '2.0', id: c.id, result: '0x' + ethBlock.toString(16) }));
        if (c.method === 'getSlot')
          return resp.end(JSON.stringify({ jsonrpc: '2.0', id: c.id, result: 250000000 }));
        resp.end('{}');
      });
    });
    node.listen(0, '127.0.0.1', () => { nodePort = node.address().port; res(); });
  });
});

after(async () => {
  node?.close();
  await hub?.stop();
  removeDir(work);
});

const cfg = (extra = {}) => {
  const p = join(work, 'rpc.json');
  writeFileSync(p, JSON.stringify({
    interval: 1, stall: 2,
    endpoints: [
      { chain: 'ethereum', provider: 'nodeA', url: `http://127.0.0.1:${nodePort}` },
      { chain: 'solana', provider: 'nodeB', kind: 'solana', url: `http://127.0.0.1:${nodePort}` },
      { chain: 'bitcoin', provider: 'nodeC', kind: 'bitcoin', url: `http://127.0.0.1:${nodePort}` },
      { chain: 'dead', provider: 'nowhere', url: 'http://127.0.0.1:59998' },
    ], ...extra,
  }));
  return p;
};

describe('superlog-rpc', () => {
  it('reads block height across dialects, and a dead endpoint goes DOWN', async () => {
    const h = start('superlog-rpc.mjs', ['--config', cfg(), '--url', hub.url], {});
    await h.waitForStderr(/endpoint\(s\)/);
    const eth = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.metric?.name === 'rpc.ethereum.nodea.block'),
      { topic: 'rpc.ethereum', timeoutMs: 15000 });
    eth.forEach((r, i) => assertValidEvent(r.event, `eth[${i}]`));
    assert.equal(eth.map((r) => r.event).find((e) => e.metric?.name === 'rpc.ethereum.nodea.block').metric.value, 0x100);

    const sol = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.metric?.name === 'rpc.solana.nodeb.block'),
      { topic: 'rpc.solana', timeoutMs: 15000 });
    assert.equal(sol.map((r) => r.event).find((e) => e.metric?.name === 'rpc.solana.nodeb.block').metric.value, 250000000);

    const btc = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.fields?.block === '842000'),
      { topic: 'rpc.bitcoin', timeoutMs: 15000 });
    assert.ok(btc.length, 'bitcoin tip height read via Esplora');

    // The dead endpoint: DOWN after two misses.
    const dead = await waitFor(hub.url,
      (rs) => rs.some((r) => /DOWN/.test(r.event?.msg ?? '')),
      { topic: 'rpc.dead', timeoutMs: 15000 });
    assert.equal(dead.map((r) => r.event).find((e) => /DOWN/.test(e.msg)).level, 'ERROR');
    await h.stop();
  });

  it('a frozen block on a still-answering endpoint is STALLED', async () => {
    // A distinct chain/provider so this test never matches the previous
    // test's stale readings lingering in the shared hub ring.
    ethBlock = 0x200; alive = true;
    const p = join(work, 'rpc-stall.json');
    writeFileSync(p, JSON.stringify({
      interval: 1, stall: 2,
      endpoints: [{ chain: 'ethstall', provider: 'frozen', url: `http://127.0.0.1:${nodePort}` }],
    }));
    const h = start('superlog-rpc.mjs', ['--config', p, '--url', hub.url], {});
    await h.waitForStderr(/endpoint\(s\)/);
    // ethBlock stays at 0x200 - the node still answers, but the height is frozen.
    const stalled = await waitFor(hub.url,
      (rs) => rs.some((r) => /STALLED/.test(r.event?.msg ?? '')),
      { topic: 'rpc.ethstall', timeoutMs: 25000 });
    const e = stalled.map((r) => r.event).find((x) => /STALLED/.test(x.msg));
    assert.equal(e.level, 'WARN', 'a frozen-but-answering endpoint is a WARN, not silence');
    assert.match(e.msg, /still answering/);

    // Advance it again -> recovery.
    ethBlock = 0x201;
    const rec = await waitFor(hub.url,
      (rs) => rs.some((r) => /advancing again/.test(r.event?.msg ?? '')),
      { topic: 'rpc.ethstall', timeoutMs: 15000 });
    assert.ok(rec.length, 'recovery is announced when the block advances again');
    await h.stop();
  });
});
