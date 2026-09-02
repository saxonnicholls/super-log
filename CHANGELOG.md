# Changelog

Notable changes, newest first. Each entry says what is verified and what is
not, because that distinction matters more than the feature list.

## Unreleased

**Viewers: the servers board** — a new window in both viewers (View →
Servers), answering "is that box fine" without opening a log. Every event
carries `origin.device`, so the hub's traffic IS the server list: one row
per machine with a recency light (`up` under 2 minutes, `quiet` under 10,
`silent` beyond), last seen, and the loudest level of the last minute -
mechanism-agnostic by design, because a vitals reading, a ping metric and
an app's own SDK all count as the machine speaking. Silence renders grey,
deliberately not "down": the board lacks the evidence for that verdict,
and the footer says which tool has it (a `silence` rule in alerts.json).
No probes, no configuration - a machine joins the board by logging once.

**superlog-netstate: the network's state, watched; changes, announced** —
half of "everything just broke" on a bench is the network moving
underneath the developer, silently. Now it says so, once per change:
interface addresses (DHCP renumber is WARN — every held connection just
died), the default gateway, the Wi-Fi SSID, VPN tunnels up/down, the DNS
resolver set (captive portals and filtering resolvers live here — this
bench lost a live debugging round to one), and the ARP neighbourhood with
judgment: a new LAN device is one INFO at first sight, cache expiry is
silence, and the gateway's MAC changing is ERROR because that is a router
swap or an ARP-spoofing MITM. `--ping` targets (the gateway rides free)
publish RTT/loss as metric readings with edge-triggered degradation — and
at the crossing, ONE traceroute runs and lands beside the alarm on the
same `trace`, so the alarm arrives carrying its own diagnosis; a healthy
path follows on recovery for comparison. Continuous traceroute was
rejected on purpose: ECMP makes hop lists differ legitimately per flow,
and diffing them teaches muting. The demo starts it unconditionally on
macOS, beside power and sys.

**superlog-dns --asn: the BGP question a bench can honestly ask** — a
laptop has no BGP view, but RIPEstat does, and the one question that
matters about your names is answerable: which AS originates the prefix
your A records live in. The origin changing or the prefix vanishing is
CRITICAL — from outside, that is what a hijack looks like, and it is
otherwise invisible until customers phone. Polled politely (default
300s). Local BGP daemons are out of scope on purpose; a router's own
session events already have a road in via the syslog socket tailer.

Verified on this bench: the real inventory (interfaces, gateway,
resolvers, ARP) and the full degradation story — TEST-NET-1 pinged to a
100%-loss ERROR edge with its traceroute landing on the same trace —
against a real hub (`tests/netstate.test.mjs`); origin-AS live against
RIPEstat (the bench's production domain resolves under its expected
origin AS).
Written but unverified: the Linux collectors (`ip -j`, `ip neigh`,
resolv.conf) beyond CI's `--once` exercise, and Wi-Fi SSID on Linux
(`iwgetid`).

**superlog-sql: SQL gets a voice** — SQL runs inside an engine and cannot
POST, so the engines are met where they live. Postgres: the tailer holds
`LISTEN <channel>` open and any trigger, stored procedure or batch job
logs to the bench with one built-in statement — `NOTIFY superlog,
'{"level":"ERROR","msg":"..."}'` — no extensions, no privileges beyond
NOTIFY; JSON payloads carry level/msg/fields, plain text arrives INFO
verbatim, and the watch is only claimed after a sentinel row proves the
LISTEN is committed (claiming earlier is a race: postgres does not queue
notifications for future listeners). psql carries the wire, the shell
SDK's curl bargain again. SQLite: the database *file* watched from
outside the process — the header's own change counter (offset 24), page
count and `-wal` growth, read without taking a lock — because in-process
code already has a language SDK and the outside observer was the missing
piece. Both engines poll `--query "name=SELECT ..."` into metric
readings, a failing query being ONE WARN until recovery.

**C#, Zig, and one object file for everything else** — the C# SDK
(`sdk/csharp/SuperLog.cs`) is BCL-only — `HttpClient` and
`System.Text.Json` — one file into any console app, ASP.NET service,
Unity profile or Xbox Dev Mode build; `SUPERLOG_MODE` with no default,
production inert. Zig gets no SDK because it needs none: `@cImport` reads
`sdk/c/superlog.h` directly. That exposed a general truth, so the C SDK
grew `SUPERLOG_API` — static by default (header-only consumers see no
change), external with `-DSUPERLOG_API=`, so ONE compiled object exports
the SDK to any language with a C FFI.

