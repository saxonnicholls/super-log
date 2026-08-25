//
//  tests/harness.mjs - what every test file stands on.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The tools here are executable scripts that do their work on import: they
//  read argv, spawn a child, open a socket and exit. There is nothing to
//  import and unit-test, and pretending otherwise would mean testing a
//  refactored copy rather than the thing that ships. So they are tested the
//  way they are used - as subprocesses talking to a real superlogd over
//  real HTTP - and this file is the plumbing for that.
//
//  Three rules it exists to enforce:
//
//    - Hermetic. Every hub gets its own port, every test its own temp dir,
//      and children run with a scrubbed environment pointing at an empty
//      .env, because a tailer's loadEnv() would otherwise pick up the
//      operator's SUPER_LOG_URL and quietly publish into their live bench.
//    - Synchronised on evidence, never on a clock. waitFor() polls /recent
//      until the thing being waited for is actually there. A suite that
//      sleeps and hopes fails on a loaded CI box and teaches everyone to
//      re-run it, which is worse than having no suite.
//    - One validator. assertValidEvent() is docs/PROTOCOL.md expressed as
//      code, applied to everything every tool emits.
//
//  Node >= 18.
//

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(TESTS, '..');
export const BIN = join(REPO, 'tailers', 'bin');
export const FIXTURES = join(TESTS, 'fixtures');
export const HUB_BIN = join(REPO, 'build', 'hub', 'superlogd');

/** The one .env the tailers are allowed to see. Without this they walk up
 *  the tree, find the repo's own .env, and inherit whatever hub, serial port
 *  and watch directories the operator happens to have configured. */
const EMPTY_ENV = join(FIXTURES, 'empty.env');

export const hubBuilt = () => existsSync(HUB_BIN);

// ------------------------------------------------------------- environment

/** process.env minus everything super-log reads, plus what the test wants.
 *  A stray SUPER_LOG_URL in the operator's shell would otherwise redirect a
 *  test's events onto their real bench and make the test hang waiting for
 *  events that went somewhere else. */
export function cleanEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith('SUPER_LOG_')) out[k] = v;
  out.SUPER_LOG_ENV = EMPTY_ENV;
  return { ...out, ...extra };
}

// ------------------------------------------------------------------ ports

