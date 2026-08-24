// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
//
//  The web viewer. One firehose subscription, filtered client-side - the
//  four device streams interleaved by hub sequence, colour-coded by topic.
//

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLogFeed, type LogRow } from './useLogFeed';
import { copyText, download, rowText, stamp, timeOf, toCsv, toJson, toTxt } from './exporting';

// The hub lives on whichever machine served this page - true for the demo,
// for scripts/dev.sh, and for anyone who opened the viewer over the LAN. A
// hardcoded 127.0.0.1 meant "the machine I am *viewing* from", so opening
// the viewer from a second machine silently talked to its own loopback.
// ?hub=http://host:7333 overrides ad hoc; VITE_SUPERLOG_URL at build time.
const HUB =
  new URLSearchParams(window.location.search).get('hub') ??
  import.meta.env.VITE_SUPERLOG_URL ??
  `${window.location.protocol}//${window.location.hostname}:7333`;

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'] as const;
const LEVEL_COLOR: Record<string, string> = {
  TRACE: '#5c6470', DEBUG: '#4fb6c9', INFO: '#68c964',
  WARN: '#d9a441', ERROR: '#e05b4f', CRITICAL: '#ff2e1f',
};

// Stable colour per topic so a stream is recognisable at a glance
const TOPIC_COLORS = ['#7aa2f7', '#bb9af7', '#e0af68', '#9ece6a', '#f7768e', '#2ac3de'];
function topicColor(topic: string): string {
  let h = 0;
  for (let i = 0; i < topic.length; i++) h = (h * 31 + topic.charCodeAt(i)) >>> 0;
  return TOPIC_COLORS[h % TOPIC_COLORS.length] as string;
}

