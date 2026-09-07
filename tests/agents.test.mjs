//
//  tests/agents.test.mjs - the agents blotter's feed, over real MCP stdio.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Nothing mocked: a real superlog-mcp process over real stdio JSON-RPC
//  against a real hub. The initialize handshake alone must put a
//  LISTENING agent on the blotter (the client did not lift a finger),
//  and agent_report must land a REPORTING agent with its LLM named -
//  the one deliberate write the read-only server performs.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { assertValidEvent, startHub, waitFor } from './harness.mjs';

let hub, mcp;

const rpc = (msg) => mcp.stdin.write(JSON.stringify(msg) + '\n');

before(async () => {
  hub = await startHub();
  mcp = spawn(process.execPath, ['sdk/js/packages/mcp/bin/superlog-mcp.mjs'],
              { env: { ...process.env, SUPER_LOG_URL: hub.url },
                stdio: ['pipe', 'pipe', 'pipe'] });
  rpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {},
                  clientInfo: { name: 'Blotter Test Client', version: '1.0' } } });
  rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

after(async () => {
  mcp?.kill();
  await hub?.stop();
});

describe('the agents blotter feed', () => {
  it('connecting over MCP alone puts a LISTENING agent on the blotter', async () => {
    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => /connected - listening/.test(r.event?.msg ?? '')),
      { topic: 'agent.blotter-test-client', timeoutMs: 10000 });
    recs.forEach((r, i) => assertValidEvent(r.event, `agent[${i}]`));
    const e = recs.map((r) => r.event).find((x) => /listening/.test(x.msg));
    assert.equal(e.fields.kind, 'listening');
    assert.equal(e.fields.client, 'Blotter Test Client');
  });

  it('a tool call becomes a requesting event; agent_report names the LLM', async () => {
    rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'hub_status', arguments: {} } });
    const req = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.fields?.kind === 'requesting'),
      { topic: 'agent.blotter-test-client', timeoutMs: 10000 });
    assert.equal(req.map((r) => r.event)
      .find((e) => e.fields.kind === 'requesting').fields.tool, 'hub_status');

    rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name: 'agent_report',
                    arguments: { agent: 'proof-search', llm: 'claude-fable-5',
                                 status: 'mathlib bump 12% - 7h left',
                                 task: '8h proof search', pct: 12, interval_s: 900 } } });
    const rep = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.fields?.llm === 'claude-fable-5'),
      { topic: 'agent.proof-search', timeoutMs: 10000 });
    const e = rep.map((r) => r.event).find((x) => x.fields?.llm);
    assert.equal(e.fields.kind, 'reporting');
    assert.equal(e.fields.pct, '12');
    assert.equal(e.fields.interval_s, '900');
    assert.match(e.msg, /mathlib bump 12%/);
  });
});
