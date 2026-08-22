//
//  @super-log/client
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  One client for every JavaScript we run: React Native (Expo), the browser,
//  and Node. Zero dependencies - `fetch` is global in all three now, and a
//  batch POST every 250 ms is the whole transport (docs/PROTOCOL.md).
//
//  Events are buffered and dropped-oldest when the buffer fills; a logging
//  client that can stall the app it observes is worse than none, which is
//  the same decision the C++ and Rust SDKs make.
//
//      import { createSuperLog } from '@super-log/client';
//
//      const slog = createSuperLog({
//        url: 'http://192.168.1.20:7333',      // the dev machine; see PROTOCOL.md
//        topic: 'expo.ios.device',             // for the host table
//        app: 'moveables-app',
//        patchConsole: true,                   // console.* now reaches the bench
//      });
//      slog.info('checkout mounted', { user: '42' });
//

export type Level = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface SuperLogOptions {
  /** Hub base URL, e.g. http://192.168.1.20:7333 - no trailing slash. */
  url: string;
  /** Stream name from the PROTOCOL.md topic table, e.g. expo.android.emu. */
  topic: string;
  app: string;
  /** Exactly one of development/production must be true - neither or both
   *  throws, the same rule as the C++ and Rust SDKs. RN callers usually
   *  pass development: __DEV__, production: !__DEV__. */
  development?: boolean;
  production?: boolean;
  /** What each mode forwards: the minimum level that ships, or 'OFF'.
   *  Defaults - development 'TRACE' (everything), production 'OFF'
   *  (nothing): log lines leaving a production app are a security decision,
   *  so loosen it deliberately (e.g. productionPolicy: 'ERROR'), never by
   *  default. Below-policy events are not serialised; a policy of 'OFF'
   *  makes the client an inert shell (no timer, no console patch, nothing
   *  on the wire). Metrics ride at INFO. */
  developmentPolicy?: Level | 'OFF';
  productionPolicy?: Level | 'OFF';
  /** Detected when omitted; RN callers should pass 'ios' | 'android'. */
  platform?: string;
  /** Human-readable, e.g. from expo-device's deviceName. */
  device?: string;
  flushMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  /** Mirror console.log/info/warn/error/debug onto the hub. */
  patchConsole?: boolean;
}

interface EventFields {
  [key: string]: string;
}

const LEVEL_OF_CONSOLE: Record<string, Level> = {
  debug: 'DEBUG',
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

// Policy ranks, matching the C++ SDK's mode.hpp and the Rust crate.
const RANK: Record<Level, number> = {
  TRACE: 1, DEBUG: 2, INFO: 3, WARN: 4, ERROR: 5, CRITICAL: 6,
};
const OFF_RANK = 7;

function detectPlatform(): string {
  if (typeof navigator !== 'undefined' && (navigator as { product?: string }).product === 'ReactNative')
    return 'react-native';
  // Via globalThis so the client type-checks without @types/node - it runs in
  // three runtimes and depends on none of them.
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node) return 'node';
  return 'web';
}

function detectRuntime(): string {
  const p = detectPlatform();
  return p === 'react-native' ? 'react-native' : p === 'node' ? 'node' : 'js';
}

