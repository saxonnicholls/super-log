#!/usr/bin/env node
//
//  superlog-watch - a directory tree, on the bench, as it changes.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  "It worked five minutes ago" is a question about files, and the answer is
//  usually a file you did not remember touching - a generated header, a lock
//  file a tool rewrote, a config a script overwrote, an artefact something
//  deleted. This puts filesystem changes in the same ordered stream as the
//  build that then failed, so the cause sits directly above the effect
//  instead of in a terminal you closed.
//
//    superlog-watch                          # this directory
//    superlog-watch --dir src --dir include
//    superlog-watch --dir . --ext .cpp,.hpp  # only what you care about
//    superlog-watch --ssh web1 --dir /srv/app  # a deployed tree, polled
//
//  Publishes to fs.<host>.<dir>.
//
//  No watchman, no chokidar, no dependency: Node's own fs.watch does
//  recursive watching natively on macOS and Windows, and on Linux since
//  Node 20. Where recursive is unavailable it falls back to polling, and
//  says which it chose - a watcher silently missing half a tree is worse
//  than one that admits it is polling.
//
//  Two things it does that a bare watcher does not. Editors do not write
//  files once - they write a temp file, rename it, and touch the mtime,
//  which is three events for one save; changes are debounced per path so
//  that is one event. And a tree can change ten thousand times in a second
//  (npm install, a build, a checkout), which would drown every other stream
//  on the bench; a burst larger than --max-burst becomes one summary event
//  instead, saying how many and where.
//
//  --diff answers the next question - not "which file" but "which LINES".
//  It holds a bounded snapshot of each watched file and, on change, emits
//  ONE event per hunk with the removed and added lines together, every hunk
//  of one save sharing a trace with its "modified" anchor - so
//  /recent?trace= returns the whole edit as one story, and nothing is ever
//  shown twice. It is idempotent by content hash: a rewrite that changes no
//  bytes (an editor's touch, an atomic re-save) produces NOTHING, which
//  a bare mtime watcher cannot promise. Files over --diff-max, binaries,
//  and anything past the --diff-budget are tracked by hash alone and say
//  so, rather than pretending; bursts refresh baselines silently.
//
//  Levels: created and modified are INFO, deleted is WARN. A file appearing
//  is usually you; a file vanishing is usually not.
//
//  Node >= 18.
//

