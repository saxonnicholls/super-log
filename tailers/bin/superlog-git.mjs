#!/usr/bin/env node
//
//  superlog-git - what the repositories on this bench are doing.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Half the questions that start "why did that break" are answered by "what
//  changed", and the answer is usually in git - but only if you thought to
//  look, in the right repo, at the right time. This puts commits, branch
//  switches, rewritten history and merge conflicts on the same screen as the
//  build that failed and the service that restarted, in the order they
//  actually happened.
//
//    superlog-git                              # this repo, watch for change
//    superlog-git --repo ~/a --repo ~/b        # several at once
//    superlog-git --once                       # state of each, then exit
//    superlog-git --ssh web1 --repo /srv/app   # a deployed checkout
//    superlog-git --fetch --interval 60        # ...and notice remote movement
//
//  Publishes to git.<host>.<repo>. Like the DNS and ports watchers, the
//  first poll is a silent baseline and only changes are reported after it -
//  a watcher that re-states the current branch every thirty seconds teaches
//  you to ignore it.
//
//  Everything it runs is read-only. --fetch is the one exception and is
//  opt-in for that reason: it touches the network, and on a repo with an
//  http remote it can sit waiting for credentials that will never come.
//
//  Levels follow meaning. A commit is INFO. Rewritten history is WARN -
//  a rebase you did is unremarkable, the same event on a shared branch is
//  the beginning of a bad afternoon, and the watcher cannot tell which.
//  Conflicts and interrupted merges are WARN because the tree is in a state
//  that will surprise the next command. A repo that disappears is ERROR.
//
//  Zero dependency: git, which is already there.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const optAll = (name) =>
  args.reduce((acc, a, i) => (a === `--${name}` && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-git - commits, branches and conflicts, watched for change

  superlog-git [--repo PATH]... [--once] [--ssh DEST] [--interval SECONDS]
               [--fetch] [--url HUB] [--identity KEY] [--ssh-port N]

Publishes to git.<host>.<repo>. First poll is a silent baseline; after that
only changes are reported. --once prints each repo's current state instead.
--fetch updates remote-tracking refs first, so "behind by 3" is true rather
than merely last known - it is opt-in because it touches the network.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const intervalMs = Number(opt('interval', env.SUPER_LOG_GIT_INTERVAL ?? '15')) * 1000;
const once = args.includes('--once');
const doFetch = args.includes('--fetch');
const dest = opt('ssh');

const sanitize = (s) => s.split('.')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const host = dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest) : sanitize(hostname());

const repos = optAll('repo').length
  ? optAll('repo')
  : (env.SUPER_LOG_GIT_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!repos.length) repos.push(dest ? '.' : process.cwd());

// ---------------------------------------------------------------- running

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];

// Single-quote for the remote shell. Every repo path and ref reaching a
// command string goes through this - a branch name is attacker-adjacent
// input the moment a repo has a remote.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Run a shell command here or there. Never throws: a host that is down or
 *  a repo that has been deleted is a fact to report, not a crash. */
