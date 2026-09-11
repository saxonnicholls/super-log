# Proposal: packet capture on the bench (tshark / tcpdump / pcap / pcapng / pktap)

**Status:** PROPOSAL — not built. Nothing here ships until reviewed.
**Date:** 2026-09-09.
**Scope:** OSS / MIT bench tailer + a viewer window.

The ask: log Wireshark-grade packet data — `tshark`, `tcpdump`, and the capture
formats `pcap`, `pcapng` (a.k.a. pcap-ng) and Apple's `pktap` — onto the bench,
the way the other tailers put a stream on one screen.

This one earns a design doc before a line of code, because packet capture walks
straight into three walls that none of the other tailers face, and **the middle
one is a security decision** — which, per the bench's own rule, comes first.

---

## 1. The three walls

1. **Volume.** A capture is thousands of packets a second. Publishing a packet
   per event would firehose the hub — the exact anti-pattern the bench exists to
   prevent (the MCP server's own instruction is "never try to read every event:
   streams can produce thousands per second"). So the tailer must publish
   **flows and summaries, never raw packets.**
2. **Privacy — the load-bearing one.** Packets carry payloads: credentials,
   tokens, cookies, PII, the bodies of unencrypted requests. And the hub
   **rebroadcasts** what it ingests. Logging packet payloads to a rebroadcasting
   hub is the worst data-exfiltration bug this project could ship. Even
   *metadata* — who your machine talks to — is sensitive. So: **metadata only,
   payloads never, and the capture topic is a first-class candidate for the
   egress cut** (`SUPER_LOG_NO_EGRESS`) we already built.
3. **Privilege.** Live capture needs root / `CAP_NET_RAW` / a setuid `dumpcap`.
   A dev-bench tool that asks for root is a big ask, so privilege must be opt-in,
   minimal and pinned — and there must be a **useful path that needs none.**

## 2. What's being asked, and what it actually means

"Log the packets" almost never means "log every packet" — it means answer:
*what is my machine talking to, is anything talking to somewhere new, and which
process is responsible.* That is a **flow-and-metadata** problem, not a
packet-dump problem, and it is squarely a **security** capability: lightweight
network forensics / egress visibility on your own bench.

## 3. Design

### Metadata only — the shape of what we publish

Never a packet; always a **flow** (a connection) or a **rollup**. Per flow, from
the headers alone: the 5-tuple (src/dst IP:port, protocol), byte and packet
counts, duration, TCP flag summary, and — the prize below — the owning process.
No payload bytes, ever. (A `--payload` switch is a loaded gun; v1 does not have
one. If it ever does, it is hex-only, length-capped, redaction-first, and it
forces the topic into the egress cut.)

- **Readings** (DEBUG `metric`): packets/sec and bytes/sec per interface, active
  flow count, top talkers — charted, out of a default INFO view.
- **Edges** (WARN/ERROR, with recovery), the few that mean something:
  - a **new external endpoint** a process has not talked to before this run
    (the direct answer to "is my app phoning home / talking to prod vs dev");
  - a **port scan** shape (one source, many dest ports, in a window);
  - a **retransmission / RST storm** (a connection failing, not merely chatty);
  - a **DNS query to a new domain** (cheap exfil/adware signal);
  - a listener or connection on an **unexpected port**.

### The prize: process attribution (pktap)

macOS's **`pktap`** pseudo-interface tags each packet with the **process name
and pid** that sent or received it (`tcpdump -i pktap ...`, or tshark over the
PKTAP DLT). That turns "192.0.2.10 got 4 MB" into "**Slack** sent 4 MB to
192.0.2.10" — which is the whole game for a dev bench, and it is exactly the
question the topology proposal's `net.<host>.connections` tree also answers, at a
coarser grain. On Linux the equivalent is joining flows to `/proc` sockets (via
`ss -tnp` / conntrack) rather than a per-packet tag — coarser, but the same
answer. Windows: ETW, out of scope for v1.

### Sources — and a no-privilege path that is genuinely useful

- **Offline file (no privilege, ship this first).** Point the tailer at a
  `.pcap` / `.pcapng` someone already captured and it summarises the flows onto
  the bench: "drop a capture here and see it on one screen." Zero privilege, zero
  live risk, and it reads both formats (tshark/tcpdump handle pcap and pcapng
  natively; pcapng's interface/name-resolution blocks are a bonus).
- **Live capture (opt-in, privileged).** A pinned, minimal invocation — a setuid
  `dumpcap`, or `sudo` with a specific BPF filter, on the model of the power
  tailer's single pinned `powermetrics`. Loopback and a chosen interface only;
  a capture filter by default (e.g. exclude the hub's own port so we don't watch
  ourselves). Never promiscuous unless explicitly asked.

### Formats

Read **pcap** and **pcapng** (the modern default) via tshark/tcpdump — no
format parsing of our own. **pktap** on macOS for process tags. We do **not**
write captures as a rule (we summarise); an optional "keep the raw `.pcapng`
for forensics" mode could mirror the journal, but it is out of v1.

## 4. Security & privacy stance (paramount)

- **Metadata only. Payloads never** (v1 has no switch to log them).
- The capture topic is **egress-cuttable**: `SUPER_LOG_NO_EGRESS=pcap.*` keeps it
  on the machine, and the docs will *recommend* that for any real network.
- **Privilege is opt-in, minimal, pinned**; the offline-file path needs none.
- Dual-use, used defensively: monitoring your **own** bench's egress. The docs
  say plainly what it does and does not capture, so there is no surprise.

## 5. Topic conventions

Fits `net.<host>.*` / a `pcap.<host>` namespace ([PROTOCOL.md](../PROTOCOL.md)):

| Topic | Carries |
|---|---|
| `net.<host>.flows` (or `pcap.<host>`) | flow summaries + the rollup readings, and the edge events |
| `net.<host>.connections` | the process→endpoint view (shared with the topology proposal — build once) |

## 6. Tools & the zero-dependency line

The SDKs and tailers are zero-dependency, but a capture tailer necessarily
**shells out to `tshark` / `tcpdump` / `dumpcap`**, which are not installed by
default (like `superlog-gpu` needs `nvidia-smi`). So: detect the tool, degrade
honestly when absent (one WARN, not a crash — the `gpu`/`netstate` pattern),
and parse a stable machine format — tshark `-T ek` (newline-delimited JSON) or
`-T fields`, or tcpdump's text — never scrape the human view.

## 7. The viewer

A **Flows** window (or a section of the Topology window): top talkers, active
flows with their owning process, and the edge events inline. It shares the
`net.<host>.connections` model with the topology proposal, so the two are one
window, not two.

## 8. Open questions (for the review)

1. **Live capture privilege model** — setuid `dumpcap` (Wireshark's own answer)
   vs a pinned `sudo` rule (the power tailer's answer). Which fits the bench?
2. **Default filter** — capture everything on an interface, or start
   conservative (exclude loopback/hub, TCP control only) and widen on request?
3. **Flow state vs sampling** — hold flow state in the tailer (accurate, more
   memory) or sample tshark's own per-packet output into rollups (cheaper)?
4. **Relationship to `net.<host>.connections`** — the topology proposal already
   wants the process→endpoint tree from `ss`/`lsof`. Packet capture is the
   deeper, packet-accurate version. Build the coarse one first (no privilege),
   and let live capture enrich the same topic? (Recommended.)
5. **Retention of raw captures** — never, or an opt-in local `.pcapng` ring for
   forensics (which must itself be egress-cut and access-controlled)?

## 9. Recommendation

Ship in this order, because each step is useful and the risk climbs:

1. **Offline `.pcap`/`.pcapng` summariser** — no privilege, no live risk, reads
   both formats, and immediately useful ("see this capture on the bench").
2. **The coarse `net.<host>.connections` tree** from `ss`/`lsof` (shared with
   the topology proposal) — process→endpoint over time, no packet capture at all.
3. **Live capture, opt-in and privileged**, metadata-only, with pktap process
   tags on macOS — enriching the same topic, behind an explicit privilege step
   and with the egress cut recommended in the docs.

When built, each step follows the full capability checklist (README ×3, an MCP
`guide.json` entry that states plainly it is metadata-only and PATH/egress
data — not payloads, a PROTOCOL.md topic row, a CHANGELOG entry marking
VERIFIED-vs-written, and subprocess tests against a real hub with tshark/tcpdump
output mocked the way `tests/gpu.test.mjs` mocks `nvidia-smi`).

---

*Prior art reused: the `gpu`/`netstate` "detect the tool, degrade honestly"
pattern; the power tailer's pinned-privilege model; the egress cut
(`SUPER_LOG_NO_EGRESS`) as the on-by-recommendation control for a capture
topic; the topology proposal's `net.<host>.connections` process→endpoint tree
and its "path health is not service health" honesty.*
