#!/usr/bin/env node
//
//  superlog-mcp - the bench, as tools an agent can call.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  An agent debugging an app should be able to ask "what did the logs say
//  just now" without a human copying lines into a chat. This is an MCP
//  server over stdio: it wraps the hub's GET /recent and /healthz in five
//  tools, plus a sixth that reads the journal on disk when the question is
//  older than the hub's few minutes of memory. Every one of them is
//  designed around the fact that an agent's context is small and the
//  firehose is not - one 8-second sample of a
//  single OS stream on this bench was 8,400 events. So: filters first,
//  hard caps everywhere, compact one-line output, and a summarise tool that
//  answers "what is going on" in a paragraph instead of ten thousand rows.
//
//  Dependency-free on purpose (the house rule for the JS packages): MCP
//  over stdio is newline-delimited JSON-RPC 2.0, which is small enough to
//  own outright rather than pin a toolchain for.
//
//    claude mcp add super-log -- npx -y superlog-mcp
//    SUPER_LOG_URL=http://127.0.0.1:7333 superlog-mcp
//
//  Wire contract: ../../../../docs/PROTOCOL.md
//

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const HUB = process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333';
const JOURNAL = process.env.SUPER_LOG_JOURNAL ?? './superlog-journal';

// The bench explained to agents: one detailed entry per logging capability
// plus step-by-step playbooks, maintained as data (guide.json) so the
// documentation is queryable rather than baked into tool descriptions -
// an agent's context is small, and the guide is fetched only when needed.
// House rule: every logging capability ships a detailed README entry AND a
// detailed entry there.
let GUIDE = { streams: {}, playbooks: {} };
try {
  GUIDE = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'guide.json'), 'utf8'));
} catch {
  /* a missing or broken guide degrades to empty, never to a dead server */
}
const guideEntry = ([name, e]) =>
  `## ${name} (${e.topics})\n${e.what}\nReading it: ${e.read}\nGotchas: ${e.gotchas}`;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

// Caps, not suggestions. An agent that asks for everything gets a usable
// slice and a note saying so - which is friendlier than a blown context.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_WAIT_MS = 120000;
// A journal can be gigabytes. A tool call that reads all of it is a tool
// call the agent is still waiting on, so the scan has a deadline and says
// when it hit one.
const MAX_SCAN_MS = 15000;

// ---------------------------------------------------------------- the hub

