# @super-log/client

One client for every JavaScript we run: React Native (Expo), the browser,
and Node. Zero dependencies — `fetch` is global in all three, and a batch
POST every 250 ms is the whole transport ([PROTOCOL.md](../../../../docs/PROTOCOL.md)).

```js
import { createSuperLog } from '@super-log/client';

const slog = createSuperLog({
  url: 'http://192.168.1.20:7333',   // the bench machine
  topic: 'expo.ios.device',          // a stream name from the topic table
  app: 'my-app',
  development: __DEV__,              // exactly one of these two, or it throws
  production: !__DEV__,
  patchConsole: true,                // console.* now reaches the bench
});

slog.info('checkout mounted', { user: '42' });
slog.metric('fps', 58.9);
```

## Modes and policies

Exactly one of `development` / `production` must be true — neither or both
throws, deliberately: a logging client you *think* is off is worse than one
that refuses to start. Each mode forwards only what its policy allows:

| Option | Default | Meaning |
|--------|---------|---------|
| `developmentPolicy` | `'TRACE'` | everything |
| `productionPolicy`  | `'OFF'`   | **nothing** |

Production ships nothing until you say otherwise, because log lines leaving
a release build are a security decision. Want crash triage from production?
Set `productionPolicy: 'ERROR'` on purpose. Below-policy events are never
serialised, and `'OFF'` leaves an inert shell: no timer, no console patch,
nothing on the wire.

## Installing it into a React Native app

Two things bite, both learned from a real integration:

**1. Reinstall after pulling.** `main` points at `dist/`, a build artefact
that is not in git. A `prepare` script builds it when npm installs this as a
`file:` or git dependency — but if you installed before that script existed,
you have a package whose entry point does not exist, which Metro reports as
`unknown module` and node as `ERR_MODULE_NOT_FOUND`. Reinstall the
dependency, or run `npm run build --workspace @super-log/client` here.

**2. Metro needs the real path.** A `file:` install is a symlink, and Metro
only bundles what is inside its watched folders. Add the real path:

```js
// metro.config.js
const config = getDefaultConfig(__dirname);
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, '../../super-log/sdk/js/packages/client'),
];
```

Then pick a topic per target from the table in PROTOCOL.md — hardware and
simulator are different streams even when they run the same build, and
`expo-device`'s `isDevice` is the usual way to choose between them.

## Behaviour worth relying on

- **It never blocks your app.** Events go into a bounded buffer that drops
  oldest when full, counted — `dropped()` tells you how many. A logger that
  can stall the app it observes is worse than no logger.
- **A failed POST is counted, not retried.** A retry queue grows without
  bound on a phone that left the building; the next batch succeeds or counts
  again.
- **Browsers post `no-cors`.** `application/x-ndjson` would force a CORS
  preflight the stock hub does not answer, and the hub treats payloads as
  opaque bytes anyway.
- **`patchConsole` adds a screen, it does not move one.** The original
  `console.*` still runs. It returns an unpatch function; `close()` also
  unpatches and flushes.
- **Do not run a tailer on the same topic** at the same time, or the app's
  console lines are reported twice.

## Logging every uncaught error

On by default (`captureUncaught: false` opts out). The client installs the
right hook for the runtime and **chains** rather than replaces, so nothing
that used to happen stops happening:

| Runtime | Hook | Behaviour preserved |
|---------|------|---------------------|
| React Native | `ErrorUtils.setGlobalHandler` | the red box still appears; a previously installed handler still runs |
| Browser | `error` + `unhandledrejection` listeners | passive; the console still reports |
| Node | `uncaughtException` (or `uncaughtExceptionMonitor` if you already handle it) | still prints the stack, still exits 1 |

Each event is `ERROR`, tagged `exception`, with the stack in
`fields.stack` (capped at 40 frames) and `fields.where` saying which hook
caught it. A fatal crash flushes before the process dies — measured, and
the reason `flush()` waits for an in-flight POST rather than returning on
an empty buffer.

`slog.exception(err, 'where', {extra})` logs a caught error the same way.

For React, `@super-log/react` adds the part a global hook cannot reach: a
render error is swallowed by React and unmounts the tree, so it never
becomes an uncaught exception. `<SuperLogProvider>` wraps the tree in an
error boundary and logs the **component stack** — which component threw,
which no JS stack contains.

## Logging every network call

`patchNetwork: true` logs every HTTP call the app makes — method, URL,
status, duration, size — as events tagged `http`, with 4xx as WARN and 5xx
as ERROR. Off by default: it is the loudest thing the client can do.

```js
createSuperLog({ ..., patchNetwork: true });
// GET https://api.example.com/v1/wallet → 200 in 42ms
```

It patches both `fetch` and `XMLHttpRequest`, because different libraries
use different ones (axios uses XHR). React Native's `fetch` is a polyfill
*over* XHR, so a naive pair of patches double-logs every RN fetch; the
fetch wrapper marks the window in which it starts its request and an XHR
started inside that window stays quiet. Verified: one fetch-over-XHR plus
one direct XHR produce exactly two events.

Never logs bodies or headers, and redacts credential-shaped query values
(`token`, `api_key`, `signature`, …) from URLs — a URL is worth having, the
token in it is not. Its own POSTs to the hub are excluded, or the client
would feed itself.

Note this is the app's own traffic. **Android logcat does not contain HTTP
calls** — across ~20k lines of every logcat buffer on a real handset only
30 even mentioned a URL, and those were config strings. Instrument the app,
or front the service with `superlog-net`.

## Catching exceptions nobody logs

The hardest class to see is an exception that third-party code throws and
your code **catches and displays**: never uncaught, never `console.error`'d,
invisible to every global hook. Two layers, and they are not the same thing:

**The guarantee — capture where errors are DISPLAYED.** Make one component
or function the sanctioned way to show an error, and log there:

```js
function ErrorNotice({ error, where }) {
  useEffect(() => { slog.exception(error, where ?? 'rendered'); }, [error]);
  return <Text style={styles.error}>{messageOf(error)}</Text>;
}
```

Render sites are countable; catch sites are not, and grow with every branch.
This also catches what is thrown but is not an `Error` at all — a string, a
`{message}` from a native bridge, a GraphQL errors array.

**The safety net — `captureErrorConstruction: true`.** A TRACE breadcrumb
whenever *anyone* constructs an Error, so a throw is visible even if nothing
renders or logs it. Deduped and rate-limited, because construction is not
evidence of a problem: libraries build Errors as control flow. In one test,
801 constructed errors produced 40 breadcrumbs, with suppressed counts
reported rather than silently dropped.

It reports the real class (`constructed FfiException: …`, read from
`new.target`, since inside `super()` the instance still calls itself
`Error`) and uses a Proxy so `instanceof`, subclass prototypes and custom
fields all survive untouched.

Know its limits: errors the **engine** constructs (a `TypeError` from
`undefined.foo`) may never pass through the JS constructor, especially on
Hermes; non-Error throws are invisible; and `class X extends Error` captures
`Error` when the class is *defined*, so install before importing the
libraries you want to observe. It is a net, not a guarantee — which is why
the render chokepoint is the guarantee.
