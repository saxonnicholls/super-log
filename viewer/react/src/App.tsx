//
//  The web viewer. One firehose subscription, filtered client-side - the
//  four device streams interleaved by hub sequence, colour-coded by topic.
//

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLogFeed, type LogRow } from './useLogFeed';

const HUB = import.meta.env.VITE_SUPERLOG_URL ?? 'http://127.0.0.1:7333';

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

function timeOf(r: LogRow): string {
  const iso = r.ts ?? new Date(r.hubTs).toISOString();
  return iso.slice(11, 23); // HH:MM:SS.mmm
}

export default function App() {
  const { rows, connected, clear } = useLogFeed(HUB);
  const [minLevel, setMinLevel] = useState(0);
  const [needle, setNeedle] = useState('');
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  const topics = useMemo(() => [...new Set(rows.map((r) => r.topic))].sort(), [rows]);

  const visible = useMemo(() => {
    const q = needle.toLowerCase();
    return rows.filter((r) => {
      const li = LEVELS.indexOf(r.level as (typeof LEVELS)[number]);
      if (li >= 0 && li < minLevel) return false;
      if (topicFilter && r.topic !== topicFilter) return false;
      if (q && !`${r.msg} ${r.tag ?? ''} ${JSON.stringify(r.fields ?? {})}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [rows, minLevel, needle, topicFilter]);

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
        <button onClick={clear} style={selStyle}>clear</button>
        <span style={{ color: '#5c6470' }}>{visible.length}/{rows.length}</span>
      </header>

      <main style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
        {visible.map((r) => (
          <div key={r.hubSeq} style={{ display: 'flex', gap: 8, whiteSpace: 'pre-wrap' }}>
            <span style={{ color: '#5c6470' }}>{timeOf(r)}</span>
            <span style={{ color: topicColor(r.topic), minWidth: 130 }}>{r.topic}</span>
            <span style={{ color: LEVEL_COLOR[r.level] ?? '#d6dae2', minWidth: 56 }}>{r.level}</span>
            {r.tag && <span style={{ color: '#8a93a3' }}>[{r.tag}]</span>}
            <span style={{ flex: 1 }}>
              {r.msg}
              {r.metric && <span style={{ color: '#4fb6c9' }}> ={r.metric.value}</span>}
              {r.fields &&
                Object.entries(r.fields).map(([k, v]) => (
                  <span key={k} style={{ color: '#8a93a3' }}> {k}={v}</span>
                ))}
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
