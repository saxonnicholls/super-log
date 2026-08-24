#!/usr/bin/env node
//
//  superlog-build - wrap a build, put it on the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Builds are the thing you run twenty times a day and read once, badly:
//  a wall of output where the one line that matters scrolled past. This
//  wraps any build command - cmake, make, clang, gcc, cargo, npm, gradle,
//  xcodebuild - and publishes it as structured events, so the failure is a
//  filtered row rather than a search through a terminal.
//
//    superlog-build -- cmake --build build -j
//    superlog-build --label ios -- xcodebuild -scheme App
//    superlog-build --ssh web1 -- 'cd /srv/app && cargo build --release'
//
//  Publishes to build.<host>.<label>. What it adds over piping to a file:
//
//    - Compiler diagnostics become WARN and ERROR events with file and
//      line in `src`, so the viewer's level filter finds them instantly
//      and the ERROR count IS the thing you wanted to know.
//    - The exit status and the wall-clock duration are one event, so "when
//      did this start taking four minutes" is answerable later.
//    - Remote builds look exactly like local ones. A build on a Hetzner
//      box lands beside the app logs from the same box.
//
//  Everything unrecognised still ships at INFO - the tolerant-reader rule
//  applies to compilers too, and a build system this does not know about
//  is still worth having on the screen.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { loadEnv } from './env.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flags = sep >= 0 ? argv.slice(0, sep) : argv;
const command = sep >= 0 ? argv.slice(sep + 1) : [];

const opt = (name, dflt) => {
  const i = flags.indexOf(`--${name}`);
  return i >= 0 && flags[i + 1] !== undefined ? flags[i + 1] : dflt;
};

if (!command.length || flags.includes('--help') || flags.includes('-h')) {
  console.error(`superlog-build - run a build, publish it as events

  superlog-build [--label NAME] [--ssh DEST] [--url HUB] [--quiet] -- <command...>

  superlog-build -- cmake --build build -j
  superlog-build --ssh web1 -- 'cd /srv/app && cargo build --release'

Publishes to build.<host>.<label>. Compiler warnings and errors become WARN
and ERROR events with file:line; the exit status and duration are one event.
Output is still printed locally unless --quiet.`);
  process.exit(command.length ? 0 : 2);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const dest = opt('ssh');
const quiet = flags.includes('--quiet');
const sanitize = (s) => s.split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const host = dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest) : sanitize(hostname());
// The label defaults to the tool being run, which is almost always the
// right name: cmake, cargo, npm, xcodebuild.
const label = sanitize(opt('label', command[0].split('/').pop() ?? 'build'));
const topic = opt('topic', `build.${host}.${label}`);

// ------------------------------------------------------------- diagnostics
//
// Every compiler says the same three things in its own punctuation. These
// patterns pull out file, line and severity; anything unmatched is INFO,
// which keeps an unknown toolchain useful rather than invisible.

const PATTERNS = [
  // clang/gcc:            src/main.cpp:42:17: error: no member named 'x'
  { rx: /^(.+?):(\d+):(?:(\d+):)?\s+(fatal error|error|warning|note):\s*(.*)$/,
    map: (m) => ({ src: `${m[1]}:${m[2]}`, sev: m[4], msg: m[5] }) },
  // rustc:                error[E0308]: mismatched types
  { rx: /^(error|warning)(\[[A-Z0-9]+\])?:\s+(.*)$/,
    map: (m) => ({ sev: m[1], msg: `${m[2] ?? ''}${m[2] ? ' ' : ''}${m[3]}` }) },
  // MSBuild/xcodebuild:   /path/File.swift:12:5: error: ...  (caught above)
  // cmake:                CMake Error at CMakeLists.txt:14 (message):
  { rx: /^CMake (Error|Warning)(?: at (.+?):(\d+))?/,
    map: (m) => ({ src: m[2] ? `${m[2]}:${m[3]}` : undefined, sev: m[1], msg: 'cmake: ' }) },
  // make:                 make: *** [target] Error 2
  { rx: /^(?:g?make(?:\[\d+\])?): \*\*\* (.*)$/,
    map: (m) => ({ sev: 'error', msg: `make: ${m[1]}` }) },
  // npm/node:             npm ERR! code ELIFECYCLE
  { rx: /^npm (ERR!|WARN)\s+(.*)$/,
    map: (m) => ({ sev: m[1] === 'ERR!' ? 'error' : 'warning', msg: `npm: ${m[2]}` }) },
  // ld:                   ld: symbol(s) not found for architecture arm64
  { rx: /^(?:ld|lld|link\.exe): (?:(error|warning): )?(.*)$/,
    map: (m) => ({ sev: m[1] ?? 'error', msg: `ld: ${m[2]}` }) },
];