function safeString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export class SuperLog {
  private readonly opts: Required<Pick<SuperLogOptions, 'flushMs' | 'maxBatch' | 'maxQueue'>> &
    SuperLogOptions;
  private readonly ingestUrl: string;
  private readonly session: string;
  private readonly origin: { runtime: string; app: string; platform: string; device?: string };
  private readonly enabled: boolean;
  private readonly minRank: number;
  private buf: string[] = [];
  private seq = 0;
  private droppedCount = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private consoleRestore: (() => void) | undefined;

  constructor(opts: SuperLogOptions) {
    // DEVELOPMENT xor PRODUCTION, enforced - a logging pipeline you *think*
    // is off is worse than one that refuses to start until you decide.
    const dev = opts.development === true;
    const prod = opts.production === true;
    if (dev === prod)
      throw new Error(
        'super-log: set exactly one of development / production (got ' +
          (dev ? 'both' : 'neither') + ')',
      );
    // The active mode picks its policy: dev ships everything by default,
    // prod ships nothing until a dev deliberately loosens it.
    const policy = dev ? (opts.developmentPolicy ?? 'TRACE') : (opts.productionPolicy ?? 'OFF');
    this.minRank = policy === 'OFF' ? OFF_RANK : RANK[policy];
    this.enabled = this.minRank < OFF_RANK;
    this.opts = { flushMs: 250, maxBatch: 256, maxQueue: 2048, ...opts };
    this.ingestUrl = `${opts.url}/ingest/${opts.topic}`;
    this.session = Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
    this.origin = {
      runtime: detectRuntime(),
      app: opts.app,
      platform: opts.platform ?? detectPlatform(),
      ...(opts.device ? { device: opts.device } : {}),
    };
    if (!this.enabled) return; // production: inert shell, nothing scheduled
    this.timer = setInterval(() => void this.flush(), this.opts.flushMs);
    // Node: a log timer must never keep the process alive
    (this.timer as { unref?: () => void }).unref?.();
    if (opts.patchConsole) this.patchConsole();
  }

  log(level: Level, msg: string, fields?: EventFields, tag?: string): void {
    if (RANK[level] < this.minRank) return; // below this mode's policy: not even serialised
    const ev: Record<string, unknown> = {
      v: 1,
      ts: new Date().toISOString(),
      seq: this.seq++,
      session: this.session,
      level,
      origin: this.origin,
      msg,
    };
    if (tag) ev.tag = tag;
    if (fields && Object.keys(fields).length) ev.fields = fields;
    this.push(JSON.stringify(ev));
  }

  trace(msg: string, fields?: EventFields): void { this.log('TRACE', msg, fields); }
  debug(msg: string, fields?: EventFields): void { this.log('DEBUG', msg, fields); }
  info(msg: string, fields?: EventFields): void { this.log('INFO', msg, fields); }
  warn(msg: string, fields?: EventFields): void { this.log('WARN', msg, fields); }
  error(msg: string, fields?: EventFields): void { this.log('ERROR', msg, fields); }

  metric(name: string, value: number): void {
    if (RANK.INFO < this.minRank) return; // metrics ride at INFO
    this.push(
      JSON.stringify({
        v: 1,
        ts: new Date().toISOString(),
        seq: this.seq++,
        session: this.session,
        level: 'INFO',
        origin: this.origin,
        msg: name,
        metric: { name, value },
      }),
    );
  }

  /** Events dropped locally because the buffer was full or a POST failed. */
  dropped(): number {
    return this.droppedCount;
  }

  /** Send what is buffered now. Called on a timer; call it yourself before exit. */
  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const lines = this.buf;
    this.buf = [];
    try {
      // In a browser the ingest POST is cross-origin (page on :7335 or a
      // dev server, hub on :7333) and application/x-ndjson would force a
      // CORS preflight the stock hub does not answer. no-cors sends it as a
      // simple request - opaque response, but we never read it anyway, and
      // the hub treats payloads as opaque bytes whatever the content-type.
      const browser = this.origin.runtime === 'js';
      await fetch(this.ingestUrl, {
        method: 'POST',
        body: lines.join('\n'),
        // Let the batch survive a page unload where supported
        keepalive: true,
        ...(browser
          ? { mode: 'no-cors' }
          : { headers: { 'content-type': 'application/x-ndjson' } }),
      } as RequestInit);
    } catch {
      // The hub is down or unreachable; count, don't retry - the next batch
      // will succeed or count again, and a retry queue grows without bound
      // on a phone that left the building.
      this.droppedCount += lines.length;
    }
  }

  /** Mirror console.* to the hub. Originals still run - this adds a screen,
   *  it does not move one. Returns an unpatch function; close() also unpatches. */
  patchConsole(): () => void {
    if (!this.enabled) return () => {}; // production: console stays untouched
    if (this.consoleRestore) return this.consoleRestore;
    const originals: Array<[string, (...a: unknown[]) => void]> = [];
    for (const name of Object.keys(LEVEL_OF_CONSOLE)) {
      const target = console as unknown as Record<string, (...a: unknown[]) => void>;
      const orig = target[name];
      if (typeof orig !== 'function') continue;
      originals.push([name, orig]);
      const level = LEVEL_OF_CONSOLE[name] as Level;
      target[name] = (...args: unknown[]) => {
        orig.apply(console, args);
        this.log(level, args.map(safeString).join(' '), undefined, 'console');
      };
    }
    // TODO(M3): RN global error handler - ErrorUtils.setGlobalHandler - and
    // browser window.onerror / onunhandledrejection, so crashes reach the
    // bench even when nobody console.error'd them.
    this.consoleRestore = () => {
      const target = console as unknown as Record<string, (...a: unknown[]) => void>;
      for (const [name, orig] of originals) target[name] = orig;
      this.consoleRestore = undefined;
    };
    return this.consoleRestore;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.consoleRestore?.();
    await this.flush();
  }

  private push(line: string): void {
    if (this.buf.length >= this.opts.maxQueue) {
      this.buf.shift();
      this.droppedCount++;
    }
    this.buf.push(line);
    if (this.buf.length >= this.opts.maxBatch) void this.flush();
  }
}

export function createSuperLog(opts: SuperLogOptions): SuperLog {
  return new SuperLog(opts);
}
