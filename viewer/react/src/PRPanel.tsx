// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The PRs board: whose move is it, and for how long. superlog-prs
// publishes one DEBUG row per PR per poll; this keeps the latest per
// repo#number, sorted ours-and-oldest first - the sort order IS the
// to-do list. Waiting on US ages amber at 3d, red at 9d, and fires the
// alarm gateway; closed-without-merge stays red, because that is what
// "closed as stale" looks like from outside - 51 silent days once
// turned a review request into exactly that.

import { useMemo } from 'react';
import type { LogRow } from './useLogFeed';

interface Pr {
  repo: string; number: string; title: string; url: string; state: string;
  waitingOn: string; days: number; lastActor: string; changesRequested: boolean;
  ts: number;
}

const NAME_COLORS = ['#7aa2f7', '#bb9af7', '#e0af68', '#9ece6a', '#f7768e', '#2ac3de'];
const nameColor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length] as string;
};

export function PRPanel({ rows }: { rows: LogRow[] }) {
  const prs = useMemo(() => {
    const out = new Map<string, Pr>();
    for (const r of rows) {
      if (!r.topic.startsWith('pr.') || !r.fields?.repo || !r.fields?.number) continue;
      const key = `${r.fields.repo}#${r.fields.number}`;
      const e = out.get(key) ?? { repo: r.fields.repo, number: r.fields.number,
        title: '', url: '', state: 'open', waitingOn: '', days: 0,
        lastActor: '', changesRequested: false, ts: 0 };
      if (r.fields.title) e.title = r.fields.title;
      if (r.fields.url) e.url = r.fields.url;
      if (r.fields.state) e.state = r.fields.state;
      if (r.fields.waiting_on) e.waitingOn = r.fields.waiting_on;
      if (r.fields.days_waiting) e.days = Number(r.fields.days_waiting);
      if (r.fields.last_actor) e.lastActor = r.fields.last_actor;
      e.changesRequested = r.fields.changes_requested === 'yes';
      e.ts = r.hubTs;
      out.set(key, e);
    }
    return [...out.values()].sort((a, b) => {
      const au = a.waitingOn === 'us' && a.state === 'open';
      const bu = b.waitingOn === 'us' && b.state === 'open';
      if (au !== bu) return au ? -1 : 1;
      return b.days - a.days;
    });
  }, [rows]);

  const waitingUs = prs.filter((p) => p.waitingOn === 'us' && p.state === 'open').length;

  return (
    <aside style={{ width: 420, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: waitingUs ? '#d9a441' : '#8a93a3' }}>
          ⇄ PRs{waitingUs ? ` · ${waitingUs} waiting on us` : ` · ${prs.length}`}
        </strong>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 10px', fontSize: 13 }}>
        {prs.length === 0 && (
          <div style={{ color: '#3d434d', padding: 12, fontSize: 12 }}>
            no PRs on the books — superlog-prs watches them
            (npm run prs -- --author you --repo owner/name).
          </div>
        )}
        {prs.map((p) => {
          const ours = p.waitingOn === 'us' && p.state === 'open';
          const late = ours && p.days >= 3;
          const dead = p.state === 'closed';
          const [word, color] = dead ? ['closed', '#ff2e1f']
            : p.state === 'merged' ? ['merged', '#7aa2f7']
            : ours ? [late ? (p.days >= 9 ? 'OURS' : 'ours') : 'ours',
                      late ? (p.days >= 9 ? '#ff2e1f' : '#d9a441') : '#68c964']
            : ['theirs', '#5c6470'];
          const bg = dead ? 'rgba(224,91,79,0.13)'
            : late ? (p.days >= 9 ? 'rgba(224,91,79,0.11)' : 'rgba(217,164,65,0.09)')
            : undefined;
          return (
            <div key={`${p.repo}#${p.number}`}
                 style={{ padding: '6px 4px', borderBottom: '1px solid #1b2027',
                          backgroundColor: bg }}
                 title={p.lastActor ? `last word: ${p.lastActor}` +
                        (p.changesRequested ? ' (changes requested)' : '') : undefined}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span style={{ color, fontWeight: late || dead ? 'bold' : 'normal' }}>
                  {word}
                </span>
                <a href={p.url} target="_blank" rel="noreferrer"
                   style={{ color: nameColor(p.repo), textDecoration: 'none' }}>
                  {p.repo}#{p.number}
                </a>
                <span style={{ color: late ? '#d9a441' : '#5c6470',
                               marginLeft: 'auto', fontSize: 12 }}>
                  {p.days.toFixed(1)}d
                </span>
              </div>
              <div style={{ color: '#8a93a3', fontSize: 12 }}>{p.title}</div>
            </div>
          );
        })}
      </div>
      <div style={{ color: '#3d434d', fontSize: 11, padding: '6px 10px',
                    borderTop: '1px solid #1b2027' }}>
        waiting on US ages amber at 3d, red at 9d, and fires the alarm gateway —
        51 silent days once turned a review request into a stale-close.
      </div>
    </aside>
  );
}
