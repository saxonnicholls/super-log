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
  /** Log every HTTP call the app makes - method, URL, status, duration,
   *  size - as `net.*` events tagged `http`. Off by default: it is the
   *  loudest thing the client can do. Patches XMLHttpRequest (which is
   *  what React Native's fetch, axios and most libraries end up using) and
   *  native fetch where there is one. Never logs bodies, and redacts
   *  credential-shaped query values from URLs. */
  patchNetwork?: boolean;
  /** Log every uncaught exception and unhandled rejection (default true).
   *  Installs the right global hook for the runtime - React Native's
   *  ErrorUtils, the browser's error/unhandledrejection events, Node's
   *  uncaughtExceptionMonitor - and *chains* rather than swallows, so the
   *  red box still appears, the browser console still reports, and Node
   *  still crashes exactly as it would have. */
  captureUncaught?: boolean;
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

// Deep enough to find the throw, short enough not to ship a book per crash.
const MAX_STACK_LINES = 40;
// How long a dying process waits for its last batch. Long enough for a
// loopback POST, short enough that a wedged hub cannot hang the exit.
const FATAL_FLUSH_MS = 1500;

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

// Credentials live in query strings more often than anyone admits. The URL
// is worth having; the token in it is not worth shipping to a dev bench.
const SECRET_PARAM = /^(token|access_token|id_token|refresh_token|key|api[-_]?key|secret|password|pwd|auth|signature|sig|session)$/i;

