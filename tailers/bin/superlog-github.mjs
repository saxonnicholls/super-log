#!/usr/bin/env node
//
//  superlog-github - a GitHub repository on the same screen as the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  The local git watcher answers "what changed here". This answers "what
//  changed there" - pushes you have not pulled, a CI run that went red, a
//  pull request someone opened while you were heads-down, a release that
//  shipped. The point is not to replace the GitHub UI; it is that a failing
//  workflow lands in the same ordered stream as the build that failed
//  locally and the service that restarted, so the sequence is visible
//  without three browser tabs and a guess about timing.
//
//    superlog-github --repo owner/name
//    superlog-github --repo a/b --repo c/d --interval 120
//    superlog-github --repo owner/name --once        # current state, then exit
//    superlog-github --repo owner/name --only runs   # just CI
//
//  Publishes to github.<owner>.<repo>. First poll is a silent baseline;
//  after that only changes are reported.
//
//  Auth: GITHUB_TOKEN (or SUPER_LOG_GITHUB_TOKEN) from the environment or
//  .env. Public repositories work without one at 60 requests an hour, which
//  is enough for one repo at the default interval and not enough for four.
//  A token raises that to 5000 and is required for private repositories.
//
//  Conditional requests: every poll sends the previous ETag, and GitHub's
//  304 does not count against the rate limit. A watcher that burns its own
//  quota polling an idle repository is a watcher that stops working at the
//  moment something finally happens.
//
//  Read-only: only GET, and nothing here can write to a repository.
//
//  Node >= 18.
//