const LEVEL = { 'fatal error': 'CRITICAL', error: 'ERROR', Error: 'ERROR',
                warning: 'WARN', Warning: 'WARN', note: 'DEBUG' };

function classify(line) {
  for (const p of PATTERNS) {
    const m = p.rx.exec(line);
    if (!m) continue;
    const got = p.map(m);
    return { level: LEVEL[got.sev] ?? 'INFO', src: got.src, msg: line };
  }
  return { level: 'INFO', msg: line };
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;
const counts = { CRITICAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };

function publish(level, msg, fields) {
  counts[level] = (counts[level] ?? 0) + 1;
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'build', platform: 'build', device: host },
    tag: label, msg, ...(fields?.src ? { src: fields.src } : {}),
    ...(fields && Object.keys(fields).some((k) => k !== 'src')
      ? { fields: Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'src')) }
      : {}),
  }));
  if (buf.length >= 256) void flush();
}

async function flush() {
  if (!buf.length) return;
  const body = buf.join('\n');
  buf = [];
  try {
    await fetch(`${hubUrl}/ingest/${topic}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch {
    /* the build matters more than the log of it */
  }
}
const timer = setInterval(() => void flush(), 250);
timer.unref?.();

// ------------------------------------------------------------------- run

const started = Date.now();
const shown = dest ? `${command.join(' ')} (on ${dest})` : command.join(' ');
publish('INFO', `build started: ${shown}`, { command: command.join(' '), where: dest ?? 'local' });
console.error(`superlog-build: ${shown} -> ${topic}`);

const child = dest
  ? spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T',
                  ...(opt('identity') ? ['-i', opt('identity')] : []),
                  dest, command.join(' ')],
          { stdio: ['inherit', 'pipe', 'pipe'] })
  : spawn(command[0], command.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });

let carry = { out: '', err: '' };
const feed = (which, chunk) => {
  const text = carry[which] + chunk.toString();
  const lines = text.split('\n');
  carry[which] = lines.pop() ?? '';           // an unterminated tail is not a line yet
  for (const line of lines) {
    if (!line.trim()) continue;
    // stderr is where compilers put diagnostics, but plenty of tools log
    // progress there too - so classify by content, not by stream.
    const c = classify(line);
    publish(c.level, c.msg.slice(0, 2000), { src: c.src, stream: which });
    if (!quiet) (which === 'err' ? process.stderr : process.stdout).write(line + '\n');
  }
};
child.stdout.on('data', (d) => feed('out', d));
child.stderr.on('data', (d) => feed('err', d));

child.on('error', async (e) => {
  publish('CRITICAL', `cannot run build: ${e.message}`, { error: String(e.message) });
  await flush();
  process.exit(127);
});

child.on('close', async (code) => {
  for (const w of ['out', 'err']) if (carry[w].trim()) feed(w, '\n');
  const ms = Date.now() - started;
  const ok = code === 0;
  const errors = counts.ERROR + counts.CRITICAL;
  // A zero exit with errors in the output is worth its own verdict rather
  // than a bald "succeeded": it usually means a `;` where `&&` was meant,
  // a `make -k`, or a wrapper swallowing the status - and a build that
  // reports errors and calls itself fine is how a broken artefact ships.
  const suspect = ok && errors > 0;
  const verdict = !ok ? `FAILED (exit ${code})`
    : suspect ? `exited 0 DESPITE ${errors} error(s) - check the command's exit status`
    : 'succeeded';
  publish(!ok ? 'ERROR' : suspect ? 'WARN' : 'INFO',
          `build ${verdict} in ${(ms / 1000).toFixed(1)}s` +
          ` - ${errors} error(s), ${counts.WARN} warning(s)`,
          { command: command.join(' '), where: dest ?? 'local', exit: String(code),
            ms: String(ms), errors: String(errors),
            warnings: String(counts.WARN),
            result: !ok ? 'failure' : suspect ? 'suspect' : 'success' });
  clearInterval(timer);
  await flush();
  // The wrapper must be transparent: same exit status, so it can sit inside
  // a Makefile or CI step without changing what they conclude.
  process.exit(code ?? 1);
});
