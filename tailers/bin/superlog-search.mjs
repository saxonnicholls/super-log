#!/usr/bin/env node
//
//  superlog-search - what happened at 3am.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The hub's retention is minutes (a per-topic ring of recent events) and
//  the journal's is however much disk you have - but until now nothing
//  could read the journal back, so the long history was write-only. This
//  is the reader: the same filters as GET /recent, over files instead of
//  a ring, printing the same line the viewers print.
//
//    superlog-search --since 2h --level ERROR
//    superlog-search --topic expo. --contains "order 7" --limit 50
//    superlog-search --since 03:00 --until 04:00 --count
//    superlog-search --trace 9f1c0a2b7d4e5f60 --json | jq .
//
//  Bounded by default and honest about it: an unfiltered grep over a
//  multi-gigabyte journal that prints everything it finds is how a terminal
//  hangs. The newest `--limit` matches are kept and the footer says how many
//  there were in total; --head keeps the oldest instead and stops early.
//
//  --since/--until window on the frame's HUB ARRIVAL time, while each line
//  shows the producer's own `ts`. On a healthy bench they agree to the
//  millisecond; when a phone's clock is wrong they do not, and PROTOCOL.md
//  is clear about which of the two is truth.
//
//  Node >= 18. Reads .ndjson and .ndjson.gz.
//

import {
  LEVELS,
  formatRow,
  journalFiles,
  levelRank,
  matchRow,
  parseWhen,
  readFrames,
  rowsOf,
} from './journal-read.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const USAGE = `usage: superlog-search [filters]

  --dir <path>        journal directory or one file (default ./superlog-journal,
                      or $SUPER_LOG_JOURNAL)
  --since <when>      30m | 2h | 3d | 03:00 | 2026-08-22 | full ISO (UTC).
                      Windows on hub arrival time, not the producer's clock
  --until <when>      same forms
  --topic <t>         exact topic, or a prefix ending in a dot (cpp.), or *
  --level <L>         minimum level: ${LEVELS.join(' ')}
  --contains <text>   case-insensitive substring of the whole event
  --trace <id>        one correlation id, across every stream
  --limit <n>         max events shown (default 200); the NEWEST matches
  --head              keep the OLDEST matches instead, and stop reading early
  --json              raw events as NDJSON: {seq, ts_ms, topic, event}
  --count             totals per topic only, no lines

