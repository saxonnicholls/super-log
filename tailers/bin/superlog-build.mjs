#!/usr/bin/env node
//
//  superlog-build - wrap a build, put it on the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
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
//  It is worth wrapping a TEST RUN too, not only a build: AddressSanitizer,
//  ThreadSanitizer, UBSan and valgrind all report at run time, and each of
//  their findings is one bug spread over thirty to ninety lines. Those are
//  captured whole into a single event at the level the tool itself assigned:
//
//    superlog-build --label asan -- ./build/tests
//    superlog-build --label memcheck -- valgrind --leak-check=full ./app
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
Sanitizer and valgrind findings are captured whole, one event each.
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
  // UBSan:                main.cpp:5:10: runtime error: signed integer overflow
  // It reports one line per finding and keeps going, so unlike the other
  // sanitizers there is no block to capture - but "runtime error" is not
  // one of the severities the clang pattern above knows, so without this it
  // lands as INFO.
  { rx: /^(.+?):(\d+):(?:(\d+):)?\s+runtime error:\s*(.*)$/,
    map: (m) => ({ src: `${m[1]}:${m[2]}`, sev: 'error', msg: m[4] }) },
  // Vivado:     ERROR: [Synth 8-1031] mem_ctrl is not declared [/rtl/mem.v:42]
  // Xilinx puts the severity first and the source last, in brackets, so
  // neither the clang pattern nor the rustc one sees it. Untreated, a run
  // that failed synthesis AND missed timing closed with "build succeeded,
  // 0 errors" - which is the failure this whole wrapper exists to prevent.
  // CRITICAL WARNING is Xilinx's name for "not fatal but your design is
  // wrong", and timing failure arrives under it, so it is levelled as an
  // error rather than a warning.
  { rx: /^(INFO|WARNING|CRITICAL WARNING|ERROR):\s*\[([\w-]+ [\d-]+)\]\s*(.*?)\s*(?:\[([^\]\s]+):(\d+)\])?$/,
    map: (m) => ({ src: m[4] ? `${m[4]}:${m[5]}` : undefined,
                   sev: m[1] === 'CRITICAL WARNING' ? 'error'
                      : m[1] === 'ERROR' ? 'error'
                      : m[1] === 'WARNING' ? 'warning' : 'info',
                   msg: `${m[2]} ${m[3]}` }) },
  // Quartus:    Error (10170): Verilog HDL syntax error at fsm.sv(31)
  { rx: /^(Info|Extra Info|Warning|Critical Warning|Error)\s*\((\d+)\):\s*(.*)$/,
    map: (m) => {
      const at = /\bat ([\w./-]+)\((\d+)\)/.exec(m[3]);
      return { src: at ? `${at[1]}:${at[2]}` : undefined,
               sev: /Error/.test(m[1]) ? 'error'
                  : m[1] === 'Critical Warning' ? 'error'
                  : m[1] === 'Warning' ? 'warning' : 'info',
               msg: m[3] };
    } },
  // Yosys / nextpnr / GHDL keep it lowercase and unadorned.
  { rx: /^(?:yosys|nextpnr[\w-]*|ghdl)?\s*(ERROR|Warning|WARNING):\s*(.*)$/,
    map: (m) => ({ sev: /ERROR/i.test(m[1]) ? 'error' : 'warning', msg: m[2] }) },
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
  // xcodebuild/swiftpm:   ** BUILD FAILED **        (the verdict, not a
  // diagnostic - xcodebuild can print it after a wall of INFO progress)
  { rx: /^\*\* (?:BUILD|TEST|ARCHIVE|CLEAN)[A-Z ]* (FAILED|SUCCEEDED) \*\*/,
    map: (m) => ({ sev: m[1] === 'FAILED' ? 'error' : 'ok', msg: '' }) },
  { rx: /^(?:The following build commands failed:|Undefined symbols for architecture)/,
    map: () => ({ sev: 'error', msg: '' }) },
  // XCTest:               Test Case '-[FooTests testBar]' failed (0.003 s)
  { rx: /^Test Case .+? (failed|passed)\b/,
    map: (m) => ({ sev: m[1] === 'failed' ? 'error' : 'ok', msg: '' }) },
  // swift runtime:        Fatal error: Unexpectedly found nil ...
  { rx: /^(?:Fatal error|Swift runtime failure):/,
    map: () => ({ sev: 'fatal error', msg: '' }) },
];

