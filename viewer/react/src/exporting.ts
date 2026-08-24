//
//  exporting.ts - serialisers for copy and export.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  One module so the clipboard, the three file exports and (by column
//  order) the ImGui viewer agree on what a row looks like outside the app.
//  Everything takes the *visible* rows on purpose: exporting follows the
//  filters, because the moment someone reaches for export they have already
//  narrowed the view to the thing they are chasing.
//

import type { LogRow } from './useLogFeed';

export function timeOf(r: LogRow): string {
  const iso = r.ts ?? new Date(r.hubTs).toISOString();
  return iso.slice(11, 23); // HH:MM:SS.mmm
}

/** The human-readable line - what the screen shows, minus the colour. */
export function rowText(r: LogRow): string {
  let s = `${timeOf(r)} ${r.topic} ${r.level}`;
  if (r.tag) s += ` [${r.tag}]`;
  s += ` ${r.msg}`;
  if (r.metric) s += ` =${r.metric.value}`;
  if (r.fields) for (const [k, v] of Object.entries(r.fields)) s += ` ${k}=${v}`;
  if (r.src) s += ` (${r.src})`;
  return s;
}

export function toTxt(rows: LogRow[]): string {
  return rows.map(rowText).join('\n') + '\n';
}

/** Full fidelity: the parsed rows, hub metadata included. */
export function toJson(rows: LogRow[]): string {
  return JSON.stringify(rows, null, 2) + '\n';
}

const CSV_COLUMNS = [
  'hub_seq', 'ts', 'topic', 'level', 'tag', 'msg',
  'fields', 'metric_name', 'metric_value', 'src', 'session', 'seq',
] as const;

function csvField(v: unknown): string {
  if (v === undefined || v === null) return '';
  let s = String(v);
  // Log content is untrusted; a msg starting with = + - @ would execute as
  // a formula when the CSV lands in a spreadsheet. The apostrophe prefix is
  // the standard defusal.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: LogRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.hubSeq, r.ts ?? new Date(r.hubTs).toISOString(), r.topic, r.level,
        r.tag, r.msg, r.fields ? JSON.stringify(r.fields) : '',
        r.metric?.name, r.metric?.value, r.src, r.session, r.seq,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Clipboard with a fallback: the viewer is often opened over plain http
 *  from another machine on the bench LAN, where navigator.clipboard does
 *  not exist (secure contexts only). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

export function download(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}
