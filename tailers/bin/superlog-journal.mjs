#!/usr/bin/env node
//
//  superlog-journal - the headless writer.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Subscribes to the hub and appends every envelope frame verbatim, one
//  per line - lossless by construction, and exactly the format
//  superlog-search and superlog-replay read back. This is the "continuous
//  write to file" answer: viewers stay display-only (their exports cover
//  the ad-hoc grab), one always-on subscriber owns the disk. Size-rotated
//  so a forgotten journal fills a folder, not the volume.
//
//    superlog-journal                              # ./superlog-journal/<stamp>.ndjson
//    superlog-journal --out /path --topic '*' --rotate-mb 64
//    superlog-journal --max-files 20 --max-days 7  # retention; default keeps all
//    superlog-journal --url http://<bench>:7333    # from another machine
//
//  Retention is opt-in, not a default: losing history nobody asked to lose
//  is worse than a full folder, and the folder is the thing you notice. Set
//  a limit and a forgotten journal cannot fill the volume either.
//
//  Node >= 22 (global WebSocket). Reconnects like the viewers do; the hub
//  replays recent history on connect, so frames already journalled are
//  skipped by hub seq rather than written twice.
//

import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
const maxFiles = Math.max(0, Number(opt('max-files', '0')) || 0);
const maxDays = Math.max(0, Number(opt('max-days', '0')) || 0);

mkdirSync(dir, { recursive: true });

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

// Only files this writer made are ever candidates for deletion. A retention
// sweep that can unlink a stranger's file because it happened to share the
// directory is a bug waiting for someone's data.
const MINE = /^superlog-\d{8}-\d{6}\.ndjson(\.gz)?$/;

let pruned = 0;
function prune(current) {
  if (!maxFiles && !maxDays) return;
  let mine;
  try {
    mine = readdirSync(dir)
      .filter((n) => MINE.test(n))
      .sort()                                   // the stamp sorts chronologically
      .map((n) => join(dir, n))
      .filter((p) => p !== current);
  } catch {
    return;                                     // an unreadable directory is the writer's problem, not the pruner's
  }
  const doomed = new Set();
  // maxFiles counts the file being written, so only maxFiles-1 old ones stay.
  if (maxFiles > 0)
    for (const p of mine.slice(0, Math.max(0, mine.length - (maxFiles - 1)))) doomed.add(p);
  if (maxDays > 0) {
    const cutoff = Date.now() - maxDays * 86400000;
    for (const p of mine) {
      // mtime, not the name stamp: it is when the file stopped being written,
      // which is the age that matters for "keep a week".
      try {
        if (statSync(p).mtimeMs < cutoff) doomed.add(p);
      } catch {
        /* vanished under us - fine, that was the goal */
      }
    }
  }
  for (const p of doomed) {
    try {
      unlinkSync(p);
      pruned += 1;
      console.error(`superlog-journal: pruned ${p}`);
    } catch (e) {
      console.error(`superlog-journal: could not prune ${p}: ${e.message}`);
    }
  }
}

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
  // Prune on every rotation, and therefore also at startup: retention that
  // only applies while the process happens to be rotating is not retention.
  prune(path);
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
    console.error(
      `superlog-journal: ${frames} frames across ${files} file(s)` +
        (pruned ? `, ${pruned} old file(s) pruned` : ''),
    );
    out.end(() => process.exit(0));
  });
}
