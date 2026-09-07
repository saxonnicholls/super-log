// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
/// <reference types="vite/client" />

/** Build stamp injected by vite.config.ts, shown in the header so a stale
 *  bundle is visible rather than merely suspected. */
declare const __SUPERLOG_BUILD__: string;

interface ImportMetaEnv {
  readonly VITE_SUPERLOG_URL?: string;
}
