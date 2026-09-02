// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The devices panel: each host's USB tree, live, from superlog-usb's
// usb.<host> tree events - and above the trees, the question the panel
// exists to answer: IS MY PHONE CONNECTED. Handsets are recognised by
// name, remembered for the session, and shown connected or unplugged -
// absence as visible as presence, because "adb can't see the device" and
// "Xcode lost the phone" both start here. Refresh pokes the local
// tailer to measure now; remote hosts republish on their own clocks.

import { useMemo, useState } from 'react';
import type { LogRow } from './useLogFeed';

interface UsbNode {
  name: string; vendor?: string; serial?: string; speed?: string;
  children?: UsbNode[];
}

const PHONE = /iphone|ipad|ipod|android|pixel|galaxy|oneplus|xiaomi|huawei|oppo/i;

export function DevicePanel({ rows }: { rows: LogRow[] }) {
  const [refreshed, setRefreshed] = useState(false);

  const { trees, phones } = useMemo(() => {
    const trees = new Map<string, { tree: UsbNode; ts: number }>();
    const phones = new Map<string, { label: string; host: string; serial: string;
                                     connected: boolean; ts: number }>();
    for (const r of rows) {
      if (!r.topic.startsWith('usb.') || !r.fields?.tree) continue;
      let tree: UsbNode;
      try { tree = JSON.parse(r.fields.tree) as UsbNode; } catch { continue; }
      const host = r.topic.slice(4);
      trees.set(host, { tree, ts: r.hubTs });
      const present = new Set<string>();
      const walk = (n: UsbNode) => {
        for (const c of n.children ?? []) {
          if (PHONE.test(c.name)) {
            const key = `${host}/${c.name}#${c.serial ?? ''}`;
            present.add(key);
            const p = phones.get(key);
            phones.set(key, { label: c.name, host, serial: c.serial ?? '',
                              connected: true,
                              ts: p?.connected ? p.ts : r.hubTs });
          }
          walk(c);
        }
      };
      walk(tree);
      for (const [key, p] of phones)
        if (p.host === host && p.connected && !present.has(key))
          phones.set(key, { ...p, connected: false, ts: r.hubTs });
    }
    return { trees, phones };
  }, [rows]);

  const now = Date.now();
  const age = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
  };

  const refresh = () => {
    // The local tailer's loopback poke: measure NOW, not at the next tick.
    void fetch('http://127.0.0.1:7338/poll', { method: 'POST' }).catch(() => null);
    setRefreshed(true);
    setTimeout(() => setRefreshed(false), 1500);
  };

  const renderNode = (n: UsbNode, depth: number, key: string): React.ReactNode => {
    const detail = [n.vendor, n.speed, n.serial ? `sn ${n.serial}` : '']
      .filter(Boolean).join(', ');
    return (
      <div key={key} style={{ marginLeft: depth * 14 }}>
        <span style={{ color: PHONE.test(n.name) ? '#68c964' : '#c3c9d4' }}>
          {n.children?.length ? '▾ ' : '· '}{n.name}
        </span>
        {detail && <span style={{ color: '#5c6470' }}> ({detail})</span>}
        {(n.children ?? []).map((c, i) => renderNode(c, depth + 1, `${key}/${i}`))}
      </div>
    );
  };

  return (
    <aside style={{ width: 360, borderLeft: '1px solid #262b33', display: 'flex',
                    flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderBottom: '1px solid #262b33' }}>
        <strong style={{ color: '#8a93a3' }}>🔌 devices · {trees.size} host(s)</strong>
        <button style={{ ...box, marginLeft: 'auto' }} onClick={refresh}
                title="measure this machine's tree NOW (remote hosts republish on their own clocks)">
          {refreshed ? 'poked' : 'refresh'}
        </button>
      </div>

      {phones.size > 0 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid #1b2027', fontSize: 13 }}>
          {[...phones.entries()].map(([key, p]) => (
            <div key={key} title={p.serial ? `serial ${p.serial}` : undefined}
                 style={{ color: p.connected ? '#68c964' : '#d9a441' }}>
              📱 {p.label} — {p.connected
                ? `connected (${p.host})`
                : `UNPLUGGED ${age(now - p.ts)} ago (was on ${p.host})`}
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px', fontSize: 12 }}>
        {trees.size === 0 && (
          <div style={{ color: '#3d434d', padding: 12 }}>
            no device trees yet — superlog-usb publishes them
            (npm run usb; the demo starts it on macOS).
          </div>
        )}
        {[...trees.entries()].map(([host, t]) => (
          <div key={host} style={{ marginBottom: 8 }}>
            <div style={{ color: '#8a93a3', marginBottom: 2 }}>
              {host} <span style={{ color: '#3d434d' }}>({age(now - t.ts)} ago)</span>
            </div>
            {(t.tree.children ?? []).map((c, i) => renderNode(c, 0, `${host}/${i}`))}
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
