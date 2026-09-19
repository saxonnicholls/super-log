#!/usr/bin/env node
//
//  superlog git - commit markers on the bench, and the logs behind any commit.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Two halves of one idea: "what was the bench doing when I made this commit?"
//
//    superlog git install-hooks [--repo PATH]   a post-commit hook that stamps
//                                               a git.commit frame on the bench
//    superlog git uninstall-hooks [--repo PATH] remove it
//    superlog git recall <commit> [opts]        replay the logs from that commit
//                                               to the next one
//
//  install-hooks writes a `.git/hooks/post-commit` that, at every commit,
//  posts one INFO frame to git.<host>.<repo> carrying the sha, author, subject
//  and whether the tree was dirty. That is the marker; superlog-git (the
//  watcher) reports the same shape when it *notices* a commit, so the two are
//  interchangeable on the timeline - the hook is just exact and instant.
//
//  recall does the retrieval. A commit has a committer time; the next commit
//  toward HEAD has another. Everything the journal collected between those two
//  wall-clock instants is "the logs behind this commit" - the build that ran,
//  the tests, the services that flapped - and recall prints them by handing
//  that window to superlog-search. It reads the LOCAL journal (MIT, on this
//  box); durable/hosted recall across sealed segments is the Cloud console.
//
//  Zero dependency: git and the journal, both already here. Node >= 18.
//

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MARKER = 'super-log post-commit hook';   // how we recognise our own block

// --------------------------------------------------------------- shared bits
// Kept byte-identical to superlog-git.mjs so a hook-stamped commit and a
// watcher-noticed one land on the very same topic.

const sanitize = (s) => String(s).split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');

