#!/usr/bin/env node
//
//  superlog-mcp - the bench, as tools an agent can call.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  An agent debugging an app should be able to ask "what did the logs say
//  just now" without a human copying lines into a chat. This is an MCP
//  server over stdio: it wraps the hub's GET /recent and /healthz in five
//  tools, and every one of them is designed around the fact that an agent's
//  context is small and the firehose is not - one 8-second sample of a
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

import { createInterface } from 'node:readline';

const HUB = process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

// Caps, not suggestions. An agent that asks for everything gets a usable
// slice and a note saying so - which is friendlier than a blown context.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_WAIT_MS = 120000;

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

function query({ topic, level, since, limit, contains }) {
  const p = new URLSearchParams();
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
      capabilities: { tools: {} },
      serverInfo: { name: 'super-log', version: '0.1.0' },
      instructions:
        `Log streams from the super-log bench at ${HUB}. Start with hub_status or ` +
        `list_streams to see what is running, then tail_logs/search_logs narrowed by ` +
        `topic and level. Use wait_for after triggering an action instead of sleeping. ` +
        `Never try to read every event: streams can produce thousands per second.`,
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
