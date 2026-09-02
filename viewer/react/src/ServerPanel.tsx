// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The servers board: every event carries origin.device, so the hub's
// traffic IS the server list - who has spoken, how recently, how loudly.
// No probes, no configuration; a machine joins by logging once, whatever
// the mechanism. "Last seen" is the last event; silence is grey, not a
// verdict - an alerts.json silence rule is what turns it into an alarm.
// The question it answers is "is the build box fine" without opening a
// log; when the answer is grey, the firehose is one topic filter away.

import { useMemo } from 'react';
import type { LogRow } from './useLogFeed';

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'] as const;
const LEVEL_COLOR: Record<string, string> = {
  TRACE: '#5c6470', DEBUG: '#4fb6c9', INFO: '#68c964',
  WARN: '#d9a441', ERROR: '#e05b4f', CRITICAL: '#ff2e1f',
};

const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
};

interface Server { last: number; lastLevel: string; worst: string; worstAt: number }

export function ServerPanel({ rows }: { rows: LogRow[] }) {
  const servers = useMemo(() => {
    const out = new Map<string, Server>();
    for (const r of rows) {
      // Agents carry a device too, but an agent is not a server - it has
      // its own blotter, held to its own cadence.
      if (r.topic.startsWith('agent.')) continue;
      const dev = r.origin?.device;
      if (!dev) continue;
      const e = out.get(dev) ?? { last: 0, lastLevel: 'INFO', worst: 'TRACE', worstAt: 0 };
      e.last = r.hubTs;
      e.lastLevel = r.level;
      if (LEVELS.indexOf(r.level as typeof LEVELS[number]) >=
            LEVELS.indexOf(e.worst as typeof LEVELS[number]) ||
          r.hubTs - e.worstAt > 60000) {
        e.worst = r.level;
        e.worstAt = r.hubTs;
      }
      out.set(dev, e);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const now = Date.now();

  return (
    <aside style={{ width: 320, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: '#8a93a3' }}>🖥 servers · {servers.length}</strong>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#5c6470', textAlign: 'left' }}>
              <th style={th}></th><th style={th}>server</th>
              <th style={th}>last seen</th><th style={th}>loudest (1m)</th>
            </tr>
          </thead>
          <tbody>
            {servers.map(([name, e]) => {
              const ago = now - e.last;
              // Recency is the health: fresh green, hesitant amber, silence
              // grey - a verdict this panel lacks the evidence to call "down".
              const [word, color] = ago < 120000 ? ['up', '#68c964']
                                  : ago < 600000 ? ['quiet', '#d9a441']
                                                 : ['silent', '#5c6470'];
              const loud = now - e.worstAt <= 60000 &&
                           LEVELS.indexOf(e.worst as typeof LEVELS[number]) >= 3
                ? e.worst : ago < 120000 ? e.lastLevel : null;
              return (
                <tr key={name} style={{ borderTop: '1px solid #1b2027' }}>
                  <td style={{ ...td, color, fontWeight: word === 'up' ? 'normal' : 'bold' }}>
                    {word}
                  </td>
                  <td style={{ ...td, color: '#c3c9d4' }}>{name}</td>
                  <td style={{ ...td, color: '#5c6470', whiteSpace: 'nowrap' }}>
                    {age(ago)}
                  </td>
                  <td style={{ ...td, color: loud ? (LEVEL_COLOR[loud] ?? '#5c6470') : '#3d434d' }}>
                    {loud ?? '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {servers.length === 0 && (
          <div style={{ color: '#3d434d', padding: 12, fontSize: 12 }}>
            nobody has spoken yet.
          </div>
        )}
      </div>
      <div style={{ color: '#3d434d', fontSize: 11, padding: '6px 10px',
                    borderTop: '1px solid #1b2027' }}>
        last seen is the last event heard, whatever the mechanism; silence is
        grey, not a verdict - a silence rule in alerts.json turns it into an alarm.
      </div>
    </aside>
  );
}

const th: React.CSSProperties = { padding: '2px 6px', fontWeight: 'normal' };
const td: React.CSSProperties = { padding: '3px 6px', verticalAlign: 'top' };
