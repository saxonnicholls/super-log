# The super-log wire protocol, v1

Three roles. **Producers** (an Expo app on a phone, a C++ process, a Rust
service, a host-side tailer) emit log events. The **hub** (`superlogd`, one
process on the dev machine) fans them out and keeps a short replay history.
**Viewers** (the ImGui app, the React app) subscribe and render.

The hub is `snicholls::http::ws_broadcast_hub` from ts-moveables, unmodified.
That is a deliberate constraint: topics are opaque strings and payloads are
opaque bytes to the hub, so everything super-log-specific lives at the two
edges and is described here.

## Transport

### Producers → hub: `POST /ingest/:topic`

Body: one **NDJSON chunk** — one or more events, each a JSON object on its own
line. The hub publishes the whole body as a single message, so batching is
free: one POST, one hub frame, N events. Success is `202`.

HTTP POST rather than a streaming socket in v1 because every producer already
has it — `fetch` in React Native and the browser, `fetch` in Node,
`std::net::TcpStream` in Rust, a 60-line socket write in C++ — and a batch
every ~250 ms is indistinguishable from live at human reading speed. A
A WebSocket ingest route is possible future work, for producers that want
lower latency; the event format does not change when it lands.

### Hub → viewers: `GET /ws?topic=*` (WebSocket)

The hub's stock envelope framing. Each text frame is exactly one JSON object:

```json
{"seq": 184, "ts_ms": 1755831845123, "topic": "expo.ios.sim", "payload": "<the NDJSON chunk, verbatim>"}
```

- `seq` — hub-global, monotonic, one per publish. **This is the total order
  across all streams**; sort and gap-detect by it.
- `payload` — the POSTed body, carried verbatim as a JSON string. A viewer
  parses the envelope, then splits `payload` on `\n` and parses each line as
  an event.
- On connect the hub replays recent history for the topic before live
  delivery, so a freshly opened viewer is not blank. `topic=*` is the
  firehose; viewers should subscribe to that and filter client-side.

## Topics

A topic names a *stream*, not a transport. The four React Native streams keep
their names whether the events came from the in-app JS SDK or from a
host-side tailer scraping the same device:

| Topic                 | Stream                          |
|-----------------------|---------------------------------|
| `expo.ios.sim`        | iOS Simulator                   |
| `expo.ios.device`     | iOS hardware                    |
| `expo.android.emu`    | Android emulator                |
| `expo.android.device` | Android hardware                |
| `cpp.<app>`           | a C++ process                   |
| `rust.<app>`          | a Rust process                  |
| `node.<app>`          | a Node process                  |
| `python.<app>`        | a Python process                |
| `go.<app>`            | a Go process                    |
| `java.<app>`          | a JVM process (Java, Kotlin)    |
| `swift.<app>`         | a Swift process                 |
| `fortran.<app>`       | a Fortran program               |
| `shell.<app>`         | a shell script                  |
| `web.<app>`           | a browser app                   |
| `os.<host>`           | a machine's own OS logs (macOS unified log, journald, Windows event log) - one topic per machine, tailed locally, from the LAN, or over ssh |
| `app.<host>.<name>`   | a service's log file on that machine (postgres, nginx, redis, ...); `.<file>` suffix when one service writes several |
| `net.<host>.<target>` | HTTP/HTTPS calls through the logging proxy - one event per request/response pair |
| `grpc.<host>.<target>`| gRPC calls through the logging proxy - one event per RPC, levelled by `grpc-status` from the trailers rather than the HTTP status; streaming RPCs are reported when the stream ends, with message counts each way |
| `dns.<domain>`        | a domain's DNS records and TLS certificate, reported when they change |
| `net.<host>.listeners`| listening sockets and the processes that own them |
| `build.<host>.<label>`| a build: one event per compiler diagnostic, one verdict; sanitizer and valgrind findings arrive whole, one event each |
| `git.<host>.<repo>`   | a checkout: commits, branch switches, rewritten history, tags, conflicts |
| `github.<owner>.<repo>`| a GitHub repository: pushes, CI runs, pull requests, issues, releases |
| `fs.<host>.<dir>`     | a directory tree: files created, modified and deleted; with `--diff`, one event per changed hunk (removed and added lines together), the hunks of one save sharing a `trace` with their modified event |
| `tee.<host>`          | anything piped through superlog-tee; `--topic` names it something better |
| `ws.<host>.<stream>`  | frames on a WebSocket, with a periodic frames/s `metric` |
| `serial.<host>.<port>`| a board's serial console; ESP-IDF, Zephyr and bracketed levels recognised |
| `syslog.<host>.<app>` | anything that speaks syslog over UDP or TCP - routers, switches, appliances, rsyslog |
| `cf.<worker>`         | a Cloudflare Worker: one trace per invocation, its console lines, exceptions, and CPU/wall time as metrics |
| `stripe.<account>.<mode>` | Stripe events, one topic per account and per live/test — **redacted to an allowlist**, never customer records |
| `socket.<host>.<peer>`| plain lines on a raw TCP or UDP socket |
| `ros.<host>.<node>`   | a ROS 1 / ROS 2 node's log, one topic per node, from `/rosout` or `~/.ros/log` |
| `gpu.<host>.<index>`  | a GPU: utilisation, memory, temperature and power as `metric` events, plus threshold crossings |
| `cuda.<app>`          | a CUDA program: kernel time from CUDA events, device printf, and faults caught at the synchronise |
| `host.<name>.vitals`  | disk, memory, CPU and load; readings are `metric` events |
| `power.<host>`        | CPU package watts, thermal pressure, fan RPM, die temperatures, aggregate CPU and the top energy consumers, as `metric` events plus edge-triggered crossings; macOS |
| `dl.<host>.<label>`   | a download in flight: percent, bytes and rate as `metric` events, an edge-triggered WARN on stall, and one verdict when it ends |
| `sys.<host>`          | the machine's own life events: crash reports (ERROR) and kernel panics (CRITICAL) parsed from DiagnosticReports, the previous shutdown cause once per boot, volume mounts/unmounts/renames, sleep/wake; macOS |
| `gas.<chain>`         | operational key balances (native coin or ERC-20): readings as `metric` events, edge-triggered CRITICAL below the fund-now line, WARN below the low line, recovery announced |
| `alert.<rule>`        | an alert rule that fired, so alerts sit beside their cause |

