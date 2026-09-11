// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// B5 regression: a web page could open ws://127.0.0.1:7333/ws and read every
// stream, and forge events into any topic with a no-cors POST, because the hub
// checked no Origin. Fixed in ts-moveables (the handshake lives there): the
// Origin policy is enforced before the /ws 101 AND before an /ingest publish,
// secure by default (no Origin -> allow, loopback -> allow, else 403). This
// proves both doors against a foreign Origin, with the loopback/no-Origin
// controls that show a legit client still works.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

import { startHub, hubBuilt } from './harness.mjs';

// A raw RFC6455 upgrade, exactly what a browser sends - returns the HTTP status.
function wsHandshake(port, origin) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      let req = 'GET /ws?topic=* HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n`;
      if (origin) req += `Origin: ${origin}\r\n`;
      sock.write(req + '\r\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(Number(buf.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0)); }
    });
    sock.on('error', () => resolve(0));
    setTimeout(() => { sock.destroy(); resolve(0); }, 3000);
  });
}
const ingest = (url, topic, origin, msg) => fetch(`${url}/ingest/${topic}`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain', ...(origin ? { origin } : {}) },  // the CSRF-simple write
  body: `{"v":1,"level":"CRITICAL","msg":"${msg}"}`,
});

describe('B5: the hub checks Origin on both doors', { skip: !hubBuilt() }, () => {
  let hub, port;
  before(async () => { hub = await startHub(); port = Number(hub.url.split(':').pop()); });
  after(async () => { await hub?.stop?.(); });

  it('/ws: a foreign Origin is rejected; loopback and no-Origin are accepted', async () => {
    assert.equal(await wsHandshake(port, 'https://evil.example'), 403, 'a drive-by page is refused');
    assert.equal(await wsHandshake(port, 'http://localhost:7334'), 101, 'the local viewer still connects');
    assert.equal(await wsHandshake(port, null), 101, 'a CLI/SDK client (no Origin) still connects');
    // a lookalike host must not slip through
    assert.equal(await wsHandshake(port, 'http://127.0.0.1.evil.example'), 403, 'a loopback lookalike is refused');
  });

  it('/ingest: a foreign-Origin forge is rejected and never published; no-Origin still writes', async () => {
    // Distinct bodies so a forge is not confused with the legit control write.
    assert.equal((await ingest(hub.url, 'csrf.probe', 'https://evil.example', 'forged-by-a-web-page')).status, 403);
    assert.equal((await ingest(hub.url, 'legit.probe', null, 'written-by-the-cli')).status, 202);
    await new Promise((r) => setTimeout(r, 200));
    const txt = await fetch(`${hub.url}/recent?topic=*&limit=50`).then((r) => r.text());
    assert.ok(txt.includes('legit.probe') && txt.includes('written-by-the-cli'),
      'a no-Origin write is served (control)');
    assert.ok(!txt.includes('csrf.probe') && !txt.includes('forged-by-a-web-page'),
      'a foreign-Origin forge never reaches /recent');
  });
});
