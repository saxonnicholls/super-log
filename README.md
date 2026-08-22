# super-log

**One hub for every log stream on your dev bench.**

If you build across devices, you know the ritual: a Metro console for the
iOS simulator, another for the Android emulator, `adb logcat` for the phone
on your desk, a terminal for the C++ engine, another for the Rust service,
the browser devtools for the web build, and an ssh session to the box in
the cloud. Six places to look, none of them agreeing on timestamps, and the
bug is always in the interleaving.

super-log converges all of it on one process and one screen:

```
 4 × RN/Expo devices ─┐
 C++  (spdlog/SN_LOG) │
 Rust (tracing)       ├── POST NDJSON ──▶  superlogd :7333  ──▶  native viewer (ImGui)
 Node / browser JS    │                    (fan-out+replay)  ──▶  web viewer (React)
 OS logs (mac/linux)  │                                      ──▶  journal (NDJSON on disk)
 remote hosts via ssh ┘
```

Every producer speaks one tiny wire protocol ([docs/PROTOCOL.md](docs/PROTOCOL.md):
one JSON event per line, batched over plain HTTP POST), the hub fans out to
any number of viewers with replay-on-connect, and the viewers interleave
all streams in one totally-ordered view.

## What it does for you

- **One screen.** Every stream, colour-coded by source and level,
  interleaved by hub sequence (not by device clocks, which drift). Filter
  by stream, minimum level, or substring; follow the tail or pause it.
- **Your apps need almost nothing.** The SDKs are tiny and dependency-free:
  a header-only C++ pair of sinks (native `snicholls::log` and **spdlog**),
  a Rust crate (plus an optional `tracing` layer), and one JS client for
  React Native, the browser, and Node — `patchConsole: true` and every
  `console.log` in your app is on the bench.
- **Zero-app-change fallbacks.** Host-side tailers scrape what already
  exists: `adb logcat`, the iOS simulator's log stream, macOS unified log,
  journald. Old builds you can't touch still show up.
- **OS logs beside app logs.** Stream the kernel/system feed next to your
  app's lines — "what was the OS doing at that moment" is one filter away.
- **Your services, switched on by name.** A catalog knows where ~20 common
  services log on macOS and Linux — postgres, mysql, mongodb, redis, nginx,
  apache, kafka, elasticsearch, rocksdb and more, both Homebrew prefixes
  included. `superlog-tail apps` shows what this machine actually has;
  `superlog-tail app postgres nginx` puts them on the bench, parsed into
  real levels. Anything custom: `superlog-tail file <path>`.
- **HTTP/HTTPS calls, request and response.** Point a client at the logging
  proxy and every call arrives as one event — method, path, status,
  latency, sizes. HTTPS targets need no certificate work. Bodies are
  opt-in and secrets are always redacted.
- **Remote machines over ssh.** `superlog-tail ssh <host>` detects the
  remote OS (macOS / Linux / Windows), streams its logs — or its postgres,
  or any file — to the bench over your existing ssh config, installing
  nothing remotely. Cloud boxes that could never reach your LAN just work.
- **Producers never block.** Every SDK uses a bounded queue that drops
  oldest under burst — counted, never hidden. A logger that can stall the
  app it observes is worse than no logger.
- **Grab what you see.** Copy a row or the whole filtered view; export it
  as JSON, CSV, or plain text. For continuous capture, `npm run journal`
  appends every frame verbatim to size-rotated NDJSON — lossless, and
  replayable later.
- **Readable by scripts and agents.** `GET /recent?since=<cursor>&level=ERROR`
  answers "what happened since I last looked" over plain HTTP, with a
  cursor that never misses or repeats an event and a hard cap so nothing
  gets handed the whole firehose. For coding agents there is also an **MCP
  server** ([sdk/js/packages/mcp](sdk/js/packages/mcp)) — register it once
  and every project's agent can check the hub, list streams, tail and
  search filtered logs, and *wait* for an event after triggering an action
  instead of sleeping and hoping.
- **Off in production, by construction.** Every SDK requires you to declare
  DEVELOPMENT or PRODUCTION (neither or both refuses to build), and each
  mode ships only what its policy allows. Production defaults to shipping
  **nothing**; loosening it (say, ERROR and up) is a deliberate decision.

## Quick start

```sh
git clone --recurse-submodules <this repo>
cd super-log

# The whole demo: hub, C++/Rust/iOS/Android/browser/container clocks,
# OS-log streams, both viewers - one command, ~11 live streams
npm run demo                   # see demo/README.md for the tour

# Or piece by piece:
./scripts/dev.sh               # build + run the hub
npm install && npm run viewer  # web viewer on http://localhost:7334
npm run tail:android           # first stream: the Android emulator
```

The demo binds everything to loopback. Real phones need the hub on the LAN:
`SUPER_LOG_LAN=1 ./demo/run.sh` (read the security section first).

## Putting your own apps on the bench

**React Native / browser / Node** (`@super-log/client`, zero dependencies):

```js
import { createSuperLog } from '@super-log/client';

const slog = createSuperLog({
  url: 'http://192.168.1.20:7333',      // your bench machine
  topic: 'expo.ios.device',             // topics name streams - PROTOCOL.md
  app: 'my-app',
  development: __DEV__,
  production: !__DEV__,
  patchConsole: true,                   // console.* now reaches the bench
});
slog.info('checkout mounted', { user: '42' });
```

