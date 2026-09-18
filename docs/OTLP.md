# OpenTelemetry (OTLP)

super-log is a **two-way OTLP member of your bench**: it accepts OTLP in (the
*inlet*) and emits OTLP out (the *outlet*). Point your existing OTel setup at
it, or point it at your existing OTel backend — no new SDK either way, and no
lock-in.

- **Inlet — `superlog-otlp`**: an OTLP/HTTP server. Anything OTel-instrumented
  joins the bench with one exporter stanza.
- **Outlet — `superlog-otlp-export`**: reads the hub and forwards OTLP/JSON to
  any collector or vendor, so the bench feeds the rest of your observability
  stack.

Both are MIT, zero-dependency, and speak **OTLP/HTTP**. Neither speaks gRPC —
see [gRPC and the Collector bridge](#grpc-and-the-collector-bridge).

---

## Inlet — receive OTLP into the bench

```
superlog-otlp                 # OTLP/HTTP on 127.0.0.1:4318 (the standard port)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318  your-app
```

- Routes: `POST /v1/logs` (first-class), `/v1/metrics`, `/v1/traces`.
- Encodings: `application/json` **and** `application/x-protobuf` (a hand-rolled
  bounded decoder — most SDKs default to protobuf, so JSON-only would gut it).
- Mapping: `severityNumber` → bench level; each resource's `service.name`
  becomes the topic `otlp.<service>`; an OTel `trace_id` becomes the event's
  `trace`, so **one `/recent?trace=<id>` returns the OTel spans and the bench's
  own lines as a single story**.
- Signals land as the bench models them: logs as events; metric gauge/sum points
  as `metric` readings; spans as trace-carrying `DEBUG` events. See
  [the deliberate limits](#deliberate-limits-not-gaps).

Full field-level detail: `docs/PROTOCOL.md` (`otlp.<service>` row) and
`stream_guide otlp` over MCP.

## Outlet — send the bench out as OTLP

```
superlog-otlp-export --endpoint https://otlp.example.com \
    --header 'authorization: Bearer <token>'

# or the standard env, and read a non-default hub:
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com \
SUPER_LOG_URL=http://127.0.0.1:7333 superlog-otlp-export
```

It subscribes to the hub over `/ws` (like the journal — same reconnect and
epoch handling), maps each event, batches, and `POST`s **OTLP/JSON** to
`<endpoint>/v1/logs` and `<endpoint>/v1/metrics`.

| Flag / env | Default | Meaning |
|---|---|---|
| `--endpoint` / `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:4318` | backend **base**; `/v1/*` is appended |
| `--header 'k: v'` (repeatable) / `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,…`) | — | auth and any other headers |
| `--topic PATTERN` | `*` | which bench topics leave (exact, `prefix.`, or `*`) |
| `--service NAME` | `origin.app` | force one `service.name`, else per-event |
| `--signals logs,metrics` | both | which signals to emit |
| `--batch N` / `--flush-ms MS` | `512` / `2000` | batch size and flush cadence |
| `--url HUB` / `SUPER_LOG_URL` | `http://127.0.0.1:7333` | the hub to read |

**Mapping (the inverse of the inlet):**

- Every event → an OTLP `LogRecord`: `severityText` is the bench level and
  `severityNumber` is that band's start (`ERROR` → 17); `body.stringValue` is
  the message; `service.name` comes from `origin.app` (or `--service`); fields
  and a few `superlog.*` keys (topic, seq, session, tag, runtime, platform,
  device) become attributes.
- `trace`: a 32-hex id (16 bytes) becomes `traceId`; the bench's own 16-hex ids
  don't fit OTLP's 16-byte field, so they ride as a `superlog.trace` attribute.
- A `metric` event → an OTLP **gauge** data point under `/v1/metrics`.
- **Traces are not exported** — the bench has no spans of its own; a trace id
  travels out on its LogRecord, which is where the correlation already lives.

**Delivery contract:** a bounded queue that drops **oldest** under burst and
counts it; a backend that is down or slow costs the batch in flight, never the
bench (the hub read never blocks on the export POST). There is no retry queue —
a retry buffer grows without bound against a backend that stays down — so a
failed delivery is counted and the next batch continues. Progress is reported on
stderr (`N exported, M dropped`), never re-injected into the hub (that would
export its own status and, on a failing backend, amplify).

**JSON only, on purpose.** OTLP/JSON is accepted by every Collector and the
major vendors. Writing a protobuf *encoder* here would add a hand-rolled wire
format to maintain and buy nothing the JSON path doesn't already deliver.

---

## gRPC and the Collector bridge

Neither the inlet nor the outlet speaks **OTLP/gRPC** (port 4317). This is a
deliberate scope line, not a stub: a correct gRPC implementation is HTTP/2 +
gRPC framing, which is either a hand-rolled protocol to maintain forever or a
dependency that breaks the SDK's zero-dependency rule. The bench does not need
it, because the **OpenTelemetry Collector** already bridges the two transports
in one hop — and if you run OTel at any scale you already have a Collector.

**A gRPC producer → super-log** (Collector receives gRPC, exports HTTP to the
inlet):

```yaml
receivers:
  otlp:
    protocols:
      grpc:            # your apps push here on :4317
exporters:
  otlphttp:
    endpoint: http://127.0.0.1:4318   # the superlog-otlp inlet
    encoding: json                    # or proto; the inlet takes both
service:
  pipelines:
    logs:    { receivers: [otlp], exporters: [otlphttp] }
    metrics: { receivers: [otlp], exporters: [otlphttp] }
    traces:  { receivers: [otlp], exporters: [otlphttp] }
```

**super-log → a gRPC-only backend** (the outlet posts HTTP to a local Collector,
which speaks gRPC onward):

```yaml
receivers:
  otlp:
    protocols:
      http:            # superlog-otlp-export posts here
exporters:
  otlp:
    endpoint: your-backend:4317       # gRPC to the vendor/backend
service:
  pipelines:
    logs:    { receivers: [otlp], exporters: [otlp] }
    metrics: { receivers: [otlp], exporters: [otlp] }
```
```
superlog-otlp-export --endpoint http://127.0.0.1:4318   # the Collector's HTTP receiver
```

The Collector also gets you ret/queue/backoff, batching, and TLS/mTLS if the
backend requires them — all the transport concerns super-log deliberately keeps
out of a zero-dependency tailer.

---

## Deliberate limits (not gaps)

These are design choices consistent with what super-log is — a bench, not a
metrics TSDB or a trace store:

- **Histograms are summarized to count and sum**, in both directions, with a
  `(summarized)` note — never invented percentiles or reconstructed buckets. A
  bench answers "how many, how much, is it moving"; percentile analysis over raw
  buckets belongs in the system you keep the histograms in. This is a limit we
  chose and stand behind, not a missing feature.
- **Spans are correlation, not a tree.** The inlet lands spans as
  trace-carrying events; the outlet exports no traces. The value super-log adds
  is lining an OTel `trace_id` up with the bench's own `withTrace()` ids — not a
  waterfall view.
- **Logs are the first-class signal** on both sides.

## Ports & security

- Inlet binds loopback (`127.0.0.1:4318`) by default — the hub has no auth, so do
  not expose it without one; `--bind`/`--port` (`SUPER_LOG_OTLP_*`) move it.
- The outlet makes an **outbound** connection to your backend; put credentials in
  `--header`/`OTEL_EXPORTER_OTLP_HEADERS` and prefer `https://` endpoints.
