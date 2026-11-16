#!/usr/bin/env node
//
//  superlog-cuda - a CUDA program's faults, device output and kernel timings.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A CUDA kernel fails on another timeline from the host. The launch returns
//  success, the host runs on, and the real verdict - an illegal address, a
//  launch that never completed - only arrives later, at the synchronise, far
//  from the line that caused it. By then the stderr says
//  "an illegal memory access was encountered" with no hint of which kernel,
//  and the hardest failures wear no CUDA error at all: a host-side segfault
//  that compute-sanitizer waves through with "0 errors". This wraps or tails
//  the program, reads what it, the driver, compute-sanitizer and nsys already
//  print, and turns each failure into one edge-triggered event - telling a
//  device fault apart from a host crash, and lifting nsys's kernel table into
//  metrics you can line up run against run.
//
//  It links no CUDA and installs nothing; it drives tools that are already
//  there. The card is usually not on this machine, so it reaches one over ssh.
//
//    superlog-cuda -- ./tests                         # run it, watch its output
//    superlog-cuda --ssh hetzner_gpu -- ./tests       # run it where the card is
//    superlog-cuda --ssh hetzner_gpu --sanitizer -- ./tests
//    superlog-cuda --ssh hetzner_gpu --nsys -- ./bench # profile -> kernel metrics
//    superlog-cuda --ssh hetzner_gpu --gdb -- ./tests  # backtrace a host crash
//    ./tests 2>&1 | superlog-cuda                      # or just tail a stream
//    superlog-cuda --file run.log --follow
//
//  Publishes to cuda.<app>. Kernel timings are DEBUG `metric` events
//  (cuda.kernel_ms, cuda.kernel_pct, ...), always charted and out of a default
//  INFO view. A fault is edge-triggered - ERROR for a device fault, a signal
//  death or a toolchain/NVRTC error; WARN for the recoverable ones - said once,
//  with recovery announced when the next run comes back clean.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { loadEnv } from './env.mjs';

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const ours = dashdash < 0 ? argv : argv.slice(0, dashdash);
const command = dashdash < 0 ? [] : argv.slice(dashdash + 1);

