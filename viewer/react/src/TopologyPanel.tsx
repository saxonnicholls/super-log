// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The topology panel: the local network as a tree, live, from superlog-topology's
// net.<host>.topology events - this host, its gateway, the devices under it -
// plus each watched route (net.<host>.route.<target>) as its hops. The same
// {name, children} shape and recursive renderer the device tree uses.
//
// A deliberate honesty, matching the tailer and the ImGui window: this shows
// that the PATH is up, never that the service behind it is healthy. A route
// that resolves to a dead or starved endpoint still draws its hops - reachable
// is not verified, and the panel must not let the two be confused.

import { useMemo, useState } from 'react';
import type { LogRow } from './useLogFeed';
import { PanelTools } from './PanelTools';

interface TopoNode { name: string; children?: TopoNode[] }

const treeText = (n: TopoNode, depth = 0): string =>
  '  '.repeat(depth) + n.name + '\n' + (n.children ?? []).map((c) => treeText(c, depth + 1)).join('');

// Keep a node if it matches, or if any descendant does (so the path to a match
// stays visible). A matched node keeps its whole subtree for context.
function filterTree(n: TopoNode, q: string): TopoNode | null {
  if (!q) return n;
  if (n.name.toLowerCase().includes(q)) return n;
  const kids = (n.children ?? [])
    .map((c) => filterTree(c, q))
    .filter((x): x is TopoNode => x !== null);
  return kids.length ? { name: n.name, children: kids } : null;
}

const isTopo = (t: string) =>
  t.startsWith('net.') &&
  (t.includes('.topology') || t.includes('.route.') || t.includes('.connections'));

// net.<host>.topology -> "topology · <host>"; .route.<target> -> "route <target>
// · <host>"; .connections -> "connections · <host>". A readable label beats the
// raw topic.
function label(topic: string): string {
  const m = /^net\.([^.]+)\.(topology|connections|route\.(.+))$/.exec(topic);
  if (!m) return topic;
  const host = m[1];
  if (m[3]) return `route ${m[3]} · ${host}`;
  return `${m[2]} · ${host}`;
}

export function TopologyPanel({ rows }: { rows: LogRow[] }) {
  const [q, setQ] = useState('');
  const [shut, setShut] = useState<Set<string>>(new Set());   // collapsed views
  const toggle = (k: string) => setShut((s) => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const views = useMemo(() => {
    const v = new Map<string, { tree: TopoNode; ts: number }>();
    for (const r of rows) {
      if (!isTopo(r.topic) || !r.fields?.tree) continue;
      let tree: TopoNode;
      try { tree = JSON.parse(r.fields.tree) as TopoNode; } catch { continue; }
      v.set(r.topic, { tree, ts: r.hubTs });
    }
    // LAN topology first, then routes; each group by topic for stability.
    return [...v.entries()].sort((a, b) => {
      const ra = a[0].includes('.route.') ? 1 : 0;
      const rb = b[0].includes('.route.') ? 1 : 0;
      return ra - rb || a[0].localeCompare(b[0]);
    });
  }, [rows]);

  const now = Date.now();
  const age = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
  };

  const renderNode = (n: TopoNode, depth: number, key: string): React.ReactNode => (
    <div key={key} style={{ marginLeft: depth * 14 }}>
      <span style={{ color: '#c3c9d4' }}>
        {n.children?.length ? '▾ ' : '· '}{n.name}
      </span>
      {(n.children ?? []).map((c, i) => renderNode(c, depth + 1, `${key}/${i}`))}
    </div>
  );

  return (
    <aside style={{ width: 380, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: '#8a93a3' }}>🌐 topology · {views.length} view(s)</strong>
        <PanelTools stem="topology" style={{ marginLeft: 'auto' }}
                    text={() => views.map(([t, v]) => `${label(t)}:\n${treeText(v.tree, 1)}`).join('\n') + '\n'} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…"
               style={{ width: 110, background: '#181c22', color: '#d6dae2',
                        border: '1px solid #262b33', borderRadius: 4, padding: '2px 6px', font: 'inherit' }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px', fontSize: 12 }}>
        {views.length === 0 && (
          <div style={{ color: '#3d434d', padding: 12 }}>
            no topology yet — superlog-topology publishes it (npm run topology;
            add --discover for every device, --to &lt;target&gt; to watch a route).
            The path being up is not the service being healthy.
          </div>
        )}
        {views.map(([topic, t]) => {
          const tree = filterTree(t.tree, q.trim().toLowerCase());
          if (!tree) return null;
          const open = !shut.has(topic);
          return (
            <div key={topic} style={{ marginBottom: 10 }}>
              <div style={{ color: '#8a93a3', marginBottom: 2, cursor: 'pointer', userSelect: 'none' }}
                   onClick={() => toggle(topic)}>
                {open ? '▾' : '▸'} {label(topic)} <span style={{ color: '#3d434d' }}>({age(now - t.ts)} ago)</span>
              </div>
              {open && renderNode(tree, 0, topic)}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
