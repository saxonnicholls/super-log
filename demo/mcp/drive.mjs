#!/usr/bin/env node
//
//  demo/mcp/drive.mjs - the MCP server, driven the way an agent drives it.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Every other demo here is watched in a viewer. This one cannot be: the MCP
//  server talks newline-delimited JSON-RPC over stdio to a coding agent, and
//  there is nothing to look at. So this script IS the demo - it speaks the
//  protocol itself, calls every tool, and prints what an agent would get
//  back.
//
//    npm run demo:mcp                 # against a hub on 7333
//    SUPER_LOG_URL=http://host:7333 npm run demo:mcp
//
//  It is also the fastest way to check the server after changing it, which
//  is why it exits non-zero when a tool fails: this doubles as the smoke
//  test that the wiring still works end to end.
//
//  Node >= 22.
//

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '../../sdk/js/packages/mcp/bin/superlog-mcp.mjs');
const hubUrl = process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333';

const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, SUPER_LOG_URL: hubUrl },
});

let carry = '';
const waiting = new Map();
child.stdout.on('data', (d) => {
  const lines = (carry + d.toString()).split('\n');
  carry = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const r = waiting.get(msg.id);
    if (r) { waiting.delete(msg.id); r(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    waiting.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => { if (waiting.delete(id)) rej(new Error(`${method} timed out`)); }, 20000);
  });
}

// The text an agent actually sees. Tool results are content blocks, and the
// whole design of this server is that each one is small enough to read.
const textOf = (r) =>
  (r?.result?.content ?? []).map((c) => c.text ?? '').join('\n').trim();

let failures = 0;
async function call(name, args, why) {
  process.stdout.write(`\n\x1b[1m${name}\x1b[0m  ${why}\n`);
  process.stdout.write(`  \x1b[2m-> ${JSON.stringify(args)}\x1b[0m\n`);
  try {
    const r = await rpc('tools/call', { name, arguments: args });
    if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
    const text = textOf(r);
    const lines = text.split('\n');
    for (const l of lines.slice(0, 8)) process.stdout.write(`  ${l}\n`);
    if (lines.length > 8) process.stdout.write(`  \x1b[2m… ${lines.length - 8} more line(s)\x1b[0m\n`);
    if (!text) process.stdout.write('  \x1b[2m(no matching events - that is an answer too)\x1b[0m\n');
  } catch (e) {
    failures += 1;
    process.stdout.write(`  \x1b[31mFAILED: ${e.message}\x1b[0m\n`);
  }
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'super-log-demo', version: '0.1.0' },
});
console.log(`connected to ${init.result?.serverInfo?.name} ` +
            `${init.result?.serverInfo?.version} (hub ${hubUrl})`);

const list = await rpc('tools/list', {});
const tools = list.result?.tools ?? [];
console.log(`\n${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

// The order an agent would actually use them in: is it running, what is
// there, then look.
await call('hub_status', {},
           'is the bench even up? distinguishes "hub down" from "app logged nothing"');
await call('list_streams', {},
           'orientation - which topics exist, so the next call names one rather than guessing');
await call('tail_logs', { limit: 5 },
           'the newest events across every stream');
await call('tail_logs', { level: 'ERROR', limit: 5 },
           'only what went wrong');
await call('search_logs', { contains: 'tick', limit: 3 },
           'find by text when you know the message but not the stream');
await call('search_history', { since: '15m', limit: 3 },
           'the on-disk journal - needs superlog-journal to have been running');
await call('wait_for', { contains: 'tick', timeout_ms: 5000 },
           'block until it happens, instead of sleeping and hoping');

// Every tool this server exposes should appear above; if one is added and
// not demonstrated, say so rather than quietly covering five of six.
const shown = new Set(['hub_status', 'list_streams', 'tail_logs', 'search_logs',
                       'search_history', 'wait_for']);
const missed = tools.map((t) => t.name).filter((n) => !shown.has(n));
if (missed.length) {
  console.log(`\n\x1b[33mnot demonstrated: ${missed.join(', ')}\x1b[0m`);
  failures += 1;
}

child.stdin.end();
child.kill();
console.log(failures ? `\n\x1b[31m${failures} tool(s) failed\x1b[0m`
                     : '\n\x1b[32mall tools answered\x1b[0m');
process.exit(failures ? 1 : 0);
