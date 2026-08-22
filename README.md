# super-log

One hub for every log stream on the dev bench.

Right now the bench runs React Native + Expo on four targets at once - iOS
Simulator, iOS hardware, Android emulator, Android hardware - which is four
scattered log feeds, plus the C++ (ts-moveables, spdlog) and Rust processes
behind them. super-log converges all of it on one process, `superlogd`, and
renders it in two viewers: a native Dear ImGui app and a React web app. Add
Node and browser JS and the answer to "where do I look?" is: one screen.

```
 4 × RN/Expo devices ─┐
 C++  (spdlog/SN_LOG) ├── POST NDJSON ──▶  superlogd :7333  ──▶  ImGui viewer
 Rust (tracing)       │                    (fan-out+replay)  ──▶  React viewer
 Node / web ──────────┘
```

Transport, fan-out, replay, and backpressure come from
[ts-moveables](https://github.com/saxonnicholls/ts-moveables)
(`ws_broadcast_hub`, `websocket_client`, the logging fabric) - this repo is
the configuration, the SDKs at each edge, and the two viewers. The wire
contract is [docs/PROTOCOL.md](docs/PROTOCOL.md); the shape of the whole
thing is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Status: scaffold.** The hub builds and runs; the SDKs and viewers are at
varying depths of skeleton. [HANDOFF.md](HANDOFF.md) is the build-out plan
and the honest ledger of what is verified versus written.

## Quick start

```sh
# The hub (expects ts-moveables checked out as a sibling ../TSMoveables)
./scripts/dev.sh

# A first stream: tail the Android emulator
npm install
npm run tail:android

# Watch it
npm run viewer          # http://localhost:7334
```

## Layout

| Path            | What |
|-----------------|------|
| `hub/`          | `superlogd` - the one process everything meets at |
| `sdk/cpp/`      | header-only: `snicholls::log` forward sink + spdlog sink |
| `sdk/rust/`     | `super-log` crate: core + `tracing` layer |
| `sdk/js/`       | `@super-log/client` - React Native, browser, Node |
| `tailers/`      | zero-app-change scrapers: `adb logcat`, `simctl log stream` |
| `viewer/imgui/` | native viewer |
| `viewer/react/` | web viewer |
| `docs/`         | PROTOCOL.md (the contract), ARCHITECTURE.md (the shape) |

Copyright 2026 Saxon Herschel Nicholls.
