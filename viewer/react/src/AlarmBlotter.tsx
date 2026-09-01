// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
//
//  The alarm blotter - the sparse panel, deliberately unlike the firehose.
//
//  One row per dedup key, newest state wins: a key that fired 113 times is
//  ONE row saying repeat 113, a recovered key turns green and ages out of
//  urgency rather than vanishing (resolved and forgotten must not look
//  identical). Everything here comes from alert.* topics - the rules
//  engine's own firings, and production's inbound webhooks through
//  superlog-alarm.
//
//  Alarms own the top of the panel and never share it: the routes grid
//  below is collapsible and scrolls inside its own space. Every route is a
//  row with the same columns - the gateway's own front door included,
//  because a route is a route - and expands into the full diagnostics:
//  whole URL (copyable), kind, ping clock, counters, its verdict from the
//  last test run. The test button round-trips EVERY route, not just one.
//

import { useEffect, useMemo, useState } from 'react';
import type { LogRow } from './useLogFeed';

interface SelftestStep { name: string; ok: boolean; ms: number; detail: string }
interface Selftest {
  ok: boolean;
  steps: SelftestStep[];
  tunnel?: { kind: string; state: string; url: string | null };
  channels?: { name: string; configured: boolean; why: string; active?: boolean }[];
}

interface TunnelHealth {
  name: string; url: string; public_url?: string; interval_s: number;
  healthy: boolean | null; last_ms: number | null; fails: number; checks?: number;
  last_checked?: string | null; last_ok?: string | null;
  kind?: string; target?: string | null; state?: string | null; deletable?: boolean;
}
interface GatewayHealth {
  tunnels?: TunnelHealth[];
  endpoints?: { name: string; kind: string; url: string | null; state: string }[];
}

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

