#!/usr/bin/env node
//
//  superlog-journal - the headless writer.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Subscribes to the hub and appends every envelope frame verbatim, one
//  per line - lossless by construction, and exactly the format an M6
//  replayer reads back. This is the "continuous write to file" answer:
//  viewers stay display-only (their exports cover the ad-hoc grab), one
//  always-on subscriber owns the disk. Size-rotated so a forgotten journal
//  fills a folder, not the volume.
//
//    superlog-journal                              # ./superlog-journal/<stamp>.ndjson
//    superlog-journal --out /path --topic '*' --rotate-mb 64
//    superlog-journal --url http://<bench>:7333    # from another machine
//
//  Node >= 22 (global WebSocket). Reconnects like the viewers do; the hub
//  replays recent history on connect, so frames already journalled are
//  skipped by hub seq rather than written twice.
//

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const url = opt('url', process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const topic = opt('topic', '*');
const dir = opt('out', './superlog-journal');
const rotateBytes = Number(opt('rotate-mb', '64')) * 1024 * 1024;

mkdirSync(dir, { recursive: true });

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

let out;
let written = 0;
let frames = 0;
let files = 0;
function openFile() {
  const path = join(dir, `superlog-${stamp()}.ndjson`);
  out = createWriteStream(path, { flags: 'a' });
  written = 0;
  files += 1;
  console.error(`superlog-journal: writing ${path}`);
}
openFile();

let ws;
let closed = false;
let lastSeq = -1; // hub seq is the total order; replay after reconnect is <= this

function connect() {
  const wsUrl = url.replace(/^http/, 'ws') + `/ws?topic=${encodeURIComponent(topic)}`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.error(`superlog-journal: subscribed ${wsUrl}`);
  ws.onmessage = (e) => {
    const line = typeof e.data === 'string' ? e.data : String(e.data);
    const m = line.match(/^\{"seq":\s*(\d+)/);
    const seq = m ? Number(m[1]) : NaN;
    if (Number.isFinite(seq)) {
      if (seq <= lastSeq) return; // reconnect replay - already on disk
      lastSeq = seq;
    }
    out.write(line + '\n');
    written += line.length + 1;
    frames += 1;
    if (written >= rotateBytes) {
      out.end();
      openFile();
    }
  };
  ws.onclose = () => {
    if (!closed) setTimeout(connect, 1000);
  };
  ws.onerror = () => ws.close();
}
connect();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    closed = true;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    console.error(`superlog-journal: ${frames} frames across ${files} file(s)`);
    out.end(() => process.exit(0));
  });
}
