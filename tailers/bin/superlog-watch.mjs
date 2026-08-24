#!/usr/bin/env node
//
//  superlog-watch - a directory tree, on the bench, as it changes.
//
//  Copyright 2026 Saxon Herschel Nicholls
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
//  Levels: created and modified are INFO, deleted is WARN. A file appearing
//  is usually you; a file vanishing is usually not.
//
//  Node >= 18.
//

import { watch, statSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
                 [--debounce MS] [--max-burst N] [--ssh DEST] [--interval S]
                 [--url HUB] [--identity KEY] [--ssh-port N]

Publishes to fs.<host>.<dir>. Created and modified are INFO, deleted WARN.
Bursts larger than --max-burst (default 50) collapse into one summary event.
--ssh polls the remote tree with find(1) instead of watching it.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const dest = opt('ssh');
const debounceMs = Number(opt('debounce', '150'));
const maxBurst = Number(opt('max-burst', '50'));
const pollMs = Number(opt('interval', '10')) * 1000;

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

function publish(topic, level, msg, fields) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'fs-watcher', platform: 'fs', device: host },
    tag: 'fs', msg, fields,
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
        try { known.set(rel, statSync(full).size); } catch { /* raced */ }
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
        try { known.set(rel, statSync(join(root, rel)).size); } catch { known.delete(rel); }
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
        publish(topic, 'WARN', `deleted ${rel}`, { host, dir: root, change: 'deleted', path: rel });
      } else {
        const before = known.get(rel);
        known.set(rel, size);
        if (!had) {
          publish(topic, 'INFO', `created ${rel}`,
                  { host, dir: root, change: 'created', path: rel, size: String(size) });
        } else {
          const delta = size - before;
          publish(topic, 'INFO', `modified ${rel}`,
                  { host, dir: root, change: 'modified', path: rel, size: String(size),
                    ...(delta ? { delta: `${delta > 0 ? '+' : ''}${delta}` } : {}) });
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
