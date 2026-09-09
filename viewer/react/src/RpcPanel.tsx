// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The RPC board: block height and health per node endpoint. superlog-rpc
// publishes one DEBUG row per endpoint per poll; this keeps the latest per
// chain/provider. Running two providers per chain is the point - a DOWN
// (no answer) or STALLED (answering, but the block froze) endpoint shows
// which one to fail away from before the chain watcher behind it goes
// quiet.

import { useMemo } from 'react';
import type { LogRow } from './useLogFeed';
import { PanelTools } from './PanelTools';

interface Rpc {
  chain: string; provider: string; url: string; health: string;
  block: string; latency: string; ts: number;
}

const NAME_COLORS = ['#7aa2f7', '#bb9af7', '#e0af68', '#9ece6a', '#f7768e', '#2ac3de'];
const nameColor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length] as string;
};

const age = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};

export function RpcPanel({ rows }: { rows: LogRow[] }) {
  const rpcs = useMemo(() => {
    const out = new Map<string, Rpc>();
    for (const r of rows) {
      if (!r.topic.startsWith('rpc.') || !r.fields?.chain || !r.fields?.provider) continue;
      const key = `${r.fields.chain}/${r.fields.provider}`;
      const e = out.get(key) ?? { chain: r.fields.chain, provider: r.fields.provider,
        url: '', health: '', block: '', latency: '', ts: 0 };
      if (r.fields.url) e.url = r.fields.url;
      if (r.fields.health) e.health = r.fields.health;
      if (r.fields.block) e.block = r.fields.block;
      if (r.fields.latency_ms) e.latency = r.fields.latency_ms;
      e.ts = r.hubTs;
      out.set(key, e);
    }
    return [...out.values()].sort((a, b) =>
      a.chain.localeCompare(b.chain) || a.provider.localeCompare(b.provider));
  }, [rows]);

  const unhealthy = rpcs.filter((e) => e.health === 'down' || e.health === 'stalled').length;
  const now = Date.now();

  const asText = () => rpcs.map((e) => {
    const word = e.health === 'down' ? 'DOWN' : e.health === 'stalled' ? 'STALL' : 'up';
    return `${word.padEnd(6)}${e.chain}  ${e.provider}  block ${e.block || '-'}` +
           (e.latency ? `  ${e.latency}ms` : '') + (e.url ? `  ${e.url}` : '');
  }).join('\n') + '\n';

  return (
    <aside style={{ width: 440, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: unhealthy ? '#e05b4f' : '#8a93a3' }}>
          ⛓ RPC nodes{unhealthy ? ` · ${unhealthy} unhealthy` : ` · ${rpcs.length}`}
        </strong>
        <PanelTools text={asText} stem="rpc" style={{ marginLeft: 'auto' }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#5c6470', textAlign: 'left' }}>
              <th style={th}></th><th style={th}>chain</th><th style={th}>provider</th>
              <th style={th}>block</th><th style={th}>lat</th><th style={th}>url</th><th style={th}>seen</th>
            </tr>
          </thead>
          <tbody>
            {rpcs.map((e) => {
              const down = e.health === 'down';
              const stalled = e.health === 'stalled';
              const [word, color] = down ? ['DOWN', '#ff2e1f']
                : stalled ? ['STALL', '#d9a441'] : ['up', '#68c964'];
              const bg = down ? 'rgba(224,91,79,0.13)'
                : stalled ? 'rgba(217,164,65,0.10)' : undefined;
              const key = `${e.chain}/${e.provider}`;
              return (
                <tr key={key} style={{ borderTop: '1px solid #1b2027', backgroundColor: bg }}>
                  <td style={{ ...td, color, fontWeight: down || stalled ? 'bold' : 'normal' }}>{word}</td>
                  <td style={{ ...td, color: nameColor(e.chain) }}>{e.chain}</td>
                  <td style={{ ...td, color: '#c3c9d4' }}>{e.provider}</td>
                  <td style={{ ...td, color: '#c3c9d4', fontVariantNumeric: 'tabular-nums' }}>
                    {e.block || '-'}
                  </td>
                  <td style={{ ...td, color: Number(e.latency) > 1000 ? '#d9a441' : '#5c6470' }}>
                    {e.latency ? `${e.latency}ms` : '-'}
                  </td>
                  <td style={{ ...td, color: '#5c6470', maxWidth: 130, overflow: 'hidden',
                               textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.url}>
                    {e.url.replace(/^https?:\/\//, '')}
                  </td>
                  <td style={{ ...td, color: now - e.ts < 120000 ? '#5c6470' : '#d9a441',
                               whiteSpace: 'nowrap' }}>
                    {age(now - e.ts)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rpcs.length === 0 && (
          <div style={{ color: '#3d434d', padding: 12, fontSize: 12 }}>
            no RPC endpoints — superlog-rpc watches them (npm run rpc, config rpc.json).
          </div>
        )}
      </div>
      <div style={{ color: '#3d434d', fontSize: 11, padding: '6px 10px',
                    borderTop: '1px solid #1b2027' }}>
        a block that freezes while still answering is STALLED (amber); no answer
        is DOWN (red). Run two providers per chain to see which failed.
      </div>
    </aside>
  );
}

const th: React.CSSProperties = { padding: '2px 6px', fontWeight: 'normal' };
const td: React.CSSProperties = { padding: '3px 6px', verticalAlign: 'top' };