import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const optAll = (name) =>
  args.reduce((acc, a, i) => (a === `--${name}` && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-github - pushes, CI runs, pull requests and releases

  superlog-github --repo OWNER/NAME [--repo ...] [--once] [--interval SECONDS]
                  [--only runs,commits,pulls,issues,releases] [--url HUB]

Publishes to github.<owner>.<repo>. First poll is a silent baseline; after
that only changes are reported. Set GITHUB_TOKEN for private repos and a
5000/hour rate limit (public repos work without one at 60/hour).`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const token = env.SUPER_LOG_GITHUB_TOKEN ?? env.GITHUB_TOKEN ??
              process.env.SUPER_LOG_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
const once = args.includes('--once');
// 60s by default: GitHub's own guidance, and fast enough that a red build
// reaches the bench while you are still looking at what you pushed.
const intervalMs = Number(opt('interval', env.SUPER_LOG_GITHUB_INTERVAL ?? '60')) * 1000;

const repos = optAll('repo').length
  ? optAll('repo')
  : (env.SUPER_LOG_GITHUB_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!repos.length) {
  console.error('superlog-github: --repo owner/name is required (or SUPER_LOG_GITHUB_REPOS)');
  process.exit(2);
}
for (const r of repos) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) {
    console.error(`superlog-github: '${r}' is not owner/name`);
    process.exit(2);
  }
}

const ALL = ['runs', 'commits', 'pulls', 'issues', 'releases'];
const only = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = only.length ? ALL.filter((k) => only.includes(k)) : ALL;

// ------------------------------------------------------------------- API

const API = 'https://api.github.com';
const etags = new Map();     // url -> etag
let rateRemaining = null;
let rateWarned = false;
const missing = new Set();

/** GET one endpoint. Returns null on 304 (nothing changed), on any error,
 *  and on rate-limit exhaustion - callers treat "no data" as "no news",
 *  which is what keeps a flaky network from inventing events. */
async function api(path, topic) {
  const url = `${API}${path}`;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'super-log',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(etags.has(url) ? { 'if-none-match': etags.get(url) } : {}),
  };
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    publish(topic, 'WARN', `github unreachable: ${String(e.message ?? e)}`,
            { change: 'api-error', path });
    return null;
  }

  const rem = res.headers.get('x-ratelimit-remaining');
  if (rem !== null) rateRemaining = Number(rem);
  if (res.status === 304) return null;

  if (res.status === 403 || res.status === 429) {
    // Say it once. A rate-limited watcher that reports being rate-limited
    // every poll is its own denial of service on the reader's attention.
    if (!rateWarned) {
      const reset = res.headers.get('x-ratelimit-reset');
      const when = reset ? new Date(Number(reset) * 1000).toISOString() : 'unknown';
      publish(topic, 'WARN',
              `github rate limit reached${token ? '' : ' (no GITHUB_TOKEN: 60 requests/hour)'} - resets ${when}`,
              { change: 'rate-limit', resets: when, token: token ? 'yes' : 'no' });
      rateWarned = true;
    }
    return null;
  }
  rateWarned = false;

  if (res.status === 404) {
    // Once per repo, not once per endpoint: a missing repository 404s on
    // all five and reads as five separate problems.
    if (!missing.has(topic)) {
      publish(topic, 'ERROR',
              `repository not found or not visible to this token${token ? '' : ' (no GITHUB_TOKEN, so private repos are invisible)'}`,
              { change: 'not-found', path });
      missing.add(topic);
    }
    return null;
  }
  missing.delete(topic);
  if (!res.ok) {
    publish(topic, 'WARN', `github ${res.status} on ${path}`, { change: 'api-error', path });
    return null;
  }

  const tag = res.headers.get('etag');
  if (tag) etags.set(url, tag);
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();
let seq = 0;

function publish(topic, level, msg, fields) {
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'github-watcher', platform: 'github', device: 'github' },
    tag: 'github', msg, fields,
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

// ------------------------------------------------------------------ state

const seen = new Map();   // repo -> { runs:Map, commits:Set, pulls:Map, issues:Map, releases:Set }
const fresh = () => ({ runs: new Map(), commits: new Set(), pulls: new Map(),
                       issues: new Map(), releases: new Set() });

// A workflow run is the one thing here with a verdict, so it is the one
// thing that gets a level above INFO. `conclusion` is null while running.
const RUN_LEVEL = {
  success: 'INFO', failure: 'ERROR', timed_out: 'ERROR', startup_failure: 'ERROR',
  cancelled: 'WARN', action_required: 'WARN', stale: 'WARN', neutral: 'INFO',
  skipped: 'DEBUG',
};

async function tick(repo) {
  const [owner, name] = repo.split('/');
  const topic = opt('topic', `github.${owner.toLowerCase()}.${name.toLowerCase()}`);
  const first = !seen.has(repo);
  const state = seen.get(repo) ?? fresh();

  if (want.includes('runs')) {
    const d = await api(`/repos/${repo}/actions/runs?per_page=20`, topic);
    for (const r of d?.workflow_runs ?? []) {
      const key = String(r.id);
      const status = r.conclusion ?? r.status;   // queued/in_progress until it ends
      if (state.runs.get(key) === status) continue;
      const known = state.runs.has(key);
      state.runs.set(key, status);
      if (first || once) continue;
      // A run appearing mid-flight is news; each intermediate status of a
      // run already seen is not, or one push becomes four rows.
      if (known && !r.conclusion) continue;
      publish(topic, RUN_LEVEL[r.conclusion] ?? 'DEBUG',
              `CI ${status}: ${r.name} on ${r.head_branch}`,
              { change: 'workflow', repo, workflow: r.name, status,
                branch: r.head_branch, sha: (r.head_sha ?? '').slice(0, 12),
                actor: r.actor?.login ?? '', run: String(r.run_number ?? ''),
                url: r.html_url ?? '' });
    }
  }

  if (want.includes('commits')) {
    const d = await api(`/repos/${repo}/commits?per_page=20`, topic);
    // Oldest first, so a push of five commits reads in the order it was made.
    for (const c of (Array.isArray(d) ? d : []).slice().reverse()) {
      if (state.commits.has(c.sha)) continue;
      state.commits.add(c.sha);
      if (first || once) continue;
      publish(topic, 'INFO', (c.commit?.message ?? '').split('\n')[0], {
        change: 'commit', repo, sha: c.sha.slice(0, 12),
        author: c.commit?.author?.name ?? c.author?.login ?? '',
        when: c.commit?.author?.date ?? '', url: c.html_url ?? '',
      });
    }
  }

  if (want.includes('pulls')) {
    const d = await api(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=20`, topic);
    for (const p of Array.isArray(d) ? d : []) {
      const status = p.merged_at ? 'merged' : p.state;
      const key = String(p.number);
      if (state.pulls.get(key) === status) continue;
      state.pulls.set(key, status);
      if (first || once) continue;
      publish(topic, 'INFO', `PR #${p.number} ${status}: ${p.title}`, {
        change: 'pull', repo, number: String(p.number), status,
        author: p.user?.login ?? '', branch: p.head?.ref ?? '', url: p.html_url ?? '',
      });
    }
  }

  if (want.includes('issues')) {
    const d = await api(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=20`, topic);
    for (const i of Array.isArray(d) ? d : []) {
      if (i.pull_request) continue;   // the issues endpoint returns PRs too
      const key = String(i.number);
      if (state.issues.get(key) === i.state) continue;
      state.issues.set(key, i.state);
      if (first || once) continue;
      publish(topic, i.state === 'open' ? 'INFO' : 'DEBUG',
              `issue #${i.number} ${i.state}: ${i.title}`,
              { change: 'issue', repo, number: String(i.number), status: i.state,
                author: i.user?.login ?? '', url: i.html_url ?? '' });
    }
  }

  if (want.includes('releases')) {
    const d = await api(`/repos/${repo}/releases?per_page=10`, topic);
    for (const r of Array.isArray(d) ? d : []) {
      if (state.releases.has(r.id)) continue;
      state.releases.add(r.id);
      if (first || once) continue;
      publish(topic, 'INFO', `release ${r.tag_name}: ${r.name ?? ''}`.trim(), {
        change: 'release', repo, tag: r.tag_name ?? '',
        draft: String(!!r.draft), url: r.html_url ?? '',
      });
    }
  }

  if (once) {
    const runs = [...state.runs.values()];
    const failing = runs.filter((s) => s === 'failure' || s === 'timed_out').length;
    const open = [...state.pulls.values()].filter((s) => s === 'open').length;
    const issues = [...state.issues.values()].filter((s) => s === 'open').length;
    publish(topic, failing ? 'WARN' : 'INFO',
            `${repo}: ${state.commits.size} recent commit(s), ${runs.length} CI run(s)` +
            `${failing ? `, ${failing} failing` : ''}, ${open} open PR(s), ${issues} open issue(s)`,
            { change: 'inventory', repo, commits: String(state.commits.size),
              runs: String(runs.length), failing: String(failing),
              open_pulls: String(open), open_issues: String(issues),
              rate_remaining: String(rateRemaining ?? '') });
  }

  seen.set(repo, state);
}

async function loop() {
  for (const r of repos) await tick(r);
  await flush();
  if (once) return;
  setTimeout(loop, intervalMs);
}

console.error(`superlog-github: watching ${repos.join(', ')}` +
              `${once ? '' : ` every ${intervalMs / 1000}s`}` +
              `${token ? '' : ' (no token: 60 requests/hour)'} -> github.<owner>.<repo>`);
await loop();
