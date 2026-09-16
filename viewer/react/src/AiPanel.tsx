// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The AI interpretation panel: a thin CLIENT of super-log Cloud. Token issuance
// and billing are commercial; this only reads a token the `superlog` launcher
// hands the page as a one-time #cloud=... fragment, asks the Cloud whether this
// org is entitled, and either interprets the bench or renders the server's own
// upsell. The plan ladder and marketing copy are server-driven so they can move
// without a release - but the upsell must NEVER go blank, so a compelling
// built-in pitch stands in whenever the Cloud is unreachable. Findings render as
// TEXT, never markup (log content is data, all the way: the log4j rule).

import { useEffect, useState, type CSSProperties } from 'react';

const API_BASE = 'https://api.super-log.com';
const CONNECT_URL = 'https://super-log.com/connect';

// The built-in pitch. Shown only when the Cloud can't be reached to send its own
// (fresher) copy - a customer must never meet a dead end here. Kept honest and
// tight: the real value, the two free seats, the two ways in.
const FALLBACK_OFFER: Offer = {
  headline: 'Turn your logs into answers',
  body:
    "You're already watching every stream on the bench. Flip this on and super-log "
    + 'reads them for you: click Interpret and get a plain-English account of the last '
    + 'fifteen minutes - what changed, what broke, and what to look at first. A technical '
    + 'read for the engineers, a management read for the room. Start with two free seats. '
    + 'No card - sign in and it works.',
  tiers: [{ name: 'Free', seats: 2, blurb: 'two seats on us, enough for a small bench' }],
  cta: { label: 'Start free — 2 seats', url: CONNECT_URL },
};

