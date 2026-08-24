//
//  journal-read - the other end of superlog-journal.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  superlog-journal appends hub envelope frames verbatim, one per line.
//  This module reads them back, and superlog-search and superlog-replay
//  share it so that --since, --topic and friends mean exactly the same
//  thing in both tools - and the same thing they mean on the hub's
//  /recent, whose topic and level rules are mirrored here on purpose.
//
//  Nothing here ever holds a file in memory. A journal is measured in
//  gigabytes; everything is a line at a time over a read stream, and the
//  callers keep at most `limit` rows.
//

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';

export const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

/** Unknown or missing level is INFO - the tolerant-reader default the hub
 *  and both viewers already use. */
export function levelRank(level) {
  const i = LEVELS.indexOf(String(level ?? '').toUpperCase());
  return i < 0 ? LEVELS.indexOf('INFO') : i;
}

/** Exact topic, `*`/empty for all, or a prefix ending in a dot. Same rule as
 *  recent_ring::topic_matches in hub/src/main.cpp - two implementations of
 *  one rule is already one too many, so keep them in step. */
export function topicMatches(want, name) {
  if (!want || want === '*' || want === name) return true;
  return want.endsWith('.') && name.length > want.length && name.startsWith(want);
}

const UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

/**
 * A point in time from what someone would actually type: `30m`, `2h`, `3d`,
 * `now`, `03:00` (today), `2026-08-22`, or a full ISO timestamp.
 *
 * Bare times are read as UTC, because UTC is what the events carry and what
 * the viewers display - a search whose clock disagreed with the line it
 * printed would be worse than useless.
 */
export function parseWhen(spec, now = Date.now()) {
  if (spec === undefined || spec === null || spec === '') return undefined;
  const s = String(spec).trim();
  if (s === 'now') return now;

  const rel = /^-?(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(s);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];

  let iso = s;
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
  if (hm) iso = `${new Date(now).toISOString().slice(0, 10)}T${hm[1].padStart(2, '0')}:${hm[2]}:${hm[3] ?? '00'}Z`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += 'T00:00:00Z';
  else if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';

  const t = Date.parse(iso);
  if (!Number.isFinite(t))
    throw new Error(
      `cannot read a time from ${JSON.stringify(s)} - try 30m, 2h, 3d, 03:00, 2026-08-22 or a full ISO timestamp`,
    );
  return t;
}

const JOURNAL_NAME = /\.ndjson(\.gz)?$/;

/**
 * The journal files under `where`, oldest first - which is also the order
 * the hub published them in. Sorting by name is chronological because the
 * writer stamps `superlog-YYYYMMDD-HHMMSS`; a file path is accepted too, so
 * one journal can be searched without moving it.
 */
export function journalFiles(where) {
  if (!existsSync(where)) return [];
  if (statSync(where).isFile()) return [where];
  return readdirSync(where)
    .filter((n) => JOURNAL_NAME.test(n))
    .sort()
    .map((n) => join(where, n));
}

/** A substring usable as a pre-parse gate on the raw frame line. The payload
 *  is JSON-escaped inside the envelope, so only needles that escaping cannot
 *  touch (no quote, no backslash, no control character) survive the trip
 *  verbatim; anything else falls back to testing each parsed event. */
function fastNeedle(contains) {
  if (!contains) return '';
  return /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/.test(contains) ? contains.toLowerCase() : '';
}

function openLines(path) {
  const file = createReadStream(path);
  const input = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
  return { file, input, rl: createInterface({ input, crlfDelay: Infinity }) };
}

/**
 * Envelope frames from `files`, in order, with the cheap gates applied
 * before the JSON parse - topic and text are scanned out of the raw line the
 * way the hub reads `level` out of an event, because a parse per line over
 * gigabytes is the whole cost of the tool.
 *
 * A line that does not parse is skipped and counted, never fatal: a journal
 * whose tail was truncated by a kill -9 is still worth reading.
 */