Verified on this bench: Postgres NOTIFY (real server via initdb/pg_ctl,
JSON and plain payloads) and SQLite change detection with polled metrics
(`tests/sql.test.mjs`, real engines, nothing mocked); the C#, Zig, C and
COBOL clocks all delivering to a real hub (`verify-sdks.sh` — 6 ok
including regression checks after the SUPERLOG_API change). CI runs
csharp (dotnet is on the runner) and lists zig honestly as a skip where
absent.

**Perl, Lua and COBOL join the bench** — three more producers, three
different bargains, all house rules kept. **Perl** (`sdk/perl/SuperLog.pm`)
is core modules only — `HTTP::Tiny` has shipped with Perl since 5.14 and
`JSON::PP` beside it — for the glue scripts and cron jobs that run half
the world; `SUPERLOG_MODE` with no default, production an inert shell.
**Lua** (`sdk/lua/superlog.lua`, any 5.1+, PUC or LuaJIT) makes the same
honest curl bargain the shell SDK makes, because Lua never grew sockets;
hand-rolled JSON escaping, same mode contract. **COBOL** deliberately gets
no SDK: GnuCOBOL `CALL`s C by symbol, so `demo/cobol/shim.c` (~20 lines)
exports the header-only C SDK and the oldest business language on the
bench inherits it whole — including the provably-compiled-out production
story, `strings`-check included.

Verified on this bench: all three clocks delivering to a real hub
(`scripts/verify-sdks.sh perl lua cobol` - 3 ok), production mode running
inert for Perl and Lua, and the production COBOL binary containing zero
hub URL/route strings while the development build contains them. CI runs
all three on Ubuntu (perl is on the runner; lua5.4 and gnucobol are
installed alongside gfortran/ocaml).

**Viewers: production and development split, one menu.json** — both
viewers separate the two webhook audiences into their own panels: **alarms
(production)** is the sparse blotter with the alarm path beneath it (test
button, per-step detail, the gateway door and watch-only routes), and
**webhooks (development)** is the endpoint factory plus a live feed of
every captured delivery with payload, signature verdict and relay status —
both are webhooks, but one is an incident surface and one is a development
tool, and a screen that mixes them teaches the eye to skim past alarms.
Both viewers render the same menu bar from `viewer/menu.json` (asoOne's
schema: key/label/action/attributes/children, CHECKBOX seeded by
`checked`) with View toggles per window — a window nobody can find may as
well not exist, and the earlier separate routes window spent its life
buried under the alarms window. Every route row gained a **ping** button
(`POST /ping/<name>`, loopback): the same watchdog measurement on the same
books, just now instead of next interval. The GitHub HMAC scheme
(`x-hub-signature-256`) verifies beside Stripe's, and the MCP server
gained `list_webhooks` so an agent can find the URL to hand a webhook
sender without asking a human.

Verified: both HMAC schemes and the relay pass-through against a real hub
(`tests/alarm.test.mjs`); live on this bench, through real public tunnels:
two Stripe-signed events `verified` at INFO, a tampered one `FAILED` at
WARN, a GitHub-signed payload `verified`, `/ping` measuring a route on
demand, and `list_webhooks` answering over real stdio JSON-RPC. The React
build and the ImGui build both compile clean; menu fallback (baked-in copy
when menu.json is missing) is written but untested.

**superlog-alarm: webhook testing (Stripe-grade)** — capture endpoints grew
into a webhook development tool. The `wh.<name>` body cap rose from 4KB to
32KB (a real Stripe invoice event runs 5–15KB; a tester that truncates the
payload is not a tester). With a signing secret on the endpoint
(`"secret":"whsec_..."` in the manifest, or `STRIPE_WEBHOOK_SECRET`) the
Stripe signature scheme is verified on arrival — `fields.sig` says
`verified` or `FAILED` (WARN), stale timestamps are flagged as possible
replays, and no secret means the field stays absent, never a fake verdict.
A `relay` endpoint (`"relay":5000` or a full URL) additionally hands each
delivery to a local handler and returns the handler's real response to the
sender — `stripe listen --forward-to`, except every delivery, signature
verdict and handler status land on the bench; a handler that is down is
`relay unreachable` at WARN, the exact finding the endpoint exists to
produce. `"local": true` skips the tunnel when the /hook route itself is
the endpoint (bench-local tests, your own reverse proxy).

