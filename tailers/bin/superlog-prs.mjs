#!/usr/bin/env node
//
//  superlog-prs - pull requests, watched; silence, alarmed.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Born from a real failure: a reviewer requested changes, the request
//  sat unanswered for 51 days, and the PR was closed as stale. Nobody
//  rejected it - it aged out, invisibly. The state "a PR is waiting on
//  US" must age on the bench like everything else: visibly, and with an
//  alarm before it becomes an apology.
//
//  Two watch modes, combinable:
//    --author <login>   every open PR that login authored, ANYWHERE on
//                       GitHub (the DefiLlama case: your PR in someone
//                       else's repo), plus recently closed ones - closed
//                       WITHOUT merge is an ERROR, because that is what
//                       "closed as stale" looks like from outside.
//    --repo <owner/name> open PRs on a repo you tend.
//
//  Waiting-on-us is computed, not guessed: a CHANGES_REQUESTED review or
//  a non-author comment newer than the author's last activity starts the
//  clock. Crossing --warn-days (default 3) is one WARN; 3x that is one
//  ERROR; a reply resets it with a recovery. Every poll also publishes a
//  DEBUG row per PR so the viewers' PRs window is always current, with
//  days_waiting riding as a metric.
//
//  Crossings ALSO fire the alarm gateway (dedup key pr:<repo>#<n>, so a
//  PR nagging for a week is ONE alarm with a repeat count, recovery
//  closing the loop, desktop/telegram per your channels) - unless
//  --no-alarm, or no gateway answers, which is said once and honestly.
//
//  gh carries the wire (auth included) - the same bargain as curl in the
//  shell SDK. Zero node dependencies.
//
//    superlog-prs --author bankcoincapital --author saxonnicholls
//    superlog-prs --repo DefiLlama/DefiLlama-Adapters --once
//

import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { loadEnv } from './env.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};
const optAll = (name) => {
  const out = [];
  for (let i = 0; i < args.length - 1; i++)
    if (args[i] === `--${name}`) out.push(args[i + 1]);
  return out;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-prs - pull requests watched, silence alarmed

  superlog-prs [--author LOGIN]... [--repo OWNER/NAME]...
               [--warn-days 3] [--interval 300] [--once] [--no-alarm]
               [--url HUB]

Reads .env: SUPER_LOG_PR_AUTHORS, SUPER_LOG_PR_REPOS (comma-separated),
SUPER_LOG_PR_WARN_DAYS. Publishes to pr.<owner>.<repo>. A PR waiting on
us past --warn-days is ONE WARN (3x is ONE ERROR, recovery announced),
also fired at the alarm gateway with dedup key pr:<repo>#<n>. A PR of
ours closed WITHOUT merge is an ERROR - that is "closed as stale" seen
from outside. Needs the gh CLI, authenticated.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const authors = [...optAll('author'),
                 ...(env.SUPER_LOG_PR_AUTHORS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
const repos = [...optAll('repo'),
               ...(env.SUPER_LOG_PR_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
const warnDays = Number(opt('warn-days', env.SUPER_LOG_PR_WARN_DAYS ?? 3)) || 3;
const intervalS = Number(opt('interval', 300)) || 300;
const once = args.includes('--once');
const useAlarm = !args.includes('--no-alarm');
const alarmUrl = env.SUPER_LOG_ALARM_URL ?? 'http://127.0.0.1:7336';
const alarmToken = env.SUPER_LOG_ALARM_TOKEN ?? '';

if (!authors.length && !repos.length) {
  console.error('superlog-prs: nothing to watch - give --author and/or --repo ' +
                '(or SUPER_LOG_PR_AUTHORS / SUPER_LOG_PR_REPOS in .env)');
  process.exit(2);
}

const device = hostname().split('.')[0].toLowerCase();
const session = randomBytes(4).toString('hex');
let seq = 0;
const buffers = new Map();      // topic -> lines

function publish(topic, level, msg, fields, metric) {
  if (!buffers.has(topic)) buffers.set(topic, []);
  buffers.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'prs', platform: 'github', device },
    tag: 'pr', msg,
    ...(metric ? { metric } : {}),
    ...(fields && Object.keys(fields).length
      ? { fields: Object.fromEntries(Object.entries(fields)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, String(v)])) }
      : {}),
  }));
}

async function flush() {
  for (const [topic, lines] of buffers) {
    if (!lines.length) continue;
    const body = lines.join('\n');
    buffers.set(topic, []);
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
      });
    } catch { /* hub down; the next batch counts again */ }
  }
}