export function AlarmBlotter({ rows, hub }: { rows: LogRow[]; hub: string }) {
  const [open, setOpen] = useState(true);
  const [routesOpen, setRoutesOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [test, setTest] = useState<Selftest | 'running' | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [gw, setGw] = useState<GatewayHealth | null>(null);
  const [newName, setNewName] = useState('');
  const [newPort, setNewPort] = useState('');
  const [provisioned, setProvisioned] = useState<string | null>(null);

  // The gateway lives beside the hub unless told otherwise.
  const gateway =
    new URLSearchParams(window.location.search).get('alarm') ??
    (import.meta.env.VITE_SUPERLOG_ALARM_URL as string | undefined) ??
    hub.replace(/:\d+$/, ':7336');

  // One row per key, latest state wins; keyless alerts fall back to their
  // topic so the rules engine's firings dedup per rule.
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

  // The lights: the gateway measures its routes on their own clocks; the
  // blotter just asks every 30s and draws what it is told.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${gateway}/healthz`);
        if (alive) setGw((await r.json()) as GatewayHealth);
      } catch {
        if (alive) setGw(null);
      }
    };
    void poll();
    const t = setInterval(poll, 30000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);

  const provision = async () => {
    try {
      const r = await fetch(`${gateway}/provision`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName || undefined,
                               ...(newPort ? { port: Number(newPort) } : {}) }),
      });
      const j = (await r.json()) as { ok: boolean; url?: string; error?: string };
      setProvisioned(j.ok && j.url ? j.url : `failed: ${j.error ?? 'unknown'}`);
      setNewName(''); setNewPort('');
    } catch (e) {
      setProvisioned(`failed: ${String((e as Error).message)} - is superlog-alarm running?`);
    }
  };

  const runTest = async () => {
    setTest('running');
    try {
      const r = await fetch(`${gateway}/selftest`, { method: 'POST' });
      setTest((await r.json()) as Selftest);
    } catch (e) {
      setTest({
        ok: false,
        steps: [{ name: 'reach the alarm gateway', ok: false, ms: 0,
                  detail: `${gateway} - ${String((e as Error).message)}. Is superlog-alarm running? (npm run alarm)` }],
      });
      setTestOpen(true);
    }
  };

  // Each route's verdict from the last test run; the gateway's front door
  // answers under its flagship step name.
  const verdictFor = (name: string): SelftestStep | undefined => {
    if (!test || test === 'running') return undefined;
    return test.steps.find((s) => s.name === `route ${name}` ||
                                  (name === 'ALARM' && s.name === 'public round-trip'));
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
              style={{ ...box, position: 'fixed', right: 12, bottom: 12,
                       borderColor: firing.length ? '#e05b4f' : '#262b33',
                       color: firing.length ? '#e05b4f' : '#8a93a3' }}>
        ⚠ alarms{firing.length ? ` (${firing.length})` : ''}
      </button>
    );
  }

  const routes = gw?.tunnels ?? [];
  const testSummary = test && test !== 'running'
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
        <button style={{ ...box, marginLeft: 'auto' }} onClick={() => setOpen(false)}
                title="collapse">✕</button>
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

      {/* The routes grid: collapsible, scrolling in its own space. */}
      <div style={{ borderTop: '1px solid #262b33' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px' }}>
          <button style={{ ...box, border: 'none', background: 'none', padding: 0 }}
                  onClick={() => setRoutesOpen((v) => !v)}>
            {routesOpen ? '▾' : '▸'} routes{routes.length ? ` · ${routes.length}` : ''}
          </button>
          <button style={{ ...box, marginLeft: 'auto' }} onClick={() => void runTest()}
                  title="prove the whole path: hub, tunnel, channels, then a public round-trip through EVERY route">
            {test === 'running' ? 'testing…' : 'test alarm'}
          </button>
          {testSummary && (
            <button style={{ ...box, border: 'none', background: 'none', padding: 0,
                             color: testSummary.ok ? '#68c964' : '#e05b4f' }}
                    onClick={() => setTestOpen((v) => !v)}
                    title="show every step of the last test">
              {testSummary.ok ? 'PASS' : 'FAIL'} {testSummary.okc}/{testSummary.n}
            </button>
          )}
        </div>

        {routesOpen && testOpen && test && test !== 'running' && (
          <div style={{ padding: '4px 10px', borderTop: '1px solid #1b2027',
                        maxHeight: 140, overflowY: 'auto' }}>
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

        {routesOpen && (
          <div style={{ maxHeight: 260, overflowY: 'auto', borderTop: '1px solid #1b2027' }}>
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
                  // The route itself, not the watchdog's ping target.
                  const pub = t.public_url ?? t.url;
                  return [
                    <tr key={t.name} style={{ borderTop: '1px solid #1b2027' }}>
                      <td style={{ ...td, color: t.healthy === true ? '#68c964'
                                       : t.healthy === false ? '#ff2e1f' : '#5c6470',
                                   fontWeight: t.healthy === false ? 'bold' : 'normal' }}>
                        {t.healthy === true ? 'up' : t.healthy === false ? 'DOWN' : '--'}
                      </td>
                      <td style={{ ...td, color: '#c3c9d4', cursor: 'pointer',
                                   whiteSpace: 'nowrap' }}
                          onClick={() => setExpanded((e) => ({ ...e, [t.name]: !isOpen }))}>
                        {isOpen ? '▾' : '▸'} {t.name}
                      </td>
                      <td style={{ ...td, color: '#5c6470', maxWidth: 120, overflow: 'hidden',
                                   textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={pub}>
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
                        <button style={{ ...box, padding: '0 4px' }} title="copy the full URL"
                                onClick={() => void navigator.clipboard.writeText(pub)}>⧉</button>
                        {t.deletable && (
                          <button style={{ ...box, padding: '0 4px', marginLeft: 4 }}
                                  title="tear this endpoint down"
                                  onClick={() => {
                                    void fetch(`${gateway}/provision/${t.name.toLowerCase()}`,
                                               { method: 'DELETE' }).then(() => setGw((g) => g && ({
                                      ...g,
                                      tunnels: g.tunnels?.filter((x) => x.name !== t.name),
                                      endpoints: g.endpoints?.filter(
                                        (x) => x.name.toUpperCase() !== t.name),
                                    })));
                                  }}>✕</button>
                        )}
                      </td>
                    </tr>,
                    isOpen && (
                      <tr key={`${t.name}-detail`}>
                        <td style={td}></td>
                        <td colSpan={5} style={{ ...td, paddingBottom: 8 }}>
                          <div style={{ color: '#c3c9d4', wordBreak: 'break-all' }}>
                            {pub}
                            <button style={{ ...box, marginLeft: 6, padding: '0 4px' }}
                                    onClick={() => void navigator.clipboard.writeText(pub)}>copy</button>
                          </div>
                          {t.url !== pub && (
                            <div style={{ ...detail, wordBreak: 'break-all' }}>ping target: {t.url}</div>
                          )}
                          <div style={detail}>kind: {t.kind ?? 'watch'}
                            {t.target ? ` -> ${t.target}` : ''}</div>
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
          </div>
        )}

        {routesOpen && (
          <div style={{ display: 'flex', gap: 4, padding: '6px 10px',
                        borderTop: '1px solid #1b2027' }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
                   placeholder="name" style={{ ...box, width: 90 }} />
            <input value={newPort} onChange={(e) => setNewPort(e.target.value)}
                   placeholder="port (blank=capture)" style={{ ...box, width: 120 }} />
            <button style={box} onClick={() => void provision()}
                    title="one click, one public URL: forward a local port, or capture deliveries (Stripe webhook testing) as wh.<name> events">
              + endpoint
            </button>
          </div>
        )}
        {routesOpen && provisioned && (
          <div style={{ padding: '4px 10px', fontSize: 12,
                        color: provisioned.startsWith('failed') ? '#e05b4f' : '#68c964',
                        wordBreak: 'break-all' }}>
            {provisioned}
            {!provisioned.startsWith('failed') && (
              <button style={{ ...box, marginLeft: 6 }}
                      onClick={() => void navigator.clipboard.writeText(provisioned)}>copy</button>
            )}
            <button style={{ ...box, marginLeft: 6 }} onClick={() => setProvisioned(null)}>✕</button>
          </div>
        )}
      </div>
    </aside>
  );
}

const box: React.CSSProperties = {
  background: '#181c22', color: '#d6dae2', border: '1px solid #262b33',
  borderRadius: 4, padding: '2px 6px', font: 'inherit', cursor: 'pointer',
};
const th: React.CSSProperties = { padding: '2px 6px', fontWeight: 'normal' };
const td: React.CSSProperties = { padding: '2px 6px', verticalAlign: 'top' };
const detail: React.CSSProperties = { color: '#8a93a3', marginTop: 2 };
