// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The one place the MIT viewer learns whether it is signed in to super-log
// Cloud. Token issuance and billing are commercial and never live here; this
// only READS a one-time #cloud=<token> fragment that the launcher - or the VS
// Code extension host, from ~/.superlog/cloud.json - hands the page, and keeps
// it for the session. The header's login light and the AI panel read the SAME
// token, so they can never disagree, and it is consumed here exactly once (two
// readers would race and one would find nothing).

export const API_BASE = 'https://api.super-log.com';
export const CONNECT_URL = 'https://super-log.com/connect';

function readCloudToken(): string {
  try {
    const m = window.location.hash.match(/[#&]cloud=([^&]+)/);
    if (m && m[1]) {
      // Drop it from the URL so it never lingers in history or a screenshot.
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return decodeURIComponent(m[1]);
    }
  } catch { /* no hash available (sandbox, SSR) */ }
  return '';
}

export const CLOUD_TOKEN = readCloudToken();
export const signedIn = (): boolean => CLOUD_TOKEN.length > 0;

// A Cloud API call from a VS Code webview hits CORS - the API allows the
// browser viewer's origin, not vscode-webview:// - so the extension host injects
// window.__superlogBridge, which performs the request in Node (no CORS) and
// hands back the result. We use it when present; a standalone browser has none
// and fetches directly (its origin IS allowed). One code path, both homes.
interface BridgeReq { url: string; method: string; headers: Record<string, string>; body?: string }
interface BridgeRes { ok: boolean; status: number; body?: string; error?: string }
type Bridge = (r: BridgeReq) => Promise<BridgeRes>;

export interface CloudResult { ok: boolean; status: number; json: any }

export async function cloudFetch(
  path: string,
  init: { method?: string; token?: string; body?: string } = {},
): Promise<CloudResult> {
  const url = path.startsWith('http') ? path : API_BASE + path;
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body) headers['Content-Type'] = 'application/json';

  const bridge = (window as unknown as { __superlogBridge?: Bridge }).__superlogBridge;
  if (bridge) {
    const r = await bridge({ url, method, headers, body: init.body });
    let json: any = null;
    try { json = r.body ? JSON.parse(r.body) : null; } catch { /* non-JSON */ }
    return { ok: r.ok, status: r.status, json };
  }
  const r = await fetch(url, { method, headers, body: init.body });
  let json: any = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, json };
}
