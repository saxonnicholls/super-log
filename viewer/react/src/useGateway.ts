// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// The alarm gateway, as React state: the routes roster polled every 30s,
// an on-demand ping per route (the same watchdog measurement, just now),
// and the selftest. Shared by the alarms panel (production's routes) and
// the webhooks panel (development's) so the two agree on what the
// gateway said.

import { useCallback, useEffect, useState } from 'react';

export interface RouteHealth {
  name: string; url: string; public_url?: string; interval_s: number;
  healthy: boolean | null; last_ms: number | null; fails: number; checks?: number;
  last_checked?: string | null; last_ok?: string | null;
  kind?: string; target?: string | null; state?: string | null; deletable?: boolean;
}
export interface GatewayHealth {
  tunnels?: RouteHealth[];
  endpoints?: { name: string; kind: string; url: string | null; state: string }[];
}
export interface SelftestStep { name: string; ok: boolean; ms: number; detail: string }
export interface Selftest {
  ok: boolean;
  steps: SelftestStep[];
  channels?: { name: string; configured: boolean; why: string; active?: boolean }[];
}

export function gatewayUrl(hub: string): string {
  return (
    new URLSearchParams(window.location.search).get('alarm') ??
    (import.meta.env.VITE_SUPERLOG_ALARM_URL as string | undefined) ??
    hub.replace(/:\d+$/, ':7336')
  );
}

export function useGateway(hub: string) {
  const gateway = gatewayUrl(hub);
  const [gw, setGw] = useState<GatewayHealth | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${gateway}/healthz`);
      setGw((await r.json()) as GatewayHealth);
    } catch {
      setGw(null);
    }
  }, [gateway]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const ping = useCallback(async (name: string) => {
    try {
      await fetch(`${gateway}/ping/${name}`, { method: 'POST' });
    } catch { /* the refresh below reports the truth either way */ }
    void refresh();
  }, [gateway, refresh]);

  const remove = useCallback(async (name: string) => {
    await fetch(`${gateway}/provision/${name.toLowerCase()}`, { method: 'DELETE' })
      .catch(() => null);
    void refresh();
  }, [gateway, refresh]);

  return { gateway, gw, refresh, ping, remove };
}