const opt = (name, dflt) => {
  const i = ours.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = ours[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};
const has = (name) => ours.includes(`--${name}`);
const optEq = (name, dflt) => {
  const hit = ours.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : dflt;
};

if (has('help') || ours.includes('-h')) {
  console.error(`superlog-cuda - CUDA faults, device output and kernel timings

  superlog-cuda [--ssh DEST] -- <command...>   run a CUDA program, watch output
  <command> 2>&1 | superlog-cuda               or tail a merged stream on stdin
  superlog-cuda --file LOG [--follow]           or read / follow a logfile

  --ssh DEST          run the command on DEST (ssh alias) - the card is rarely here
  --sanitizer[=TOOL]  run under compute-sanitizer (memcheck racecheck synccheck initcheck)
  --nsys              profile the run, publish nsys's kernel table as metrics
  --gdb               on a host-side crash, capture a gdb backtrace (re-runs the program)
  --cuda-bin DIR      where compute-sanitizer/nsys/ncu live (default /usr/local/cuda/bin)
  --app NAME          publish to cuda.<NAME> (default: the command's basename)
  --url HUB           hub ingest base (default $SUPER_LOG_URL or 127.0.0.1:7333)
  --kernel-regex RE   JS regex, named groups <name> and <ms>|<us>, for inline timing lines
  --quiet-output      do not forward ordinary program output as DEBUG
  --identity KEY --ssh-port N    passed to ssh
  --topic TOPIC       override the full topic (default cuda.<app>)

Device faults, signal deaths, toolchain and NVRTC errors are edge-triggered
ERROR; recoverable ones WARN; kernel timings and benchmark lines DEBUG. Reads
what the program, the CUDA driver, compute-sanitizer and nsys already print -
it links no CUDA and installs nothing. With no CUDA present it stays silent
rather than report absence as zero.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const quietOutput = has('quiet-output');
const file = opt('file');
const follow = has('follow') || ours.includes('-f');
const sanitizerTool = optEq('sanitizer', 'memcheck');
const useNsys = has('nsys');
const useGdb = has('gdb');
const cudaBin = opt('cuda-bin', env.SUPER_LOG_CUDA_BIN ?? '/usr/local/cuda/bin');
const dest = opt('ssh');

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
const appName = sanitize(
  opt('app') ?? (command.length ? basename(command[0]) : file ? basename(file) : 'app'));
const host = dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest)
                  : sanitize(hostname().split('.')[0]);
const topic = opt('topic', `cuda.${appName}`);
const platform = dest ? 'linux'
  : ({ darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform] ?? process.platform);

// ------------------------------------------------------------- publishing
//
// Same wire shape and batching as the other tailers: NDJSON POSTed to
// /ingest/<topic>. A fault flushes at once; ordinary lines ride a short timer
// so a chatty kernel is one POST, not a thousand. POSTs are chained so the
// process can await the last one before it exits - a short run that fails must
// not die before the hub hears why.

const session = Math.random().toString(16).slice(2, 10);
let seq = 0;
let buf = [];
let flushTimer = null;
let inflight = Promise.resolve();

function publish(level, msg, fields, metric) {
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'cuda', app: appName, platform, device: host },
    tag: 'cuda', msg: String(msg).slice(0, 2000),
    ...(fields ? { fields: Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')) } : {}),
    ...(metric ? { metric } : {}),
  }));
  if (level === 'ERROR' || level === 'WARN') drain();
  else if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; drain(); }, 400);
}

async function flushOnce() {
  if (!buf.length) return;
  const body = buf.join('\n');
  buf = [];
  try {
    await fetch(`${hubUrl}/ingest/${topic}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch { /* hub down; the next batch counts again */ }
}

function drain() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  inflight = inflight.then(flushOnce).catch(() => {});
  return inflight;
}

function metric(name, value, fields) {
  if (!Number.isFinite(value)) return;
  publish('DEBUG', `${name} ${value}`, fields, { name, value });
}

// --------------------------------------------------------------- fault state
//
// Edge-triggered, like every watcher here: a fault is announced once, and a
// clean next run announces recovery. A program stuck in a fault loop is one
// ERROR, not one per iteration. `faulted` is the device/program fault; host
// crashes and sanitizer findings fold into it so the recovery is honest.

let faulted = false;
let faults = 0;
let sanitizerRan = false;
let sanitizerErrors = null;      // null until a summary line is seen
let hostAbortSinceSummary = false;

function emitFault(level, msg, fields) {
  if (!faulted) publish(level, msg, { ...fields, change: 'fault', count: String(faults + 1) });
  faults += 1;
  faulted = true;
}
function emitRecovery(why) {
  if (faulted) {
    publish('INFO', `cuda ${appName}: clear - ${why}`, { change: 'recovered', after_faults: String(faults) });
    faulted = false;
  }
}
// A non-sticky emit at a given level: it never arms the fault/recovery edge, so
// it can neither mute nor be muted by a device fault, and the same line in a
// loop is said once. WARN recoverables and gtest results both ride this.
let lastNote = '';
function note(level, msg, fields) {
  if (msg === lastNote) return;
  lastNote = msg;
  publish(level, msg, fields);
}
function warn(msg, fields) { note('WARN', msg, { ...fields, change: 'warn' }); }

// --------------------------------------------------------------- parsing
//
// CUDA's failures are a small, stable vocabulary. These are the exact shapes
// seen debugging snicholls-gpu (NVRTC at runtime, cuBLAS, no .cu build): the
// driver/runtime strings, the NVRTC compiler's nvcc-format errors, the
// toolchain mismatch caught at kernel lookup, and the program's own wrapped
// exceptions. Order matters - the specific before the generic.

const CLASSIFIERS = [
  // compute-sanitizer handled separately (prefix ====).

  // Toolchain / driver-older-than-toolkit, caught at kernel lookup not load.
  { re: /unsupported toolchain|was compiled with an unsupported/i, level: 'ERROR',
    say: (m, line) => ({ msg: `toolchain mismatch: ${line.trim()}`,
      fields: { kind: 'toolchain', hint: 'driver older than toolkit - compile to CUBIN for the device sm' } }) },

  // NVRTC compile errors, nvcc's format: file.cu(140): error: ...
  { re: /^(?<file>\S+\.cu)\((?<line>\d+)\):\s*(?:catastrophic )?error:\s*(?<what>.+)$/,
    level: 'ERROR', say: (m) => ({ msg: `NVRTC error ${m.groups.file}(${m.groups.line}): ${m.groups.what}`,
      fields: { kind: 'nvrtc', file: m.groups.file, line: m.groups.line } }) },
  { re: /(?<n>\d+)\s+errors?\s+detected in the compilation/i, level: 'ERROR',
    say: (m) => ({ msg: `NVRTC: ${m.groups.n} error(s) detected in the compilation`,
      fields: { kind: 'nvrtc', errors: m.groups.n } }) },

  // The program's own wrapped exception:
  //   snicholls::gpu: cudaLaunchKernel(attend) [invalid argument] failed with CUDA code 1
  //   snicholls::gpu: cudaMemcpy failed with CUDA code 1
  { re: /(?<call>cuda[A-Za-z]+)(?:\((?<arg>[^)]*)\))?\s*(?:\[(?<reason>[^\]]+)\])?\s*failed with CUDA code\s*(?<code>\d+)/,
    level: (m) => /invalid argument/i.test(m.groups.reason ?? '') && !/memcpy/i.test(m.groups.call) ? 'WARN' : 'ERROR',
    say: (m) => ({ msg: `${m.groups.call}${m.groups.arg ? `(${m.groups.arg})` : ''}` +
      `${m.groups.reason ? ` [${m.groups.reason}]` : ''} failed (CUDA code ${m.groups.code})`,
      fields: { kind: 'api', call: m.groups.call, reason: m.groups.reason, code: m.groups.code } }) },

  // checkCudaErrors / helper_cuda.h: CUDA error at f.cu:12 code=700(cudaErrorIllegalAddress) "call"
  { re: /CUDA error at (?<file>[^\s:]+):(?<line>\d+)\s+code=(?<code>\d+)\((?<name>cuda\w+)\)\s+"(?<call>[^"]*)"/,
    level: 'ERROR', say: (m) => ({ msg: `${m.groups.name} at ${m.groups.file}:${m.groups.line}` +
      `${m.groups.call ? ` in ${m.groups.call}` : ''}`,
      fields: { kind: 'runtime', error: m.groups.name, file: m.groups.file, line: m.groups.line, code: m.groups.code, call: m.groups.call } }) },

  // gpuErrchk: GPUassert: an illegal memory access was encountered f.cu 12
  { re: /GPUassert:\s*(?<what>.+?)\s+(?<file>\S+)\s+(?<line>\d+)\s*$/, level: 'ERROR',
    say: (m) => ({ msg: `GPUassert: ${m.groups.what} (${m.groups.file}:${m.groups.line})`,
      fields: { kind: 'runtime', detail: m.groups.what, file: m.groups.file, line: m.groups.line } }) },

  // Bare driver/runtime message from Thrust or a raw abort.
  { re: /\b(?<what>an illegal memory access was encountered|unspecified launch failure|misaligned address|device-side assert triggered|too many resources requested for launch|invalid device function)\b/i,
    level: 'ERROR', say: (m) => ({ msg: `CUDA fault: ${m.groups.what}`, fields: { kind: 'runtime', detail: m.groups.what } }) },

  // Driver API spelling.
  { re: /\b(?<name>CUDA_ERROR_[A-Z_]+)\b/, level: 'ERROR',
    say: (m) => ({ msg: `driver: ${m.groups.name}`, fields: { kind: 'driver', error: m.groups.name } }) },

  // Recoverable / benchmark-level WARNs.
  { re: /fairness check FAILED|\bdiffers\b/i, level: 'WARN', sticky: false,
    say: (m, line) => ({ msg: line.trim(), fields: { kind: 'check' } }) },
  { re: /cudaGetLastError/i, level: 'WARN', sticky: false,
    say: (m, line) => ({ msg: line.trim(), fields: { kind: 'last-error' } }) },
];