// The launcher hands the page a one-time #cloud=<token> fragment; read it once
// and drop it from the URL so it never lingers in history or a screenshot.
function readCloudToken(): string {
  try {
    const m = window.location.hash.match(/[#&]cloud=([^&]+)/);
    if (m && m[1]) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return decodeURIComponent(m[1]);
    }
  } catch { /* no hash available */ }
  return '';
}

interface Tier { name: string; blurb?: string; seats?: number; price_usd_month?: number }
interface Offer { headline?: string; body?: string; tiers?: Tier[]; cta?: { label?: string; url?: string } }

const box: CSSProperties = {
  padding: 12, border: '1px solid #2a2f3a', borderRadius: 8, margin: 8, background: '#12151c',
};
const dim: CSSProperties = { color: '#5c6470', fontSize: 12 };
const primaryBtn: CSSProperties = {
  background: '#7aa2f7', color: '#0b0d12', border: 'none', borderRadius: 6,
  padding: '8px 14px', fontWeight: 600, cursor: 'pointer', fontSize: 14,
};
const codeChip: CSSProperties = {
  background: '#0b0d12', border: '1px solid #2a2f3a', borderRadius: 4,
  padding: '1px 6px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
const wrap: CSSProperties = { maxWidth: 560, margin: '0 auto', textAlign: 'center' };

// A small ASCII badge for the upsell. Pure ASCII on purpose - the same art is
// used in the imgui viewer, whose bitmap font carries no box-drawing glyphs -
// and the border is generated from the wordmark row so it always lines up.
const ART_WAVE = '.:-=I=-:.';
const ART_ROW = `   ${ART_WAVE}   super-log   ${ART_WAVE}   `;
const ART_BAR = '-'.repeat(ART_ROW.length);
const ASCII_LOGO = `+${ART_BAR}+\n|${ART_ROW}|\n+${ART_BAR}+`;

export function AiPanel() {
  const [token] = useState(readCloudToken);
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [plan, setPlan] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [audience, setAudience] = useState<'technical' | 'executive'>('technical');
  const [reading, setReading] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Interpret-vs-upsell: a signed-in org asks the server; no token = the offer.
  useEffect(() => {
    let live = true;
    (async () => {
      if (!token) { setEntitled(false); return; }
      try {
        const r = await fetch(`${API_BASE}/ai/entitlement`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.status === 401) { if (live) setEntitled(false); return; }
        const j = await r.json();
        if (!live) return;
        setEntitled(!!j.entitled);
        setPlan(j.plan || '');
        setRemaining(j.interpretations?.remaining ?? null);
      } catch { if (live) setEntitled(false); }
    })();
    return () => { live = false; };
  }, [token]);

  // Ask the server for its own upsell when not entitled. If it can't be reached
  // we simply keep offer=null and the built-in FALLBACK_OFFER carries the pitch.
  useEffect(() => {
    if (entitled !== false || offer) return;
    let live = true;
    fetch(`${API_BASE}/ai/offer`).then((r) => r.json()).then((j) => { if (live && j) setOffer(j); })
      .catch(() => { /* keep the built-in pitch */ });
    return () => { live = false; };
  }, [entitled, offer]);

  async function interpret() {
    setBusy(true); setReading('');
    try {
      const r = await fetch(`${API_BASE}/ai/interpret`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience, kind: 'bench', wait_ms: 20000 }),
      });
      const j = await r.json();
      const rd = j.reading || {};
      setReading(rd.text || '(no reading returned)');
      setTopics((rd.context?.topTopics || []).slice(0, 6));
      if (j.quota?.remaining != null) setRemaining(j.quota.remaining);
    } catch { setReading('The interpreter did not answer. Is the hub reachable and your subscription active?'); }
    setBusy(false);
  }

  if (entitled === null)
    return <div style={box}><span style={dim}>AI interpretation - loading&hellip;</span></div>;

  if (entitled) {
    return (
      <div style={box}>
        <div style={dim}>{plan ? `${plan} plan` : 'signed in'}{remaining != null ? ` — ${remaining} interpretations left this month` : ''}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' }}>
          <span>Read as:</span>
          <select value={audience} onChange={(e) => setAudience(e.target.value as 'technical' | 'executive')}>
            <option value="technical">Technical &mdash; for the engineers</option>
            <option value="executive">Management &mdash; for the C-suite</option>
          </select>
          <button disabled={busy} onClick={interpret}>{reading ? 'Refresh' : 'Interpret now'}</button>
          {busy && <span style={dim}>reading the last 15 minutes of the bench&hellip;</span>}
        </div>
        {reading
          ? (<div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{reading}</div>
              {topics.length > 0 && <div style={{ ...dim, marginTop: 8 }}>read: {topics.join(', ')}</div>}
            </div>)
          : <div style={dim}>Ask the bench what just happened &mdash; pick an audience and Interpret.</div>}
      </div>
    );
  }

  // Not entitled: sell it. Server copy when the Cloud sent it, the built-in pitch
  // otherwise - this branch is never allowed to render blank or an error.
  const o = offer || FALLBACK_OFFER;
  return (
    <div style={box}>
      <div style={wrap}>
        <pre style={{ color: '#7aa2f7', margin: '0 0 12px', fontSize: 12, lineHeight: 1.15, whiteSpace: 'pre', overflowX: 'auto' }}>{ASCII_LOGO}</pre>
        <div style={{ color: '#7aa2f7', fontSize: 18, fontWeight: 600 }}>{o.headline}</div>
        {o.body && <div style={{ margin: '10px auto', lineHeight: 1.55, maxWidth: 480 }}>{o.body}</div>}
        {o.tiers && o.tiers.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0' }}>
            {o.tiers.map((t, i) => (
              <li key={i} style={{ margin: '2px 0' }}>
                {t.name}
                {t.seats != null ? ` — ${t.seats} seat${t.seats === 1 ? '' : 's'}` : ''}
                {t.price_usd_month != null ? ` — $${t.price_usd_month}/mo` : ''}
                {t.blurb ? <span style={dim}> &mdash; {t.blurb}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <button style={primaryBtn} onClick={() => window.open(o.cta?.url || CONNECT_URL, '_blank')}>
            {o.cta?.label || 'Start free — 2 seats'}
          </button>
        </div>
        <div style={{ ...dim, marginTop: 10 }}>or run <code style={codeChip}>superlog login</code> in your terminal</div>
      </div>
    </div>
  );
}
