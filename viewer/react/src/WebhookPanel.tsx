// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// DEVELOPMENT's panel - the endpoint factory and the deliveries it
// captures. Stripe events under test land here with the signature verdict
// and relay status the gateway stamped on arrival, far from the alarms:
// both are webhooks, but one is an incident surface and the other is a
// development tool, and a screen that mixes them teaches the eye to skim
// past alarms.

import { useMemo, useState } from 'react';
import type { LogRow } from './useLogFeed';
import { useGateway, type SelftestStep } from './useGateway';
import { RoutesGrid } from './RoutesGrid';

const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

const LEVEL_COLOR: Record<string, string> = {
  INFO: '#68c964', WARN: '#d9a441', ERROR: '#e05b4f', CRITICAL: '#ff2e1f',
};
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'] as const;

// A delivery as paste-able text - the line the feed shows, then the
// verdicts, then the payload verbatim.
const whText = (r: LogRow): string => {
  const lines = [`${r.ts ?? new Date(r.hubTs).toISOString()} ${r.level} ${r.topic} ${r.msg}`];
  if (r.fields?.sig) lines.push(`  sig: ${r.fields.sig}`);
  if (r.fields?.relay_status) lines.push(`  relay: ${r.fields.relay_status}`);
  if (r.fields?.body) lines.push(r.fields.body);
  return lines.join('\n');
};

export function WebhookPanel({ rows, hub, verdictFor }: {
  rows: LogRow[]; hub: string;
  verdictFor: (name: string) => SelftestStep | undefined;
}) {
  const { gateway, gw, refresh, ping, remove } = useGateway(hub);
  const [newName, setNewName] = useState('');
  const [newPort, setNewPort] = useState('');
  const [provisioned, setProvisioned] = useState<string | null>(null);
  const [openBody, setOpenBody] = useState<number | null>(null);
  // The same two filters the main log has: which endpoint, and how loud.
  const [epFilter, setEpFilter] = useState('');   // '' = all endpoints
  const [minLevel, setMinLevel] = useState(0);
  const [copiedAll, setCopiedAll] = useState(false);

  // Development's routes: the endpoint factory's children. Production's
  // (the door, watch-only externals) live in the alarms panel.
  const devRoutes = (gw?.tunnels ?? []).filter((t) =>
    t.kind === 'capture' || t.kind === 'relay' || t.kind === 'forward');

  const endpoints = useMemo(() => [...new Set([
    ...devRoutes.map((r) => r.name.toLowerCase()),
    ...rows.filter((r) => r.topic.startsWith('wh.')).map((r) => r.topic.slice(3)),
  ])].sort(), [devRoutes, rows]);

  const deliveries = useMemo(() =>
    rows.filter((r) => r.topic.startsWith('wh.') &&
                       (!epFilter || r.topic.slice(3) === epFilter) &&
                       LEVELS.indexOf(r.level as typeof LEVELS[number]) >= minLevel)
      .slice(-100).reverse(), [rows, epFilter, minLevel]);

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
      void refresh();
    } catch (e) {
      setProvisioned(`failed: ${String((e as Error).message)} - is superlog-alarm running?`);
    }
  };

  return (
    <aside style={{ width: 380, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: '#8a93a3' }}>⚡ webhooks · {devRoutes.length}</strong>
        <span style={{ color: '#3d434d', fontSize: 12, marginLeft: 'auto' }}>development</span>
      </div>

      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        <RoutesGrid routes={devRoutes} verdictFor={verdictFor}
                    onPing={(n) => void ping(n)} onDelete={(n) => void remove(n)} />
      </div>

      <div style={{ display: 'flex', gap: 4, padding: '6px 10px',
                    borderTop: '1px solid #1b2027', borderBottom: '1px solid #1b2027' }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
               placeholder="name" style={{ ...box, width: 90 }} />
        <input value={newPort} onChange={(e) => setNewPort(e.target.value)}
               placeholder="port (blank=capture)" style={{ ...box, width: 120 }} />
        <button style={box} onClick={() => void provision()}
                title="one click, one public URL: forward a local port, or capture deliveries (Stripe webhook testing) as wh.<name> events - relay/secret/local via endpoints.json">
          + endpoint
        </button>
      </div>
      {provisioned && (
        <div style={{ padding: '4px 10px', fontSize: 12, borderBottom: '1px solid #1b2027',
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

      <div style={{ display: 'flex', gap: 6, alignItems: 'center',
                    padding: '4px 10px' }}>
        <span style={{ color: '#5c6470', fontSize: 11 }}>deliveries</span>
        <select value={epFilter} onChange={(e) => setEpFilter(e.target.value)}
                style={{ ...box, marginLeft: 'auto' }}>
          <option value="">all endpoints</option>
          {endpoints.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <select value={minLevel} onChange={(e) => setMinLevel(Number(e.target.value))}
                style={box}>
          {LEVELS.map((l, i) => <option key={l} value={i}>{l}</option>)}
        </select>
        <button style={box}
                title="every delivery the filters show, newest first, payloads included"
                onClick={() => {
                  if (deliveries.length)
                    void navigator.clipboard.writeText(
                      deliveries.map(whText).join('\n\n') + '\n');
                  setCopiedAll(true);
                  setTimeout(() => setCopiedAll(false), 1500);
                }}>
          {copiedAll ? 'copied' : 'copy all'}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 6px' }}>
        {deliveries.length === 0 && (
          <div style={{ color: '#3d434d', padding: 12, fontSize: 12 }}>
            none yet - paste an endpoint URL into a webhook sender (a Stripe
            endpoint, a GitHub hook) and watch every delivery arrive with its
            signature verdict and relay status.
          </div>
        )}
        {deliveries.map((r) => {
          const sig = r.fields?.sig;
          const relay = r.fields?.relay_status;
          const body = r.fields?.body;
          const open = openBody === r.hubSeq;
          return (
            <div key={r.hubSeq} style={{ padding: '4px 0', borderBottom: '1px solid #1b2027',
                                         fontSize: 12 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <button style={{ ...box, padding: '0 4px', fontSize: 11 }}
                        title="copy this delivery, payload included"
                        onClick={() => void navigator.clipboard.writeText(whText(r) + '\n')}>
                  ⧉
                </button>
                <span style={{ color: LEVEL_COLOR[r.level] ?? '#d6dae2' }}>
                  {r.topic.slice(3)}
                </span>
                <span style={{ color: '#c3c9d4' }}>{r.msg}</span>
                <span style={{ color: '#5c6470', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {age(Date.now() - r.hubTs)} ago
                </span>
              </div>
              {(sig ?? relay) && (
                <div style={{ color: '#8a93a3' }}>
                  {sig && <span style={{ color: sig === 'verified' ? '#68c964' : '#e05b4f' }}>
                    sig: {sig}{' '}</span>}
                  {relay && <span>relay: {relay}</span>}
                </div>
              )}
              {body && (
                <div>
                  <button style={{ ...box, padding: '0 4px', fontSize: 11 }}
                          onClick={() => setOpenBody(open ? null : r.hubSeq)}>
                    {open ? '▾ payload' : '▸ payload'}
                  </button>
                  {open && (
                    <pre style={{ color: '#8a93a3', whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-all', margin: '4px 0 0', fontSize: 11 }}>
                      {body}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

const box: React.CSSProperties = {
  background: '#181c22', color: '#d6dae2', border: '1px solid #262b33',
  borderRadius: 4, padding: '2px 6px', font: 'inherit', cursor: 'pointer',
};
