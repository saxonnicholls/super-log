// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// One menu, two renderers: viewer/menu.json (asoOne's schema - key/label/
// action/attributes/children, CHECKBOX seeded by "checked") is rendered
// here and by the ImGui viewer, so both screens carry the same bar.
// Checkbox state lives in the app, keyed by action; the file only seeds it.

import { useState } from 'react';
import menuSpec from '../../menu.json';

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

export function MenuBar({ toggles, onToggle, onAction }: {
  toggles: Record<string, boolean>;
  onToggle: (action: string) => void;
  onAction: (action: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
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
    </nav>
  );
}

const item: React.CSSProperties = {
  background: 'none', color: '#d6dae2', border: 'none', borderRadius: 4,
  padding: '3px 10px', font: 'inherit', cursor: 'pointer',
};