Verified against a real hub with a stand-in handler
(`tests/alarm.test.mjs`): a correctly signed delivery reads
`sig: verified` at INFO with the payload intact, a tampered one reads
`FAILED` at WARN, and a relayed delivery hands the sender the handler's
own 201 and path while the bench records `relay_status: 201`. Written but
unverified by tests: relay through a real public tunnel (the suite uses
`local` endpoints to keep cloudflared out of CI; the public capture path
itself is live-verified on this bench).

**superlog-alarm: every route tested, endpoints from a manifest** — the
selftest now walks the whole roster, not just the flagship tunnel: one
verdict per watched route, in parallel, where "tested" means what the route
is for — a capture endpoint passes only when a probe POSTed through its
public URL lands back on the hub as a `wh.<name>` event, a forwarded port
answering 502 reports "tunnel up, your service is not", and a watch-only
URL passes on any HTTP answer. `--provision endpoints.json` (or
`SUPER_LOG_PROVISION`) applies a declarative manifest of many endpoints —
`{"name":"stripe"}` capture, `{"name":"webapp","port":5173}` forward,
`{"name":"partner","url":"https://…"}` watch-only, `interval_s` per entry —
re-applied as the file changes, with removals torn down (only names the
file created; the button's endpoints are not the file's to kill). A
route deleted from the roster now also stops its ping clock (the loop
checks it still owns its map entry), and the viewers' route deletion was
extracted into one `deleteEndpoint` shared with the manifest. Route checks
share the flagship's DNS patience (four attempts, three seconds apart) —
a route provisioned moments ago failed its verdict on this bench purely
because its tunnel name had not reached 1.1.1.1 yet, and a route must not
be reported dead for being young.

Verified: per-route selftest verdicts (env-declared and manifest-declared
routes), manifest apply at startup, and declarative removal sparing
env-declared routes, all against a real hub (`tests/alarm.test.mjs`);
capture-probe round-trip and forward-502 diagnosis exercised live through
real cloudflared quick tunnels on this bench. Written but unverified by
tests: the manifest's forward/capture entries spawning real tunnels (the
suite uses watch-only entries to keep cloudflared out of CI).

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

**Alarms, both directions, with somewhere to go.** Shaped by a real
4.7-day outage that was detected in 600 seconds and ignored for 113
re-fires. Outbound: `superlog-alert` gains a fourth rule shape — `combo`
fires when several conditions all land inside one window, the correlation
no single filter can say — and every human-facing channel now lives in
one registry (`notify.mjs`): console, desktop, webhook, command today,
Telegram / Twilio SMS / WhatsApp / email as config-gated entries
(`--channels` prints the roster and what each missing channel needs).
Inbound: `superlog-alarm` is production's door — a token-guarded webhook
through a Cloudflare tunnel (quick tunnel zero-config; a NAMED tunnel
auto-provisioned via the API, falling back loudly with the exact missing
permission when DNS edit rights are absent; ngrok and zrok as alternates)
— with dedup keys and repeat counts, recovery events, renotify windows,
and per-checker heartbeats that raise `monitor_dead:<name>` CRITICAL when
a watcher goes silent. Both viewers gain an **alarm blotter** — sparse,
one row per key, repeats counted, recovery greyed not erased — and a
**test-alarm button** driving the gateway's `/selftest`: hub, tunnel, a
real internet round-trip through the public URL (with a DoH + SNI
fallback that diagnoses "your resolver filters the tunnel name;
production's does not"), and the channel roster. Verified live end to
end: a real Cloudflare quick tunnel, repeats 1→3 on one key, recovery
with fired-count, monitor_dead firing and recovering, the desktop
notification arriving on a real human, and `tests/alarm.test.mjs` +
`tests/alert.test.mjs`. The ImGui blotter's first button-press found a
recursive mutex lock; fixed, snapshot-then-render now.

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