Lowercase, dot-separated, `[a-z0-9._-]`. New streams add rows here.

## The event

One JSON object per line. Only `msg` is required; everything else has a
default, because half the producers are tailers wrapping text they did not
generate.

```json
{
  "v": 1,
  "ts": "2026-08-22T03:04:05.123456789Z",
  "seq": 42,
  "session": "a3f9c2d1",
  "level": "INFO",
  "origin": {
    "runtime": "react-native",
    "app": "moveables-app",
    "platform": "ios",
    "device": "iPhone 16 Pro"
  },
  "tag": "network",
  "msg": "order 7 filled at 101.5",
  "fields": {"venue": "XLON", "px": "101.5"},
  "metric": {"name": "fps", "value": 58.9},
  "src": "OrderScreen.tsx:88"
}
```

| Key       | Type   | Default      | Meaning |
|-----------|--------|--------------|---------|
| `v`       | int    | `1`          | schema version |
| `ts`      | string | hub arrival  | producer wall clock, ISO-8601 UTC; nanosecond digits welcome, fewer fine |
| `seq`     | uint64 | absent       | per-`session` monotonic counter, starts at 0. Orders events *within* one producer; a gap means that producer dropped |
| `session` | string | absent       | one random id per process/app run; `seq` is meaningless without it |
| `level`   | string | `"INFO"`     | `TRACE` `DEBUG` `INFO` `WARN` `ERROR` `CRITICAL` |
| `origin`  | object | absent       | who is speaking: `runtime` (`cpp` `rust` `python` `go` `java` `swift` `fortran` `shell` `serial` `socket` `ros` `cuda` `cloudflare` `stripe` `js` `node` `react` `react-native` `web`), `app`, `platform` (`ios` `android` `macos` `linux` `windows` `web`), `device` (human-readable) |
| `tag`     | string | absent       | logical channel/logger name — spdlog logger name, tracing target, RN component |
| `trace`   | string | absent       | correlation id: the same value on every event caused by one user action, across every stream. See below |
| `msg`     | string | **required** | the line |
| `fields`  | object | absent       | structured extras, string values |
| `metric`  | object | absent       | telemetry riding the same pipeline (mirrors `snicholls::log::record::is_metric`): `{name, value}` — `msg` may be empty then |
| `src`     | string | absent       | `file:line` |

**Tolerant reader rule.** A viewer MUST accept: missing optional keys, unknown
extra keys, and a payload line that is not JSON at all — the last becomes
`{"msg": "<the raw line>"}` at whatever level heuristics suggest (default
`INFO`). Producers should be strict; readers must be forgiving. This is what
lets a dumb `adb logcat` tailer share a pipeline with a structured spdlog
sink.

## Correlation: following one action across every stream

A tap on a phone becomes an HTTP request, a database write, a chain call
and four log streams. `trace` is what says they are the same story.

- **One id per user action**, minted wherever the action starts (usually
  the app), and carried unchanged by everything it causes. It is opaque:
  16 hex characters here, but any short string a producer sets is legal.
