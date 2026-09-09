// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The copy/save toolbar every panel carries. One tiny component so a panel
// supplies only a serialiser and a filename stem: "copy" to the clipboard
// (through copyText's http-LAN fallback, because the viewer is often opened
// over plain http from another machine on the bench, where navigator.clipboard
// does not exist), and "save" to a timestamped .txt download. The text is
// lazy - built on click, never on every render of a firehose-fed panel.

import { useState } from 'react';
import { COPY_LINE_CHOICES, capForCopy, copyText, download, stamp } from './exporting';

const btn: React.CSSProperties = {
  background: '#181c22', color: '#d6dae2', border: '1px solid #262b33',
  borderRadius: 4, padding: '2px 6px', font: 'inherit', cursor: 'pointer',
};

export function PanelTools({ text, stem, style }: {
  text: () => string; stem: string; style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState<number | null>(null);
  const doCopy = (n: number) => void copyText(capForCopy(text(), n)).then((ok) => {
    if (ok) { setCopied(n); setTimeout(() => setCopied(null), 1200); }
  });
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center', ...style }}>
      {/* copy the last N lines - a big paste crashes an LLM or a 4 MB body;
          save is the uncapped escape hatch. */}
      <span style={{ color: '#5c6470', fontSize: 11 }}>copy</span>
      {COPY_LINE_CHOICES.map((n) => (
        <button key={n} style={btn} title={`copy the last ${n} lines`}
                onClick={() => doCopy(n)}>
          {copied === n ? '✓' : n}
        </button>
      ))}
      <button style={btn} title="save the whole panel as a timestamped .txt"
              onClick={() => download(`superlog-${stem}-${stamp()}.txt`, 'text/plain', text())}>
        save
      </button>
    </span>
  );
}
