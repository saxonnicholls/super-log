#!/usr/bin/env node
//
//  superlog-tee - tee(1), with the bench as one of the outputs.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Anything that prints can be on the bench without being taught to log:
//
//    make 2>&1 | superlog-tee --topic build.local
//    ./deploy.sh 2>&1 | superlog-tee --topic deploy --classify
//    tail -f /var/log/app.log | superlog-tee --topic app.legacy
//    pytest -v 2>&1 | superlog-tee --topic tests out.txt   # and a file, like tee
//
//  It is a drop-in for tee: stdin goes to stdout byte for byte, and to any
//  files named on the command line, exactly as tee would. The hub is simply
//  one more output. That matters because it means it can be dropped into an
//  existing pipeline without changing what the pipeline does - if it altered
//  the stream, or swallowed it, nobody would leave it in.
//
//    -a, --append     append to the files rather than truncating (as tee -a)
//    --level LEVEL    level for every line (default INFO)
//    --classify       read the level from the line instead: lines that look
//                     like errors become ERROR, warnings WARN. Off by
//                     default, because "error" appears in plenty of prose
//                     and a false ERROR is worse than a missing one.
//    --quiet          do not write to stdout (the one un-tee-like option,
//                     for when the terminal copy is just noise)
//
//  Publishes to whatever --topic says, defaulting to tee.<host>.
//
//  Node >= 18.
//

import { createWriteStream } from 'node:fs';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const argv = process.argv.slice(2);
const flagsWithValues = new Set(['--topic', '--level', '--url', '--app', '--trace']);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.error(`superlog-tee - tee(1) with the hub as an extra output

  <command> | superlog-tee [--topic NAME] [--level LEVEL] [--classify]
                           [--app NAME] [--trace ID] [-a] [--quiet] [FILE...]

  make 2>&1 | superlog-tee --topic build.local
  ./deploy.sh 2>&1 | superlog-tee --topic deploy --classify out.log

stdin is copied to stdout unchanged and to any FILEs, exactly as tee does;
each line is also published to the hub.`);
  process.exit(0);
}

// Anything not a flag and not a flag's value is a file, as tee takes them.
const files = argv.filter((a, i) => {
  if (a.startsWith('-')) return false;
  const prev = argv[i - 1];
  return !(prev && flagsWithValues.has(prev));
});

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const append = argv.includes('-a') || argv.includes('--append');
const quiet = argv.includes('--quiet');
const classify = argv.includes('--classify');
const trace = opt('trace', '');
const sanitize = (s) => s.split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const host = sanitize(hostname());
const topic = opt('topic', `tee.${host}`);
const app = opt('app', 'tee');

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
const fixedLevel = (opt('level', 'INFO') || 'INFO').toUpperCase();
if (!LEVELS.includes(fixedLevel)) {
  console.error(`superlog-tee: unknown level '${fixedLevel}' (${LEVELS.join(' ')})`);
  process.exit(2);
}

// Deliberately narrow. These only run under --classify, and they anchor on
// the shapes tools actually emit rather than on the word appearing anywhere
// - "0 errors" and "error handling" must not become ERROR events.
const ERROR_RX = /(^|\s)(error|traceback|exception|failed|failure)\b(?!\s*[:=]?\s*0\b)/i;
const WARN_RX = /(^|\s)(warn|warning|deprecated)\b/i;
// Fatal is not the same as error and should survive a filter that error does
// not: a run that aborted is a different fact from a run that logged a
// problem and carried on.
const FATAL_RX = /(^|\s)(fatal|panic|abort(?:ed|ing)?)\b/i;
// Verification frameworks glue the severity to their own prefix, so the word
// boundary that finds "error" in prose does not find it in UVM_ERROR -
// underscore is a word character. A testbench reporting a mismatch is the
// most important line in the run, and it was landing as INFO.
const TAGGED_RX = /\b(?:UVM|OVM|VMM)_(FATAL|ERROR|WARNING)\b/i;
const levelFor = (line) => {
  if (!classify) return fixedLevel;
  const tagged = TAGGED_RX.exec(line);
  if (tagged) {
    const k = tagged[1].toUpperCase();
    return k === 'FATAL' ? 'CRITICAL' : k === 'ERROR' ? 'ERROR' : 'WARN';
  }
  if (FATAL_RX.test(line)) return 'CRITICAL';
  if (ERROR_RX.test(line)) return 'ERROR';
  if (WARN_RX.test(line)) return 'WARN';
  return fixedLevel;
};

// ------------------------------------------------------------------ sinks

const sinks = files.map((f) => {
  const s = createWriteStream(f, { flags: append ? 'a' : 'w' });
  s.on('error', (e) => console.error(`superlog-tee: ${f}: ${e.message}`));
  return s;
});

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;
let dropped = 0;
let pendingPost = Promise.resolve();

// Bounded, drop-oldest, counted - the same bargain every SDK here makes. A
// tee that grows without limit while the hub is down would take the build
// down with it, which is precisely the failure this must never cause.
const MAX_QUEUE = 4096;

function record(line) {
  if (buf.length >= MAX_QUEUE) { buf.shift(); dropped += 1; }
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session,
    level: levelFor(line),
    origin: { runtime: 'node', app, platform: 'tee', device: host },
    tag: 'tee', msg: line.slice(0, 4000),
    ...(trace ? { trace } : {}),
  }));
  if (buf.length >= 256) void flush();
}

function flush() {
  if (!buf.length) return pendingPost;
  const body = buf.join('\n');
  buf = [];
  // Chained rather than fired and forgotten, so the final flush on exit can
  // be waited for - otherwise the last lines of a build, which are the ones
  // that say whether it worked, are exactly the ones that never arrive.
  pendingPost = pendingPost.then(() =>
    fetch(`${hubUrl}/ingest/${topic}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    }).catch(() => { dropped += body.split('\n').length; }));
  return pendingPost;
}
const timer = setInterval(() => void flush(), 250);
timer.unref?.();

// ------------------------------------------------------------------- pump

let carry = '';

process.stdin.on('data', (chunk) => {
  // Pass through FIRST and unchanged. Whatever this tool does afterwards,
  // the pipeline it was dropped into must behave as though it were tee.
  if (!quiet) {
    try { process.stdout.write(chunk); } catch { /* downstream closed */ }
  }
  for (const s of sinks) s.write(chunk);

  const text = carry + chunk.toString();
  const lines = text.split('\n');
  carry = lines.pop() ?? '';        // an unterminated tail is not a line yet
  for (const line of lines) if (line.trim()) record(line);
});

// A downstream `head` closing the pipe is normal, not an error.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
});

async function done(code) {
  if (carry.trim()) record(carry);
  clearInterval(timer);
  await flush();
  await pendingPost;
  if (dropped) console.error(`superlog-tee: ${dropped} line(s) not delivered`);
  for (const s of sinks) s.end();
  process.exit(code);
}

process.stdin.on('end', () => void done(0));
process.on('SIGINT', () => void done(130));
process.on('SIGTERM', () => void done(143));
