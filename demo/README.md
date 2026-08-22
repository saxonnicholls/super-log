# The four-client clock demo

Four producers, five streams, one hub, two viewers, one command:

```sh
./demo/run.sh        # or: npm run demo
```

Every client logs the time (UTC) once a second, so the demo doubles as an
eyeball test: all the streams, interleaved by hub `seq`, saying the same
thing at the same moment.

| Stream                | Client | Path onto the pipeline |
|-----------------------|--------|------------------------|
| `cpp.clock`           | [cpp/clock.cpp](cpp/clock.cpp) | the native path: `SN_LOG` → lane → `superlog::forward_sink` → batcher, ticked by ts-moveables' `time_master`. |
| `cpp.spdlog.clock`    | [cpp/clock.cpp](cpp/clock.cpp) (same process) | the spdlog path: spdlog → `superlog::spdlog_sink` → batcher. The proof that the pinned `third_party/` spdlog+fmt pair works end to end. |
| `rust.clock`          | [../sdk/rust/examples/clock.rs](../sdk/rust/examples/clock.rs) | `SuperLog::log` + a `clock.uptime_s` metric every fifth tick. |
| `expo.ios.sim`        | [js/clock.mjs](js/clock.mjs) `ios` | `@super-log/client` from Node - a stand-in for the real Expo app until M2 (HANDOFF.md) puts the client inside it. Same topic, same origin shape, so the swap changes nothing downstream. |
| `expo.android.emu`    | [js/clock.mjs](js/clock.mjs) `android` | same, as the Android emulator. |
| `web.clock`           | [web/](web/) (http://localhost:7335) | a real browser page whose **console** streams to the bench via `patchConsole` - the client half of a client/server web app. Ticks arrive through `console.log`; buttons for warn/error/throw. The page follows its own hostname to find the hub, so other machines on the LAN can open it too. |
| `cpp.linux.clock` + `cpp.linux.spdlog.clock` | [../docker/compose.yml](../docker/compose.yml) | the same C++ clock, built and smoke-tested on Ubuntu, streaming from a container: `docker compose -f docker/compose.yml up --build`. |
| `os.<this-mac>`       | started by `run.sh` | this Mac's unified log, kernel-scoped (`SUPER_LOG_OS_PROCESS` widens it) - unfiltered is thousands of lines a second. Any other machine joins with `npm run tail:os -- --url http://<bench>:7333 --process <name>`; see [../tailers/README.md](../tailers/README.md). |
| `os.linux-bench`      | the same container | real journald: [../docker/entry.sh](../docker/entry.sh) runs one (no systemd PID 1), pipes the clock's console through `systemd-cat`, and tails it back out - so one process is visible as app stream AND OS stream. |
| `os.<remote>`         | started by `run.sh` | a remote machine's OS logs **over ssh** - OS auto-detected, nothing installed there, and the logs come TO the bench so the remote needs no hub access. `SUPER_LOG_SSH_HOSTS="a b"` picks the machines, empty disables; see [../tailers/README.md](../tailers/README.md). |
| `app.<host>.<name>`   | `SUPER_LOG_APPS="postgres nginx"` | your services' own logs - the catalog knows the default paths. `npm run tail:apps` lists what this machine has. |
| `net.curl.http` + `net.curl.https` | [curl_clock.sh](curl_clock.sh) | the clock as **HTTP traffic**: one http and one https call a second through the logging proxy, with deliberate 500s and slow calls so the viewer has errors and latency to colour. Run it beside the main demo: `./demo/curl_clock.sh`. |

The **real Expo app** ([expo-clock/](expo-clock/)) replaces the two RN
stand-ins when you want the genuine article on simulators and phones - see
its README. Start the bench with `SUPER_LOG_STANDINS=0` so the topics are
not double-reported.

The bench binds **loopback only** by default - the hub has no auth, and OS
logs are worth protecting. `SUPER_LOG_LAN=1 ./demo/run.sh` opens hub and web
page to the LAN for real devices (see ARCHITECTURE.md).

Continuous capture to disk is the journal's job, not the viewers':
`npm run journal` appends every hub frame verbatim to size-rotated NDJSON
(`--out`, `--rotate-mb`, `--topic`); viewer export stays for the ad-hoc grab.

`run.sh` builds what is stale, starts `superlogd`, the four clients, and the
React viewer (http://localhost:7334, opened for you), then runs the ImGui
viewer in the foreground. Closing the ImGui window - or Ctrl-C - tears the
whole bench down.

Pieces run fine on their own too, against a `./scripts/dev.sh` hub:

```sh
./build/demo/cpp/superlog_clock_cpp
(cd sdk/rust && cargo run --release --features development --example clock)
npm run demo:ios
npm run demo:android
```