exit 0 if something matched, 1 if nothing did, 2 on a bad argument.`;

if (has('help') || has('h')) {
  console.log(USAGE);
  process.exit(0);
}

let filter;
let dir;
let limit;
try {
  dir = opt('dir', process.env.SUPER_LOG_JOURNAL ?? './superlog-journal');
  limit = Math.max(1, Number(opt('limit', '200')) || 200);
  const level = opt('level', '');
  if (level && !LEVELS.includes(level.toUpperCase()))
    throw new Error(`unknown level ${JSON.stringify(level)} - one of ${LEVELS.join(' ')}`);
  filter = {
    topic: opt('topic', ''),
    contains: (opt('contains', '') || '').toLowerCase(),
    trace: opt('trace', ''),
    since: parseWhen(opt('since', '')),
    until: parseWhen(opt('until', '')),
    minLevel: level ? levelRank(level) : 0,
  };
} catch (e) {
  console.error(`superlog-search: ${e.message}\n\n${USAGE}`);
  process.exit(2);
}

const asJson = has('json');
const countOnly = has('count');
const head = has('head');

const files = journalFiles(dir);
if (files.length === 0) {
  console.error(
    `superlog-search: no journal files at ${dir}\n` +
      `Nothing has been written there. Start the writer with: npm run journal`,
  );
  process.exit(1);
}

const started = Date.now();
const stats = { files: 0, frames: 0, events: 0, matched: 0, bad: 0 };
const perTopic = new Map();
// Bounded on purpose: only `limit` rows are ever held, however big the
// journal is. Counting continues past the cap so the footer can be honest
// about what was left out. Tail mode overwrites in place rather than
// shifting - the same ring the hub keeps, for the same reason.
const kept = [];
let ringAt = 0;
function keep(row) {
  if (head || kept.length < limit) kept.push(row);
  else {
    kept[ringAt] = row;
    ringAt = (ringAt + 1) % limit;
  }
}
const keptInOrder = () =>
  kept.length < limit || ringAt === 0 ? kept : [...kept.slice(ringAt), ...kept.slice(0, ringAt)];

let earliest;
let latest;

for await (const frame of readFrames(files, {
  topic: filter.topic,
  contains: filter.contains,
  since: filter.since,
  until: filter.until,
  onFile: () => stats.files++,
  onBadLine: () => stats.bad++,
  onFileError: (path, e) => console.error(`superlog-search: ${path}: ${e.message}`),
})) {
  stats.frames++;
  for (const row of rowsOf(frame)) {
    stats.events++;
    if (!matchRow(row, filter)) continue;
    stats.matched++;

    const t = perTopic.get(row.topic) ?? { n: 0, levels: {} };
    t.n++;
    const lv = String(row.ev.level ?? 'INFO').toUpperCase();
    t.levels[lv] = (t.levels[lv] ?? 0) + 1;
    perTopic.set(row.topic, t);
    if (earliest === undefined || row.at < earliest) earliest = row.at;
    if (latest === undefined || row.at > latest) latest = row.at;

    if (countOnly) continue;
    keep(row);
    if (head && kept.length >= limit) break;
  }
  // --head is the escape hatch for a journal too big to scan: the oldest
  // `limit` matches are already in hand, so stop rather than read the rest.
  if (head && kept.length >= limit) break;
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
const n = (x) => x.toLocaleString('en-US');

if (countOnly) {
  const rows = [...perTopic.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [topic, t] of rows) {
    const mix = LEVELS.filter((l) => t.levels[l])
      .map((l) => `${l}:${t.levels[l]}`)
      .join(' ');
    console.log(`${String(t.n).padStart(9)}  ${topic}  ${mix}`);
  }
  console.log(`${String(stats.matched).padStart(9)}  TOTAL across ${perTopic.size} topic(s)`);
} else {
  // The date only earns a column when the answer spans more than one day;
  // otherwise this is exactly the line the viewers show.
  const rows = keptInOrder();
  const withDate = new Set(rows.map((r) => r.ts.slice(0, 10))).size > 1;
  for (const row of rows) {
    if (asJson)
      console.log(JSON.stringify({ seq: row.seq, ts_ms: row.ts_ms, topic: row.topic, event: row.ev }));
    else console.log(formatRow(row, { date: withDate }));
  }
}

const span =
  earliest === undefined
    ? ''
    : `  hub time ${new Date(earliest).toISOString().replace('T', ' ').slice(0, 19)}Z .. ` +
      `${new Date(latest).toISOString().replace('T', ' ').slice(0, 19)}Z`;
console.error(
  `superlog-search: ${n(stats.files)} file(s), ${n(stats.frames)} frames, ` +
    `${n(stats.events)} events, ${n(stats.matched)} match(es) in ${secs}s${span}`,
);
if (!countOnly && stats.matched > kept.length)
  console.error(
    `superlog-search: showing the ${head ? 'oldest' : 'newest'} ${n(kept.length)} of ` +
      `${n(stats.matched)} - narrow with --since/--topic/--level, or raise --limit`,
  );
if (head && !countOnly && stats.matched >= limit)
  console.error('superlog-search: --head stopped early, so the totals above cover only what was read');
if (stats.bad)
  console.error(`superlog-search: skipped ${n(stats.bad)} unreadable line(s) - the journal is not all JSON`);

// exitCode, not exit(): stdout to a pipe is asynchronous, and exiting on the
// spot would truncate the results this tool exists to print.
process.exitCode = stats.matched > 0 ? 0 : 1;
