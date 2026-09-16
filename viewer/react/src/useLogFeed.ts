// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
//
//  useLogFeed - one hook, the whole wire protocol.
//
//  Parses the hub envelope, splits the payload NDJSON chunk, applies the
//  tolerant-reader rule from docs/PROTOCOL.md (a line that is not JSON
//  becomes {msg: line}), and keeps two views with auto-reconnect:
//
//    rows       - the firehose: newest MAX_ROWS across every topic, for the
//                 Log firehose panel that wants the true interleaved stream.
//    stateRows  - the FAIR view: the newest PER_TOPIC of EACH topic, so a
//                 600-line/second neighbour can never crush a once-every-five-
//                 minutes state stream (versions, usb, topology) out of the
//                 panels that read it. This is the client mirror of the hub's
//                 per-topic ring.
//
//  On load both are seeded from GET /recent?snapshot=1 - the hub's fair
//  per-topic backfill - so a viewer that just opened is as populated as the
//  hub can make it, not blank until each producer next speaks.
//

import { useEffect, useRef, useState } from 'react';

export interface LogRow {
  /** Hub-global sequence: the total order across streams. */
  hubSeq: number;
  /** Hub arrival time, ms epoch - the ts fallback per PROTOCOL.md. */
  hubTs: number;
  topic: string;
  level: string;
  ts?: string;
  seq?: number;
  session?: string;
  tag?: string;
  /** Correlation id: everything caused by one user action shares it. */
  trace?: string;
  msg: string;
  fields?: Record<string, string>;
  metric?: { name: string; value: number };
  origin?: { runtime?: string; app?: string; platform?: string; device?: string };
  src?: string;
}

const MAX_ROWS = 2000;   // the firehose ring: every panel re-scans it - keep it lean
const PER_TOPIC = 60;    // the fair ring keeps this many of EACH topic

function parseLine(line: string, hubSeq: number, hubTs: number, topic: string, sub: number): LogRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const base = { hubSeq: hubSeq + sub / 1000, hubTs, topic };
  try {
    const ev = JSON.parse(trimmed) as Partial<LogRow> & { msg?: unknown };
    if (typeof ev !== 'object' || ev === null) throw new Error('not an object');
    return {
      ...base,
      level: typeof ev.level === 'string' ? ev.level : 'INFO',
      msg: typeof ev.msg === 'string' ? ev.msg : trimmed,
      ts: typeof ev.ts === 'string' ? ev.ts : undefined,
      seq: typeof ev.seq === 'number' ? ev.seq : undefined,
      session: typeof ev.session === 'string' ? ev.session : undefined,
      tag: typeof ev.tag === 'string' ? ev.tag : undefined,
      trace: typeof ev.trace === 'string' ? ev.trace : undefined,
      fields: ev.fields as Record<string, string> | undefined,
      metric: ev.metric as { name: string; value: number } | undefined,
      origin: ev.origin as LogRow['origin'],
      src: typeof ev.src === 'string' ? ev.src : undefined,
    };
  } catch {
    return { ...base, level: 'INFO', msg: trimmed }; // tolerant-reader rule
  }
}

// A /recent event ({id, seq, topic, event}) carries its payload ALREADY parsed
// as `event`, where the WS wire carries a raw line. Re-serialise so both paths
// share the one tolerant parser above.
interface RecentEvent { id: number; seq: number; topic: string; event: unknown }
function rowFromRecent(rec: RecentEvent): LogRow | null {
  const ev = rec.event as { ts?: string } | undefined;
  const hubTs = ev && typeof ev.ts === 'string' ? Date.parse(ev.ts) || Date.now() : Date.now();
  return parseLine(JSON.stringify(rec.event ?? {}), rec.seq, hubTs, rec.topic, 0);
}

export function useLogFeed(hubUrl: string, topic = '*') {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [stateRows, setStateRows] = useState<LogRow[]>([]);
  const [connected, setConnected] = useState(false);
  const pending = useRef<LogRow[]>([]);
  // The fair ring: topic -> its newest PER_TOPIC rows, oldest first.
  const byTopic = useRef<Map<string, LogRow[]>>(new Map());

  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    byTopic.current = new Map();

    // Batch state updates per animation frame; per-message setState melts
    // React under a burst of four devices at once.
    const tick = setInterval(() => {
      if (pending.current.length === 0) return;
      const add = pending.current;
      pending.current = [];
      setRows((prev) => {
        const next = prev.concat(add);
        return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
      });
      // Fold the same batch into the fair per-topic ring, capped per topic so
      // one loud topic only ever evicts its own older rows.
      const bt = byTopic.current;
      for (const row of add) {
        const arr = bt.get(row.topic);
        if (arr) {
          arr.push(row);
          if (arr.length > PER_TOPIC) arr.splice(0, arr.length - PER_TOPIC);
        } else {
          bt.set(row.topic, [row]);
        }
      }
      const flat: LogRow[] = [];
      bt.forEach((arr) => { for (const r of arr) flat.push(r); });
      flat.sort((a, b) => a.hubSeq - b.hubSeq);
      setStateRows(flat);
    }, 100);

    // Seed both views from the hub's fair per-topic backfill before (and
    // beside) the live feed, so the view opens populated. A hub too old to
    // know `snapshot` answers a normal query - still a valid seed, just not
    // per-topic fair - and a failure just leaves the live feed to fill in.
    const seed = async () => {
      try {
        const res = await fetch(`${hubUrl.replace(/\/$/, '')}/recent?snapshot=1&limit=${PER_TOPIC}`,
          { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return;
        const body = await res.json() as { events?: RecentEvent[] };
        if (closed) return;
        for (const rec of body.events ?? []) {
          const row = rowFromRecent(rec);
          if (row) pending.current.push(row);
        }
      } catch {
        /* no seed; the live feed still fills the view */
      }
    };
    void seed();

    const connect = () => {
      const wsUrl = hubUrl.replace(/^http/, 'ws') + `/ws?topic=${encodeURIComponent(topic)}`;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e: MessageEvent<string>) => {
        try {
          const env = JSON.parse(e.data) as { seq: number; ts_ms: number; topic: string; payload: string };
          env.payload.split('\n').forEach((line, i) => {
            const row = parseLine(line, env.seq, env.ts_ms, env.topic, i);
            if (row) pending.current.push(row);
          });
        } catch {
          /* not an envelope frame; ignore */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      clearInterval(tick);
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [hubUrl, topic]);

  const clear = () => { byTopic.current = new Map(); setRows([]); setStateRows([]); };
  return { rows, stateRows, connected, clear };
}
