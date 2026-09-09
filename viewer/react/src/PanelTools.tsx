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
import { copyText, download, stamp } from './exporting';

const btn: React.CSSProperties = {
  background: '#181c22', color: '#d6dae2', border: '1px solid #262b33',
  borderRadius: 4, padding: '2px 6px', font: 'inherit', cursor: 'pointer',
};

export function PanelTools({ text, stem, style }: {
  text: () => string; stem: string; style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: 'flex', gap: 6, ...style }}>
      <button style={btn} title="copy this panel as text"
              onClick={() => void copyText(text()).then((ok) => {
                if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1200); }
              })}>
        {copied ? 'copied ✓' : 'copy'}
      </button>
      <button style={btn} title="save this panel as a timestamped .txt"
              onClick={() => download(`superlog-${stem}-${stamp()}.txt`, 'text/plain', text())}>
        save
      </button>
    </span>
  );
}
