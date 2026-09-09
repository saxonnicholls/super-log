//
//  tests/history.test.mjs - search_history is honest about a partial scan.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A real superlog-mcp process over stdio JSON-RPC, against a synthetic journal
//  on disk. The bug this guards against cost real trust: the scan has a time
//  budget, and when it ran out having read nothing it reported "0 matches" -
//  a false "no" to "did this ever happen?", which an agent then relayed as
//  fact. The fixes: read the NEWEST files first (almost every query is recent),
//  report how much of the journal was actually covered, and NEVER format a
//  cut-short scan like a clean zero. A truncated scan is amber, not "no".
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { removeDir, startHub, tempDir } from './harness.mjs';

const MCP = 'sdk/js/packages/mcp/bin/superlog-mcp.mjs';
let hub, work, journalDir;

// A journal line is a hub FRAME: {seq, topic, ts_ms, payload}, payload being
// the NDJSON event line(s) the hub received.
const frame = (seq, topic, tsMs, event) =>
  JSON.stringify({ seq, topic, ts_ms: tsMs, payload: JSON.stringify(event) });

function buildFile(path, baseTs, seqBase, needleAt, needle) {
  const lines = [];
  for (let i = 0; i < 120; i++) {
    const msg = i === needleAt ? `marker ${needle} marker` : `noise line ${i}`;
    lines.push(frame(seqBase + i, 'os.test', baseTs + i * 1000, { v: 1, level: 'INFO', msg }));
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

// One search_history call against a fresh MCP process (so SUPER_LOG_SCAN_MS,
// read once at startup, can differ per test). Returns the tool's text.
async function search(args, env = {}) {
  const p = spawn(process.execPath, [MCP],
    { env: { ...process.env, SUPER_LOG_URL: hub.url, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pend = new Map();
  let buf = '', id = 1;
  p.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    }
  });
  const req = (method, params) => new Promise((res) => {
    const mid = ++id; pend.set(mid, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
  });
  try {
    await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const resp = await req('tools/call', { name: 'search_history', arguments: args });
    return (resp.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  } finally { p.kill(); }
}

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-hist-');
  journalDir = join(work, 'journal');
  mkdirSync(journalDir);
  const now = Date.now();
  // Filenames sort chronologically; 01 is oldest, 04 newest. The needle lives
  // once in the oldest file and once in the newest.
  buildFile(join(journalDir, 'superlog-01.ndjson'), now - 3 * 3600e3, 1000, 5, 'OLD-NEEDLE');
  buildFile(join(journalDir, 'superlog-02.ndjson'), now - 2 * 3600e3, 2000, -1, '');
  buildFile(join(journalDir, 'superlog-03.ndjson'), now - 1 * 3600e3, 3000, -1, '');
  buildFile(join(journalDir, 'superlog-04.ndjson'), now - 60e3, 4000, 7, 'NEW-NEEDLE');
});
after(async () => { await hub?.stop(); removeDir(work); });

describe('search_history', () => {
  it('reports how much of the journal it actually covered', async () => {
    const t = await search({ dir: journalDir, contains: 'noise' });
    assert.match(t, /scanned \d+ of 4 file\(s\)/, 'coverage must be stated, not implied');
  });

  it('finds a recent match (newest files are read first)', async () => {
    const t = await search({ dir: journalDir, contains: 'NEW-NEEDLE' });
    assert.match(t, /NEW-NEEDLE/, 'a match in the newest file must be found');
  });

  it('a COMPLETED scan with no match is a definitive "no"', async () => {
    const t = await search({ dir: journalDir, contains: 'DEFINITELY-ABSENT-XYZ' });
    assert.match(t, /No matching events \(scan completed\)/,
      'only a finished scan may say "no"');
    assert.doesNotMatch(t, /INCOMPLETE/);
  });

  it('a scan cut short by the budget is INCOMPLETE, never a clean zero', async () => {
    // A 1ms budget cannot read ~500 frames across four files, so the scan is
    // cut off before it can finish - and it found nothing yet.
    const t = await search({ dir: journalDir, contains: 'OLD-NEEDLE' }, { SUPER_LOG_SCAN_MS: '1' });
    assert.match(t, /INCOMPLETE SCAN - this is NOT a "no"/,
      'a truncated scan must not read as "it did not happen"');
    assert.doesNotMatch(t, /No matching events/, 'it must NOT imply a definitive no');
  });
});