function run(cmd) {
  return new Promise((resolve) => {
    const child = dest
      ? spawn('ssh', [...SSH_BASE, dest, cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ ok: false, out: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

// ---------------------------------------------------------------- polling
//
// One shell round trip per repo per poll, not six. Over ssh the difference
// is the whole cost of the watcher, and six sequential connections to a
// box in another country is a watcher nobody leaves running.

const US = '\x1f';   // between fields
const RS = '\x1e';   // between commits

function pollCommand(repo) {
  const R = shq(repo);
  const fetch = doFetch ? `git -C ${R} fetch --quiet --all 2>/dev/null;` : '';
  return `${fetch}
git -C ${R} rev-parse --git-dir >/dev/null 2>&1 || { echo "@@GONE"; exit 0; }
echo "@@BRANCH"; git -C ${R} rev-parse --abbrev-ref HEAD 2>/dev/null
echo "@@HEAD";   git -C ${R} rev-parse HEAD 2>/dev/null
echo "@@STATUS"; git -C ${R} status --porcelain=v1 2>/dev/null
echo "@@TRACK";  git -C ${R} rev-list --left-right --count HEAD...@{upstream} 2>/dev/null
echo "@@TAGS";   git -C ${R} tag 2>/dev/null
echo "@@STATE";  D=$(git -C ${R} rev-parse --absolute-git-dir 2>/dev/null); for f in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do [ -e "$D/$f" ] && echo "$f"; done
echo "@@END"`;
}

function parsePoll(text) {
  if (text.includes('@@GONE')) return { gone: true };
  const sec = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^@@([A-Z]+)$/.exec(line);
    if (m) { cur = m[1]; sec[cur] = []; continue; }
    if (cur && cur !== 'END') sec[cur].push(line);
  }
  const status = (sec.STATUS ?? []).filter((l) => l.trim());
  // XX/UU/AA/DD in the first two columns is an unmerged path, which is the
  // difference between "dirty" and "this tree will not build".
  const conflicts = status.filter((l) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(l))
                          .map((l) => l.slice(3));
  const track = (sec.TRACK ?? []).join('').trim().split(/\s+/);
  return {
    branch: (sec.BRANCH ?? []).join('').trim(),
    head: (sec.HEAD ?? []).join('').trim(),
    dirty: status.length,
    conflicts,
    ahead: track.length === 2 ? Number(track[0]) : null,
    behind: track.length === 2 ? Number(track[1]) : null,
    tags: new Set((sec.TAGS ?? []).filter((t) => t.trim())),
    state: (sec.STATE ?? []).filter((s) => s.trim()),
  };
}

/** The commits between two SHAs, newest last, with their shortstat. */
async function commitsBetween(repo, from, to) {
  const R = shq(repo);
  const { ok, out } = await run(
    `git -C ${R} log --reverse --format=${shq(`${RS}%H${US}%an${US}%cI${US}%s`)} --shortstat ${shq(`${from}..${to}`)} 2>/dev/null`,
  );
  if (!ok) return null;
  const commits = [];
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const [head, ...rest] = rec.split('\n');
    const [sha, author, when, ...subject] = head.split(US);
    if (!sha) continue;
    const stat = rest.find((l) => /files? changed/.test(l))?.trim() ?? '';
    commits.push({ sha, author, when, subject: subject.join(US), stat });
  }
  return commits;
}

/** Is `from` an ancestor of `to`? If not, history was rewritten under us. */
async function isAncestor(repo, from, to) {
  const R = shq(repo);
  const { ok } = await run(`git -C ${R} merge-base --is-ancestor ${shq(from)} ${shq(to)}`);
  return ok;
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();   // topic -> lines, because one process watches many repos
let seq = 0;

function publish(topic, level, msg, fields) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'git-watcher', platform: 'git', device: host },
    tag: 'git', msg, fields,
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

// ------------------------------------------------------------------ loop

const prev = new Map();   // repo -> last state

async function tick(repo) {
  const name = sanitize(basename(dest ? repo : resolve(repo)) || 'repo');
  const topic = opt('topic', `git.${host}.${name}`);
  const { out } = await run(pollCommand(repo));
  const now = parsePoll(out);
  const before = prev.get(repo);

  if (now.gone) {
    // Only once: a deleted checkout would otherwise be an error every poll.
    if (!before || !before.gone)
      publish(topic, 'ERROR', `${repo} is not a git repository (moved, deleted, or never was)`,
              { repo, host, change: 'missing' });
    prev.set(repo, { gone: true });
    return;
  }

  if (once) {
    const bits = [`${now.branch} at ${now.head.slice(0, 8)}`];
    if (now.dirty) bits.push(`${now.dirty} uncommitted`);
    if (now.conflicts.length) bits.push(`${now.conflicts.length} conflicted`);
    if (now.ahead || now.behind) bits.push(`ahead ${now.ahead} behind ${now.behind}`);
    if (now.state.length) bits.push(now.state.join(' '));
    publish(topic, now.conflicts.length ? 'WARN' : 'INFO', `${name}: ${bits.join(', ')}`, {
      repo, host, branch: now.branch, head: now.head, dirty: String(now.dirty),
      ahead: String(now.ahead ?? ''), behind: String(now.behind ?? ''),
      tags: String(now.tags.size),
    });
    prev.set(repo, now);
    return;
  }

  if (before && !before.gone) {
    if (now.branch !== before.branch)
      publish(topic, now.branch === 'HEAD' ? 'WARN' : 'INFO',
              now.branch === 'HEAD'
                ? `detached HEAD at ${now.head.slice(0, 8)} (was on ${before.branch})`
                : `switched branch ${before.branch} -> ${now.branch}`,
              { repo, host, change: 'branch', from: before.branch, to: now.branch });

    if (now.head !== before.head) {
      const ff = await isAncestor(repo, before.head, now.head);
      if (ff) {
        const commits = await commitsBetween(repo, before.head, now.head);
        for (const c of commits ?? [])
          publish(topic, 'INFO', `${c.subject}`, {
            repo, host, change: 'commit', branch: now.branch,
            sha: c.sha.slice(0, 12), author: c.author, when: c.when,
            ...(c.stat ? { stat: c.stat } : {}),
          });
        if (!commits?.length)
          publish(topic, 'INFO', `HEAD moved to ${now.head.slice(0, 8)}`,
                  { repo, host, change: 'head', branch: now.branch, sha: now.head.slice(0, 12) });
      } else {
        // The old HEAD is no longer reachable: a rebase, an amend, a reset
        // or a force-pull. Unremarkable on your own branch and the worst
        // news of the day on a shared one, and nothing here can tell which.
        publish(topic, 'WARN',
                `history rewritten on ${now.branch}: ${before.head.slice(0, 8)} is no longer an ancestor of ${now.head.slice(0, 8)}`,
                { repo, host, change: 'rewrite', branch: now.branch,
                  was: before.head.slice(0, 12), now: now.head.slice(0, 12) });
      }
    }

    // Only the transitions. The count changing from 3 to 4 while someone
    // is typing is not news; clean becoming dirty, or dirty becoming
    // clean, is.
    if (!!now.dirty !== !!before.dirty)
      publish(topic, 'DEBUG',
              now.dirty ? `working tree dirty (${now.dirty} file(s))` : 'working tree clean',
              { repo, host, change: now.dirty ? 'dirty' : 'clean', files: String(now.dirty) });

    const hadConflicts = before.conflicts.length > 0;
    if (now.conflicts.length && !hadConflicts)
      publish(topic, 'WARN', `merge conflicts in ${now.conflicts.length} file(s)`,
              { repo, host, change: 'conflict', files: now.conflicts.slice(0, 20).join(' ') });
    else if (!now.conflicts.length && hadConflicts)
      publish(topic, 'INFO', 'conflicts resolved',
              { repo, host, change: 'conflict-resolved' });

    const stateNow = now.state.join(' ');
    const stateBefore = before.state.join(' ');
    if (stateNow !== stateBefore)
      publish(topic, stateNow ? 'WARN' : 'INFO',
              stateNow ? `${stateNow.toLowerCase().replace(/_head|_log/g, '')} in progress`
                       : 'merge/rebase finished',
              { repo, host, change: 'state', state: stateNow || 'none' });

    for (const t of now.tags)
      if (!before.tags.has(t))
        publish(topic, 'INFO', `tag ${t}`, { repo, host, change: 'tag', tag: t });

    if (now.behind !== before.behind && now.behind)
      publish(topic, 'INFO', `${now.behind} commit(s) behind upstream`,
              { repo, host, change: 'behind', behind: String(now.behind), ahead: String(now.ahead) });
  }

  prev.set(repo, now);
}

async function loop() {
  for (const r of repos) await tick(r);
  await flush();
  if (once) return;
  setTimeout(loop, intervalMs);
}

console.error(`superlog-git: watching ${repos.length} repo(s)${dest ? ` on ${dest}` : ''}` +
              `${once ? '' : ` every ${intervalMs / 1000}s`} -> git.${host}.<repo>`);
await loop();