let alarmWarned = false;
async function fireAlarm(key, level, msg, fields, recovered = false) {
  if (!useAlarm) return;
  try {
    const r = await fetch(`${alarmUrl}/alarm/prs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-superlog-token': alarmToken },
      body: JSON.stringify(recovered ? { key, recovered: true }
                                     : { key, level, msg, fields }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`gateway ${r.status}`);
  } catch (e) {
    if (!alarmWarned) {
      alarmWarned = true;
      console.error(`superlog-prs: alarm gateway not answering at ${alarmUrl} ` +
                    `(${String(e.message ?? e)}) - PR alarms land on the hub only`);
    }
  }
}

// ------------------------------------------------------------------- gh

async function gh(path) {
  const { stdout } = await run('gh', ['api', path], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

const repoOf = (item) => item.repository_url.split('/repos/')[1];
const topicOf = (repo) => `pr.${repo.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace('/', '.')}`;
const dayMs = 86400000;

// Waiting-on-us is computed from the record, not guessed: the newest
// thing the AUTHOR did versus the newest thing anyone else did.
async function analyse(repo, number, author) {
  const [pr, reviews, comments, rcomments] = await Promise.all([
    gh(`repos/${repo}/pulls/${number}`),
    gh(`repos/${repo}/pulls/${number}/reviews?per_page=100`),
    gh(`repos/${repo}/issues/${number}/comments?per_page=100`),
    gh(`repos/${repo}/pulls/${number}/comments?per_page=100`),
  ]);
  const all = [...comments, ...rcomments].map((c) => ({
    who: c.user?.login ?? '', at: Date.parse(c.created_at),
  }));
  for (const r of reviews)
    all.push({ who: r.user?.login ?? '', at: Date.parse(r.submitted_at),
               state: r.state });
  let authorLast = Date.parse(pr.created_at);
  let otherLast = 0;
  let otherWho = '';
  let changesRequested = false;
  const latestReview = new Map();
  for (const r of reviews)
    latestReview.set(r.user?.login ?? '', r.state);
  for (const v of latestReview.values())
    if (v === 'CHANGES_REQUESTED') changesRequested = true;
  for (const a of all) {
    if (a.who === author) authorLast = Math.max(authorLast, a.at);
    else if (a.who && !a.who.includes('[bot]')) {
      if (a.at > otherLast) { otherLast = a.at; otherWho = a.who; }
    }
  }
  // The last non-bot word decides whose move it is - a requested change
  // we have not answered, a question left hanging, all reduce to this.
  const waitingOnUs = otherLast > authorLast;
  const since = waitingOnUs ? otherLast : authorLast;
  return {
    title: pr.title, url: pr.html_url, state: pr.merged_at ? 'merged' : pr.state,
    author, waitingOnUs, otherWho,
    days: (Date.now() - since) / dayMs,
    changesRequested,
  };
}

// ------------------------------------------------------------- the poll

const known = new Map();   // repo#n -> { phase: 'fresh'|'warn'|'error', open, closedAlarmed }

async function pollOne(repo, number, author) {
  const key = `${repo}#${number}`;
  let a;
  try {
    a = await analyse(repo, number, author);
  } catch (e) {
    console.error(`superlog-prs: cannot read ${key}: ${String(e.message ?? e).slice(0, 120)}`);
    return;
  }
  const topic = topicOf(repo);
  const st = known.get(key) ?? { phase: 'fresh', open: true, closedAlarmed: false };
  const waitStr = a.waitingOnUs
    ? `waiting on US ${a.days.toFixed(1)}d${a.changesRequested ? ' (changes requested)' : ''} - last word ${a.otherWho}`
    : `waiting on them ${a.days.toFixed(1)}d`;

  if (a.state !== 'open') {
    if (st.open && !st.closedAlarmed) {
      st.closedAlarmed = true;
      st.open = false;
      if (a.state === 'merged') {
        publish(topic, 'INFO', `#${number} MERGED: ${a.title}`,
                { repo, number, title: a.title, url: a.url, state: 'merged', author });
        await fireAlarm(`pr:${key}`, 'INFO', '', {}, true);
      } else {
        // The DefiLlama lesson: closed-without-merge IS the alarm. It
        // usually means stale, and stale means we went silent.
        publish(topic, 'ERROR',
          `#${number} CLOSED WITHOUT MERGE: ${a.title} - if this was ` +
          'staleness, the silence was ours',
          { repo, number, title: a.title, url: a.url, state: 'closed', author });
        await fireAlarm(`pr-closed:${key}`, 'ERROR',
          `PR closed without merge: ${key} - ${a.title}`,
          { repo, number: String(number), url: a.url });
      }
    }
    known.set(key, st);
    return;
  }

  st.open = true;
  const phase = !a.waitingOnUs ? 'fresh'
              : a.days >= warnDays * 3 ? 'error'
              : a.days >= warnDays ? 'warn' : 'fresh';

  // The row, every poll: the window's data, days as a reading.
  publish(topic, 'DEBUG', `#${number} ${a.title} - ${waitStr}`,
          { repo, number, title: a.title, url: a.url, state: 'open', author,
            waiting_on: a.waitingOnUs ? 'us' : 'them',
            days_waiting: a.days.toFixed(1),
            changes_requested: a.changesRequested ? 'yes' : '',
            last_actor: a.otherWho },
          { name: 'pr.days_waiting', value: Number(a.days.toFixed(2)) });

  // The crossings, once each way.
  if (phase !== st.phase) {
    if (phase === 'warn' || phase === 'error') {
      const lvl = phase === 'error' ? 'ERROR' : 'WARN';
      publish(topic, lvl,
        `#${number} has waited on us ${a.days.toFixed(1)}d` +
        `${a.changesRequested ? ' since changes were requested' : ''}: ${a.title}`,
        { repo, number, title: a.title, url: a.url, days: a.days.toFixed(1) });
      await fireAlarm(`pr:${key}`, lvl,
        `PR waiting on us ${a.days.toFixed(1)}d: ${key} - ${a.title}`,
        { repo, number: String(number), url: a.url, days: a.days.toFixed(1) });
    } else if (st.phase === 'warn' || st.phase === 'error') {
      publish(topic, 'INFO',
        `RECOVERED: #${number} answered - no longer waiting on us: ${a.title}`,
        { repo, number, title: a.title, url: a.url });
      await fireAlarm(`pr:${key}`, 'INFO', '', {}, true);
    }
    st.phase = phase;
  }
  known.set(key, st);
}

async function discover() {
  const targets = new Map();  // repo#n -> {repo, number, author}
  for (const login of authors) {
    try {
      const open = await gh(`search/issues?q=${encodeURIComponent(`is:pr author:${login} is:open`)}&per_page=50`);
      for (const it of open.items ?? [])
        targets.set(`${repoOf(it)}#${it.number}`,
                    { repo: repoOf(it), number: it.number, author: login });
      const cutoff = new Date(Date.now() - 14 * dayMs).toISOString().slice(0, 10);
      const closed = await gh(`search/issues?q=${encodeURIComponent(`is:pr author:${login} is:closed closed:>=${cutoff}`)}&per_page=30`);
      for (const it of closed.items ?? [])
        targets.set(`${repoOf(it)}#${it.number}`,
                    { repo: repoOf(it), number: it.number, author: login });
    } catch (e) {
      console.error(`superlog-prs: search for ${login} failed: ${String(e.message ?? e).slice(0, 120)}`);
    }
  }
  for (const repo of repos) {
    try {
      const open = await gh(`repos/${repo}/pulls?state=open&per_page=50`);
      for (const pr of open)
        targets.set(`${repo}#${pr.number}`,
                    { repo, number: pr.number, author: pr.user?.login ?? '' });
    } catch (e) {
      console.error(`superlog-prs: cannot list ${repo}: ${String(e.message ?? e).slice(0, 120)}`);
    }
  }
  return targets;
}

async function poll() {
  const targets = await discover();
  for (const t of targets.values())
    await pollOne(t.repo, t.number, t.author);
  // PRs that vanished from every search (old closes ageing out) keep
  // their last published state; the viewers grey them by age.
  await flush();
}

const main = async () => {
  try { await run('gh', ['auth', 'status'], { timeout: 15000 }); }
  catch {
    console.error('superlog-prs: gh is not authenticated - run `gh auth login`');
    process.exit(1);
  }
  await poll();
  if (once) {
    console.error(`superlog-prs: one pass over ${authors.length} author(s), ${repos.length} repo(s)`);
    process.exit(0);
  }
  setInterval(() => void poll(), intervalS * 1000);
  console.error(`superlog-prs: watching ${authors.join(',') || '-'} / ${repos.join(',') || '-'} ` +
                `every ${intervalS}s, warn at ${warnDays}d -> ${hubUrl}`);
};

void main();