/** An ephemeral port the OS has just confirmed is free. There is a window
 *  between closing this and the hub binding it, so startHub() retries. */
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** The same, for UDP: a free TCP port says nothing about the UDP one. */
export function freeUdpPort() {
  return new Promise((res, rej) => {
    const s = createSocket('udp4');
    s.on('error', rej);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

// -------------------------------------------------------------------- hub

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy(url) {
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn a real superlogd on its own port and wait until it answers /healthz.
 * Loopback-bound: a test hub that accepts connections from the LAN is a test
 * that can be joined by whatever else is on the network.
 */
export async function startHub({ port, timeoutMs = 15000 } = {}) {
  if (!hubBuilt())
    throw new Error(`superlogd not built at ${HUB_BIN} - run ./scripts/dev.sh or cmake --build build`);

  for (let attempt = 0; attempt < 4; attempt++) {
    const p = port ?? (await freePort());
    const url = `http://127.0.0.1:${p}`;
    const child = spawn(HUB_BIN, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv({
        SUPER_LOG_PORT: String(p),
        SUPER_LOG_BIND: '127.0.0.1',
        SUPER_LOG_RECENT: '5000',
      }),
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    let exited = false;
    child.on('exit', () => (exited = true));

    const deadline = Date.now() + timeoutMs;
    let up = false;
    while (Date.now() < deadline && !exited) {
      if (await healthy(url)) { up = true; break; }
      await sleep(25);
    }

    if (up) {
      return {
        url,
        port: p,
        async stop() {
          if (exited) return;
          child.kill('SIGTERM');
          // The hub's main loop only checks the stop flag between ten-second
          // stat prints, so a polite shutdown is not worth waiting for in a
          // test fixture that holds nothing but memory.
          for (let i = 0; i < 20 && !exited; i++) await sleep(25);
          if (!exited) child.kill('SIGKILL');
        },
      };
    }

    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    if (port) throw new Error(`hub did not come up on ${port}: ${log}`);
  }
  throw new Error('hub did not come up on any of four free ports');
}

// ----------------------------------------------------------------- tailers

/**
 * Launch a tailer and keep the handle: most of them run until killed, and a
 * test needs to interact with them while they are alive.
 */
export function start(script, args = [], { url, env, cwd, stdio } = {}) {
  const argv = [join(BIN, script), ...(url ? ['--url', url] : []), ...args];
  const child = spawn(process.execPath, argv, {
    cwd: cwd ?? REPO,
    env: cleanEnv(env),
    stdio: stdio ?? ['pipe', 'pipe', 'pipe'],
  });

  const outChunks = [];
  const errChunks = [];
  const errWaiters = [];
  child.stdout?.on('data', (d) => outChunks.push(d));
  child.stderr?.on('data', (d) => {
    errChunks.push(d);
    const text = Buffer.concat(errChunks).toString();
    for (const w of [...errWaiters])
      if (w.rx.test(text)) { errWaiters.splice(errWaiters.indexOf(w), 1); w.res(text); }
  });

  let exit = null;
  const exited = new Promise((res) => {
    child.on('exit', (code, signal) => { exit = { code, signal }; res(exit); });
    child.on('error', (e) => { exit = { code: null, signal: null, error: e }; res(exit); });
  });

  const result = (timedOut) => ({
    code: exit?.code ?? null,
    signal: exit?.signal ?? null,
    stdout: Buffer.concat(outChunks).toString(),
    stderr: Buffer.concat(errChunks).toString(),
    stdoutBuf: Buffer.concat(outChunks),
    timedOut,
  });

  const handle = {
    child,
    stdout: () => Buffer.concat(outChunks).toString(),
    stderr: () => Buffer.concat(errChunks).toString(),

    /** Resolve when the tool says on stderr that it is ready. Tailers all
     *  announce what they bound or opened, which is the only readiness
     *  signal that is true rather than merely likely. */
    waitForStderr(rx, { timeoutMs = 15000 } = {}) {
      const text = Buffer.concat(errChunks).toString();
      if (rx.test(text)) return Promise.resolve(text);
      return new Promise((res, rej) => {
        const w = { rx, res };
        errWaiters.push(w);
        const t = setTimeout(() => {
          const i = errWaiters.indexOf(w);
          if (i >= 0) errWaiters.splice(i, 1);
          rej(new Error(`timed out waiting for ${rx} on ${script} stderr; saw:\n${handle.stderr()}`));
        }, timeoutMs);
        t.unref?.();
      });
    },

    async wait(timeoutMs = 20000) {
      let timer;
      const timeout = new Promise((res) => {
        timer = setTimeout(() => res('timeout'), timeoutMs);
        timer.unref?.();
      });
      const who = await Promise.race([exited.then(() => 'exit'), timeout]);
      clearTimeout(timer);
      if (who === 'timeout') {
        child.kill('SIGKILL');
        await exited;
        return result(true);
      }
      return result(false);
    },

    /** SIGTERM first: several tailers flush a final batch on it, and a test
     *  that SIGKILLs loses exactly the events it was about to assert on. */
    async stop({ timeoutMs = 4000 } = {}) {
      if (exit) return result(false);
      child.kill('SIGTERM');
      let timer;
      const timeout = new Promise((res) => {
        timer = setTimeout(() => res('timeout'), timeoutMs);
        timer.unref?.();
      });
      const who = await Promise.race([exited.then(() => 'exit'), timeout]);
      clearTimeout(timer);
      if (who === 'timeout') { child.kill('SIGKILL'); await exited; }
      return result(false);
    },
  };
  return handle;
}

/** Run a tailer to completion (or to `timeoutMs`, whichever comes first). */
export async function run(script, args = [], opts = {}) {
  const h = start(script, args, opts);
  if (h.child.stdin) {
    if (opts.stdin !== undefined) h.child.stdin.end(opts.stdin);
    else h.child.stdin.end();
    h.child.stdin.on('error', () => { /* the tool may exit before we finish writing */ });
  }
  return h.wait(opts.timeoutMs ?? 30000);
}

// ------------------------------------------------------------------ /recent

function recentQuery({ topic, limit = 1000, since = 0, level, trace } = {}) {
  const q = new URLSearchParams();
  q.set('limit', String(limit));
  q.set('since', String(since));
  if (topic) q.set('topic', topic);
  if (level) q.set('level', level);
  if (trace) q.set('trace', trace);
  return q.toString();
}

/** The raw /recent body. The hub embeds each event line verbatim, so this is
 *  the only place a test can see exactly what a producer wrote. */
export async function recentText(url, opts = {}) {
  const r = await fetch(`${url}/recent?${recentQuery(opts)}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`GET /recent: ${r.status}`);
  return r.text();
}

/** Records as /recent returns them: {id, seq, topic, event}. */
export async function recent(url, opts = {}) {
  return JSON.parse(await recentText(url, opts)).events;
}

/**
 * Pull the event objects back out of the raw /recent body, still as text.
 * `embedded:false` means the hub could not relay the line as JSON and wrapped
 * it as a string - which for a producer in this repo is a bug, since every
 * one of them is supposed to emit a JSON object per line.
 */
export function embeddedEventText(body) {
  const NEEDLE = '"event":';
  const out = [];
  let i = 0;
  for (;;) {
    const at = body.indexOf(NEEDLE, i);
    if (at < 0) break;
    let j = at + NEEDLE.length;
    if (body[j] !== '{') { out.push({ embedded: false, text: null }); i = j; continue; }
    let depth = 0, inStr = false, esc = false, k = j;
    for (; k < body.length; k++) {
      const c = body[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') { depth -= 1; if (depth === 0) { k += 1; break; } }
    }
    out.push({ embedded: true, text: body.slice(j, k) });
    i = k;
  }
  return out;
}

/**
 * Poll /recent until `predicate(records)` is satisfied. Returns the records
 * it was satisfied by, so a caller can assert on them without a second GET
 * that might see a different world.
 */
export async function waitFor(url, predicate, { timeoutMs = 20000, intervalMs = 40, ...opts } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  let lastErr = null;
  for (;;) {
    try {
      last = await recent(url, opts);
      if (predicate(last)) return last;
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  const seen = last.map((r) => `  ${r.topic} ${r.event?.level ?? '?'} ${String(r.event?.msg ?? '').slice(0, 90)}`)
    .join('\n');
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${lastErr ? ` (last error: ${lastErr.message})` : ''}\n` +
    `${last.length} event(s) on ${opts.topic ?? '*'}:\n${seen}`);
}

// ------------------------------------------------------------- the contract

export const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

/**
 * docs/PROTOCOL.md, as an assertion. Every event every tool produces goes
 * through this - readers are told to be tolerant, but producers in this repo
 * are held to the strict shape, which is the only reason a tolerant reader
 * is ever cheap.
 */
export function assertValidEvent(ev, where = 'event') {
  assert.ok(ev && typeof ev === 'object' && !Array.isArray(ev),
            `${where}: not a JSON object`);
  const at = `${where} (${ev.level ?? '?'} ${String(ev.msg ?? '').slice(0, 60)})`;

  assert.equal(ev.v, 1, `${at}: v must be 1`);

  assert.equal(typeof ev.ts, 'string', `${at}: ts must be a string`);
  assert.ok(!Number.isNaN(Date.parse(ev.ts)), `${at}: ts ${JSON.stringify(ev.ts)} does not parse as a date`);

  assert.equal(typeof ev.seq, 'number', `${at}: seq must be a number`);
  assert.ok(Number.isInteger(ev.seq) && ev.seq >= 0, `${at}: seq must be a non-negative integer`);

  assert.ok(LEVELS.includes(ev.level), `${at}: level ${JSON.stringify(ev.level)} is not one of ${LEVELS.join(' ')}`);

  assert.ok(ev.origin && typeof ev.origin === 'object' && !Array.isArray(ev.origin),
            `${at}: origin must be an object`);

  assert.equal(typeof ev.msg, 'string', `${at}: msg must be a string`);

  if ('session' in ev) assert.equal(typeof ev.session, 'string', `${at}: session must be a string`);
  if ('tag' in ev) assert.equal(typeof ev.tag, 'string', `${at}: tag must be a string`);
  if ('src' in ev) assert.equal(typeof ev.src, 'string', `${at}: src must be a string`);
  if ('trace' in ev) assert.equal(typeof ev.trace, 'string', `${at}: trace must be a string`);

  if ('fields' in ev) {
    assert.ok(ev.fields && typeof ev.fields === 'object' && !Array.isArray(ev.fields),
              `${at}: fields must be an object`);
    for (const [k, v] of Object.entries(ev.fields))
      assert.equal(typeof v, 'string',
                   `${at}: fields.${k} must be a string, got ${typeof v} (${JSON.stringify(v)})`);
  }

  if ('metric' in ev) {
    assert.ok(ev.metric && typeof ev.metric === 'object' && !Array.isArray(ev.metric),
              `${at}: metric must be an object`);
    assert.equal(typeof ev.metric.name, 'string', `${at}: metric.name must be a string`);
    assert.equal(typeof ev.metric.value, 'number', `${at}: metric.value must be a number`);
    assert.ok(Number.isFinite(ev.metric.value), `${at}: metric.value must be finite`);
  }
  return ev;
}

/**
 * No whitespace outside string literals. The hub's field scanner reads
 * `level` and `trace` out of the line by targeted scan rather than by
 * parsing it, so a producer that pretty-prints its events is a producer
 * whose events cannot be filtered - and nothing looks broken when it
 * happens, they simply arrive unfindable.
 */
export function assertCompactJson(line, where = 'event') {
  let inStr = false, esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r')
      assert.fail(`${where}: JSON is not compact - whitespace at index ${i}: ` +
                  `...${line.slice(Math.max(0, i - 40), i + 40)}...`);
  }
  assert.ok(!inStr, `${where}: unterminated string in event JSON`);
}

// ------------------------------------------------------------------- files

/** A temp dir with the symlinks resolved: on macOS os.tmpdir() is a symlink
 *  into /private, and a watcher comparing paths would disagree with itself. */
export function tempDir(prefix = 'superlog-test-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function removeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}