export default function App() {
  const { rows, connected, clear } = useLogFeed(HUB);
  const [minLevel, setMinLevel] = useState(0);
  const [needle, setNeedle] = useState('');
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  // Following one action is a different question from filtering a stream:
  // it deliberately ignores the topic filter, because the answer crosses
  // streams by definition.
  const [traceFilter, setTraceFilter] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  // One row expanded at a time: the point of expanding is to read that one
  // stack, and several open at once is the wall of text again.
  const [expanded, setExpanded] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  // Pause freezes the DISPLAY, not the collection: the feed keeps filling
  // `rows` (capped ring) while the frozen snapshot is what renders, and
  // play snaps back to the live tail. setRows always replaces the array,
  // so the captured reference stays exactly as it was.
  const frozen = useRef<LogRow[]>([]);

  const topics = useMemo(() => [...new Set(rows.map((r) => r.topic))].sort(), [rows]);

  const source = paused ? frozen.current : rows;
  const visible = useMemo(() => {
    const q = needle.toLowerCase();
    return source.filter((r) => {
      if (traceFilter) return r.trace === traceFilter;
      const li = LEVELS.indexOf(r.level as (typeof LEVELS)[number]);
      if (li >= 0 && li < minLevel) return false;
      if (topicFilter && r.topic !== topicFilter) return false;
      if (q && !`${r.msg} ${r.tag ?? ''} ${JSON.stringify(r.fields ?? {})}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [source, minLevel, needle, topicFilter, traceFilter]);

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView();
  }, [visible, follow]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 12px',
                       borderBottom: '1px solid #262b33', flexWrap: 'wrap' }}>
        <strong style={{ color: '#7aa2f7' }}>super-log</strong>
        <span style={{ color: connected ? '#68c964' : '#e05b4f' }}>
          {connected ? '● live' : '○ reconnecting…'}
        </span>
        <button
          style={selStyle}
          title={paused ? 'resume the live tail' : 'freeze the display (collection continues)'}
          onClick={() => {
            if (!paused) frozen.current = rows;
            setPaused(!paused);
          }}
        >
          {paused ? '▶ play' : '⏸ pause'}
        </button>
        <select value={minLevel} onChange={(e) => setMinLevel(Number(e.target.value))}
                style={selStyle} title="minimum level">
          {LEVELS.map((l, i) => <option key={l} value={i}>≥ {l}</option>)}
        </select>
        <select value={topicFilter ?? ''} onChange={(e) => setTopicFilter(e.target.value || null)}
                style={selStyle} title="stream">
          <option value="">all streams</option>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder="filter…"
               style={{ ...selStyle, flex: 1, minWidth: 120 }} />
        <label style={{ userSelect: 'none' }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
        {traceFilter && (
          <button onClick={() => setTraceFilter(null)}
                  style={{ ...selStyle, borderColor: '#bb9af7', color: '#bb9af7' }}
                  title="stop following this action">
            ⇢ trace {traceFilter.slice(0, 8)} ✕
          </button>
        )}
        <button onClick={clear} style={selStyle}>clear</button>
        {/* copy + export act on the *visible* rows - export follows the
            filters, because that is the view someone just narrowed down to */}
        <button
          style={selStyle}
          title="copy visible rows"
          onClick={() => {
            void copyText(toTxt(visible)).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
        <span style={{ color: '#5c6470' }}>export</span>
        <button style={selStyle} title="visible rows, full fidelity"
                onClick={() => download(`superlog-${stamp()}.json`, 'application/json', toJson(visible))}>
          json
        </button>
        <button style={selStyle} title="visible rows, one line per event"
                onClick={() => download(`superlog-${stamp()}.csv`, 'text/csv', toCsv(visible))}>
          csv
        </button>
        <button style={selStyle} title="visible rows, as displayed"
                onClick={() => download(`superlog-${stamp()}.txt`, 'text/plain', toTxt(visible))}>
          txt
        </button>
        <span style={{ color: '#5c6470' }}>
          {visible.length}/{source.length}
          {paused && ` · live ${rows.length}`}
        </span>
        {/* Which viewer build, and which hub it decided to talk to - the two
            things you want when the screen is not showing what you expect. */}
        <span style={{ color: '#3d434d', marginLeft: 'auto' }}
              title={`viewer build ${__SUPERLOG_BUILD__}\nhub ${HUB}`}>
          {HUB.replace(/^https?:\/\//, '')} · build {__SUPERLOG_BUILD__.slice(5)}
        </span>
      </header>

      <main style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
        {visible.map((r) => (
          <div key={r.hubSeq} className="row" style={{ display: 'flex', gap: 8, whiteSpace: 'pre-wrap' }}>
            <button className="rowcopy" title="copy row"
                    onClick={() => void copyText(rowText(r))}>⧉</button>
            <span style={{ color: '#5c6470' }}>{timeOf(r)}</span>
            <span style={{ color: topicColor(r.topic), minWidth: 130 }}>{r.topic}</span>
            <span style={{ color: LEVEL_COLOR[r.level] ?? '#d6dae2', minWidth: 56 }}>{r.level}</span>
            {r.trace && (
              <button className="rowcopy" title={`follow this action (trace ${r.trace})`}
                      style={{ color: '#bb9af7' }}
                      onClick={() => setTraceFilter(r.trace ?? null)}>⇢</button>
            )}
            {r.tag && <span style={{ color: '#8a93a3' }}>[{r.tag}]</span>}
            <span style={{ flex: 1 }}>
              {r.msg}
              {r.metric && <span style={{ color: '#4fb6c9' }}> ={r.metric.value}</span>}
              {r.fields &&
                Object.entries(r.fields).map(([k, v]) => {
                  // A stack trace or a locals dump is many lines, and
                  // rendering it inline turns one event into ten wrapped
                  // rows - which destroys the scannability the whole view
                  // exists for. Collapse to the first line and let the row
                  // be expanded when it is the row you care about.
                  const text = String(v);
                  const multi = text.includes('\n') || text.length > 120;
                  if (!multi) return <span key={k} style={{ color: '#8a93a3' }}> {k}={text}</span>;
                  const open = expanded === r.hubSeq;
                  return (
                    <span key={k}>
                      <button className="rowcopy" style={{ color: '#7aa2f7', opacity: 1 }}
                              title={open ? 'collapse' : `expand ${k}`}
                              onClick={() => setExpanded(open ? null : r.hubSeq)}>
                        {' '}{open ? '▾' : '▸'}{k}
                      </button>
                      {open
                        ? <span style={{ color: '#8a93a3', display: 'block',
                                         whiteSpace: 'pre-wrap', marginLeft: 24 }}>{text}</span>
                        : <span style={{ color: '#8a93a3' }}>
                            ={text.split('\n')[0]!.slice(0, 60)}…
                          </span>}
                    </span>
                  );
                })}
              {r.src && <span style={{ color: '#5c6470' }}> ({r.src})</span>}
            </span>
          </div>
        ))}
        <div ref={bottom} />
      </main>
    </div>
  );
}

const selStyle: React.CSSProperties = {
  background: '#181c22', color: '#d6dae2', border: '1px solid #262b33',
  borderRadius: 4, padding: '2px 6px', font: 'inherit',
};
