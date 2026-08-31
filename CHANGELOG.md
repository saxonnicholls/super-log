# Changelog

Notable changes, newest first. Each entry says what is verified and what is
not, because that distinction matters more than the feature list.

## Unreleased

**superlog-power** — CPU package watts, thermal pressure, SMC fan RPM and
CPU/GPU die temperatures, aggregate CPU as a single number, and the top
energy consumers attached to every sample (topic `power.<host>`, macOS,
Intel and Apple Silicon plist dialects both handled). Written after this
machine sat at 1258% aggregate CPU — eleven saturated cores, one VS Code
extension — until the fans said so, and crashed repeatedly under runaway
draw. `powermetrics` needs root and the tailer never prompts:
`scripts/install-power-tailer.sh` installs a sudoers entry pinned to one
root-owned wrapper rather than to powermetrics itself, whose `-o` flag
would turn a wildcarded rule into a root file write. Without root it
degrades honestly — thermals, aggregate CPU and top processes still flow,
each reading marked `power_unavailable: not root`. `--out` writes a local
sidecar with superlog-journal's rotation and retention, for the samples a
crash would otherwise take with it. The demo starts it **unconditionally on
macOS**.

Verified: degraded mode live against a real hub; both plist dialects, the
explicit-degradation contract and the no-orphan SIGTERM shutdown against
stand-ins (`tests/power.test.mjs`). The sudoers path needs a root prompt
this bench could not answer unattended — run the installer once, then
`npm run power -- --once` and compare against a hand-run
`sudo powermetrics --samplers cpu_power -n 1`.

**superlog-dl** — a download in flight as `metric` events: percent, bytes
and rate (topic `dl.<host>.<label>`), a stall as an edge-triggered WARN
hours before the tool's own patience runs out, and one verdict at the end.
A transparent wrapper in superlog-build's mould — output, stdin and exit
status untouched — that reads tqdm/hf, curl's meter, wget, or a bare NN%;
`--watch` sums the destination file or directory instead, which is the
honest aggregate for a many-shard Hugging Face pull and works even when a
piped tool mutes its bar (superlog-tee cannot do this job: bars are
\r-rewritten, not line-oriented). A stall escalates: no movement for
`--stall` seconds is one WARN, three times that is one ERROR — a download
at 0.0MB/s that long is dead, not slow. Verified against stand-in bars
(`tests/dl.test.mjs`) and live against a real 25MB curl transfer and a
100GB fetch on a second machine, where the escalation's first catch was
real: a watcher pointed at a path the fetch had moved away from.

**Engine and content-tool logs.** The app catalog now knows **Unity**
(`Editor.log`, with a format that levels the C# compiler's diagnostics and
thrown exceptions while a folder named "Exceptions" stays INFO) and
**Unreal Engine** (per-project editor logs, levelled by Unreal's own
verbosity words with the `LogCategory` kept in the message; rotated
`-backup-` copies excluded so they do not each hold a dormant tail).
Catalog patterns may now live under `{home}` and carry directory-level
globs — Unreal keeps one log directory per project, so the only honest
default path has a star in the middle. Blender and AutoCAD get one-line
recipes rather than false promises: Blender logs to stdout (pipe it
through `superlog`), AutoCAD writes a file only when `LOGFILEMODE` says
so. Verified against the real Unity and Unreal logs on this machine
(`superlog-tail apps` finds 13 of them); parsing under
`tests/engines.test.mjs`.

**Lean 4, both halves.** An SDK for the programs (`sdk/lean/Superlog.lean`:
core IO plus `curl` — Lean grew a kernel before it grew sockets — mode
from `SUPERLOG_MODE` with no default, verified live), and the build story
for the jobs that run all night: `superlog-build` now reads lake's
severity-first diagnostics (`error: File.lean:2:20: ...`) with their
`file:line`, and turns `[n/m]` progress — lake's, ninja's, and make's
`[ 47%]` alike — into DEBUG readings carrying a `build.progress_pct`
metric, so a six-hour mathlib build charts like a download instead of
spamming INFO all afternoon. Fixtures captured from a real Lean 4.33
lake build; the clean-build test now asserts the metric.

**Plain C.** One stb-style header (`sdk/c/superlog.h`), C99 plus POSIX
sockets, zero allocation — the caller owns the `superlog_t` and the batch
buffer lives inside it. The same compile-time discipline as the C++
header: `SUPERLOG_DEVELOPMENT` xor `SUPERLOG_PRODUCTION`, neither or both
refuses with `#error`, and a production build contains NO wire code at
all — `strings` the binary for `/ingest/` and find nothing, which turns
"logging is off in production" from a belief into a provable property of
the artefact. Verified live (`demo/c/clock.c` under `-Wall -Wextra`),
plus the proof itself: the dev binary carries the ingest string, the
production binary does not, and both misdeclared modes refuse to compile.