import { watch, statSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const optAll = (name) =>
  args.reduce((acc, a, i) => (a === `--${name}` && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-watch - filesystem changes as events

  superlog-watch [--dir PATH]... [--ext .a,.b] [--ignore name,name]
                 [--diff] [--diff-max KB] [--diff-budget MB]
                 [--debounce MS] [--max-burst N] [--ssh DEST] [--interval S]
                 [--url HUB] [--identity KEY] [--ssh-port N]

Publishes to fs.<host>.<dir>. Created and modified are INFO, deleted WARN.
Bursts larger than --max-burst (default 50) collapse into one summary event.
--diff also emits the changed LINES: one event per hunk, hunks of one save
sharing a trace with their modified event, and a rewrite that changes no
bytes emits nothing at all. Files over --diff-max KB (512), binaries, and
files past --diff-budget MB (64) are tracked by hash alone and say so.
--ssh polls the remote tree with find(1) instead of watching it (no diffs).`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const dest = opt('ssh');
const debounceMs = Number(opt('debounce', '150'));
const maxBurst = Number(opt('max-burst', '50'));
const pollMs = Number(opt('interval', '10')) * 1000;
const diffOn = args.includes('--diff');
const diffMax = Number(opt('diff-max', '512')) * 1024;
const diffBudget = Number(opt('diff-budget', '64')) * 1024 * 1024;
if (diffOn && dest)
  console.error('superlog-watch: --diff is local-only - the remote poll holds no baseline; continuing without diffs');

const dirs = optAll('dir').length ? optAll('dir')
  : (env.SUPER_LOG_WATCH_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!dirs.length) dirs.push(dest ? '.' : process.cwd());

const exts = (opt('ext', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// The directories every tree has and nobody wants an event from. A build
// directory alone can produce more changes in one compile than a day of
// editing, and a watcher that reports them is a watcher you turn off.
const DEFAULT_IGNORE = [
  '.git', 'node_modules', 'build', 'dist', 'target', '.build', '.next',
  '__pycache__', '.venv', 'venv', '.gradle', '.idea', 'DerivedData',
  '.swiftpm', 'Pods', 'vendor', '.cache', 'coverage', '.DS_Store',
];
const ignore = new Set([...DEFAULT_IGNORE,
  ...(opt('ignore', '') || '').split(',').map((s) => s.trim()).filter(Boolean)]);

const sanitize = (s) => s.split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const host = dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest) : sanitize(hostname());

function ignored(rel) {
  if (!rel) return true;
  for (const part of rel.split(sep)) {
    if (ignore.has(part)) return true;
    if (part.startsWith('.') && ignore.has(part)) return true;
    // Editor scratch files: vim swap, emacs autosave, JetBrains, and the
    // ~ backups every one of them still writes.
    if (/^(\.#|#|\.~)|(~|\.swp|\.swx|\.tmp)$/.test(part)) return true;
  }
  if (exts.length && !exts.some((e) => rel.endsWith(e))) return true;
  return false;
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();
let seq = 0;

function publish(topic, level, msg, fields, trace) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'fs-watcher', platform: 'fs', device: host },
    tag: 'fs', msg, ...(trace ? { trace } : {}), fields,
  }));
}

async function flush() {
  for (const [topic, lines] of buf) {
    if (!lines.length) continue;
    const body = lines.join('\n');
    buf.set(topic, []);
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
      });
    } catch {
      /* hub down; the next batch counts again */
    }
  }
}
setInterval(() => void flush(), 500).unref?.();

// ---------------------------------------------------------------- diffing
//
// Patience-flavoured line diff, no dependency: trim the common prefix and
// suffix, anchor on lines unique to both sides (matched in order by longest
// increasing subsequence), recurse between the anchors, and call whatever
// is left between two anchors a hunk. Unique-line anchoring is what keeps a
// moved brace from smearing a config edit across the whole file, and it is
// O(n log n) rather than the quadratic table a textbook LCS wants.

function lisPairs(pairs) {
  // pairs are [aIdx, bIdx] in ascending aIdx; keep the longest chain with
  // ascending bIdx - the anchors that appear in the same order on both sides.
  const tails = [];      // smallest ending bIdx for each chain length
  const prev = new Array(pairs.length);
  const at = [];
  for (let i = 0; i < pairs.length; i++) {
    const b = pairs[i][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < b) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = b;
    at[lo] = i;
    prev[i] = lo > 0 ? at[lo - 1] : -1;
  }
  const out = [];
  for (let i = at[tails.length - 1]; i >= 0; i = prev[i]) out.unshift(pairs[i]);
  return out;
}

/** Change regions between two line arrays: {aStart, aLines, bStart, bLines},
 *  with aStart/bStart 0-based into the ORIGINAL arrays. */
function diffRegions(a, b, aOff = 0, bOff = 0, out = []) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let ea = a.length, eb = b.length;
  while (ea > p && eb > p && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  if (p === ea && p === eb) return out;
  const A = a.slice(p, ea), B = b.slice(p, eb);
  if (A.length && B.length) {
    const countA = new Map(), posB = new Map(), countB = new Map();
    for (const l of A) countA.set(l, (countA.get(l) ?? 0) + 1);
    for (const l of B) countB.set(l, (countB.get(l) ?? 0) + 1);
    B.forEach((l, i) => { if (countB.get(l) === 1 && countA.get(l) === 1) posB.set(l, i); });
    const pairs = [];
    A.forEach((l, i) => { if (posB.has(l)) pairs.push([i, posB.get(l)]); });
    if (pairs.length) {
      let ca = 0, cb = 0;
      for (const [ia, ib] of lisPairs(pairs)) {
        diffRegions(A.slice(ca, ia), B.slice(cb, ib), aOff + p + ca, bOff + p + cb, out);
        ca = ia + 1;
        cb = ib + 1;
      }
      diffRegions(A.slice(ca), B.slice(cb), aOff + p + ca, bOff + p + cb, out);
      return out;
    }
  }
  out.push({ aStart: aOff + p, aLines: A, bStart: bOff + p, bLines: B });
  return out;
}

const sha = (buf) => createHash('sha1').update(buf).digest('hex');
const looksBinary = (buf) => buf.subarray(0, 8192).includes(0);
const mintTrace = () =>
  Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-6);

// ----------------------------------------------------------------- local

/** One event per path per debounce window, classified by whether the file
 *  is there afterwards. fs.watch reports 'rename' for both creation and
 *  deletion, so the filesystem itself is the only reliable answer. */
function makeLocalWatcher(dir) {
  const root = resolve(dir);
  const topic = opt('topic', `fs.${host}.${sanitize(basename(root) || 'root')}`);
  const known = new Map();   // rel -> size, so "modified" can say by how much
  const pending = new Map();
  let timer = null;

  // --diff baselines: rel -> {hash, lines, bytes} when the content is held,
  // or {hash, why} when it can only be fingerprinted (binary, too big, or
  // past the budget). The hash is what makes this idempotent - same bytes,
  // no event - even for the files whose lines are not worth holding.
  const held = new Map();
  let heldBytes = 0;

  const snapshot = (rel, full, raw = null) => {
    if (!diffOn) return;
    if (raw === null) {
      try {
        raw = readFileSync(full);
      } catch {
        held.delete(rel);
        return;
      }
    }
    const prior = held.get(rel);
    if (prior?.lines) heldBytes -= prior.bytes;
    if (raw.length > diffMax) held.set(rel, { hash: sha(raw), why: 'big' });
    else if (looksBinary(raw)) held.set(rel, { hash: sha(raw), why: 'binary' });
    else if (heldBytes + raw.length > diffBudget) held.set(rel, { hash: sha(raw), why: 'budget' });
    else {
      heldBytes += raw.length;
      held.set(rel, { hash: sha(raw), lines: raw.toString().split('\n'), bytes: raw.length });
    }
  };
  const forget = (rel) => {
    const prior = held.get(rel);
    if (prior?.lines) heldBytes -= prior.bytes;
    held.delete(rel);
  };

  // A baseline of what is there now, so the first change to an existing
  // file reads as modified rather than created.
  const seed = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      const rel = relative(root, full);
      if (ignored(rel)) continue;
      if (e.isDirectory()) seed(full);
      else {
        try {
          known.set(rel, statSync(full).size);
          snapshot(rel, full);
        } catch { /* raced */ }
      }
    }
  };
  seed(root);

  const settle = () => {
    timer = null;
    const changes = [...pending.keys()];
    pending.clear();
    if (!changes.length) return;

    if (changes.length > maxBurst) {
      // One line, not ten thousand. The directories involved are the useful
      // part - "3184 changes under node_modules" is a complete answer.
      const tops = new Map();
      for (const rel of changes) {
        const top = rel.split(sep)[0] ?? '.';
        tops.set(top, (tops.get(top) ?? 0) + 1);
      }
      const where = [...tops.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([d, n]) => `${d} (${n})`).join(', ');
      publish(topic, 'INFO', `${changes.length} changes in ${basename(root)}: ${where}`,
              { host, dir: root, change: 'burst', count: String(changes.length), where });
      for (const rel of changes) {
        try {
          known.set(rel, statSync(join(root, rel)).size);
          // Refresh baselines we already hold, silently - a burst is not
          // twenty diffs, but the NEXT quiet edit must diff against now,
          // not against before the checkout.
          if (held.has(rel)) snapshot(rel, join(root, rel));
        } catch {
          known.delete(rel);
          forget(rel);
        }
      }
      return;
    }

    for (const rel of changes) {
      let size = null;
      try { size = statSync(join(root, rel)).size; } catch { /* gone */ }
      const had = known.has(rel);
      if (size === null) {
        known.delete(rel);
        if (!had) continue;   // a temp file that never really existed
        const lines = held.get(rel)?.lines;
        forget(rel);
        publish(topic, 'WARN', `deleted ${rel}`,
                { host, dir: root, change: 'deleted', path: rel,
                  ...(lines ? { lines: String(lines.length) } : {}) });
      } else {
        const before = known.get(rel);
        known.set(rel, size);
        if (!had) {
          publish(topic, 'INFO', `created ${rel}`,
                  { host, dir: root, change: 'created', path: rel, size: String(size) });
          snapshot(rel, join(root, rel));
        } else {
          const deltaF = (d) => (d ? { delta: `${d > 0 ? '+' : ''}${d}` } : {});
          const h = diffOn ? held.get(rel) : undefined;
          if (!h) {
            // Not diffing, or a baseline this watcher never held (born in a
            // burst): report the change the old way and hold it from now on.
            publish(topic, 'INFO', `modified ${rel}`,
                    { host, dir: root, change: 'modified', path: rel, size: String(size),
                      ...deltaF(size - before) });
            snapshot(rel, join(root, rel));
            continue;
          }
          let raw = null;
          try { raw = readFileSync(join(root, rel)); } catch { /* raced away */ }
          if (raw === null) {
            publish(topic, 'INFO', `modified ${rel}`,
                    { host, dir: root, change: 'modified', path: rel, size: String(size),
                      ...deltaF(size - before) });
            continue;
          }
          // The idempotency gate: same bytes is not a change, whatever the
          // mtime says. An editor's touch, an atomic re-save of identical
          // content - nothing is published at all.
          if (sha(raw) === h.hash) continue;

          const trace = mintTrace();
          const diffable = h.lines && raw.length <= diffMax && !looksBinary(raw);
          if (diffable) {
            const regions = diffRegions(h.lines, raw.toString().split('\n'));
            const removed = regions.reduce((n, r) => n + r.aLines.length, 0);
            const added = regions.reduce((n, r) => n + r.bLines.length, 0);
            publish(topic, 'INFO', `modified ${rel} (+${added} -${removed} across ${regions.length} hunk${regions.length === 1 ? '' : 's'})`,
                    { host, dir: root, change: 'modified', path: rel, size: String(size),
                      ...deltaF(size - before), hunks: String(regions.length),
                      added: String(added), removed: String(removed) }, trace);
            // One event per hunk, both sides in it, newest line number first
            // so the msg is a clickable-enough path:line.
            const MAX_HUNKS = 20;
            for (const r of regions.slice(0, MAX_HUNKS)) {
              const msg = [`${rel}:${r.bStart + 1}`,
                ...r.aLines.map((l) => `- ${l}`),
                ...r.bLines.map((l) => `+ ${l}`)].join('\n').slice(0, 4000);
              publish(topic, 'INFO', msg,
                      { host, dir: root, change: 'diff', path: rel, line: String(r.bStart + 1),
                        removed: String(r.aLines.length), added: String(r.bLines.length) }, trace);
            }
            if (regions.length > MAX_HUNKS)
              publish(topic, 'INFO', `...and ${regions.length - MAX_HUNKS} more hunk(s) in ${rel}`,
                      { host, dir: root, change: 'diff-overflow', path: rel,
                        hunks: String(regions.length) }, trace);
          } else {
            const why = raw.length > diffMax ? 'big' : looksBinary(raw) ? 'binary' : h.why ?? 'budget';
            const said = why === 'binary' ? 'binary' : why === 'big' ? 'too big to diff' : 'over the diff budget';
            publish(topic, 'INFO', `modified ${rel} (content changed, ${said})`,
                    { host, dir: root, change: 'modified', path: rel, size: String(size),
                      ...deltaF(size - before), undiffable: why }, trace);
          }
          snapshot(rel, join(root, rel), raw);
        }
      }
    }
  };

  let recursive = true;
  const onChange = (_type, filename) => {
    if (!filename) return;
    const rel = String(filename);
    if (ignored(rel)) return;
    pending.set(rel, true);
    if (!timer) timer = setTimeout(settle, debounceMs);
  };

  try {
    watch(root, { recursive: true }, onChange);
  } catch {
    recursive = false;
    // Node before 20 on Linux cannot watch recursively. Say so rather than
    // silently watching one level and calling it a tree.
    console.error(`superlog-watch: recursive watching unavailable here - ` +
                  `watching ${root} non-recursively. Node >= 20 fixes this on Linux.`);
    watch(root, onChange);
  }
  console.error(`superlog-watch: ${root} (${known.size} files, ` +
                `${recursive ? 'recursive' : 'top level only'}) -> ${topic}`);
}

// ---------------------------------------------------------------- remote
//
// fs.watch cannot reach another machine, and installing an agent on a
// production box to watch a directory is a bad trade. find(1) with a
// timestamp is already there, costs one ssh round trip, and answers the
// question that matters: what changed since I last looked.

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function runRemote(cmd) {
  return new Promise((res) => {
    const child = spawn('ssh', [...SSH_BASE, dest, cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => res({ ok: false, out: '' }));
    child.on('close', (code) => res({ ok: code === 0, out }));
  });
}

async function remoteLoop(dir) {
  const topic = opt('topic', `fs.${host}.${sanitize(basename(dir) || 'root')}`);
  const prune = [...ignore].filter((i) => !i.startsWith('.') || i === '.git')
    .map((i) => `-name ${shq(i)} -prune -o`).join(' ');
  let since = null;

  const poll = async () => {
    // -newermt with an epoch is understood by GNU and BSD find alike.
    const when = since === null ? '' : `-newermt ${shq(`@${Math.floor(since / 1000)}`)}`;
    const cmd = `find ${shq(dir)} ${prune} -type f ${when} -print 2>/dev/null | head -500`;
    const { out } = await runRemote(cmd);
    const files = out.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((f) => relative(dir, f) || basename(f))
      .filter((rel) => !ignored(rel));

    if (since !== null && files.length) {
      if (files.length > maxBurst) {
        publish(topic, 'INFO', `${files.length}+ changes under ${dir}`,
                { host, dir, change: 'burst', count: String(files.length) });
      } else {
        for (const rel of files)
          // find cannot tell created from modified without a prior
          // inventory, and carrying one for a remote tree costs more than
          // the distinction is worth. It says what it knows: touched.
          publish(topic, 'INFO', `touched ${rel}`,
                  { host, dir, change: 'touched', path: rel });
      }
    }
    since = Date.now();
    setTimeout(poll, pollMs);
  };

  console.error(`superlog-watch: polling ${dest}:${dir} every ${pollMs / 1000}s -> ${topic}`);
  await poll();
}

// ------------------------------------------------------------------- go

if (dest) for (const d of dirs) void remoteLoop(d);
else for (const d of dirs) makeLocalWatcher(d);
