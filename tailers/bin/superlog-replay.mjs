#!/usr/bin/env node
//
//  superlog-replay - put a journal back on the wire.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Reads what superlog-journal wrote and re-POSTs it to a hub, in the
//  original order, at the original pace. Records are values: nothing
//  downstream can tell a replayed event from a live one, which is the point
//  (a viewer, an MCP tool or a fresh pair of eyes gets last night's incident
//  exactly as it happened) and also the hazard - so the banner on stderr is
//  deliberately impossible to miss, and --prefix exists for when a topic of
//  its own is the honest answer.
//
//    superlog-replay                                   # original pace, local hub
//    superlog-replay --speed 0                         # as fast as the hub accepts
//    superlog-replay --since 03:00 --until 04:00 --speed 10
//    superlog-replay --topic expo. --prefix replay.    # -> replay.expo.ios.sim
//
//  Events are never mutated: the payload is POSTed byte for byte as it was
//  published, so `seq`, `session`, `ts` and `trace` all still line up.
//  Filtering is therefore per FRAME, not per event - splitting a batch would
//  mean rewriting it, and a rewritten record is not a replay.
//
//  Node >= 18. Reads .ndjson and .ndjson.gz.
//

import { journalFiles, parseWhen, readFrames } from './journal-read.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const USAGE = `usage: superlog-replay [options]

  --dir <path>      journal directory or one file (default ./superlog-journal,
                    or $SUPER_LOG_JOURNAL)
  --url <u>         hub to publish into (default http://127.0.0.1:7333)
  --speed <x>       1 = original pace (default), 2 = twice as fast, 0 = flat out
  --max-gap <s>     compress silences longer than this (default 10, 0 = keep them)
  --topic <t>       exact topic, a prefix ending in a dot, or *
  --since <when>    30m | 2h | 3d | 03:00 | 2026-08-22 | full ISO (UTC).
                    Windows on hub arrival time, as the pacing does
  --until <when>    same forms
  --prefix <p>      republish to <p><topic> so a viewer can see it is a replay
  --dry-run         count and pace, but POST nothing`;

if (has('help') || has('h')) {
  console.log(USAGE);
  process.exit(0);
}

let dir, hubUrl, speed, maxGapMs, topic, since, until, prefix;
try {
  dir = opt('dir', process.env.SUPER_LOG_JOURNAL ?? './superlog-journal');
  hubUrl = opt('url', process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
  speed = Math.max(0, Number(opt('speed', '1')));
  if (!Number.isFinite(speed)) throw new Error('--speed must be a number');
  maxGapMs = Math.max(0, Number(opt('max-gap', '10'))) * 1000;
  topic = opt('topic', '');
  since = parseWhen(opt('since', ''));
  until = parseWhen(opt('until', ''));
  prefix = opt('prefix', '');
} catch (e) {
  console.error(`superlog-replay: ${e.message}\n\n${USAGE}`);
  process.exit(2);
}

const dryRun = has('dry-run');
const files = journalFiles(dir);
if (files.length === 0) {
  console.error(`superlog-replay: no journal files at ${dir}`);
  process.exit(1);
}

const rule = '='.repeat(72);
console.error(
  `${rule}\n` +
    `  REPLAY IN PROGRESS - THESE EVENTS ARE NOT LIVE\n` +
    `  They were recorded earlier and are being published again as-is,\n` +
    `  so viewers and agents cannot tell them from the real thing.\n` +
    `${rule}\n` +
    `  source : ${dir} (${files.length} file(s))\n` +
    `  target : ${hubUrl}${dryRun ? '   [DRY RUN - nothing is published]' : ''}\n` +
    `  pace   : ${speed === 0 ? 'flat out (--speed 0)' : `${speed}x original`}` +
    `${maxGapMs && speed !== 0 ? `, silences over ${maxGapMs / 1000}s compressed` : ''}\n` +
    `  filter : topic=${topic || '*'}` +
    `${since !== undefined ? ` since=${new Date(since).toISOString()}` : ''}` +
    `${until !== undefined ? ` until=${new Date(until).toISOString()}` : ''}` +
    `${prefix ? `  republished as ${prefix}<topic>` : ''}\n` +
    `${rule}`,
);

const stats = { frames: 0, events: 0, posted: 0, failed: 0, bad: 0 };
let stopping = false;
let lastReport = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publish(name, payload) {
  if (dryRun) {
    stats.posted++;
    return;
  }
  try {
    const res = await fetch(`${hubUrl}/ingest/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: payload,
    });
    if (res.ok) stats.posted++;
    else stats.failed++;
  } catch {
    stats.failed++;
  }
}

function finish(why) {
  console.error(
    `${rule}\n` +
      `  REPLAY ${why} - ${stats.frames} frame(s), ${stats.events} event(s), ` +
      `${stats.posted} ${dryRun ? 'would have been published' : 'published'}` +
      `${stats.failed ? `, ${stats.failed} FAILED` : ''}` +
      `${stats.bad ? `, ${stats.bad} unreadable line(s) skipped` : ''}\n` +
      `${rule}`,
  );
}

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    stopping = true;
    finish('STOPPED');
    process.exit(0);
  });

// Wall-clock anchor for pacing: the first frame published becomes "now", and
// every later frame waits out the gap the hub originally saw between them.
let wallStart = 0;
let frameStart = 0;

for await (const frame of readFrames(files, {
  topic,
  since,
  until,
  onBadLine: () => stats.bad++,
  onFileError: (path, e) => console.error(`superlog-replay: ${path}: ${e.message}`),
})) {
  if (stopping) break;
  if (speed > 0) {
    if (wallStart === 0) {
      wallStart = Date.now();
      frameStart = frame.ts_ms;
    }
    const due = wallStart + (frame.ts_ms - frameStart) / speed;
    let wait = due - Date.now();
    // A journal that ran overnight has hours of silence in it. Waiting them
    // out faithfully would be useless, so long gaps collapse and the banner
    // says so rather than the tool quietly lying about the pace.
    if (maxGapMs > 0 && wait > maxGapMs) {
      wallStart -= wait - maxGapMs;
      wait = maxGapMs;
    }
    if (wait > 0) await sleep(wait);
  }

  const events = frame.payload.split('\n').filter((l) => l.trim()).length;
  stats.frames++;
  stats.events += events;
  await publish(prefix + frame.topic, frame.payload);

  if (Date.now() - lastReport >= 2000) {
    lastReport = Date.now();
    console.error(
      `REPLAY: ${stats.frames} frames, ${stats.events} events, ` +
        `now at ${new Date(frame.ts_ms).toISOString().slice(11, 19)}Z` +
        `${stats.failed ? ` (${stats.failed} failed)` : ''}`,
    );
  }
}

if (!stopping) finish('FINISHED');
process.exitCode = stats.failed > 0 ? 1 : 0;