export async function* readFrames(files, opts = {}) {
  const { topic, contains, since, until, onBadLine, onFileError, onFile } = opts;
  const needle = fastNeedle(contains);

  for (const path of files) {
    let handles;
    try {
      handles = openLines(path);
    } catch (e) {
      onFileError?.(path, e);
      continue;
    }
    onFile?.(path);
    const { file, input, rl } = handles;
    let stop = false;
    try {
      for await (const line of rl) {
        if (!line) continue;

        const tm = /"topic":"([^"]*)"/.exec(line);
        if (topic && tm && !topicMatches(topic, tm[1])) continue;
        if (needle && !line.toLowerCase().includes(needle)) continue;

        // The time window is on the frame's HUB ARRIVAL time, not on the
        // producer's `ts`. PROTOCOL.md is blunt about why: phone clocks
        // drift, and `ts` is display, not truth. Arrival is monotonic and
        // the journal is written in it, so the window is exact, needs no
        // slack for skew, and - the part that matters over gigabytes - once
        // arrival passes `until` nothing later can qualify, so the
        // remaining files are never read at all. The line still SHOWS the
        // producer's ts, which is what the viewers show.
        const am = /"ts_ms":\s*(\d+)/.exec(line);
        const arrived = am ? Number(am[1]) : NaN;
        if (Number.isFinite(arrived)) {
          if (since !== undefined && arrived < since) continue;
          if (until !== undefined && arrived > until) {
            stop = true;
            break;
          }
        }

        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          onBadLine?.(path, line);
          continue;
        }
        if (!frame || typeof frame.payload !== 'string' || typeof frame.topic !== 'string') {
          onBadLine?.(path, line);
          continue;
        }
        // The scans above are pre-filters, not the filter: a frame that got
        // past them because a regex did not fire is still tested here, so a
        // caller never has to re-check what it asked for.
        if (topic && !topicMatches(topic, frame.topic)) continue;
        if (Number.isFinite(frame.ts_ms)) {
          if (since !== undefined && frame.ts_ms < since) continue;
          if (until !== undefined && frame.ts_ms > until) {
            stop = true;
            break;
          }
        }
        yield frame;
      }
    } catch (e) {
      onFileError?.(path, e);
    } finally {
      rl.close();
      input.destroy?.();
      file.destroy?.();
    }
    if (stop) return;
  }
}

/**
 * The events inside one frame, as rows shaped like the hub's /recent answer
 * plus the resolved timestamp. A payload line that is not JSON becomes
 * `{msg: <the raw line>}` - PROTOCOL.md's tolerant-reader rule, the same one
 * that lets a dumb logcat tailer share this pipeline.
 */
export function rowsOf(frame) {
  const rows = [];
  for (const raw of frame.payload.split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    let ev;
    try {
      ev = JSON.parse(text);
      if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) ev = { msg: text };
    } catch {
      ev = { msg: text };
    }
    // `ts` is for the eye (the producer's own clock, as the viewers show
    // it); `at` is hub arrival, which is what anything ordering or
    // windowing must use.
    rows.push({
      seq: frame.seq,
      ts_ms: frame.ts_ms,
      topic: frame.topic,
      ev,
      ts: typeof ev.ts === 'string' ? ev.ts : new Date(frame.ts_ms).toISOString(),
      at: frame.ts_ms,
      raw: text,
    });
  }
  return rows;
}

/** The per-event tests. Time is not among them: the window is a property of
 *  the frame and readFrames has already applied it. `contains` matches the
 *  whole event text, not just `msg`, so a field value or a trace id is
 *  findable without knowing which key it lives under - the same reach
 *  `search_logs` has in the MCP server. */
export function matchRow(row, f) {
  if (f.minLevel > 0 && levelRank(row.ev.level) < f.minLevel) return false;
  if (f.trace && row.ev.trace !== f.trace) return false;
  if (f.contains && !row.raw.toLowerCase().includes(f.contains)) return false;
  return true;
}

/** One event, one line - the viewers' `rowText`, minus the colour. The date
 *  rides along only when a result set spans more than one day, so the common
 *  case reads exactly like the screen it came from. */
export function formatRow(row, { date = false } = {}) {
  const ev = row.ev;
  const time = date ? `${row.ts.slice(5, 10)} ${row.ts.slice(11, 23)}` : row.ts.slice(11, 23);
  let s = `${time} ${row.topic} ${ev.level ?? 'INFO'}`;
  if (ev.tag) s += ` [${ev.tag}]`;
  s += ` ${ev.msg ?? ''}`;
  if (ev.metric) s += ` =${ev.metric.value}`;
  if (ev.fields) for (const [k, v] of Object.entries(ev.fields)) s += ` ${k}=${v}`;
  if (ev.src) s += ` (${ev.src})`;
  return s;
}
