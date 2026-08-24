# super-log

**One hub for every log stream you have — devices, servers, containers,
browsers, chains.**

If you build across devices, you know the ritual: a Metro console for the
iOS simulator, another for the Android emulator, `adb logcat` for the phone
on your desk, a terminal for the C++ engine, another for the Rust service,
browser devtools for the web build, and an ssh session to the box in the
cloud. Six places to look, none agreeing on timestamps, and the bug is
always in the interleaving.

super-log converges all of it on one process and one screen:

```
 RN/Expo devices ─────┐
 C++  (spdlog/SN_LOG) │                                     ┌─▶ native viewer (ImGui)
 Rust (tracing)       │                                     ├─▶ web viewer (React)
 Node / browser JS    ├── POST NDJSON ──▶  superlogd :7333 ─┼─▶ journal → search / replay
 OS logs (mac/linux)  │                    (fan-out+replay)  ├─▶ GET /recent  (scripts)
 services, containers │                                     └─▶ MCP tools    (agents)
 remote hosts via ssh │
 blockchain addresses ┘
```

Every producer speaks one small wire protocol
([docs/PROTOCOL.md](docs/PROTOCOL.md): one JSON event per line, batched over
plain HTTP POST), the hub fans out to any number of readers with
replay-on-connect, and everything is interleaved by hub sequence — not by
device clocks, which drift.

## What it does for you

**One screen, everything on it.** Streams colour-coded by source and level,
filtered by stream, minimum level or substring. Pause freezes the display
while collection continues; copy a row or the whole filtered view; export
JSON, CSV or plain text.

**Your apps need almost nothing.** Nine dependency-free SDKs: header-only
C++ (both a **spdlog** sink and a native `snicholls::log` one), a Rust
crate with an optional `tracing` layer, Python plugging into stdlib
`logging`, Go with a `log/slog` handler, Java with a `java.util.logging`
bridge (and Kotlin), Swift, Fortran over raw POSIX sockets, a `sh`
one-liner for scripts, and one JS client for React Native, the browser and
Node — `patchConsole: true` and every `console.log` is on the bench.

Five of them hook the logging framework the language already has — the
spdlog sink, `logging.Handler`, `slog.Handler`, `java.util.logging.Handler`
and `patchConsole` — so everything a program *already* logs reaches the
bench without a single call site changing.

**Follow one action across every tier.** A tap becomes a request, a database
write and a chain call on four streams. `withTrace()` mints a correlation
id, carries it across `await`s, and puts it on outbound HTTP automatically;
a server adopts it and logs under the same id. Then one query — a `⇢` in the
viewer, `GET /recent?trace=…`, or an agent tool — returns the whole story in
order.

**Every error, including the ones nobody logged.** Uncaught exceptions and
unhandled rejections are captured by default in every SDK, with stacks —
chaining to whatever was already installed, so React Native still shows its
red box, Node still exits 1, and C++ still aborts. C++ traces are demangled
(`pricer::Engine::quote(int)`) with no boost dependency. For the hardest
class — an exception a library throws and your code catches and *displays* —
there is a render chokepoint pattern and an opt-in breadcrumb on every Error
construction.

**Zero-app-change fallbacks.** Host-side tailers scrape what already exists:
`adb logcat` (scoped to one app, because an OEM handset emits ~600 lines a
second), the iOS simulator's log stream, the macOS unified log, journald,
Docker containers, and any log file. A catalog knows where ~20 common
services log on macOS and Linux — postgres, mysql, mongodb, redis, nginx,
apache, kafka, elasticsearch, rocksdb — including both Homebrew prefixes.

**Whole fleets, pulled over ssh.** One config file brings up every stream on
every server: OS logs, service logs, container logs. Nothing is installed
remotely, no port is opened, and the servers never need to reach the hub —
so the hub can stay loopback-bound while still watching production.

**HTTP calls, request and response.** Front a service with the logging proxy
and every call is one event (method, path, status, latency, size), or turn
on `patchNetwork` in the app and see the calls it makes. HTTPS targets need
no certificate work. Bodies are opt-in; credentials are always redacted.

**Blockchain addresses, beside the code that touched them.** Watch any EVM
address and its transfers, contract events and native balance moves land on
the same screen, in hub order, next to the app code that sent them.

**Infrastructure that only speaks when something changes.** DNS records and
TLS expiry, listening ports and the processes that own them — all watched by
diffing snapshots, so the stream is silent until it matters: an NS record you
did not change, a certificate three weeks out, a new public listener on a
production box, a service that restarted without saying so.

