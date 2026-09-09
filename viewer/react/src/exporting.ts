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

// A copy is destined for a PASTE - into a chat, an issue, an LLM - and a paste
// that is megabytes crashes the thing it lands in: an LLM context, or a body
// limit (the hub and many endpoints cap a request at 4 MB). So the copy toolbar
// offers a choice of line counts, and the clipboard is guarded so it can never
// exceed the byte wall no matter what is chosen. SAVE stays uncapped and is the
// escape hatch when you genuinely want the whole thing in a file.
export const COPY_LINE_CHOICES = [512, 1024, 2048] as const;
export const COPY_MAX_BYTES = 3_000_000;   // hard ceiling, comfortably under 4 MB

const byteLen = (s: string): number => new Blob([s]).size;

/** Keep the last `maxLines` lines and stay under `maxBytes`, keeping the tail
 *  (newest lines matter most) and stamping a one-line notice when it trims.
 *  `maxLines` may be Infinity to cap by bytes alone. */
export function capForCopy(text: string,
                           maxLines: number,
                           maxBytes = COPY_MAX_BYTES): string {
  const trailingNL = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNL) lines.pop();
  const total = lines.length;
  let kept = total > maxLines ? lines.slice(total - maxLines) : lines.slice();
  // One fat row (a versions inventory is tens of KB) can blow the byte budget
  // while under the line cap - trim more off the top until it fits.
  while (kept.length > 1 && byteLen(kept.join('\n')) > maxBytes)
    kept = kept.slice(Math.max(1, Math.round(kept.length * 0.1)));
  const body = kept.join('\n') + (trailingNL ? '\n' : '');
  return kept.length < total
    ? `… copy trimmed to the last ${kept.length} of ${total} lines — use save for the rest …\n${body}`
    : body;
}

/** Clipboard with a fallback: the viewer is often opened over plain http
 *  from another machine on the bench LAN, where navigator.clipboard does
 *  not exist (secure contexts only). A hard byte guard is applied here so that
 *  even a copy path that forgot to pick a line count can never hand a paste
 *  something big enough to crash it; the toolbars choose line counts on top. */
export async function copyText(text: string): Promise<boolean> {
  const capped = byteLen(text) > COPY_MAX_BYTES ? capForCopy(text, Infinity) : text;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(capped);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = capped;
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
