# Changelog

Notable changes, newest first. Each entry says what is verified and what is
not, because that distinction matters more than the feature list.

## v0.1.0 — first public release

**2026-08-29**

One hub for every log stream on a development bench. Nine dependency-free
SDKs, twenty-odd tailers that need no application changes at all, two
viewers, a journal with search and replay, and MCP tools so an agent reads
the same bench you are looking at.

Nought-point-one on purpose. The [wire protocol](docs/PROTOCOL.md) is
settled and documented; the surfaces around it are young and some will move.

### What is here

**Nine SDKs, no dependencies in any of them.** C++ (a spdlog sink and a
native `SN_LOG` one), Rust with an optional `tracing` layer, Python plugging
into stdlib `logging`, Go with a `log/slog` handler, Java and Kotlin through
`java.util.logging`, Swift with a `@TaskLocal` trace, Fortran over raw POSIX
sockets, a POSIX `sh` producer needing only `curl` and `awk`, and one JS
client for Node, the browser and React Native.

Five of them hook the logging framework the language already has, so
everything a program *already* logs arrives without a call site changing.

**Twenty-odd tailers that need no application changes at all.** OS logs on
macOS, Linux and Windows; ~20 known services; Docker; any host over ssh; an
HTTP/S logging proxy; WebSocket frames; a syslog and raw TCP/UDP inlet; DNS
records with TLS expiry; listening ports with their processes; host vitals;
builds with their compiler diagnostics; sanitizer and valgrind findings
captured whole; git and GitHub Actions; filesystem changes; serial consoles;
ROS 2; blockchain addresses; GPU telemetry; and `tee` for anything else that
prints.

**Hosted services.** Cloudflare Workers through `wrangler tail` — one trace
per invocation, its console lines, its exceptions, and the failures that log
nothing at all, like an isolate killed for exceeding CPU. Stripe events
across several accounts, **redacted to an allowlist** because a failed
payment carries a customer record rather than log data.

**Two viewers**, a journal with search and replay, `GET /recent` for scripts,
six MCP tools for agents, and edge-triggered alerts.

### Verified on real hardware and services

The hub; both C++ paths; Rust, Python, Go, Java, Swift, Fortran and the shell
producer all delivering live. The JS client in a real Expo app on simulators,
an Android handset, a browser and Node. Both viewers. macOS unified log and
journald. ssh streaming from cloud hosts and a four-server fleet. Ethereum
mainnet. Search and replay over a 1 GB journal. Correlation across tiers.
Sanitizer and valgrind capture against real ASan, TSan, UBSan and valgrind
output. Vivado and Quartus diagnostics. ROS 2 Jazzy. Syslog from real
datagrams. Metal GPU work on an AMD card. A 20-minute Binance soak that found
a real memory problem and confirmed it was not a leak.

CI builds from a clean checkout on Linux under gcc and clang and on **macOS
arm64**; runs **ThreadSanitizer on Linux**, where macOS's is broken at the
runtime level; builds the hub with **no submodules at all**; and runs the
shell producer inside **Alpine** with busybox `ash`, busybox `awk` and no GNU
`date`.

### Written but not verified

Treat these as bring-up, not regression:

- **CUDA** — no NVIDIA GPU on the machine it was written on
- **Windows** event logs
- **iOS hardware** (the simulator is verified)
- **Kotlin** — no `kotlinc` available
- **Serial** against a real board at a real baud rate (a pty is verified)
- **WebGL context loss** — needs a browser; the rest of `patchWebGL` is tested
- **gRPC over TLS** and against a real client library

### Security

No authentication, deliberately. The reasoning, what was rejected and why,
and the questions still open are in [docs/DECISIONS.md](docs/DECISIONS.md).

The hub binds **loopback**; opening it is something you type, and it warns
when it is open. The bar is to be no less safe than the logs a developer
already has, and never more dangerous than them — bound to loopback the OS is
the authentication, and it is the same OS already guarding your log files.

### Known wart

`SUPER_LOG_PORT` means the *listen* port to the hub and the *target* port to
a client. Harmless when they coincide, which is usually. Prefer
`SUPER_LOG_URL` in clients; it is what most of the SDKs read natively and has
no such ambiguity.