// Modern compilers quote the offending source under each diagnostic - Swift
// and GCC with a numbered gutter, rustc with arrows and notes, clang with a
// caret. Those lines are not events: publishing them as siblings turns one
// Swift error into six rows and buries the diagnostic that matters. They are
// folded into the preceding diagnostic as a `snippet` field instead, which
// the viewers collapse to one line and expand on demand.
const CONTINUATION = [
  /^\s*\d+\s*\|/,              // swift/gcc:  3 | let s: Int = "nope"
  /^\s*\|/,                    // swift/gcc/rustc gutter and caret rows
  /^\s*-->\s/,                 // rustc:      --> src/main.rs:4:18
  /^\s*=\s+(?:note|help):/,    // rustc:      = note: expected type `i32`
  /^\s*[\^~]+[\s\^~]*$/,       // clang:            ^~~~~
  /^\[#[A-Za-z0-9]+\]:\s*</,   // swift:      [#DeprecatedDeclaration]: <https://…>
];
const isContinuation = (line) => CONTINUATION.some((rx) => rx.test(line));

// Deep enough to show the offending expression in context, short enough that
// a build with a thousand warnings does not become the payload problem.
const SNIPPET_LINES = 24;
const SNIPPET_CHARS = 4000;

// ------------------------------------------------------------- sanitizers
//
// A sanitizer or valgrind finding is one bug reported across thirty to
// ninety lines - two stack traces, an allocation site, sometimes a shadow
// byte dump. Line-at-a-time that is thirty INFO events with the finding
// somewhere inside; whichever line happened to match a compiler pattern
// becomes the only one with a level, which is worse than useless because it
// is arbitrary. So a report is captured whole into one event, at the level
// the tool itself assigned, with the full text as a `report` field.
//
// This is also why the wrapper is worth using on a *test run* and not only
// a build: `superlog-build -- ./tests` under ASAN_OPTIONS is where these
// actually appear.

const REPORT_START = [
  // ==1234==ERROR: AddressSanitizer: heap-use-after-free on address 0x...
  { rx: /^==\d+==\s*ERROR:\s*(\w*Sanitizer):\s*(.*)$/,
    level: 'CRITICAL', tool: (m) => m[1], msg: (m) => `${m[1]}: ${m[2]}` },
  // ThreadSanitizer announces itself without the pid prefix
  { rx: /^(?:==\d+==)?\s*WARNING:\s*(ThreadSanitizer|MemorySanitizer):\s*(.*)$/,
    level: 'ERROR', tool: (m) => m[1], msg: (m) => `${m[1]}: ${m[2]}` },
  // LeakSanitizer's own header, which arrives after a clean-looking run
  { rx: /^==\d+==\s*ERROR:\s*(LeakSanitizer):\s*(.*)$/,
    level: 'ERROR', tool: (m) => m[1], msg: (m) => `${m[1]}: ${m[2]}` },
  // valgrind: ==1234== Invalid read of size 4
  { rx: /^==\d+==\s+(Invalid (?:read|write|free|memory access)[^\n]*|Mismatched free[^\n]*|Use of uninitialised[^\n]*|Conditional jump[^\n]*|Syscall param[^\n]*)$/,
    level: 'ERROR', tool: () => 'valgrind', msg: (m) => `valgrind: ${m[1]}` },
  // valgrind leaks: ==1234==    4 bytes in 1 blocks are definitely lost in ...
  { rx: /^==\d+==\s+([\d,]+ bytes in [\d,]+ blocks are (?:definitely|indirectly|possibly) lost[^\n]*)$/,
    level: 'ERROR', tool: () => 'valgrind', msg: (m) => `valgrind: ${m[1]}` },
  // valgrind's tallies. INFO, not ERROR: they restate findings that have
  // already been reported at their own level, and counting them again would
  // make the closing verdict claim more errors than the run actually found.
  // Captured as blocks all the same, because six lines of accounting is one
  // fact.
  { rx: /^==\d+==\s+((?:HEAP|LEAK) SUMMARY:.*)$/,
    level: 'INFO', tool: () => 'valgrind', msg: (m) => `valgrind: ${m[1]}` },
];

// The rule a sanitizer draws above its report. On its own it carries
// nothing, and as an event it is a row of equals signs with a level.
const RULE = /^[=-]{10,}$/;

// Everything else valgrind says about itself - its banner, copyright, the
// command line, "rerun with -v". Worth keeping, not worth a level.
const VALGRIND_CHATTER = /^==\d+==(\s|$)/;

// A report ends at its tool's own terminator. Valgrind separates findings
// with a bare `==pid==` line; the LLVM sanitizers use a rule of `=` or an
// explicit ABORTING.
const REPORT_END = {
  valgrind: (l) => /^==\d+==\s*$/.test(l),
  default: (l) => /^={10,}$/.test(l) || /^==\d+==\s*ABORTING/.test(l),
};

// Stack traces are the point, so this cap is much higher than a compiler
// snippet's - but a shadow-byte dump still must not run away with the feed.
const REPORT_LINES = 120;
const REPORT_CHARS = 20000;

// SUMMARY: AddressSanitizer: heap-use-after-free /src/main.cpp:10:3 in main
const SUMMARY_SRC = /^SUMMARY:\s*\w+:\s*\S+\s+([^\s:]+):(\d+)(?::\d+)?/;
// valgrind:  ==1234==    at 0x4005D6: main (main.c:10)
const VALGRIND_SRC = /^==\d+==\s+(?:at|by)\s+0x[0-9A-Fa-f]+:\s+\S+\s+\(([^:)]+):(\d+)\)/;