const SAN_LINE = /^=+\s*(?<body>.*)$/;
const SAN_SUMMARY = /ERROR SUMMARY:\s*(?<n>\d+)\s+error/i;
const SAN_HOSTABORT = /process didn.?t terminate successfully|Target application returned an error/i;
const STATS_MARK = '@@SLCUDA_STATS@@';

let kernelRe = null;
if (opt('kernel-regex')) {
  try { kernelRe = new RegExp(opt('kernel-regex')); }
  catch (e) { console.error(`superlog-cuda: bad --kernel-regex: ${e.message}`); process.exit(2); }
}

// nsys stats CSV (cuda_gpu_kern_sum): a header with "Time (%)" and "Name",
// then one row per kernel. A kernel name can itself hold commas (templates),
// so fields are split with quotes respected.
let inStats = false;
let statsCols = null;
let statsKernels = 0;
let statsHottest = null;

function csvFields(line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function onStatsLine(text) {
  const f = csvFields(text);
  if (!statsCols) {
    if (f.includes('Name') && f.some((c) => /Time \(%\)/.test(c))) {
      statsCols = {
        pct: f.findIndex((c) => /Time \(%\)/.test(c)),
        total: f.findIndex((c) => /Total Time \(ns\)/.test(c)),
        inst: f.findIndex((c) => /Instances/.test(c)),
        avg: f.findIndex((c) => /Avg \(ns\)/.test(c)),
        name: f.findIndex((c) => c === 'Name'),
      };
    }
    return;
  }
  const name = f[statsCols.name];
  if (!name || name === 'Name') return;
  const num = (i) => (i >= 0 ? Number(String(f[i]).replace(/[^0-9.eE+-]/g, '')) : NaN);
  const k = sanitize(name.replace(/\(.*$/, '')) || 'kernel';   // drop template args for the label
  const avgNs = num(statsCols.avg), totNs = num(statsCols.total);
  const pct = num(statsCols.pct), inst = num(statsCols.inst);
  metric('cuda.kernel_ms', avgNs / 1e6, { kernel: k, full_name: name });
  metric('cuda.kernel_total_ms', totNs / 1e6, { kernel: k });
  metric('cuda.kernel_pct', pct, { kernel: k });
  metric('cuda.kernel_count', inst, { kernel: k });
  statsKernels += 1;
  if (!statsHottest || (Number.isFinite(pct) && pct > statsHottest.pct)) statsHottest = { k, pct };
}

function onLine(raw) {
  const text = raw.replace(/\r$/, '');
  if (!text) return;

  if (text.includes(STATS_MARK)) { inStats = true; return; }
  if (inStats) { onStatsLine(text); return; }

  // compute-sanitizer diagnostics: unambiguous, and they carry the error class
  // and the offending address the bare driver string does not.
  const san = SAN_LINE.exec(text);
  if (san) {
    sanitizerRan = true;
    const body = san.groups.body.trim();
    if (!body) return;
    if (SAN_HOSTABORT.test(body)) { hostAbortSinceSummary = true; publish('DEBUG', body, { tool: 'sanitizer' }); return; }
    const sum = SAN_SUMMARY.exec(body);
    if (sum) {
      sanitizerErrors = Number(sum.groups.n);
      metric('cuda.sanitizer_errors', sanitizerErrors, { tool: sanitizerTool ?? 'memcheck' });
      if (sanitizerErrors > 0)
        emitFault('ERROR', `cuda ${appName}: compute-sanitizer found ${sanitizerErrors} error(s)`,
                  { kind: 'sanitizer', errors: String(sanitizerErrors) });
      else if (hostAbortSinceSummary)
        // 0 device errors but the app aborted: the hard case - a host crash the
        // sanitizer waved through. Say so (the close handler says it too under a
        // signal; edge-triggering keeps it to one ERROR either way).
        emitFault('ERROR', `cuda ${appName}: host-side crash, not a device fault - compute-sanitizer reported 0 errors`,
                  { kind: 'host-crash' });
      else emitRecovery('compute-sanitizer reported 0 errors');
      hostAbortSinceSummary = false;
      return;
    }
    if (/\b(invalid|out of bounds|misaligned|uninitialized|race|hazard|leaked|barrier)\b/i.test(body))
      emitFault('ERROR', `cuda ${appName}: ${body}`, { kind: 'sanitizer', tool: sanitizerTool ?? 'memcheck' });
    else
      publish('DEBUG', body, { tool: 'sanitizer' });
    return;
  }

  for (const c of CLASSIFIERS) {
    const m = c.re.exec(text);
    if (!m) continue;
    const level = typeof c.level === 'function' ? c.level(m) : c.level;
    const { msg, fields } = c.say(m, text);
    // ERROR arms the sticky fault/recovery edge; WARN never does.
    if (level === 'WARN') warn(`cuda ${appName}: ${msg}`, fields);
    else emitFault('ERROR', `cuda ${appName}: ${msg}`, fields);
    return;
  }

  // GoogleTest result lines (these binaries are gtest suites): lift the suite
  // summary above DEBUG, and make a failing case a finding. Non-sticky - a test
  // failure is not a device fault, and must neither arm nor mute that edge.
  if (/^\[\s*PASSED\s*\]/.test(text)) { note('INFO', `cuda ${appName}: ${text.trim()}`, { kind: 'test' }); return; }
  if (/^\[\s*FAILED\s*\]/.test(text)) { note('ERROR', `cuda ${appName}: ${text.trim()}`, { kind: 'test' }); return; }

  // Inline kernel timing (opt-in) -> a DEBUG metric, never a log line.
  if (kernelRe) {
    const k = kernelRe.exec(text);
    if (k && (k.groups?.ms !== undefined || k.groups?.us !== undefined)) {
      const g = k.groups; const name = sanitize(g.name ?? g.name2 ?? appName);
      if (g.ms !== undefined) { metric('cuda.kernel_ms', Number(g.ms), { kernel: name }); return; }
      if (g.us !== undefined) { metric('cuda.kernel_ms', Number(g.us) / 1000, { kernel: name }); return; }
    }
  }

  // Ordinary program / device-printf / benchmark output: DEBUG, for context
  // and search, out of a default INFO view. --quiet-output drops it.
  if (!quietOutput) publish('DEBUG', text);
}

// --------------------------------------------------------------- running
//
// Everything runs as one shell string, local (sh -c) or remote (ssh DEST),
// with the CUDA bin dir put on PATH - on the GPU box CUDA lives in
// /usr/local/cuda/bin, off PATH. A segfault in the program surfaces as the
// shell exiting 128+signal, which is how a host crash is told from a device
// fault.

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const appStr = command.map(q).join(' ');

function pipeline() {
  // Over an ssh pipe - over any pipe - a program's stdout is block-buffered, so
  // a long run's lines all land at once at exit instead of live. stdbuf -oL -eL
  // forces line buffering, and its libstdbuf is inherited by children, so
  // wrapping the outermost process line-buffers the whole subtree. coreutils
  // only, and guarded: macOS has no stdbuf and must still run.
  const prefix = `export PATH=${q(cudaBin)}:"$PATH"; ` +
    `if command -v stdbuf >/dev/null 2>&1; then SB="stdbuf -oL -eL"; else SB=""; fi; `;
  if (useNsys) {
    const tmp = '/tmp/slcuda_$$';
    const prof = `$SB nsys profile --force-overwrite true -o ${tmp} ${sanitizerTool !== undefined ? `compute-sanitizer --tool=${sanitizerTool} ` : ''}${appStr}`;
    // --force-export=true is not optional: without it, an existing .sqlite next
    // to the report makes nsys print a warning and the usage text with NO CSV
    // (core, on CUDA 13.3). The report name is unique per run, but force it so a
    // stale export can never swallow the whole kernel table.
    const stats = `nsys stats --force-export=true --report cuda_gpu_kern_sum --format csv ${tmp}.nsys-rep 2>/dev/null`;
    return `${prefix}${prof}; echo "${STATS_MARK}"; ${stats}; rm -f ${tmp}.nsys-rep ${tmp}.sqlite 2>/dev/null`;
  }
  if (sanitizerTool !== undefined)
    return `${prefix}$SB compute-sanitizer --tool=${sanitizerTool} ${appStr}`;
  return `${prefix}$SB ${appStr}`;
}

function spawnShell(shellCmd) {
  return dest
    ? spawn('ssh', [...SSH_BASE, dest, shellCmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('sh', ['-c', shellCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function pump(stream) { createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine); }

function signalFromCode(code) {
  // sh/ssh report a child killed by signal N as exit 128+N.
  const names = { 2: 'SIGINT', 4: 'SIGILL', 6: 'SIGABRT', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM' };
  return code > 128 && code < 160 ? (names[code - 128] ?? `SIG${code - 128}`) : null;
}

async function captureGdb() {
  // The hardest failures leave no CUDA error - a host segfault the sanitizer
  // passes. Re-run under gdb for the backtrace. Opt-in (--gdb), because it runs
  // the program a second time.
  const gdb = `export PATH=${q(cudaBin)}:"$PATH"; gdb -batch -ex run -ex bt --args ${appStr} 2>&1`;
  await new Promise((res) => {
    const child = spawnShell(gdb);
    let first = true; const frames = [];
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (l) => {
      const t = l.replace(/\r$/, '');
      if (/^#\d+\s/.test(t)) { frames.push(t); publish('DEBUG', t, { kind: 'backtrace' }); }
      else if (first && t) { first = false; }
    });
    child.stderr && pump(child.stderr);
    child.on('error', () => res());
    child.on('close', () => {
      publish('ERROR', `cuda ${appName}: gdb backtrace (${frames.length} frames)` +
        `${frames[0] ? ` - top ${frames[0].replace(/^#\d+\s+/, '')}` : ''}`,
        { kind: 'backtrace', frames: String(frames.length) });
      res();
    });
  });
}

function runCommand() {
  return new Promise((resolve) => {
    const child = spawnShell(pipeline());
    pump(child.stdout);
    pump(child.stderr);
    child.on('error', (e) => {
      publish('ERROR', `cuda ${appName}: failed to start: ${e.message}`, { change: 'spawn-failed' });
      resolve(127);
    });
    child.on('close', async (code) => {
      // Let the last parsed lines settle into the fault state first.
      const sig = signalFromCode(code ?? 0);
      if (sig) {
        const deviceFault = faulted && sanitizerErrors !== 0;
        const sanitizerClean = sanitizerRan && sanitizerErrors === 0;
        if (!deviceFault) {
          emitFault('ERROR',
            `cuda ${appName}: host-side crash (${sig}), not a device fault` +
            `${sanitizerClean ? ' - compute-sanitizer reported 0 errors' : ''}`,
            { kind: 'host-crash', signal: sig });
          if (useGdb) await captureGdb();
        }
        return resolve(1);
      }
      if (useNsys && statsKernels)
        publish('INFO', `cuda ${appName}: nsys profiled ${statsKernels} kernels` +
          `${statsHottest ? `, hottest ${statsHottest.k} ${statsHottest.pct}%` : ''}`,
          { kind: 'nsys', kernels: String(statsKernels) });
      if (code && !faulted)
        emitFault('ERROR', `cuda ${appName}: exited ${code}`, { kind: 'exit', exit: String(code) });
      else if (!code)
        emitRecovery('run completed cleanly');
      resolve(code ?? 0);
    });
  });
}

// --------------------------------------------------------------- file / stdin

async function tailFile(path) {
  if (!existsSync(path)) { warn(`cuda ${appName}: ${path} does not exist`, { change: 'no-file' }); return 1; }
  let pos = 0;
  const readFrom = (start) => new Promise((res) => {
    const s = createReadStream(path, { start, encoding: 'utf8' });
    let tail = '';
    s.on('data', (chunk) => { const parts = (tail + chunk).split('\n'); tail = parts.pop(); for (const l of parts) onLine(l); });
    s.on('end', () => { if (tail) onLine(tail); pos = statSync(path).size; res(); });
    s.on('error', () => res());
  });
  await readFrom(0);
  if (!follow) return 0;
  watch(path, async () => {
    try { const size = statSync(path).size; if (size < pos) pos = 0; if (size > pos) { const from = pos; pos = size; await readFrom(from); } }
    catch { /* rotated mid-read; the next event re-reads */ }
  });
  return new Promise(() => {});
}

// --------------------------------------------------------------- lifecycle

async function shutdown(code) { await drain(); process.exit(code); }
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

let mode;
if (command.length) mode = 'command';
else if (file) mode = 'file';
else if (!process.stdin.isTTY) mode = 'stdin';
else { console.error('superlog-cuda: nothing to read. Give a command after --, a --file, or pipe into stdin. (--help)'); process.exit(2); }

if ((useNsys || sanitizerTool !== undefined || useGdb) && mode !== 'command')
  console.error('superlog-cuda: --nsys/--sanitizer/--gdb need a command after -- (they run the program); ignored while tailing.');

console.error(`superlog-cuda: ${dest ? `${dest} ` : ''}${mode}` +
  `${sanitizerTool !== undefined ? ` +sanitizer(${sanitizerTool})` : ''}${useNsys ? ' +nsys' : ''}${useGdb ? ' +gdb' : ''} -> ${topic}`);

if (mode === 'command') {
  const code = await runCommand();
  await drain();
  process.exit(code);
} else if (mode === 'file') {
  const code = await tailFile(file);
  await drain();
  process.exit(code);
} else {
  createInterface({ input: process.stdin, crlfDelay: Infinity })
    .on('line', onLine)
    .on('close', () => shutdown(0));
}