async function hubGet(path) {
  const res = await fetch(`${HUB}${path}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`hub answered ${res.status} for ${path}`);
  return res.json();
}

/** Every tool goes through here, so "the bench is not running" is one clear
 *  sentence rather than a stack trace an agent has to interpret. */
async function hubOrExplain(path) {
  try {
    return { ok: true, data: await hubGet(path) };
  } catch (e) {
    const why = String(e?.message ?? e);
    const down = /ECONNREFUSED|fetch failed|timeout|abort/i.test(why);
    return {
      ok: false,
      text: down
        ? `The super-log hub is not reachable at ${HUB}.\n` +
          `Start it with ./scripts/dev.sh (or npm run demo for the full bench), ` +
          `or set SUPER_LOG_URL if it listens elsewhere.\n(${why})`
        : `The hub at ${HUB} could not answer: ${why}`,
    };
  }
}

// -------------------------------------------------------------- the journal
//
// Everything above reads the hub's ring, which is minutes deep. "What
// happened at 3am" is a different question and it is answered on disk: the
// files superlog-journal writes, which are hub envelope frames verbatim,
// one per line. Read a line at a time - a journal is measured in gigabytes
// and this process has to stay small.
//
// The filter rules here are deliberately duplicated from
// tailers/bin/journal-read.mjs rather than imported: this package ships
// `files: ["bin"]` and is meant to install standalone via npx, so it cannot
// reach across the repo. They are small and pinned by PROTOCOL.md - if one
// side changes, change both.

const levelRank = (l) => {
  const i = LEVELS.indexOf(String(l ?? '').toUpperCase());
  return i < 0 ? LEVELS.indexOf('INFO') : i; // tolerant-reader default
};

const topicMatches = (want, name) =>
  !want || want === '*' || want === name ||
  (want.endsWith('.') && name.length > want.length && name.startsWith(want));

const UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

/** `30m`, `2h`, `3d`, `03:00` (today), `2026-08-22`, or a full ISO stamp.
 *  Bare times are UTC, because UTC is what the events carry. */
function parseWhen(spec, now = Date.now()) {
  if (spec === undefined || spec === null || spec === '') return undefined;
  const s = String(spec).trim();
  if (s === 'now') return now;
  const rel = /^-?(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(s);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
  let iso = s;
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
  if (hm) iso = `${new Date(now).toISOString().slice(0, 10)}T${hm[1].padStart(2, '0')}:${hm[2]}:${hm[3] ?? '00'}Z`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += 'T00:00:00Z';
  else if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  const t = Date.parse(iso);
  if (!Number.isFinite(t))
    throw new Error(`cannot read a time from ${JSON.stringify(s)} - try 30m, 2h, 3d, 03:00 or a full ISO timestamp`);
  return t;
}

function journalFiles(where) {
  if (!existsSync(where)) return [];
  if (statSync(where).isFile()) return [where];
  return readdirSync(where)
    .filter((n) => /\.ndjson(\.gz)?$/.test(n))
    .sort()                                   // the writer's stamp sorts chronologically
    .map((n) => join(where, n));
}

/** Streams the journal and returns at most `limit` rows - the newest ones,
 *  the way /recent truncates - plus the totals needed to be honest about
 *  what was left out. */
async function searchJournal({ dir, topic, level, contains, trace, since, until, limit }) {
  const files = journalFiles(dir);
  const minLevel = level ? levelRank(level) : 0;
  const needle = contains ? String(contains).toLowerCase() : '';
  // A needle that JSON-escaping cannot touch also works as a gate on the raw
  // frame line, which skips the parse entirely for most of the journal.
  const fast = needle && /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/.test(contains) ? needle : '';
  const deadline = Date.now() + MAX_SCAN_MS;
  const stats = { files: 0, frames: 0, events: 0, matched: 0, bad: 0, timedOut: false };
  const kept = [];
  let ringAt = 0;
  let earliest, latest;
  let stop = false;

  for (const path of files) {
    stats.files++;
    const file = createReadStream(path);
    const input = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line) continue;
        if (Date.now() > deadline) {
          stats.timedOut = true;
          break;
        }
        const tm = /"topic":"([^"]*)"/.exec(line);
        if (topic && tm && !topicMatches(topic, tm[1])) continue;
        if (fast && !line.toLowerCase().includes(fast)) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          stats.bad++;                        // a truncated tail is still worth reading
          continue;
        }
        if (!frame || typeof frame.payload !== 'string' || typeof frame.topic !== 'string') {
          stats.bad++;
          continue;
        }
        if (topic && !topicMatches(topic, frame.topic)) continue;
        // The window is on hub arrival time, not the producer's `ts`:
        // arrival is monotonic (PROTOCOL.md - phone clocks drift, hub order
        // is the truth), so it needs no slack for skew and the scan can
        // stop the moment it passes `until`.
        if (Number.isFinite(frame.ts_ms)) {
          if (since !== undefined && frame.ts_ms < since) continue;
          if (until !== undefined && frame.ts_ms > until) {
            stop = true;
            break;
          }
        }
        stats.frames++;
        for (const raw of frame.payload.split('\n')) {
          const text = raw.trim();
          if (!text) continue;
          stats.events++;
          let ev;
          try {
            ev = JSON.parse(text);
            if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) ev = { msg: text };
          } catch {
            ev = { msg: text };               // PROTOCOL.md's tolerant-reader rule
          }
          const ts = typeof ev.ts === 'string' ? ev.ts : new Date(frame.ts_ms).toISOString();
          const at = frame.ts_ms;             // arrival, in the same terms as the window
          if (minLevel > 0 && levelRank(ev.level) < minLevel) continue;
          if (trace && ev.trace !== trace) continue;
          if (needle && !text.toLowerCase().includes(needle)) continue;
          stats.matched++;
          if (earliest === undefined || at < earliest) earliest = at;
          if (latest === undefined || at > latest) latest = at;
          const row = { seq: frame.seq, topic: frame.topic, event: ev.ts ? ev : { ...ev, ts } };
          if (kept.length < limit) kept.push(row);
          else {
            kept[ringAt] = row;
            ringAt = (ringAt + 1) % limit;
          }
        }
      }
    } finally {
      rl.close();
      input.destroy?.();
      file.destroy?.();
    }
    if (stats.timedOut || stop) break;
  }

  const rows = kept.length < limit || ringAt === 0 ? kept : [...kept.slice(ringAt), ...kept.slice(0, ringAt)];
  return { rows, stats, earliest, latest, fileCount: files.length };
}

// ------------------------------------------------------------- formatting

const timeOf = (ev) => (typeof ev.ts === 'string' ? ev.ts.slice(11, 23) : '------------');

/** One event, one line - what a human would read, minus the colour. */
function formatEvent(row) {
  const ev = row.event ?? {};
  let s = `${timeOf(ev)} ${row.topic} ${ev.level ?? 'INFO'}`;
  if (ev.tag) s += ` [${ev.tag}]`;
  s += ` ${ev.msg ?? ''}`;
  if (ev.metric) s += ` =${ev.metric.value}`;
  if (ev.fields) for (const [k, v] of Object.entries(ev.fields)) s += ` ${k}=${v}`;
  if (ev.src) s += ` (${ev.src})`;
  return s;
}

function formatEvents(data, note) {
  const lines = (data.events ?? []).map(formatEvent);
  const head = [];
  if (note) head.push(note);
  if (data.missed)
    head.push('WARNING: the ring moved past your cursor - some events were missed.');
  if (lines.length === 0) head.push('No matching events.');
  const tail = `\n---\ncursor: ${data.next} (pass as since= to continue)  shown: ${lines.length}`;
  return [...head, ...lines].join('\n') + (lines.length ? tail : '');
}

function query({ topic, level, since, limit, contains, trace }) {
  const p = new URLSearchParams();
  if (trace) p.set('trace', trace);
  if (since) p.set('since', String(since));
  // Ask the hub for more than we will show when we still have to filter
  // locally, so `contains` does not come back empty just because the first
  // page was uninteresting.
  p.set('limit', String(Math.min(MAX_LIMIT * (contains ? 5 : 1), 1000)));
  if (topic) p.set('topic', topic);
  if (level) p.set('level', level);
  return `/recent?${p.toString()}`;
}

function applyLocalFilters(data, { contains, limit }) {
  let events = data.events ?? [];
  if (contains) {
    const needle = contains.toLowerCase();
    events = events.filter((r) => JSON.stringify(r.event ?? {}).toLowerCase().includes(needle));
  }
  const capped = events.slice(-limit);
  return { ...data, events: capped, truncated: events.length > capped.length };
}

// ------------------------------------------------------------------ tools

const TOOLS = [
  {
    name: 'hub_status',
    description:
      'Check whether the super-log hub is running and how much traffic it has seen. ' +
      'Call this first when logs seem missing - it distinguishes "the bench is down" ' +
      'from "the app logged nothing".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await hubOrExplain('/healthz');
      if (!r.ok) return r.text;
      const s = r.data;
      return (
        `super-log hub is UP at ${HUB}\n` +
        `published: ${s.published} frames   delivered: ${s.delivered}   ` +
        `dropped: ${s.dropped}   subscribers: ${s.subscribers}\n` +
        (s.dropped > 0
          ? 'NOTE: dropped > 0 means a slow subscriber lost frames.\n'
          : '') +
        (s.published === 0
          ? 'No frames yet: nothing has logged to this hub since it started.'
          : '')
      );
    },
  },
  {
    name: 'list_streams',
    description:
      'Summarise which log streams (topics) are active and their level mix. ' +
      'Cheap orientation - call this before tail_logs so you know what topics ' +
      'exist and where the errors are, instead of guessing topic names.',
    inputSchema: {
      type: 'object',
      properties: {
        window: {
          type: 'number',
          description: 'How many recent events to summarise (default 1000, max 1000)',
        },
      },
      additionalProperties: false,
    },
    run: async ({ window: w }) => {
      const limit = Math.min(Math.max(Number(w) || 1000, 1), 1000);
      const r = await hubOrExplain(`/recent?limit=${limit}`);
      if (!r.ok) return r.text;
      const rows = r.data.events ?? [];
      if (!rows.length) return `No events in the hub's recent ring at ${HUB}.`;
      const by = new Map();
      for (const row of rows) {
        const lv = row.event?.level ?? 'INFO';
        const e = by.get(row.topic) ?? { n: 0, levels: {}, last: '' };
        e.n++;
        e.levels[lv] = (e.levels[lv] ?? 0) + 1;
        e.last = row.event?.msg ?? '';
        by.set(row.topic, e);
      }
      const lines = [...by.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .map(([topic, e]) => {
          const mix = LEVELS.filter((l) => e.levels[l])
            .map((l) => `${l}:${e.levels[l]}`)
            .join(' ');
          const bad = (e.levels.ERROR ?? 0) + (e.levels.CRITICAL ?? 0);
          return `${topic}  (${e.n} events) ${mix}${bad ? '  <-- has errors' : ''}\n` +
                 `    last: ${String(e.last).slice(0, 100)}`;
        });
      return (
        `${by.size} active stream(s) in the last ${rows.length} events at ${HUB}:\n\n` +
        lines.join('\n')
      );
    },
  },
  {
    name: 'tail_logs',
    description:
      'Read recent log events, newest last. ALWAYS narrow with topic and/or level - ' +
      'the firehose can be thousands of events per second. Returns a cursor; pass it ' +
      'back as `since` to read only what is new since your last call.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'Exact topic (cpp.clock), a prefix ending in a dot (cpp. matches all cpp streams), or * for all',
        },
        level: {
          type: 'string',
          enum: LEVELS,
          description: 'Minimum level; ERROR is the usual choice when hunting a bug',
        },
        since: { type: 'number', description: 'Cursor from a previous call; 0 or omitted starts from the oldest kept' },
        limit: { type: 'number', description: `Max events (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT})` },
        contains: { type: 'string', description: 'Only events whose text contains this (case-insensitive)' },
        trace: {
          type: 'string',
          description:
            'Follow ONE user action across every stream by its correlation id. This is the ' +
            'best tool for "what happened when X was pressed" - it deliberately ignores topic.',
        },
      },
      additionalProperties: false,
    },
    run: async (a) => {
      const limit = Math.min(Math.max(Number(a.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const r = await hubOrExplain(query({ ...a, limit }));
      if (!r.ok) return r.text;
      const data = applyLocalFilters(r.data, { contains: a.contains, limit });
      return formatEvents(
        data,
        data.truncated ? `(showing the most recent ${limit}; narrow further for the rest)` : '',
      );
    },
  },
  {
    name: 'search_logs',
    description:
      'Find events matching text across the recent window - use when you know what ' +
      'the message says (an exception, an order id, a URL) but not which stream it is in.',
    inputSchema: {
      type: 'object',
      properties: {
        contains: { type: 'string', description: 'Text to find (case-insensitive)' },
        topic: { type: 'string', description: 'Optional topic or prefix to narrow the search' },
        level: { type: 'string', enum: LEVELS, description: 'Optional minimum level' },
        limit: { type: 'number', description: `Max matches (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT})` },
      },
      required: ['contains'],
      additionalProperties: false,
    },
    run: async (a) => {
      const limit = Math.min(Math.max(Number(a.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const r = await hubOrExplain(query({ ...a, limit, since: 0 }));
      if (!r.ok) return r.text;
      const data = applyLocalFilters(r.data, { contains: a.contains, limit });
      return formatEvents(
        data,
        `Searching the recent window for ${JSON.stringify(a.contains)}: ${data.events.length} match(es).`,
      );
    },
  },
  {
    name: 'search_history',
    description:
      'Search the on-disk journal: hours or days of history, not the few minutes the ' +
      'hub keeps in memory. This is the tool for "what happened at 3am" or anything ' +
      'older than the live ring - tail_logs and search_logs cannot see that far back. ' +
      'Needs superlog-journal to have been running at the time.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description:
            'Start of the window: 30m, 2h, 3d, 03:00 (today, UTC), 2026-08-22, or a full ISO timestamp. ' +
            'Windows on hub arrival time, which is the only reliable clock across streams',
        },
        until: { type: 'string', description: 'End of the window, same forms as since' },
        topic: {
          type: 'string',
          description: 'Exact topic (cpp.clock), a prefix ending in a dot (expo. matches every device stream), or *',
        },
        level: { type: 'string', enum: LEVELS, description: 'Minimum level' },
        contains: { type: 'string', description: 'Case-insensitive substring of the whole event, fields included' },
        trace: { type: 'string', description: 'One correlation id, across every stream' },
        limit: { type: 'number', description: `Max events (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}); the NEWEST matches` },
        dir: { type: 'string', description: `Journal directory (default ${JOURNAL}, or $SUPER_LOG_JOURNAL)` },
      },
      additionalProperties: false,
    },
    run: async (a) => {
      const limit = Math.min(Math.max(Number(a.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const dir = a.dir || JOURNAL;
      const r = await searchJournal({
        dir,
        topic: a.topic,
        level: a.level,
        contains: a.contains,
        trace: a.trace,
        since: parseWhen(a.since),
        until: parseWhen(a.until),
        limit,
      });
      if (r.fileCount === 0)
        return (
          `No journal files at ${dir}.\n` +
          `History is only searchable if superlog-journal was running: start it with ` +
          `npm run journal (set SUPER_LOG_JOURNAL, or pass dir, if it writes elsewhere).\n` +
          `For the last few minutes, tail_logs reads the hub's live ring instead.`
        );
      const head = [
        `Journal ${dir}: ${r.stats.files} file(s), ${r.stats.events} events read, ` +
          `${r.stats.matched} match(es).`,
      ];
      if (r.earliest !== undefined)
        head.push(
          `Matches span ${new Date(r.earliest).toISOString()} .. ${new Date(r.latest).toISOString()} ` +
            `(hub arrival, UTC - the window filters on this, the lines show the producer's own clock).`,
        );
      if (r.stats.matched > r.rows.length)
        head.push(`Showing the newest ${r.rows.length}; narrow with since/topic/level for the rest.`);
      if (r.stats.timedOut)
        head.push(
          `WARNING: the scan stopped after ${MAX_SCAN_MS / 1000}s, so older files were not read. ` +
            `Narrow the window and ask again.`,
        );
      if (r.stats.bad) head.push(`${r.stats.bad} unreadable line(s) skipped.`);
      if (r.rows.length === 0) head.push('No matching events.');
      return [...head, '', ...r.rows.map(formatEvent)].join('\n');
    },
  },
  {
    name: 'wait_for',
    description:
      'Block until a matching event appears, then return it. This is the one to use ' +
      'after you trigger something: start the action, then wait for its log line or ' +
      'error rather than sleeping and hoping. Returns promptly on the first match.',
    inputSchema: {
      type: 'object',
      properties: {
        contains: { type: 'string', description: 'Text the event must contain (case-insensitive)' },
        topic: { type: 'string', description: 'Optional topic or prefix' },
        level: { type: 'string', enum: LEVELS, description: 'Optional minimum level, e.g. ERROR' },
        timeout_ms: { type: 'number', description: 'How long to wait (default 30000, max 120000)' },
        since: {
          type: 'number',
          description:
            'Only consider events after this cursor. Take a cursor BEFORE triggering your action so you cannot match something old.',
        },
      },
      additionalProperties: false,
    },
    run: async (a) => {
      const timeout = Math.min(Math.max(Number(a.timeout_ms) || 30000, 1000), MAX_WAIT_MS);
      const deadline = Date.now() + timeout;
      // Start from now unless told otherwise, so "wait for" cannot be
      // satisfied by something that happened before the agent acted.
      let cursor = a.since;
      if (cursor === undefined) {
        const first = await hubOrExplain('/recent?limit=1');
        if (!first.ok) return first.text;
        cursor = first.data.newest ?? 0;
      }
      for (;;) {
        const r = await hubOrExplain(query({ ...a, since: cursor, limit: MAX_LIMIT }));
        if (!r.ok) return r.text;
        const data = applyLocalFilters(r.data, { contains: a.contains, limit: MAX_LIMIT });
        if (data.events.length)
          return formatEvents(data, `Matched after ${Math.round((timeout - (deadline - Date.now())) / 1000)}s.`);
        cursor = r.data.next ?? cursor;
        if (Date.now() >= deadline)
          return (
            `No matching event within ${Math.round(timeout / 1000)}s.\n` +
            `cursor: ${cursor} (pass as \`since\` to keep waiting from here)\n` +
            `Nothing matched${a.contains ? ` containing ${JSON.stringify(a.contains)}` : ''}` +
            `${a.topic ? ` on ${a.topic}` : ''}${a.level ? ` at ${a.level}+` : ''}. ` +
            `Check hub_status and list_streams: the action may not have logged at all.`
          );
        await new Promise((res) => setTimeout(res, 500));
      }
    },
  },
];

// The guide as a tool, because tools are the one surface every MCP client
// can call. The same content backs prompts/list for clients that speak that
// half of the protocol.
TOOLS.push({
  name: 'stream_guide',
  description:
    'Detailed documentation for a bench capability, before working with an ' +
    'unfamiliar topic: what its events and metrics mean, how to read them, and ' +
    'the gotchas (what a stall escalation is, why power says not root, why a ' +
    'diff can be silent). No arguments lists everything; name one entry or a ' +
    'playbook for the detail.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'A stream entry (power, dl, build, fs, vitals, gpu, os-app, net, history) or a playbook (triage, follow-a-trace, silent-stream, power-incident, watch-a-download)',
      },
    },
    additionalProperties: false,
  },
  run: async ({ name }) => {
    if (!name) {
      const s = Object.entries(GUIDE.streams).map(([n, e]) => `  ${n.padEnd(10)} ${e.topics}`);
      const p = Object.keys(GUIDE.playbooks).map((n) => `  ${n}`);
      return `stream entries (stream_guide name=<entry>):\n${s.join('\n')}\n` +
             `playbooks:\n${p.join('\n')}`;
    }
    if (GUIDE.streams[name]) return guideEntry([name, GUIDE.streams[name]]);
    if (GUIDE.playbooks[name]) return `## ${name}\n${GUIDE.playbooks[name]}`;
    return `no guide entry '${name}'. Known: ${[...Object.keys(GUIDE.streams), ...Object.keys(GUIDE.playbooks)].join(', ')}`;
  },
});

// ------------------------------------------------------- MCP over stdio
//
// Newline-delimited JSON-RPC 2.0. Only the tools half of the protocol is
// implemented, which is all a log reader needs; anything else gets a clean
// "method not found" rather than silence.

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications have no id and must never be answered.
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    return reply(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: 'super-log', version: '0.1.0' },
      instructions:
        `Log streams from the super-log bench at ${HUB}. Start with hub_status or ` +
        `list_streams to see what is running, then tail_logs/search_logs narrowed by ` +
        `topic and level. Use wait_for after triggering an action instead of sleeping. ` +
        `Those four read the hub's live ring, which is only minutes deep - for anything ` +
        `older, search_history reads the journal on disk (${JOURNAL}). ` +
        `Before working with an unfamiliar topic (power.*, dl.*, fs.*, build.*...), ` +
        `call stream_guide with its name - it explains the metrics, levels and gotchas. ` +
        `Never try to read every event: streams can produce thousands per second.`,
    });
  }
  // The playbooks, served natively for clients that speak the prompts half
  // of the protocol; stream_guide serves the same content as a tool for the
  // clients that do not.
  if (method === 'prompts/list') {
    return reply(id, {
      prompts: Object.keys(GUIDE.playbooks).map((name) => ({
        name,
        description: GUIDE.playbooks[name].split('.')[0],
      })),
    });
  }
  if (method === 'prompts/get') {
    const text = GUIDE.playbooks[params?.name];
    if (!text) return fail(id, -32602, `unknown prompt: ${params?.name}`);
    return reply(id, {
      description: text.split('.')[0],
      messages: [{ role: 'user', content: { type: 'text', text } }],
    });
  }
  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const text = await tool.run(params.arguments ?? {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      // A tool failure is a result, not a protocol error: the agent should
      // read it and adapt, not see the connection break.
      return reply(id, {
        content: [{ type: 'text', text: `super-log: ${String(e?.message ?? e)}` }],
        isError: true,
      });
    }
  }
  if (method === 'ping') return reply(id, {});
  if (!isRequest) return; // notifications/initialized and friends
  return fail(id, -32601, `method not found: ${method}`);
}

// Tools are async (they call the hub, and wait_for deliberately blocks), so
// a closed stdin must not kill work that still owes an answer - drain the
// in-flight calls first, or a client that closes the pipe loses its reply.
const inFlight = new Set();

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const p = handle(msg)
    .catch((e) => {
      if (msg?.id !== undefined && msg?.id !== null)
        fail(msg.id, -32603, String(e?.message ?? e));
    })
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
});
rl.on('close', async () => {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
  process.exit(0);
});