function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url.slice(0, 512);
  const base = url.slice(0, q);
  const parts = url.slice(q + 1).split('&').map((kv) => {
    const eq = kv.indexOf('=');
    if (eq < 0) return kv;
    const k = kv.slice(0, eq);
    return SECRET_PARAM.test(decodeURIComponent(k)) ? `${k}=<redacted>` : kv;
  });
  return `${base}?${parts.join('&')}`.slice(0, 512);
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
  private uncaughtRestore: (() => void) | undefined;
  private netRestore: (() => void) | undefined;
  private pending: Promise<void> | undefined;

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
    if (opts.captureUncaught !== false) this.captureUncaught();
    if (opts.patchNetwork) this.patchNetwork();
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

  /** Send what is buffered now. Called on a timer; call it yourself before exit.
   *  With an empty buffer it still awaits a POST already in flight - a
   *  crashing process calls flush() to mean "make sure it left", and an
   *  earlier fire-and-forget flush must not let it exit early. */
  async flush(): Promise<void> {
    if (this.buf.length === 0) {
      await this.pending;
      return;
    }
    const lines = this.buf;
    this.buf = [];
    try {
      // In a browser the ingest POST is cross-origin (page on :7335 or a
      // dev server, hub on :7333) and application/x-ndjson would force a
      // CORS preflight the stock hub does not answer. no-cors sends it as a
      // simple request - opaque response, but we never read it anyway, and
      // the hub treats payloads as opaque bytes whatever the content-type.
      const browser = this.origin.runtime === 'js';
      const post = fetch(this.ingestUrl, {
        method: 'POST',
        body: lines.join('\n'),
        // Let the batch survive a page unload where supported
        keepalive: true,
        ...(browser
          ? { mode: 'no-cors' }
          : { headers: { 'content-type': 'application/x-ndjson' } }),
      } as RequestInit);
      // Published so a later flush() - a dying process asking "did it
      // leave?" - can await this exact POST rather than an empty buffer.
      this.pending = post.then(
        () => undefined,
        () => {
          this.droppedCount += lines.length;
        },
      );
      await this.pending;
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
    this.consoleRestore = () => {
      const target = console as unknown as Record<string, (...a: unknown[]) => void>;
      for (const [name, orig] of originals) target[name] = orig;
      this.consoleRestore = undefined;
    };
    return this.consoleRestore;
  }

  /** Log an Error with its stack, wherever it came from. `fatal` marks the
   *  ones that ended the process/render rather than merely being caught. */
  exception(err: unknown, where = 'uncaught', fields?: EventFields): void {
    const e = err as { name?: string; message?: string; stack?: string } | undefined;
    const name = e?.name ?? 'Error';
    const message = e?.message ?? safeString(err);
    const extra: EventFields = { where, ...fields };
    if (e?.stack) {
      // The whole stack, but bounded: a deep RN stack can be hundreds of
      // frames and the point is to identify the throw, not to ship a book.
      const frames = e.stack.split('\n').slice(0, MAX_STACK_LINES);
      extra.stack = frames.join('\n');
      if (e.stack.split('\n').length > MAX_STACK_LINES) extra.stack_truncated = 'true';
    }
    this.log('ERROR', `${where}: ${name}: ${message}`, extra, 'exception');
    // A crash is the one event worth trying to get out immediately - the
    // process may not survive to the next flush tick.
    void this.flush();
  }

  /** Log every HTTP call the app makes. Returns an uninstall function;
   *  close() also uninstalls.
   *
   *  Both fetch and XMLHttpRequest are patched, because different
   *  libraries use different ones (axios uses XHR, most app code uses
   *  fetch). The trick is counting each call ONCE: React Native's fetch is
   *  a polyfill that calls XHR underneath, so a naive pair of patches
   *  double-logs every RN fetch. The fetch wrapper therefore marks the
   *  window in which it synchronously kicks off its request, and an XHR
   *  started inside that window stays quiet and lets fetch report it. */
  patchNetwork(): () => void {
    if (!this.enabled || this.netRestore) return this.netRestore ?? (() => {});
    const g = globalThis as Record<string, unknown>;
    const undo: Array<() => void> = [];

    const record = (method: string, url: string, status: number, started: number, bytes: number) => {
      // Never log our own POSTs to the hub, or the client feeds itself.
      if (!url || url.startsWith(this.opts.url)) return;
      const ms = Math.round(Date.now() - started);
      const level: Level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
      const fields: EventFields = {
        method,
        url: redactUrl(url),
        status: String(status),
        ms: String(ms),
      };
      if (bytes > 0) fields.bytes = String(bytes);
      this.log(level, `${method} ${redactUrl(url)} → ${status || 'failed'} in ${ms}ms`, fields, 'http');
    };

    // >0 while a patched fetch is synchronously starting its request, which
    // is when a polyfill would call xhr.send(). Read at send() time, not at
    // loadend, which fires long after.
    let insideFetch = 0;

    const XHR = g.XMLHttpRequest as (new () => XMLHttpRequest) | undefined;
    if (XHR?.prototype) {
      const proto = XHR.prototype as unknown as Record<string, unknown>;
      const openOrig = proto.open as (...a: unknown[]) => unknown;
      const sendOrig = proto.send as (...a: unknown[]) => unknown;
      proto.open = function (this: Record<string, unknown>, method: string, url: string, ...rest: unknown[]) {
        this.__slMethod = method;
        this.__slUrl = url;
        return openOrig.call(this, method, url, ...rest);
      };
      const self = this;
      proto.send = function (this: Record<string, unknown> & XMLHttpRequest, ...a: unknown[]) {
        const started = Date.now();
        const viaFetch = insideFetch > 0; // fetch will report this one
        try {
          this.addEventListener('loadend', () => {
            try {
              if (viaFetch) return;
              record(String(this.__slMethod ?? 'GET'), String(this.__slUrl ?? ''),
                     this.status, started,
                     Number(this.getResponseHeader?.('content-length') ?? 0) || 0);
            } catch {
              /* a logger must never break the call it observed */
            }
          });
        } catch {
          /* no addEventListener (exotic polyfill): skip logging, still send */
        }
        return sendOrig.call(this, ...a);
      };
      undo.push(() => {
        proto.open = openOrig;
        proto.send = sendOrig;
      });
    }

    const fetchOrig = g.fetch as ((...a: unknown[]) => Promise<Response>) | undefined;
    if (typeof fetchOrig === 'function') {
      g.fetch = (input: unknown, init?: { method?: string }) => {
        const started = Date.now();
        const url =
          typeof input === 'string' ? input
            : (input as { url?: string })?.url ?? String(input);
        const method = init?.method ?? (input as { method?: string })?.method ?? 'GET';
        // Not awaited here: the call must be started inside the window so
        // a polyfill's xhr.send() sees insideFetch > 0 and stays quiet.
        let p: Promise<Response>;
        insideFetch++;
        try {
          p = fetchOrig(input, init);
        } finally {
          insideFetch--;
        }
        return p.then(
          (res) => {
            try {
              record(method, url, res.status, started,
                     Number(res.headers?.get?.('content-length') ?? 0) || 0);
            } catch {
              /* a logger must never break the call it observed */
            }
            return res;
          },
          (e) => {
            try {
              record(method, url, 0, started, 0);
            } catch {
              /* never break the call */
            }
            throw e; // the caller's error is the caller's, unchanged
          },
        );
      };
      undo.push(() => {
        g.fetch = fetchOrig;
      });
    }

    this.netRestore = () => {
      for (const u of undo) u();
      this.netRestore = undefined;
    };
    return this.netRestore;
  }

  /** Install the runtime's global error hooks. Chains to whatever was
   *  there, so nothing that used to happen stops happening: RN still shows
   *  the red box, the browser still logs to its console, Node still exits.
   *  Returns an uninstall function; close() also uninstalls. */
  captureUncaught(): () => void {
    if (!this.enabled || this.uncaughtRestore) return this.uncaughtRestore ?? (() => {});
    const undo: Array<() => void> = [];
    const g = globalThis as Record<string, unknown>;

    // React Native. ErrorUtils is RN's own last line of defence; replacing
    // it without calling the previous handler would kill the red box and
    // any crash reporter already installed.
    const EU = g.ErrorUtils as
      | { getGlobalHandler?: () => (e: unknown, f?: boolean) => void;
          setGlobalHandler?: (h: (e: unknown, f?: boolean) => void) => void }
      | undefined;
    if (EU?.setGlobalHandler) {
      const prev = EU.getGlobalHandler?.();
      EU.setGlobalHandler((e, fatal) => {
        this.exception(e, fatal ? 'fatal' : 'uncaught');
        prev?.(e, fatal);
      });
      undo.push(() => prev && EU.setGlobalHandler?.(prev));
    }

    // Browser. Listeners are passive - they observe and do not
    // preventDefault, so the console still shows the error.
    const w = g.window as
      | { addEventListener?: (t: string, h: (e: never) => void) => void;
          removeEventListener?: (t: string, h: (e: never) => void) => void }
      | undefined;
    if (w?.addEventListener && typeof g.document !== 'undefined') {
      const onError = (ev: { error?: unknown; message?: string; filename?: string; lineno?: number }) =>
        this.exception(ev.error ?? ev.message, 'uncaught', {
          src: `${String(ev.filename ?? '').split('/').pop() ?? ''}:${ev.lineno ?? 0}`,
        });
      const onRejection = (ev: { reason?: unknown }) => this.exception(ev.reason, 'unhandledrejection');
      w.addEventListener('error', onError as (e: never) => void);
      w.addEventListener('unhandledrejection', onRejection as (e: never) => void);
      undo.push(() => {
        w.removeEventListener?.('error', onError as (e: never) => void);
        w.removeEventListener?.('unhandledrejection', onRejection as (e: never) => void);
      });
    }

    // Node. uncaughtExceptionMonitor exists precisely for observers: it is
    // called for every uncaught exception and does NOT suppress the default
    // crash, which a plain 'uncaughtException' listener would - turning a
    // crash into a zombie process is not a logger's business.
    const proc = g.process as
      | { on?: (e: string, h: (...a: never[]) => void) => void;
          off?: (e: string, h: (...a: never[]) => void) => void;
          listenerCount?: (e: string) => number;
          versions?: { node?: string } }
      | undefined;
    if (proc?.versions?.node && proc.on) {
      // A fatal crash is the hard case: the POST is async and Node exits as
      // soon as the handlers return, so observing with
      // uncaughtExceptionMonitor logs into a buffer that dies with the
      // process - measured, not assumed. So when nobody else is handling
      // uncaughtException we take responsibility for the exit: log, flush,
      // reproduce Node's own report, exit 1. If the app HAS its own handler
      // we do not fight it - monitor only, best effort.
      const owns = (proc.listenerCount?.('uncaughtException') ?? 0) === 0;
      const onUncaught = (err: unknown) => {
        this.exception(err, 'uncaught');
        if (!owns) return;
        void (async () => {
          await Promise.race([this.flush(), new Promise((r) => setTimeout(r, FATAL_FLUSH_MS))]);
          // What Node would have printed, since we suppressed it
          const e = err as { stack?: string } | undefined;
          console.error(e?.stack ?? safeString(err));
          (proc as { exit?: (c: number) => void }).exit?.(1);
        })();
      };
      proc.on(owns ? 'uncaughtException' : 'uncaughtExceptionMonitor',
              onUncaught as (...a: never[]) => void);

      // No monitor variant exists for rejections, and a listener suppresses
      // Node's default crash - so log, then re-raise so the uncaught path
      // above ends the process exactly as Node would have.
      const onRejection = (reason: unknown) => {
        this.exception(reason, 'unhandledrejection');
        if ((proc.listenerCount?.('unhandledRejection') ?? 1) <= 1)
          setTimeout(() => {
            throw reason;
          }, 0);
      };
      proc.on('unhandledRejection', onRejection as (...a: never[]) => void);
      undo.push(() => {
        proc.off?.(owns ? 'uncaughtException' : 'uncaughtExceptionMonitor',
                   onUncaught as (...a: never[]) => void);
        proc.off?.('unhandledRejection', onRejection as (...a: never[]) => void);
      });
    }

    this.uncaughtRestore = () => {
      for (const u of undo) u();
      this.uncaughtRestore = undefined;
    };
    return this.uncaughtRestore;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.consoleRestore?.();
    this.uncaughtRestore?.();
    this.netRestore?.();
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
