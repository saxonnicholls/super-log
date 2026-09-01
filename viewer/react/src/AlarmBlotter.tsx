// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
//
//  The alarm blotter - PRODUCTION's panel, sparse by construction.
//
//  One row per dedup key, newest state wins: a key that fired 113 times is
//  ONE row saying repeat 113, a recovered key turns green and ages out of
//  urgency rather than vanishing (resolved and forgotten must not look
//  identical). Everything here comes from alert.* topics - the rules
//  engine's own firings, and production's inbound webhooks through
//  superlog-alarm. Below the blotter: the alarm path - the test button
//  that proves hub, tunnel, channels and every route with a round-trip
//  from the internet, and production's routes (the gateway's door, the
//  watch-only externals). Webhook TESTING lives in its own panel next
//  door - a development tool does not share a screen with an incident
//  surface.
//

import { useMemo, useState } from 'react';
import type { LogRow } from './useLogFeed';
import { useGateway, type Selftest, type SelftestStep } from './useGateway';
import { RoutesGrid } from './RoutesGrid';

const LEVEL_COLOR: Record<string, string> = {
  INFO: '#68c964', WARN: '#d9a441', ERROR: '#e05b4f', CRITICAL: '#ff2e1f',
};

const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};

export function AlarmBlotter({ rows, hub, test, onTest, verdictFor }: {
  rows: LogRow[]; hub: string;
  test: Selftest | 'running' | null;
  onTest: () => void;
  verdictFor: (name: string) => SelftestStep | undefined;
}) {
  const { gw, ping } = useGateway(hub);
  const [stepsOpen, setStepsOpen] = useState(false);

  const alarms = useMemo(() => {
    const byKey = new Map<string, { row: LogRow; recovered: boolean }>();
    for (const r of rows) {
      if (!r.topic.startsWith('alert.')) continue;
      const key = r.fields?.key ?? r.topic;
      byKey.set(key, { row: r, recovered: r.fields?.kind === 'recovered' || /^RECOVERED/.test(r.msg) });
    }
    return [...byKey.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.row.hubTs - a.row.hubTs);
  }, [rows]);

  const firing = alarms.filter((a) => !a.recovered && a.row.level !== 'INFO');

  // Production's routes: the door and the watched externals.
  const prodRoutes = (gw?.tunnels ?? []).filter((t) =>
    t.name === 'ALARM' || t.kind === 'watch' || (t.kind ?? '').startsWith('gateway'));

  const summary = test && test !== 'running'
    ? { ok: test.ok, okc: test.steps.filter((s) => s.ok).length, n: test.steps.length }
    : null;

  return (
    <aside style={{ width: 380, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: firing.length ? '#e05b4f' : '#8a93a3' }}>
          ⚠ alarms{firing.length ? ` · ${firing.length} firing` : ''}
        </strong>
        <span style={{ color: '#3d434d', fontSize: 12, marginLeft: 'auto' }}>production</span>
      </div>

      {/* Alarms first, always: this space belongs to them alone. */}
      <div style={{ flex: 1, minHeight: 120, overflowY: 'auto', padding: '4px 10px' }}>
        {alarms.length === 0 && (
          <div style={{ color: '#3d434d', padding: 12 }}>
            no alarms - which is the idea.
            <div style={{ marginTop: 6, fontSize: 12 }}>
              Rules (alerts.json) and production webhooks (superlog-alarm) land here,
              one row per key, repeats counted.
            </div>
          </div>
        )}
        {alarms.map(({ key, row, recovered }) => (
          <div key={key}
               style={{ padding: '6px 4px', borderBottom: '1px solid #1b2027',
                        opacity: recovered ? 0.55 : 1 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ color: recovered ? '#68c964' : (LEVEL_COLOR[row.level] ?? '#d6dae2'),
                             fontWeight: recovered ? 'normal' : 'bold' }}>
                {recovered ? '✓' : '●'} {key}
              </span>
              {row.fields?.repeat && Number(row.fields.repeat) > 1 && (
                <span style={{ color: '#d9a441', fontSize: 12 }}>×{row.fields.repeat}</span>
              )}
              <span style={{ color: '#5c6470', marginLeft: 'auto', fontSize: 12 }}>
                {age(Date.now() - row.hubTs)}
              </span>
            </div>
            <div style={{ color: '#c3c9d4', fontSize: 13, whiteSpace: 'pre-wrap' }}>{row.msg}</div>
            <div style={{ color: '#5c6470', fontSize: 11 }}>{row.topic}</div>
          </div>
        ))}
      </div>

      {/* The alarm path: the test, and production's routes. */}
      <div style={{ borderTop: '1px solid #262b33' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px' }}>
          <button style={box} onClick={onTest}
                  title="prove the whole path: hub, tunnel, channels, then a public round-trip through EVERY route">
            {test === 'running' ? 'testing…' : 'test alarm'}
          </button>
          {summary && (
            <button style={{ ...box, border: 'none', background: 'none',
                             color: summary.ok ? '#68c964' : '#e05b4f' }}
                    onClick={() => setStepsOpen((v) => !v)}
                    title="show every step of the last test">
              {summary.ok ? 'PASS' : 'FAIL'} {summary.okc}/{summary.n}
            </button>
          )}
        </div>
        {stepsOpen && test && test !== 'running' && (
          <div style={{ padding: '4px 10px', maxHeight: 140, overflowY: 'auto' }}>
            {test.steps.map((s) => (
              <div key={s.name} style={{ fontSize: 12, marginBottom: 2 }}>
                <span style={{ color: s.ok ? '#68c964' : '#e05b4f' }}>{s.ok ? '✓' : '✗'} {s.name}</span>
                <span style={{ color: '#8a93a3' }}> ({s.ms}ms) {s.detail}</span>
              </div>
            ))}
            {test.channels && (
              <div style={{ fontSize: 12, color: '#8a93a3', marginTop: 4 }}>
                channels:{' '}
                {test.channels.map((c) => (
                  <span key={c.name} title={c.configured ? 'ready' : c.why}
                        style={{ marginRight: 6,
                                 color: c.active ? (c.configured ? '#68c964' : '#e05b4f') : '#3d434d' }}>
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ maxHeight: 180, overflowY: 'auto', borderTop: '1px solid #1b2027' }}>
          <RoutesGrid routes={prodRoutes} verdictFor={verdictFor}
                      onPing={(n) => void ping(n)} />
        </div>
      </div>
    </aside>
  );
}

const box: React.CSSProperties = {
  background: '#181c22', color: '#d6dae2', border: '1px solid #262b33',
  borderRadius: 4, padding: '2px 6px', font: 'inherit', cursor: 'pointer',
};
