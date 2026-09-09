// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The versions panel: every version under the bench, from superlog-versions'
// host.<name>.versions inventory - OS, compilers, runtimes and their version
// manager, databases, libraries (every package the package manager knows),
// the CPU/GPU. Grouped by category, with a filter box, because a bench has
// hundreds. It reports; it does not advise - "openssl 3.6.3", never "and that
// is a problem", which is the paid layer.

import { useMemo, useState } from 'react';
import type { LogRow } from './useLogFeed';
import { PanelTools } from './PanelTools';

interface Fact {
  category: string; tool: string; state: string;
  version?: string; raw?: string; scope?: string; provenance?: string; unorderable?: boolean;
}

const ORDER = ['os', 'hardware', 'runtime', 'toolchain', 'database', 'library', 'firmware', 'deployed'];

const factsText = (facts: Fact[]): string => facts.map((f) =>
  `${f.category}  ${f.tool}  ${f.state === 'absent' ? 'absent' : (f.version ?? f.raw ?? '?')}` +
  `${f.scope && f.scope !== 'system' ? `  [${f.scope}]` : ''}`).join('\n');

export function VersionsPanel({ rows }: { rows: LogRow[] }) {
  const [q, setQ] = useState('');
  const [shut, setShut] = useState<Set<string>>(new Set());   // collapsed hosts
  const toggle = (h: string) => setShut((s) => {
    const n = new Set(s); n.has(h) ? n.delete(h) : n.add(h); return n;
  });

  const hosts = useMemo(() => {
    const m = new Map<string, { facts: Fact[]; ts: number }>();
    for (const r of rows) {
      if (!r.topic.startsWith('host.') || !r.topic.endsWith('.versions') || !r.fields?.versions) continue;
      let facts: Fact[];
      try { facts = JSON.parse(r.fields.versions) as Fact[]; } catch { continue; }
      m.set(r.topic.slice(5, -9), { facts, ts: r.hubTs });
    }
    // Stable order by host name - otherwise the rows reshuffle every time a
    // box republishes, which reads as the list "jumping".
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const now = Date.now();
  const age = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
  };
  const needle = q.trim().toLowerCase();
  const shows = (f: Fact) =>
    !needle || `${f.category} ${f.tool} ${f.version ?? f.raw ?? ''} ${f.scope ?? ''} ${f.provenance ?? ''}`
      .toLowerCase().includes(needle);

  return (
    <aside style={{ width: 380, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: '#8a93a3' }}>🧬 versions · {hosts.length} host(s)</strong>
        <PanelTools stem="versions" style={{ marginLeft: 'auto' }}
                    text={() => hosts.map(([h, { facts }]) => `${h}:\n${factsText(facts)}`).join('\n\n') + '\n'} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…"
               style={{ width: 110, background: '#181c22', color: '#d6dae2',
                        border: '1px solid #262b33', borderRadius: 4, padding: '2px 6px', font: 'inherit' }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px', fontSize: 12 }}>
        {hosts.length === 0 && (
          <div style={{ color: '#3d434d', padding: 12 }}>
            no versions yet — superlog-versions publishes them (npm run versions).
            It reports what changed and when; it does not advise.
          </div>
        )}
        {hosts.map(([host, { facts, ts }]) => {
          const shown = facts.filter(shows);
          const open = !shut.has(host);
          const cats = open ? [...new Set(shown.map((f) => f.category))]
            .sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)) : [];
          return (
            <div key={host} style={{ marginBottom: 10 }}>
              <div style={{ color: '#8a93a3', marginBottom: 4, cursor: 'pointer', userSelect: 'none' }}
                   onClick={() => toggle(host)}>
                {open ? '▾' : '▸'} {host} <span style={{ color: '#3d434d' }}>({shown.length}/{facts.length}, {age(now - ts)} ago)</span>
              </div>
              {cats.map((cat) => {
                const cf = shown.filter((f) => f.category === cat).sort((a, b) => a.tool.localeCompare(b.tool));
                const CAP = 40;   // render only the head of a big category; filter to see the rest
                return (
                  <div key={cat} style={{ marginBottom: 4 }}>
                    <div style={{ color: '#5c6470', textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5 }}>
                      {cat} · {cf.length}
                    </div>
                    {cf.slice(0, CAP).map((f, i) => (
                      <div key={`${f.tool}/${f.scope}/${i}`} style={{ marginLeft: 8, display: 'flex', gap: 6 }}>
                        <span style={{ color: f.state === 'absent' ? '#5c6470' : '#c3c9d4' }}>{f.tool}</span>
                        <span style={{ color: f.state === 'absent' ? '#4a3a3a' : '#68c964' }}>
                          {f.state === 'absent' ? 'absent' : (f.version ?? f.raw ?? '?')}
                          {f.unorderable && ' ⚠'}
                        </span>
                        {f.scope && f.scope !== 'system' &&
                          <span style={{ color: '#5c6470' }}>[{f.scope}]</span>}
                      </div>
                    ))}
                    {cf.length > CAP && (
                      <div style={{ marginLeft: 8, color: '#5c6470' }}>
                        +{cf.length - CAP} more — type in the filter to narrow
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
