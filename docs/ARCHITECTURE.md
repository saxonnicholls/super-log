# super-log architecture

One hub, many producers, two viewers. Everything meets at `superlogd` on the
dev machine, and the wire contract in [PROTOCOL.md](PROTOCOL.md) is the whole
coupling — no component links against another except through it (the C++
pieces share ts-moveables, which is infrastructure, not coupling).

```
 PRODUCERS                                HUB                       VIEWERS
 ─────────                                ───                       ───────
 iPhone 16 Pro (hw)   ─┐
 iOS Simulator         │  POST /ingest/:topic   ┌──────────────┐    ws://…/ws?topic=*
 Pixel (hw)            ├───── NDJSON chunks ───▶│   superlogd  │───▶  ImGui app
 Android emulator      │                        │  (one proc,  │───▶  React app
 C++  (spdlog / SN_LOG)│                        │  port 7333)  │───▶  anything else
 Rust (tracing)        │                        └──────────────┘
 Node / web (console) ─┘                     ws_broadcast_hub:
                                             fan-out, replay ring,
 host-side tailers                           per-socket backpressure
 (adb logcat, simctl) ─┘
```

## Why one hub process

- **The devices cannot see each other's stdout.** Four log streams on four
  machines/VMs; the only place they can converge is the dev machine. One
  process, one port, one URL to configure everywhere.
- **Fan-out, replay, and slow-reader backpressure are already written** —
  `ws_broadcast_hub` in ts-moveables does exactly this job and is tested by
  its demo suite. superlogd is ~100 lines of configuration around it.
- **Viewers stay dumb.** Both viewers speak one protocol to one endpoint.
  Adding a fifth producer (a Metro tailer, a CI box on the LAN) changes no
  viewer code.

## Components and where they live

| Path                     | What                                                        | Language |
|--------------------------|-------------------------------------------------------------|----------|
| `hub/`                   | `superlogd` — server + hub + health route                   | C++17, ts-moveables |
| `sdk/cpp/`               | header-only: `snicholls::log` forward sink, spdlog sink, batcher | C++17 |
| `sdk/rust/`              | `super-log` crate: core + `tracing` Layer                   | Rust |
| `sdk/js/packages/client/`| `@super-log/client`: RN / browser / Node, console patch     | TypeScript |
| `tailers/`               | zero-dependency Node tailers: `adb logcat`, `simctl log stream` | Node ≥18 |
| `viewer/imgui/`          | native viewer (Dear ImGui + GLFW), feed via ts-moveables `websocket_client` | C++17 |
| `viewer/react/`          | web viewer (Vite + React)                                   | TypeScript |

## Two ways onto the pipeline per app, on purpose

For the React Native apps there is a **tailer path** (host scrapes
`adb logcat` / `simctl log stream`; zero app changes, works today, noisy) and
an **SDK path** (`@super-log/client` inside the app; structured, quiet,
needs a code change). Both publish to the *same topic*, so viewers do not
care which is active, and the tailer path is the fallback when a build
predates the SDK.

## Threading discipline (C++ side)

Inherited from ts-moveables and worth keeping sacred: **producers never
block**. The C++ forward sink hangs off a dedicated logger *lane* (its own
queue + drain thread), so a wedged hub can at worst fill that lane's bounded
queue and drop — counted, never silently — while the app thread runs free.
The spdlog sink gets the same via the shared batcher's own thread. The ImGui
viewer runs the `event_loop` + `websocket_client` on a feed thread and hands
frames to the UI thread through a mutex-guarded deque drained once per frame.

## What is deliberately NOT here (yet)

- **Persistence** — the hub's replay ring (1024 chunks/topic) is the only
  history. File/SQLite journalling is milestone M6.
- **Auth/TLS** — dev-LAN tool: anyone who can connect can read every stream
  and publish to any topic. Defaults are arranged so exposure is a choice,
  not an accident: the hub binds all interfaces only so real devices can
  reach it, and `SUPER_LOG_BIND=127.0.0.1` confines it to one machine —
  which is what `demo/run.sh` does unless `SUPER_LOG_LAN=1` is set. This
  matters doubly once OS logs (`os.<host>` topics) are on the pipeline:
  they carry hostnames, IPs and process behaviour. In the same spirit the
  SDKs' PRODUCTION policies default to forwarding **nothing**, so a release
  build cannot leak logs to a hub nobody meant it to reach, and the viewers
  defuse spreadsheet formula injection in CSV exports. Do not run any of it
  on a hostile network; `websocket_client` already speaks wss when the day
  comes.
- **A query language** — viewers filter client-side over the firehose.
