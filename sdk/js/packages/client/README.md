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