function repoName(repo) {
  return sanitize(basename(resolve(repo)) || 'repo');
}
function topicFor(repo) {
  return `git.${sanitize(hostname())}.${repoName(repo)}`;
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function isGitRepo(repo) {
  return git(repo, ['rev-parse', '--git-dir']).ok;
}

// The effective hooks directory: honour core.hooksPath if the repo sets it,
// otherwise <git-dir>/hooks. Works for worktrees and submodules because
// --absolute-git-dir already resolves those.
function hooksDir(repo) {
  const cfg = git(repo, ['config', '--get', 'core.hooksPath']);
  if (cfg.ok && cfg.out) return resolve(repo, cfg.out);
  const gd = git(repo, ['rev-parse', '--absolute-git-dir']);
  return join(gd.out || join(repo, '.git'), 'hooks');
}

function die(msg, code = 1) { console.error(`superlog git: ${msg}`); process.exit(code); }

// ------------------------------------------------------------- install-hooks

function installHooks(repo, hubUrl) {
  if (!isGitRepo(repo)) die(`${repo} is not a git repository`);
  const dir = hooksDir(repo);
  mkdirSync(dir, { recursive: true });
  const hookPath = join(dir, 'post-commit');

  // Our block is a single invocation, guarded so a commit is never blocked by
  // a hub that's down (|| true) and never by a missing node either.
  const block = [
    `# >>> ${MARKER} >>>`,
    `# Managed by \`superlog git install-hooks\`. Remove: \`superlog git uninstall-hooks\`.`,
    `"${process.execPath}" "${SELF}" commit-frame --repo "${resolve(repo)}" --url "${hubUrl}" >/dev/null 2>&1 || true`,
    `# <<< ${MARKER} <<<`,
  ].join('\n');

  let body;
  if (existsSync(hookPath)) {
    const cur = readFileSync(hookPath, 'utf8');
    if (cur.includes(MARKER)) {
      // Idempotent: replace our old block in place, leave the rest untouched.
      body = cur.replace(
        new RegExp(`# >>> ${MARKER} >>>[\\s\\S]*?# <<< ${MARKER} <<<`),
        block,
      );
    } else {
      // Someone else's hook. Preserve it; append ours so both run.
      const sep = cur.endsWith('\n') ? '\n' : '\n\n';
      body = `${cur}${sep}${block}\n`;
    }
  } else {
    body = `#!/bin/sh\n${block}\n`;
  }
  writeFileSync(hookPath, body);
  chmodSync(hookPath, 0o755);
  console.log(`installed post-commit hook -> ${hookPath}`);
  console.log(`  every commit now stamps ${topicFor(repo)} on the bench.`);
}

function uninstallHooks(repo) {
  const hookPath = join(hooksDir(repo), 'post-commit');
  if (!existsSync(hookPath)) return console.log('no post-commit hook to remove');
  const cur = readFileSync(hookPath, 'utf8');
  if (!cur.includes(MARKER)) return console.log('post-commit hook is not ours - left untouched');
  let body = cur.replace(new RegExp(`\\n*# >>> ${MARKER} >>>[\\s\\S]*?# <<< ${MARKER} <<<\\n*`), '\n');
  // If nothing but a bare shebang is left, the file is ours alone - drop it.
  if (/^#!\/bin\/sh\s*$/.test(body.trim())) {
    rmSync(hookPath, { force: true });
    return console.log(`removed ${hookPath}`);
  }
  writeFileSync(hookPath, body);
  console.log(`removed super-log block from ${hookPath} (the rest of the hook is kept)`);
}

// ------------------------------------------------------- commit-frame (hook)
// Called BY the post-commit hook, not by a person. One frame, best-effort.

async function commitFrame(repo, hubUrl) {
  const US = '\x1f';
  const log = git(repo, ['log', '-1', `--format=%H${US}%an${US}%cI${US}%s`]);
  if (!log.ok || !log.out) process.exit(0);      // nothing to say; never block a commit
  const [sha, author, when, ...sub] = log.out.split(US);
  const subject = sub.join(US);
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out || '';
  const dirty = git(repo, ['status', '--porcelain=v1']).out.split('\n').filter((l) => l.trim()).length;

  const frame = {
    v: 1, ts: new Date().toISOString(), seq: 0,
    session: sha.slice(0, 8), level: 'INFO',
    origin: { runtime: 'node', app: 'git-hook', platform: 'git', device: sanitize(hostname()) },
    tag: 'git', msg: subject,
    fields: {
      change: 'commit', repo: resolve(repo), branch,
      sha: sha.slice(0, 12), author, when,
      dirty: String(dirty),
    },
  };
  try {
    await fetch(`${hubUrl}/ingest/${topicFor(repo)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: JSON.stringify(frame),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* hub down at commit time is fine - the commit still happened */ }
  process.exit(0);
}

// -------------------------------------------------------------------- recall
// The window is [this commit's committer time, the next commit's), and the
// retrieval is superlog-search's job - recall only computes the window and
// forwards the reader's flags.

function recall(commitish, passthru, repo) {
  if (!commitish) die('recall needs a commit: superlog git recall <sha|HEAD|HEAD~1>');
  if (!isGitRepo(repo)) die(`${repo} is not a git repository`);
  const rev = git(repo, ['rev-parse', '--verify', `${commitish}^{commit}`]);
  if (!rev.ok) die(`no such commit '${commitish}' in ${repo}`);
  const sha = rev.out;

  const since = git(repo, ['show', '-s', '--format=%cI', sha]).out;
  if (!since) die(`could not read the time of ${sha.slice(0, 12)}`);

  // The next commit toward HEAD bounds the window. --ancestry-path keeps us on
  // the line of descent from this commit, so a merge from elsewhere doesn't
  // masquerade as "the next thing that happened here".
  const nextList = git(repo, ['log', '--reverse', '--ancestry-path', '--format=%cI', `${sha}..HEAD`]);
  const until = nextList.ok && nextList.out ? nextList.out.split('\n')[0].trim() : null;

  const subject = git(repo, ['show', '-s', '--format=%s', sha]).out;
  const label = `${sha.slice(0, 12)}  ${subject}`;
  if (!until) {
    console.error(`superlog git: logs since ${label}  (${since} -> now, this is at/after HEAD)`);
  } else {
    console.error(`superlog git: logs behind ${label}  (${since} -> ${until})`);
  }

  const SEARCH = join(dirname(SELF), 'superlog-search.mjs');
  const args = ['--since', since, ...(until ? ['--until', until] : []), ...passthru];
  const child = spawn(process.execPath, [SEARCH, ...args], { stdio: 'inherit' });
  child.on('exit', (code, sigish) => {
    if (code === 0 || code === null) {
      console.error(`\nsuperlog git: local journal only. Durable recall across sealed`);
      console.error(`  segments (weeks, other hosts) is the Cloud console: superlog login`);
    }
    process.exit(sigish ? 1 : (code ?? 0));
  });
  child.on('error', () => die(`could not run superlog-search at ${SEARCH}`));
}

// ---------------------------------------------------------------------- main

function opt(args, name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}

const SUBS = new Set(['install-hooks', 'uninstall-hooks', 'commit-frame', 'recall']);

async function main() {
  // Position-independent: --url/--repo (ours) may appear anywhere, so the
  // subcommand is recognised by name, not by being argv[0]. It matters because
  // callers front-load flags - the test harness prepends `--url`, and a future
  // `superlog git --repo X recall <sha>` should work too.
  const args = process.argv.slice(2);
  const hubUrl = opt(args, 'url', process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
  const repo = resolve(opt(args, 'repo', process.cwd()));
  const sub = args.find((a) => SUBS.has(a));

  switch (sub) {
    case 'install-hooks':   return installHooks(repo, hubUrl);
    case 'uninstall-hooks': return uninstallHooks(repo);
    case 'commit-frame':    return commitFrame(repo, hubUrl);   // internal (the hook)
    case 'recall': {
      // After `recall`: the first bare token is the commit; the rest forward to
      // superlog-search (--topic, --level, --limit, --json…). Our own
      // value-flags (--repo/--url) are skipped, wherever they sit.
      const flags = [];
      let commitish = null;
      for (let i = args.indexOf('recall') + 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--repo' || a === '--url') { i++; continue; }
        if (!commitish && !a.startsWith('--')) { commitish = a; continue; }
        flags.push(a);
      }
      return recall(commitish, flags, repo);
    }
    default:
      die(`unknown 'superlog git' command '${sub ?? ''}' - try install-hooks | uninstall-hooks | recall <commit>`, 2);
  }
}

await main();
