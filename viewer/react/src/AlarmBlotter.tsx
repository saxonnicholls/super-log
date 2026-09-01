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
//  The Test button runs the gateway's /selftest - hub, tunnel, a real
//  round-trip out to the internet and back in through the public URL, and
//  the notification channel roster - and shows every step with its
//  diagnosis. An unverified alarm channel is not a channel.
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
  name: string; url: string; interval_s: number;
  healthy: boolean | null; last_ms: number | null; fails: number;
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
  const [test, setTest] = useState<Selftest | 'running' | null>(null);
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

  // The lights: the gateway measures its tunnels on their own clocks; the
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
    }
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

  return (
    <aside style={{ width: 340, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: firing.length ? '#e05b4f' : '#8a93a3' }}>
          ⚠ alarms{firing.length ? ` · ${firing.length} firing` : ''}
        </strong>
        <button style={{ ...box, marginLeft: 'auto' }} onClick={runTest}
                title="prove the whole path: hub, tunnel, a round-trip from the internet, channels">
          {test === 'running' ? 'testing…' : 'test alarm'}
        </button>
        <button style={box} onClick={() => setOpen(false)} title="collapse">✕</button>
      </div>

      {test && test !== 'running' && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid #262b33',
                      background: test.ok ? '#12210f' : '#2a1210' }}>
          <div style={{ color: test.ok ? '#68c964' : '#e05b4f', marginBottom: 4 }}>
            {test.ok ? 'test alarm delivered - the path works' : 'test failed - the diagnosis:'}
            <button style={{ ...box, float: 'right' }} onClick={() => setTest(null)}>dismiss</button>
          </div>
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

      {gw?.tunnels && gw.tunnels.length > 0 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid #262b33', fontSize: 12 }}>
          {gw.tunnels.map((t) => (
            <div key={t.name} title={`${t.url}\npinged every ${t.interval_s}s`}
                 style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span>{t.healthy === true ? '🟢' : t.healthy === false ? '🔴' : '⚪'}</span>
              <span style={{ color: '#c3c9d4' }}>{t.name}</span>
              <span style={{ color: '#5c6470' }}>every {t.interval_s}s</span>
              <span style={{ color: '#5c6470', marginLeft: 'auto' }}>
                {t.healthy === false ? `${t.fails} fails` : t.last_ms != null ? `${t.last_ms}ms` : '…'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, padding: '6px 10px',
                    borderBottom: '1px solid #262b33' }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
               placeholder="name" style={{ ...box, width: 90 }} />
        <input value={newPort} onChange={(e) => setNewPort(e.target.value)}
               placeholder="port (blank=capture)" style={{ ...box, width: 120 }} />
        <button style={box} onClick={() => void provision()}
                title="one click, one public URL: forward a local port, or capture deliveries (Stripe webhook testing) as wh.<name> events">
          + endpoint
        </button>
      </div>
      {provisioned && (
        <div style={{ padding: '4px 10px', fontSize: 12, borderBottom: '1px solid #262b33',
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

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 10px' }}>
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
    </aside>
  );
}

const box: React.CSSProperties = {
  background: '#181c22', color: '#d6dae2', border: '1px solid #262b33',
  borderRadius: 4, padding: '2px 6px', font: 'inherit', cursor: 'pointer',
};
