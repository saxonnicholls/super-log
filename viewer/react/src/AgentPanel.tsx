// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The agents blotter: who is working the bench. Every agent.<name> event
// is an agent listening (MCP connect), requesting (tool calls), or
// reporting (the agent_report contract: which LLM, what task, what
// cadence). Identity fields are sticky - a requesting DEBUG carries no
// llm, and forgetting who an agent is because it asked a question would
// be absurd. The light is each agent's OWN promised cadence (default
// 900s): grey at 2x means it broke its own word - which is exactly what
// the watcher of an 8-hour job needs to see.

import { useMemo } from 'react';
import type { LogRow } from './useLogFeed';

const LEVEL_COLOR: Record<string, string> = {
  WARN: '#d9a441', ERROR: '#e05b4f', CRITICAL: '#ff2e1f',
};

interface Agent {
  llm: string; status: string; task: string; level: string;
  pct: number | null; intervalS: number; ts: number;
}

export function AgentPanel({ rows }: { rows: LogRow[] }) {
  const agents = useMemo(() => {
    const out = new Map<string, Agent>();
    for (const r of rows) {
      if (!r.topic.startsWith('agent.')) continue;
      const name = r.topic.slice(6);
      const e = out.get(name) ?? { llm: '', status: '', task: '', level: 'INFO',
                                   pct: null, intervalS: 900, ts: 0 };
      e.status = r.msg;
      e.level = r.level;
      e.ts = r.hubTs;
      if (r.fields?.llm) e.llm = r.fields.llm;
      if (r.fields?.task) e.task = r.fields.task;
      if (r.fields?.pct) e.pct = Number(r.fields.pct);
      if (r.fields?.interval_s) e.intervalS = Number(r.fields.interval_s) || 900;
      out.set(name, e);
    }
    return [...out.entries()].sort(([, a], [, b]) => b.ts - a.ts);
  }, [rows]);

  const now = Date.now();
  const age = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 90 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago`
                                           : `${(s / 3600).toFixed(1)}h ago`;
  };

  return (
    <aside style={{ width: 380, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: '#8a93a3' }}>🤖 agents · {agents.length}</strong>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 10px', fontSize: 13 }}>
        {agents.length === 0 && (
          <div style={{ color: '#3d434d', padding: 12, fontSize: 12 }}>
            no agents yet. MCP consumers appear when they connect; anything
            can report with the agent_report tool or one POST to agent.&lt;name&gt;.
          </div>
        )}
        {agents.map(([name, a]) => {
          const ago = now - a.ts;
          const win = a.intervalS * 1000;
          const [word, color] =
            a.level !== 'INFO' && a.level !== 'DEBUG' && ago < win
              ? [a.level, LEVEL_COLOR[a.level] ?? '#d9a441']
              : ago < win * 2 ? ['up', '#68c964']
              : ago < win * 4 ? ['late', '#d9a441']
                              : ['silent', '#5c6470'];
          return (
            <div key={name} style={{ padding: '6px 0', borderBottom: '1px solid #1b2027' }}
                 title={a.task ? `task: ${a.task}` : undefined}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span style={{ color, fontWeight: word === 'up' ? 'normal' : 'bold' }}>
                  {word}
                </span>
                <span style={{ color: '#c3c9d4' }}>{name}</span>
                {a.llm && <span style={{ color: '#7aa2f7', fontSize: 12 }}>{a.llm}</span>}
                <span style={{ color: '#5c6470', marginLeft: 'auto', fontSize: 12,
                               whiteSpace: 'nowrap' }}>
                  {age(ago)}
                </span>
              </div>
              <div style={{ color: '#8a93a3', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {a.pct != null ? `[${a.pct}%] ` : ''}{a.status}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color: '#3d434d', fontSize: 11, padding: '6px 10px',
                    borderTop: '1px solid #1b2027' }}>
        the light is each agent's own promised cadence — grey means it broke
        its own word.
      </div>
    </aside>
  );
}