**Builds as events, not walls of text.** Wrap any build — cmake, clang, gcc,
cargo, npm, xcodebuild, local or over ssh — and compiler diagnostics become
WARN/ERROR rows with `file:line`, with one summary event carrying exit
status, duration and counts.

**History, not just the last few minutes.** The journal writes every frame
verbatim to disk; `search` reads it back with the same filters as the live
feed (including `--trace`), and `replay` re-publishes it at original pace.
A 1 GB / 4.8M-event journal searches in ~2.3 s.

**Readable by scripts and agents.** `GET /recent?since=<cursor>&level=ERROR`
answers "what happened since I last looked", with a cursor that never misses
or repeats an event. For coding agents there is an **MCP server**: check the
hub, list streams, tail and search (live *and* history), follow a trace, and
`wait_for` an event after triggering an action instead of sleeping.

**Something reaches you when nobody is watching.** Rules over the live feed
fire to a desktop notification, a webhook, a command, or back onto the bench
as `alert.*`. Three shapes, because production breaks in three ways:
something bad was logged, *too much* of it was logged, or something
**stopped** being logged — the last being the one most tools miss, since a
server with nothing to say and a server that is gone look identical until
you check. Rate and silence rules report recovery too.

**Producers never block.** Every SDK uses a bounded queue that drops oldest
under burst — counted, never hidden. A logger that can stall the app it
observes is worse than no logger.

**Off in production, by construction.** Every SDK requires you to declare
DEVELOPMENT or PRODUCTION (neither or both refuses to build), and each mode
ships only what its policy allows. Production defaults to **nothing**.

## Quick start

```sh
git clone --recurse-submodules <this repo>
cd super-log
cp .env.example .env             # optional: chain endpoints, hub defaults

# The whole demo: hub, C++/Rust/iOS/Android/browser/container clocks,
# OS-log streams, both viewers - one command
npm run demo                     # see demo/README.md for the tour

# ...and the other languages on the same screen, if their toolchains are here
SUPER_LOG_LANGS="go python java swift fortran shell" npm run demo

# Or piece by piece:
./scripts/dev.sh                 # build + run the hub
npm install && npm run viewer    # web viewer on http://localhost:7334
npm run tail:android             # first stream: the Android emulator
```

The demo binds to loopback. Real phones need the hub on the LAN:
`SUPER_LOG_LAN=1 ./demo/run.sh` — read the security section first. The
viewer finds the hub from the host that served the page, so opening it from
another machine needs no configuration.

## Putting your own apps on the bench

**React Native / browser / Node** (`@super-log/client`, zero dependencies):

```js
import { createSuperLog } from '@super-log/client';

const slog = createSuperLog({
  url: 'http://192.168.1.20:7333',   // your bench machine
  topic: 'expo.ios.device',          // topics name streams - PROTOCOL.md
  app: 'my-app',
  development: __DEV__,              // exactly one of these two, or it throws
  production: !__DEV__,
  patchConsole: true,                // console.* now reaches the bench
  patchNetwork: true,                // ...and every HTTP call it makes
});

// One id for everything this action causes, on every tier it reaches
await slog.withTrace(async () => {
  slog.info('checkout mounted', { user: '42' });
  await fetch('https://api.example.com/v1/pay');   // header added for you
});
```

React trees can wrap once with [`@super-log/react`](sdk/js/packages/react):
`<SuperLogProvider>` owns the client and an error boundary that logs the
**component stack** — which a global handler can never see, because React
swallows render errors.

**C++** (header-only; compile with `-DSUPERLOG_DEVELOPMENT` or
`-DSUPERLOG_PRODUCTION`):

```cpp
superlog::transport_config cfg;
cfg.topic = "cpp.pricer";
auto bat = std::make_shared<superlog::batcher>(cfg);   // before the logger

superlog::origin who;
who.app = "pricer";
spdlog::default_logger()->sinks().push_back(
    std::make_shared<superlog::spdlog_sink_mt>(bat, who));

superlog::install_terminate_handler(bat, who);  // uncaught exceptions + stack
```

**Python** (standard library only; `development=` / `production=`, exactly one):

```python
import logging, superlog

log = superlog.SuperLog(topic="python.pricer", app="pricer", development=True)

logging.getLogger().addHandler(log.handler())  # everything already logged
log.install_excepthook(capture_locals=True)    # and every crash, with locals

with log.traced():                 # ContextVars: async- and thread-safe,
    log.info("order received")     # and inherited by everything called inside
    stdlib_logger.debug("pricing") # ...including plain logging calls
```

