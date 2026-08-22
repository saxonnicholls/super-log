//
//  useLogFeed - one hook, the whole wire protocol.
//
//  Parses the hub envelope, splits the payload NDJSON chunk, applies the
//  tolerant-reader rule from docs/PROTOCOL.md (a line that is not JSON
//  becomes {msg: line}), and keeps a capped ring of rows plus connection
//  state with auto-reconnect.
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

const MAX_ROWS = 5000;

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

export function useLogFeed(hubUrl: string, topic = '*') {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [connected, setConnected] = useState(false);
  const pending = useRef<LogRow[]>([]);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
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
    }, 100);

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

  const clear = () => setRows([]);
  return { rows, connected, clear };
}
