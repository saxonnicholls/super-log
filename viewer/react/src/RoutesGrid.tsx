// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// One grid, two panels: the alarms panel shows production's routes, the
// webhooks panel shows development's. Same columns, same expandable
// diagnostics, a ping button per row - because a route is a route, and
// which side of the split it lives on is the only difference.

import { useState } from 'react';
import type { RouteHealth, SelftestStep } from './useGateway';

const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};

export function RoutesGrid({ routes, verdictFor, onPing, onDelete }: {
  routes: RouteHealth[];
  verdictFor: (name: string) => SelftestStep | undefined;
  onPing: (name: string) => void;
  onDelete?: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (routes.length === 0)
    return <div style={{ color: '#3d434d', padding: '6px 10px', fontSize: 12 }}>
      no routes yet - is superlog-alarm running? (npm run alarm)</div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ color: '#5c6470', textAlign: 'left' }}>
          <th style={th}></th><th style={th}>route</th><th style={th}>url</th>
          <th style={th}>seen</th><th style={th}>ping</th><th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {routes.map((t) => {
          const isOpen = !!expanded[t.name];
          const v = verdictFor(t.name);
          const pub = t.public_url ?? t.url;
          return [
            <tr key={t.name} style={{ borderTop: '1px solid #1b2027' }}>
              <td style={{ ...td, color: t.healthy === true ? '#68c964'
                               : t.healthy === false ? '#ff2e1f' : '#5c6470',
                           fontWeight: t.healthy === false ? 'bold' : 'normal' }}>
                {t.healthy === true ? 'up' : t.healthy === false ? 'DOWN' : '--'}
              </td>
              <td style={{ ...td, color: '#c3c9d4', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={() => setExpanded((e) => ({ ...e, [t.name]: !isOpen }))}>
                {isOpen ? '▾' : '▸'} {t.name}
              </td>
              <td style={{ ...td, color: '#5c6470', maxWidth: 120, overflow: 'hidden',
                           textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pub}>
                {pub.replace(/^https?:\/\//, '')}
              </td>
              <td style={{ ...td, color: '#5c6470', whiteSpace: 'nowrap' }}
                  title={t.last_checked ?? 'not yet pinged'}>
                {t.last_checked ? age(Date.now() - Date.parse(t.last_checked)) : '-'}
              </td>
              <td style={{ ...td, color: '#5c6470', whiteSpace: 'nowrap' }}>
                {t.last_ms != null ? `${t.last_ms}ms` : '-'}
              </td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                <button style={btn} title="measure this route now - same check, same books, just not on the clock"
                        onClick={() => onPing(t.name)}>ping</button>
                <button style={{ ...btn, marginLeft: 4 }} title="copy the full URL"
                        onClick={() => void navigator.clipboard.writeText(pub)}>⧉</button>
                {t.deletable && onDelete && (
                  <button style={{ ...btn, marginLeft: 4 }} title="tear this endpoint down"
                          onClick={() => onDelete(t.name)}>✕</button>
                )}
              </td>
            </tr>,
            isOpen && (
              <tr key={`${t.name}-detail`}>
                <td style={td}></td>
                <td colSpan={5} style={{ ...td, paddingBottom: 8 }}>
                  <div style={{ color: '#c3c9d4', wordBreak: 'break-all' }}>
                    {pub}
                    <button style={{ ...btn, marginLeft: 6 }}
                            onClick={() => void navigator.clipboard.writeText(pub)}>copy</button>
                  </div>
                  {t.url !== pub && (
                    <div style={{ ...detail, wordBreak: 'break-all' }}>ping target: {t.url}</div>
                  )}
                  <div style={detail}>kind: {t.kind ?? 'watch'}{t.target ? ` -> ${t.target}` : ''}</div>
                  {t.interval_s > 0 && (
                    <div style={detail}>ping clock: every {t.interval_s}s
                      {t.checks != null ? ` - ${t.checks} checks` : ''}
                      {t.fails ? `, ${t.fails} failing now` : ''}</div>
                  )}
                  <div style={detail}>last ok: {t.last_ok
                    ? `${age(Date.now() - Date.parse(t.last_ok))} ago` : 'never'}</div>
                  {t.state && <div style={detail}>tunnel: {t.state}</div>}
                  {v && (
                    <div style={{ ...detail, color: v.ok ? '#68c964' : '#e05b4f' }}>
                      last test: {v.ok ? 'ok' : 'FAILED'}
                      <span style={{ color: '#8a93a3' }}> - {v.detail}</span>
                    </div>
                  )}
                </td>
              </tr>
            ),
          ];
        })}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = { padding: '2px 6px', fontWeight: 'normal' };
const td: React.CSSProperties = { padding: '2px 6px', verticalAlign: 'top' };
const detail: React.CSSProperties = { color: '#8a93a3', marginTop: 2 };
const btn: React.CSSProperties = {
  background: '#181c22', color: '#d6dae2', border: '1px solid #262b33',
  borderRadius: 4, padding: '0 4px', font: 'inherit', cursor: 'pointer',
};