function reportStart(line) {
  for (const r of REPORT_START) {
    const m = r.rx.exec(line);
    if (m) return { level: r.level, tool: r.tool(m), msg: r.msg(m) };
  }
  return null;
}

const LEVEL = { 'fatal error': 'CRITICAL', error: 'ERROR', Error: 'ERROR',
                warning: 'WARN', Warning: 'WARN', note: 'DEBUG' };

function classify(line) {
  for (const p of PATTERNS) {
    const m = p.rx.exec(line);
    if (!m) continue;
    const got = p.map(m);
    return { level: LEVEL[got.sev] ?? 'INFO', src: got.src, msg: line, matched: true };
  }
  return { level: 'INFO', msg: line, matched: false };
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;
const counts = { CRITICAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };

// The most recent diagnostic, held open so the snippet lines that follow it
// can be folded in. Nothing is lost by waiting: settle() runs before every
// flush and at close, so the last event still leaves even if the compiler
// ends mid-snippet.
let pending = null;

// force=false is the periodic flush, which must NOT settle a report that is
// still arriving: over ssh a sanitizer report spans seconds, so the timer
// fires mid-report, the event is sealed, and every remaining line is dropped
// on the floor. Locally the whole report lands inside one tick, which is
// exactly why this only showed up against a remote build.
function settle(force = false) {
  if (!pending || (capturing && !force)) return;
  buf.push(JSON.stringify(pending));
  pending = null;
  if (buf.length >= 256) void flush();
}

// Returns false when there was no diagnostic to attach to, so the caller can
// fall back to publishing the line normally rather than dropping it.
function appendSnippet(line, key = 'snippet', maxLines = SNIPPET_LINES, maxChars = SNIPPET_CHARS) {
  if (!pending) return false;
  const f = (pending.fields ??= {});
  const have = f[key] ? f[key].split('\n') : [];
  if (have.length >= maxLines || (f[key]?.length ?? 0) >= maxChars) return true;
  f[key] = [...have, line].join('\n');
  return true;
}

// Non-null while a sanitizer or valgrind report is being read: { tool, lines }.
let capturing = null;

// Everything between a report's first line and its terminator belongs to
// that one finding, whatever it happens to look like - a stack frame can
// resemble anything, so content-matching mid-report would split the finding
// back into the pieces this exists to join.
function captureReport(line) {
  const done = (REPORT_END[capturing.tool] ?? REPORT_END.default)(line);
  capturing.lines += 1;
  if (!done) {
    appendSnippet(line, 'report', REPORT_LINES, REPORT_CHARS);
    const s = SUMMARY_SRC.exec(line) ?? VALGRIND_SRC.exec(line);
    // The tool names the offending line itself; taking it is more reliable
    // than picking a frame out of the stack, where the top frame is often
    // inside the allocator rather than in anyone's code.
    if (s && pending && !pending.src) pending.src = `${s[1]}:${s[2]}`;
  }
  if (done || capturing.lines >= REPORT_LINES) capturing = null;
}

function publish(level, msg, fields) {
  // A new event beginning means whatever was in flight is finished, so this
  // settles even mid-capture - which is how the closing verdict seals a
  // report whose terminator the tool never printed.
  settle(true);
  capturing = null;
  counts[level] = (counts[level] ?? 0) + 1;
  pending = {
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'build', platform: 'build', device: host },
    tag: label, msg, ...(fields?.src ? { src: fields.src } : {}),
    ...(fields && Object.keys(fields).some((k) => k !== 'src')
      ? { fields: Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'src')) }
      : {}),
  };
}

async function flush() {
  settle();
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
    if (!quiet) (which === 'err' ? process.stderr : process.stdout).write(line + '\n');
    // A report's own blank lines are part of it - and valgrind's terminator
    // IS a near-blank line - so the capture runs before the blank skip.
    if (capturing) { captureReport(line); continue; }
    const rep = reportStart(line);
    if (rep) {
      publish(rep.level, rep.msg.slice(0, 2000), { stream: which, tool: rep.tool });
      capturing = { tool: rep.tool === 'valgrind' ? 'valgrind' : 'default', lines: 0 };
      continue;
    }
    // A bare `==pid==` is valgrind's paragraph break, not a line of output.
    if (!line.trim() || RULE.test(line) || /^==\d+==\s*$/.test(line)) continue;
    // stderr is where compilers put diagnostics, but plenty of tools log
    // progress there too - so classify by content, not by stream.
    if (isContinuation(line) && appendSnippet(line)) continue;
    const c = classify(line);
    const level = !c.matched && VALGRIND_CHATTER.test(line) ? 'DEBUG' : c.level;
    publish(level, c.msg.slice(0, 2000), { src: c.src, stream: which });
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