Python gets two things the other SDKs cannot. `logging.Handler` means every
line the program *already* logs reaches the bench with no call-site changes.
And `capture_locals` attaches the local variables of the failing frames, so
an exception says `symbol='DOGE', n=7` rather than only where it happened —
secret-looking names are redacted and values truncated.

**Go** (a `log/slog` handler, so existing calls need no changes):

```go
log, _ := superlog.New(superlog.Config{
    Topic: "go.pricer", App: "pricer", Development: true,
})
defer log.Close()
slog.SetDefault(slog.New(log.SlogHandler(nil)))   // everything already logged

ctx, _ := superlog.WithTrace(context.Background(), "")
slog.InfoContext(ctx, "order received")           // ...on the tick's trace

go func() { defer log.Recover("worker"); work() }()  // panics, with stack
```

Trace lives in `context.Context` rather than a goroutine-local, because Go
deliberately has none — so the id travels exactly where the context does.
`Recover` logs the panic and re-panics: a logger that swallows a crash has
changed the program it was meant to observe.

**Java and Kotlin** (`java.util.logging` bridge; `InheritableThreadLocal`
trace, so a pooled task inherits its submitter's id):

```java
var log = SuperLog.builder().topic("java.pricer").app("pricer")
                  .development(true).build();
Logger.getLogger("").addHandler(log.julHandler());   // everything already logged
log.installUncaughtHandler();                        // and every crash

log.traceScope(() -> {
    log.info("order received");
    pool.submit(log.wrap(() -> log.debug("settled")));  // same trace
});
```

**Swift** (`@TaskLocal` trace, inherited by child tasks):

```swift
let log = try SuperLog(topic: "swift.pricer", app: "pricer", development: true)
try SuperLog.withTrace {
    log.info("order received")
    Task { log.debug("pricing pass") }   // same trace, nothing passed in
}
```

There is deliberately no `setTrace()`: a `TaskLocal` binds to a scope and
nothing else, which makes the usual leak — one request's id surviving into
the next — impossible to express rather than merely discouraged.

**Fortran** (raw POSIX sockets through `ISO_C_BINDING`, no libcurl):

```fortran
call sl_init(topic='fortran.solver', app='solver')
call sl_set_trace(sl_new_trace())
call sl_metric('solver.residual', residual)
if (residual /= residual) call sl_error('residual is NaN')
call sl_close()
```

A solver is the hardest program on the bench to observe: hours long, often
somewhere you cannot attach, and the evidence is a slurm file nobody reads
until the allocation is spent. `DEVELOPMENT` xor `PRODUCTION` is a
preprocessor error like the C++ SDK, and `SIGPIPE` is ignored at init so a
hub that goes away cannot kill a run twelve hours in.

**Shell** (any script, one line):

```sh
superlog-log --topic deploy "starting rollout"
tail -f /var/log/app.log | superlog-log --topic app.foo --level WARN
```

**Rust** (build with `--features development` or `--features production`):

```rust
let log = super_log::SuperLog::new(super_log::Config {
    topic: "rust.pricer".into(),
    app: "pricer".into(),
    ..Default::default()
});
log.install_panic_hook();                 // panics, with location
log.log(super_log::Level::Info, "engine up", None);
log.metric("fps", 58.9);
```

**Machines, services, containers, chains** (no app changes at all):

```sh
npm run tail:os -- --process MyApp          # this Mac's unified log
npm run tail:apps                           # what services log here
npm run tail:app -- postgres nginx redis    # ...then turn them on
npm run tail:file -- /srv/app/production.log
npm run tail:ssh -- my-server               # a remote box, OS auto-detected
npm run tail:ssh -- db1 --app postgres      # ...or its postgres
npm run net -- 9000 http://localhost:3000   # every HTTP call through :9000
npm run chain                               # watched addresses (see .env)
npm run dns -- example.com --once           # every DNS record + cert, then exit
npm run dns -- example.com mail.example.com # ...or watch them for change
npm run ports -- --once                     # what is listening, and which process
npm run ports -- --ssh web1 --procs nginx   # ...on a server, watched
npm run vitals -- --once                    # disk, memory, CPU, load
npm run vitals -- --ssh web1                # ...on a server, watched
npm run alert                               # rules from alerts.json
npm run alert -- --test                     # prove delivery without waiting
npm run build -- --label cxx -- cmake --build build -j
npm run build -- --label asan -- ./build/tests   # sanitizer findings, whole
npm run git                                 # this repo: commits, branches, conflicts
npm run git -- --ssh web1 --repo /srv/app   # ...a deployed checkout
npm run github -- --repo owner/name         # CI runs, PRs, releases
npm run watch -- --dir src                  # files created, modified, deleted
make 2>&1 | npx superlog --topic build.local # anything that prints (tee)
npm run ws -- wss://stream.binance.com:9443/ws/btcusdt@trade
npm run serial -- --list                    # boards plugged in
npm run serial -- --port /dev/ttyUSB0       # the serial console, as events
npm run build -- --ssh web1 -- 'cd /srv/app && cargo build --release'
```

### Infrastructure watches

These three diff a snapshot rather than streaming, so the first poll is a
silent baseline and only *changes* are reported — a watcher that announces
everything it sees teaches you to ignore it.

| Watch | Publishes | Notable levels |
|-------|-----------|----------------|
| `dns` | `dns.<domain>` — A, AAAA, NS, MX, TXT, CAA and the TLS certificate | **NS/CAA change is WARN** (you probably did not do it; it is how a domain gets taken), a record type vanishing is ERROR, certs go WARN at 3 weeks → ERROR at 1 → CRITICAL once expired. TXT changes are named by kind, so it says *"SPF/DMARC record changed"* rather than making you diff two long strings. |
| `ports` | `net.<host>.listeners` — listening sockets, owning process, pid, **and firewall rules** | A **new listener on a public address is WARN**, the same on loopback is INFO; a listener disappearing is WARN; a pid change is reported as a restart rather than as one service vanishing and another appearing; a watched process going missing is ERROR. |
| `vitals` | `host.<name>.vitals` — disk, memory, CPU and load, macOS/Linux/Windows | Readings are DEBUG `metric` events (always there for a chart, out of a default INFO view); threshold crossings are **edge-triggered** WARN/ERROR, so 85% says so once rather than every poll, and recovery says so too. Read-only filesystems are skipped: a macOS simulator runtime is 98% full by design, and alerting on it produced 25 false ERRORs before this rule existed. |
| `build` | `build.<host>.<label>` — one event per diagnostic, one verdict | Compiler errors are ERROR with `file:line`; a build that **exits 0 while reporting errors** is WARN, not success, because that usually means a `;` where `&&` was meant — and a build that reports errors and calls itself fine is how a broken artefact ships. |

`dns` queries one chosen resolver (1.1.1.1 by default) so a change means the
record changed, not that a laptop moved networks and hit a different cache.
`build` is transparent: it prints the output and exits with the build's own
status, so it can sit inside a Makefile or a CI step unchanged.

## Whole fleets

Eight servers with containers each is thirty tailers, and nobody runs thirty
commands twice. Describe them once ([tailers/fleet.example.json](tailers/fleet.example.json)):

```json
{ "url": "http://127.0.0.1:7333",
  "hosts": [
    { "ssh": "web1", "name": "web1", "os": true, "apps": ["nginx"] },
    { "ssh": "deploy@10.0.1.20", "name": "api", "os": true,
      "identity": "~/.ssh/id_ed25519",
      "docker": ["api", "worker"], "files": ["/srv/app/log/production.log"] }
  ] }
```

`npm run fleet -- fleet.json` starts every stream and restarts any that die.
`name` is the topic name, so `os.api` reads better at 3am than
`os.ubuntu-4gb-nbg1-1`. Everything is **pulled** over ssh — no agent, no open
port, no route from production to the hub.

## History

```sh
npm run journal                                   # capture everything, rotated
npm run search -- --since 3d --level ERROR --topic node.
npm run search -- --trace 9f1c0a2b7d4e5f60        # one action, days later
npm run replay -- --dir superlog-journal --speed 1
```

The window filters on **hub arrival**, not the producer's clock: arrival is
monotonic, so the window is exact and the scan can stop early.

## Modes and policies

Every SDK enforces **DEVELOPMENT xor PRODUCTION** — neither or both is a
compile error (C++ and Fortran defines, Rust features) or a raised error
(JS, Python, Go, Java, Swift). Each mode
then ships what its *policy* allows: development everything, production
**nothing**. Want crash triage from release builds? Say so explicitly —
`-DSUPERLOG_PROD_POLICY=ERROR`, `prod_policy: Policy::AtLeast(Level::Error)`,
or `productionPolicy: 'ERROR'`. Below-policy events cost one compare; a
policy of OFF compiles the transport to an inert shell — and says so once on
the console, because a client that is silently doing nothing looks exactly
like a broken one.

Log lines leaving a production box are a security decision, so nothing here
makes it for you.

## Security posture

No auth, no TLS: anyone who can reach the port can read every stream and
publish to any topic. The defaults are arranged so exposure is a choice, not
an accident:

- The demo binds **loopback only**; `SUPER_LOG_BIND` / `SUPER_LOG_LAN=1`
  open it up when real devices need it, on a network you trust.
- The ssh tailer and the fleet runner **pull**, so production logs reach the
  bench without production ever reaching the hub.
- Production builds forward nothing unless you loosened the policy.
- Credentials are redacted, not logged: `Authorization`, `Cookie` and
  `X-API-Key` headers in the proxy, token-shaped query values in URLs, and
  the provider key inside an RPC endpoint.
- `.env` is gitignored — an RPC URL with a key in it is spendable.
- CSV exports defuse spreadsheet formula injection; viewers render log
  content as text, never markup.

See the Auth/TLS section of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- **Hub + viewers:** macOS or Linux (POSIX phase 1), a C++17 compiler,
  CMake ≥ 3.16. Windows machines join as producers (SDKs, ssh tailer).
- **JS:** Node ≥ 18 (≥ 22 for journal, chain watcher and MCP).
  **Rust:** any recent stable. **Python:** ≥ 3.8, standard library only.
  **Go:** ≥ 1.21 (`log/slog`). **Java:** ≥ 17, plain `javac`, no build tool.
  **Swift:** ≥ 5.9, SwiftPM. **Fortran:** gfortran or any compiler with
  `-cpp`. **Shell:** `sh` and `curl`, nothing else.
- On macOS, Go 1.21's internal linker omits `LC_UUID`, which current dyld
  rejects; build with `-ldflags=-linkmode=external` or use Go ≥ 1.22.
- [ts-moveables](https://github.com/saxonnicholls/ts-moveables) provides the
  transport/fan-out/logging fabric — a sibling checkout if present, GitHub
  otherwise.
- spdlog + fmt, imgui + glfw, and nlohmann/json are pinned submodules in
  `third_party/` (`git submodule update --init`) — versions chosen to work
  together, so system-installed ones are never trusted.
- Docker (optional) for the Ubuntu build-and-smoke image.

## Layout

| Path            | What |
|-----------------|------|
| `hub/`          | `superlogd` - the one process everything meets at |
| `sdk/cpp/`      | header-only: forward sink, spdlog sink, terminate handler |
| `sdk/rust/`     | `super-log` crate: core, `tracing` layer, panic hook |
| `sdk/python/`   | `superlog`: client, `logging` handler, excepthook, locals capture |
| `sdk/go/`       | `superlog`: client, `log/slog` handler, panic recovery |
| `sdk/java/`     | `SuperLog`: client, `java.util.logging` bridge, Kotlin notes |
| `sdk/swift/`    | `SuperLog`: client, `@TaskLocal` trace |
| `sdk/fortran/`  | `superlog.F90`: client over raw POSIX sockets |
| `sdk/js/`       | `@super-log/client`, `@super-log/react`, `@super-log/mcp` |
| `tailers/`      | adb, simctl, OS logs, files, services, docker, ssh, fleet, chain, journal, search, replay, net proxy |
| `viewer/imgui/` | native viewer |
| `viewer/react/` | web viewer |
| `demo/`         | the multi-client clock demo: one command, whole bench |
| `docker/`       | Ubuntu build+smoke image and the Linux bench producer |
| `third_party/`  | pinned submodules |
| `docs/`         | PROTOCOL.md (the contract), ARCHITECTURE.md (the shape) |

## Status, honestly

Most of this is **verified live** on a real bench, and where something is
merely written it is labelled as such. Verified: the hub, both C++ paths,
Rust, the JS client in a real Expo app on simulators and hardware plus a
real browser and Node, both viewers, the macOS and journald tailers, the adb
tailer against a physical handset, ssh streaming from cloud hosts, a fleet
of four servers, the chain watcher against Ethereum mainnet, search and
replay over a 1 GB journal, correlation across tiers, the error hooks in all
four SDKs, and the Docker image (which smoke-tests itself during
`docker build`).

Still **written but not verified**: the Windows event-log path (no Windows
machine here) and the iOS-hardware tailer. Not built yet: viewer "load
session" and metric sparklines.

[HANDOFF.md](HANDOFF.md) is the unvarnished ledger of which is which, plus
the build-out plan and the decisions that were made on purpose. CI lives in
`.github/workflows/ci.yml`; `scripts/smoke.sh` is the one smoke test that
CI, the Docker image and your terminal all run identically.

Copyright 2026 Saxon Herschel Nicholls.