- **Over the wire it is the `X-Superlog-Trace` header.** A client puts it
  on outbound HTTP; a server adopts it for the logs of that request and
  passes it on. Anything that cannot read the header simply has no
  `trace`, which is the tolerant-reader rule again — correlation is a
  bonus on an event, never a requirement.
- **Readers filter by it**: `GET /recent?trace=<id>`, the viewers' trace
  filter, and `tail_logs(trace:)` in the MCP server. One id answers "show
  me everything that happened when the user pressed Send", in hub order,
  across the phone, the API and the box that actually failed.

Deliberately *not* a span tree. Parent/child nesting is what a tracing
system does, and this is a log bench: one flat id per action makes the
common question cheap to ask and cheap to implement in four languages. If
nesting ever earns its keep it goes in a `span` field beside this one.

## Level mappings

| super-log  | logcat | spdlog   | Rust `tracing` | `console.*`      | Apple unified log | journald |
|------------|--------|----------|----------------|------------------|-------------------|----------|
| `TRACE`    | V      | trace    | TRACE          | `console.debug`* | —                 | —        |
| `DEBUG`    | D      | debug    | DEBUG          | `console.debug`  | Debug             | 7        |
| `INFO`     | I      | info     | INFO           | `console.log/info` | Default, Info   | 5, 6     |
| `WARN`     | W      | warn     | WARN           | `console.warn`   | —                 | 4        |
| `ERROR`    | E      | err      | ERROR          | `console.error`  | Error             | 3        |
| `CRITICAL` | F      | critical | —              | —                | Fault             | 0–2      |

## Ordering, honestly

Two clocks, two counters, and what each is for:

- **hub `seq`** — the only total order across streams. Use it to interleave
  the four device feeds in one view.
- **event `seq` + `session`** — per-producer order and *loss detection*: a
  hole in one producer's `seq` proves that producer dropped (bounded queues
  drop under burst by design, in ts-moveables and in every SDK here — a
  logger that can stall the app it observes is worse than no logger).
- **`ts`** — display, and rough cross-stream alignment. Phone clocks drift;
  never sort by `ts` across streams and pretend it is truth.

## Hub endpoints (all stock ts-moveables)

| Endpoint               | What |
|------------------------|------|
| `POST /ingest/:topic`  | ingest an NDJSON chunk → `202` |
| `GET /ws?topic=<t>`    | subscribe; `*` = firehose |
| `GET /recent?...`      | pull recent events over plain HTTP (added by superlogd) |
| `GET /healthz`         | `200 ok` + hub stats JSON (added by superlogd) |

### `GET /recent` — the pull half of the feed

The WebSocket is the real-time path, but it needs a client that can hold a
socket open. `/recent` answers "what happened since I last looked" over one
GET, which is what scripts, cron jobs and agents actually want.

| Param    | Default | Meaning |
|----------|---------|---------|
| `since`  | `0`     | return events with `id` greater than this |
| `limit`  | `200`   | maximum events (hard cap 1000 — a reader is never handed the firehose) |
| `topic`  | all     | exact topic, or a prefix ending in `.` (`cpp.` matches `cpp.clock`), or `*` |
| `level`  | all     | minimum level: `TRACE` `DEBUG` `INFO` `WARN` `ERROR` `CRITICAL` |

```json
{
  "events": [
    {"id": 42, "seq": 7, "topic": "cpp.clock", "event": {"v":1, "level":"INFO", "msg":"tick 3"}}
  ],
  "next": 42, "count": 1, "oldest": 1, "newest": 42, "missed": false
}
```

- `id` — superlogd's own per-**event** cursor. Poll with `since=<the last
  next>` and you will neither miss nor repeat an event.
- `seq` — the hub frame the event arrived in, so `/recent` lines up with the
  WebSocket feed. One POSTed chunk is many events, so ids share a seq.
- `next` advances past filtered-out events too, so a `level=ERROR` poller
  does not re-scan the quiet events every time.
- `missed` — true when the ring moved past `since`: that reader lost events.
  Ring depth is 5000 events (`SUPER_LOG_RECENT`).

Default port **7333** (`SUPER_LOG_PORT` overrides).

Reaching the hub from a device:

| From                  | URL host |
|-----------------------|----------|
| iOS Simulator         | `localhost` |
| Android emulator      | `10.0.2.2`, or `localhost` after `adb reverse tcp:7333 tcp:7333` |
| Android hardware      | `localhost` after `adb reverse tcp:7333 tcp:7333` (USB), else the Mac's LAN IP |
| iOS hardware          | the Mac's LAN IP (same Wi-Fi) |