**C++** (header-only; works with spdlog or ts-moveables' `snicholls::log`;
compile with `-DSUPERLOG_DEVELOPMENT` or `-DSUPERLOG_PRODUCTION`):

```cpp
superlog::transport_config cfg;
cfg.topic = "cpp.pricer";
auto bat = std::make_shared<superlog::batcher>(cfg);

superlog::origin who;
who.app = "pricer";
spdlog::default_logger()->sinks().push_back(
    std::make_shared<superlog::spdlog_sink_mt>(bat, who));
// spdlog::info(...) now lands on every screen in the room
```

**Rust** (build with `--features development` or `--features production`):

```rust
let log = super_log::SuperLog::new(super_log::Config {
    topic: "rust.pricer".into(),
    app: "pricer".into(),
    ..Default::default()
});
log.log(super_log::Level::Info, "engine up", None);
log.metric("fps", 58.9);
```

**Machines and services** (no app changes at all):

```sh
npm run tail:os -- --process MyApp         # this Mac's unified log
npm run tail:apps                          # which services log here, and how to enable them
npm run tail:app -- postgres nginx redis   # ...then enable them
npm run tail:file -- /srv/app/production.log
npm run tail:ssh -- my-server              # a remote box, OS auto-detected
npm run tail:ssh -- db1 --app postgres     # ...or its postgres log
npm run net -- 9000 http://localhost:3000  # every HTTP call through :9000
npm run journal                            # continuous capture to NDJSON on disk
```

## Modes and policies

Every SDK enforces **DEVELOPMENT xor PRODUCTION** — neither or both is a
compile error (C++ defines, Rust features) or a thrown error (JS). Each
mode then ships what its *policy* allows: development defaults to
everything, production to **nothing**. Want crash triage from release
builds? Say so explicitly — `-DSUPERLOG_PROD_POLICY=ERROR`,
`prod_policy: Policy::AtLeast(Level::Error)`, or
`productionPolicy: 'ERROR'` — and only ERROR/CRITICAL leave the process.
Below-policy events cost one compare; a policy of OFF compiles the
transport to an inert shell. Log lines leaving a production box are a
security decision, so nothing here makes it for you.

## Security posture

This is a dev-bench tool: no auth, no TLS — anyone who can connect can read
every stream and publish to any topic. The defaults are arranged so exposure
is a choice, not an accident:

- The demo binds **loopback only**; `SUPER_LOG_BIND` / `SUPER_LOG_LAN=1`
  open the hub up when real devices need it, on a network you trust.
- OS logs carry IPs, hostnames, and process behaviour — the ssh tailer
  exists partly so remote logs reach the bench *without* exposing the hub.
- Production builds forward nothing unless you loosened the policy.
- CSV exports defuse spreadsheet formula injection; viewers render log
  content as text, never markup.

See the Auth/TLS section of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- **Hub + viewers:** macOS or Linux (POSIX phase 1), a C++17 compiler,
  CMake ≥ 3.16. Windows machines join as producers (SDKs, ssh tailer).
- **JS:** Node ≥ 18 (≥ 22 for the journal). **Rust:** any recent stable.
- [ts-moveables](https://github.com/saxonnicholls/ts-moveables) provides
  the transport/fan-out/logging fabric — used from a sibling checkout if
  present, fetched from GitHub otherwise.
- spdlog + fmt, imgui + glfw, and nlohmann/json are pinned submodules in
  `third_party/` (`git submodule update --init`) — versions chosen to work
  together, so the system-installed ones are never trusted.
- Docker (optional) for the Ubuntu build-and-smoke image and the Linux
  demo streams.

## Layout

| Path            | What |
|-----------------|------|
| `hub/`          | `superlogd` - the one process everything meets at |
| `sdk/cpp/`      | header-only: `snicholls::log` forward sink + spdlog sink |
| `sdk/rust/`     | `super-log` crate: core + `tracing` layer |
| `sdk/js/`       | `@super-log/client` - React Native, browser, Node; `@super-log/mcp` - the agent-facing MCP server |
| `tailers/`      | zero-app-change scrapers: adb, simctl, OS logs, ssh, journal |
| `viewer/imgui/` | native viewer |
| `viewer/react/` | web viewer |
| `demo/`         | the multi-client clock demo: one command, whole bench |
| `docker/`       | Ubuntu build+smoke image and the Linux bench producer |
| `third_party/`  | pinned submodules: spdlog+fmt, imgui+glfw, nlohmann/json |
| `docs/`         | PROTOCOL.md (the contract), ARCHITECTURE.md (the shape) |

## Status, honestly

Most of this is **verified live** on a real bench — the hub, both C++
paths, Rust, the JS client from Node and a real browser, both viewers, the
macOS and journald tailers, ssh streaming from a cloud host, the Docker
image (which smoke-tests itself during `docker build`), and the mode/policy
guards. A few edges are **written, not verified** — the Windows event-log
path, the iOS-hardware tailer — and [HANDOFF.md](HANDOFF.md) is the
unvarnished ledger of which is which, plus the build-out plan. CI lives in
`.github/workflows/ci.yml`; `scripts/smoke.sh` is the one smoke test that
CI, the Docker image, and your terminal all run identically.

Copyright 2026 Saxon Herschel Nicholls.
