// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// One menu, two renderers: viewer/menu.json (asoOne's schema - key/label/
// action/attributes/children, CHECKBOX seeded by "checked") is rendered
// here and by the ImGui viewer, so both screens carry the same bar.
// Checkbox state lives in the app, keyed by action; the file only seeds it.

import { useEffect, useState } from 'react';
import menuSpec from '../../menu.json';
import viewerConfig from '../../config.json';

export interface MenuItem {
  key: string; label?: string; action?: string;
  attributes?: string[]; checked?: boolean; children?: MenuItem[];
}

export function menuDefaults(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const walk = (items: MenuItem[]) => {
    for (const it of items) {
      if (it.attributes?.includes('CHECKBOX') && it.action)
        out[it.action] = it.checked ?? false;
      if (it.children) walk(it.children);
    }
  };
  walk(menuSpec as MenuItem[]);
  return out;
}

// Where you are, and when - from viewer/config.json, shared with the
// ImGui viewer. environment '' auto-detects: this viewer runs in a
// browser, so "where" is the hub it watches. TAI is UTC + tai_offset_s
// (37 until the next leap second - the config's problem, not this code's).
function envClockText(hub: string, now: Date): string {
  const cfg = viewerConfig as { environment?: string; clocks?: string[]; tai_offset_s?: number };
  const envName = cfg.environment ||
    hub.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  const two = (n: number) => String(n).padStart(2, '0');
  const parts: string[] = [envName];
  for (const c of cfg.clocks ?? ['local', 'utc']) {
    if (c === 'local')
      parts.push(`${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`);
    else if (c === 'utc')
      parts.push(`${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())}Z`);
    else if (c === 'tai') {
      const t = new Date(now.getTime() + (cfg.tai_offset_s ?? 37) * 1000);
      parts.push(`${two(t.getUTCHours())}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())} TAI`);
    }
  }
  return parts.join('  ·  ');
}

export function MenuBar({ toggles, onToggle, onAction, hub }: {
  toggles: Record<string, boolean>;
  onToggle: (action: string) => void;
  onAction: (action: string) => void;
  hub: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const items = menuSpec as MenuItem[];
  return (
    <nav style={{ display: 'flex', gap: 2, padding: '2px 8px',
                  borderBottom: '1px solid #262b33', background: '#12151a',
                  position: 'relative', zIndex: 10 }}
         onMouseLeave={() => setOpen(null)}>
      {items.map((m) => {
        if (m.attributes?.includes('HIDDEN')) return null;
        return (
          <div key={m.key} style={{ position: 'relative' }}>
            <button style={{ ...item, fontWeight: 'normal' }}
                    onClick={() => setOpen(open === m.key ? null : m.key)}
                    onMouseEnter={() => { if (open) setOpen(m.key); }}>
              {m.label}
            </button>
            {open === m.key && m.children && (
              <div style={{ position: 'absolute', top: '100%', left: 0, minWidth: 220,
                            background: '#12151a', border: '1px solid #262b33',
                            borderRadius: 4, padding: 2, zIndex: 20 }}>
                {m.children.map((c) => {
                  if (c.attributes?.includes('HIDDEN')) return null;
                  if (c.attributes?.includes('SEPARATOR'))
                    return <hr key={c.key} style={{ border: 'none',
                                                    borderTop: '1px solid #262b33' }} />;
                  const checkbox = c.attributes?.includes('CHECKBOX');
                  return (
                    <button key={c.key} disabled={c.attributes?.includes('DISABLED')}
                            style={{ ...item, display: 'block', width: '100%',
                                     textAlign: 'left' }}
                            onClick={() => {
                              if (checkbox && c.action) onToggle(c.action);
                              else if (c.action) onAction(c.action);
                              setOpen(null);
                            }}>
                      <span style={{ display: 'inline-block', width: 16 }}>
                        {checkbox && c.action && toggles[c.action] ? '✓' : ''}
                      </span>
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <span style={{ marginLeft: 'auto', color: '#5c6470', padding: '3px 4px',
                     fontSize: 13, whiteSpace: 'nowrap' }}>
        {envClockText(hub, now)}
      </span>
    </nav>
  );
}

const item: React.CSSProperties = {
  background: 'none', color: '#d6dae2', border: 'none', borderRadius: 4,
  padding: '3px 10px', font: 'inherit', cursor: 'pointer',
};