**Four more languages: Ruby (and Rails), OCaml, Haskell, Scala.** Ruby
joins the dependency-free SDKs — stdlib only, with a drop-in `::Logger`
adapter that makes the Rails story one `config.logger` assignment. OCaml
speaks the wire over the Unix library and nothing else, mode from
`SUPERLOG_MODE` with no default; Haskell uses GHC's boot libraries plus
`curl` (the shell producer's honest bargain), mode compiled in via
`-DDEVELOPMENT`/`-DPRODUCTION` where neither-or-both refuses to compile.
Scala needs no SDK at all and the demo proves it: the Java client, one
import, zero glue — the Kotlin story (Scala ≥ 3.5 retired the classic
runner, so `demo/scala/run.sh` launches the compiled clock with plain
java plus the Scala runtime jars). All four clocks are wired into the
demo launcher, `verify-sdks.sh` and `npm run demo:<lang>`. **All four
verified live against the hub** — every clock's ticks, staged pricing
error and metrics arrived, from the real compilers on this bench.

**superlog-gas** — operational key balances with the alarm built in
(topic `gas.<chain>`): the keeper or oracle that runs out of gas stops a
production system as surely as a crashed server, and fails politely.
Per-chain, per-key config (gitignored — a labelled key list is a map for
an attacker even when every address is public); native coin via
eth_getBalance or ERC-20 via a bare balanceOf call, one JSON-RPC batch
per chain per poll. Below `crit` is CRITICAL said once, below `warn` WARN
once, refunding announced. Verified against a stand-in RPC
(`tests/gas.test.mjs`) and live against arbitrum, where the first real
poll correctly fired CRITICAL on a drained oracle key.

**superlog-sys** — the machine's own life events, macOS (topic
`sys.<host>`, started unconditionally by the demo beside `power`): crash
reports and kernel panics parsed out of DiagnosticReports the moment they
land — and from the recent past at startup, because a crash writes its
report *before* the reboot that restarts the watcher; the previous
shutdown cause once per boot, translated and ERROR when unclean; volume
mounts, unmounts and renames via one long-lived `diskutil activity` child
(a rename moves every path on the volume, which is how a 100GB write died
on this bench recorded by nothing); and sleep/wake. First live run on the
machine it was written on surfaced an unclean shutdown (cause -108) and 38
crashes from the preceding 72 hours that nobody had read. Verified live
and against synthetic reports (`tests/sys.test.mjs`); the Linux
counterpart is listed under Future directions.

**Link failures are errors now.** GNU ld's `undefined reference` and
`multiple definition` verdicts carry no severity word, so they landed as
INFO — a failed link nobody sees, on the tool whose whole job is
preventing exactly that. They, `/usr/bin/ld:`-prefixed lines, `ld.lld`,
`collect2`, Apple's `duplicate symbol`, and the driver's own
`clang:/gcc: error:` (often the only error line a failed macOS link
prints) are all ERROR, with `file:line` where the linker gives one.
Fixture-tested for both GNU and Apple shapes.

**The bench documents itself to agents.** A seventh MCP tool,
`stream_guide`, serves detailed per-capability documentation — what each
topic's metrics and levels mean and the gotchas — from
`sdk/js/packages/mcp/guide.json`, whose playbooks (triage,
follow-a-trace, silent-stream, power-incident, watch-a-download) are also
served as native MCP prompts. House rule, now in CLAUDE.md: every logging
capability ships a detailed README entry AND a detailed guide entry.
Verified over real stdio JSON-RPC.

**Real-time file diffs.** `superlog-watch --diff` answers "which LINES"
rather than "which file": one event per hunk with the removed and added
lines together, every hunk of one save sharing a `trace` with its
"modified" anchor, so `/recent?trace=` returns the whole edit as one
story. Idempotent by content hash — a rewrite that changes no bytes (an
editor's touch, an atomic re-save) publishes nothing at all, which a bare
mtime watcher cannot promise. The diff is patience-flavoured (unique-line
anchors, so a moved brace does not smear an edit across the file), held
snapshots are bounded (`--diff-max` per file, `--diff-budget` overall),
and binaries or oversized files are tracked by hash alone and say so.
Verified under `tests/watch.test.mjs` against a real hub.

**superlog-bridge** — relay another hub's whole feed into this one,
verbatim: same topics, same events, so nothing downstream can tell a
bridged stream from a local one. `--ssh` tunnels to the remote hub's
loopback port, so neither hub ever listens on the network — the same
posture as superlog-fleet. One direction only; bridging two hubs at each
other is a feedback loop. Verified live: an event published into a second
Mac's loopback hub arrived on this bench over the tunnel, byte for byte.

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
