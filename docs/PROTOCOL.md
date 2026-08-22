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
WebSocket ingest route is milestone M5 in HANDOFF.md, for producers that want
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
| `web.<app>`           | a browser app                   |

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
| `origin`  | object | absent       | who is speaking: `runtime` (`cpp` `rust` `js` `node` `react` `react-native` `web`), `app`, `platform` (`ios` `android` `macos` `linux` `windows` `web`), `device` (human-readable) |
| `tag`     | string | absent       | logical channel/logger name — spdlog logger name, tracing target, RN component |
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

## Level mappings

| super-log  | logcat | spdlog   | Rust `tracing` | `console.*`      | Apple unified log |
|------------|--------|----------|----------------|------------------|-------------------|
| `TRACE`    | V      | trace    | TRACE          | `console.debug`* | —                 |
| `DEBUG`    | D      | debug    | DEBUG          | `console.debug`  | Debug             |
| `INFO`     | I      | info     | INFO           | `console.log/info` | Default, Info   |
| `WARN`     | W      | warn     | WARN           | `console.warn`   | —                 |
| `ERROR`    | E      | err      | ERROR          | `console.error`  | Error             |
| `CRITICAL` | F      | critical | —              | —                | Fault             |

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
| `GET /healthz`         | `200 ok` + hub stats JSON (added by superlogd) |

Default port **7333** (`SUPER_LOG_PORT` overrides).

Reaching the hub from a device:

| From                  | URL host |
|-----------------------|----------|
| iOS Simulator         | `localhost` |
| Android emulator      | `10.0.2.2`, or `localhost` after `adb reverse tcp:7333 tcp:7333` |
| Android hardware      | `localhost` after `adb reverse tcp:7333 tcp:7333` (USB), else the Mac's LAN IP |
| iOS hardware          | the Mac's LAN IP (same Wi-Fi) |
