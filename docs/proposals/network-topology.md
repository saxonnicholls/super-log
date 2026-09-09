# Proposal: network topology tree + route monitoring

**Status:** PROPOSAL — not built. Nothing here ships until reviewed.
**Date:** 2026-09-08.
**Scope:** OSS / MIT bench tailer + a viewer window.

The ask: see the local network as a **tree** — a sense of what is upstream and
what is downstream — in its own window; and **monitor the route** between two
points (say a client and a server) over time, tracert-style, rather than
guessing when a path changed.

This document exists to be argued with before any code is written. Its most
important section is [§3](#3-the-decision-this-reopens), because the naive
version of half this feature was already rejected on purpose.

---

## 1. What already exists (so we extend, not duplicate)

super-log is not empty here. The relevant sensors today:

| Tailer | Topic | What it already gives us |
|---|---|---|
| `netstate` | `net.<host>.state` | The ARP neighbourhood (IP→MAC), the default gateway (+ its interface), Wi-Fi SSID, VPN tunnels, the DNS resolver set — **diffed**, with judgment: a new LAN device is one INFO, a **gateway-MAC change is ERROR** (router swap / ARP-spoof). It also pings targets (RTT/loss as DEBUG readings) and the gateway for free. |
| `ports` | `net.<host>.listeners` | Listening sockets + owning process + firewall rules, `--ssh`-able to a remote box. netstat-for-listeners. |
| `dns` | `dns.<domain>` | Records + cert expiry, and with `--asn` the **origin AS** that announces a domain's prefix (via RIPEstat) — i.e. the upstream-of-the-upstream, and what a prefix hijack looks like from outside. |

Two facts from that inventory shape everything below:

1. **We already collect the LAN's nodes — we just don't structure them.**
   `netstate` holds the gateway and the full IP→MAC neighbour set every poll.
   Nobody has turned that flat set into a rooted tree.
2. **Traceroute already runs — but only once, reactively, as text.** When a
   ping target crosses a loss alarm, `netstate` fires a single
   `traceroute -n -w 2 -q 1 -m 20` and again once on recovery, then joins the
   hops into a text blob on the alarm's `trace` id. The hop list is **never
   parsed into structure, never kept, never a tree**, and there is no
   continuous path monitoring at all.

So the genuinely new surface is: **(A)** structure the LAN into a tree in its
own window, and **(B)** keep a route under continuous observation. Everything
else is reuse.

## 2. What's being asked, precisely

- **A. A local-network topology tree, in its own viewer window.** Root = this
  host. **Upstream:** the default gateway, and beyond it the origin AS (we can
  already learn it). **Downstream:** the ARP neighbours, each with what we know
  (IP, MAC, interface, first-seen, and — see limitations — maybe a vendor from
  the MAC OUI). A glance answers "what is on my network and how does it hang
  together," which no flat log line does.
- **B. Continuous route monitoring between named endpoints.** Point it at a
  server (and optionally run it *from* a client over ssh, the way `ports`
  and `gpu` already do), and it watches the path: per-hop RTT over time, and an
  **event when the route itself meaningfully changes** — a hop added, the path
  length growing, the target going unreachable — so a reroute or a path
  degradation is a thing that announces itself instead of a thing you
  reconstruct after the incident.

## 3. The decision this reopens

`CHANGELOG.md` records, deliberately:

> Continuous traceroute was rejected on purpose: ECMP makes hop lists differ
> legitimately per flow, and diffing them teaches muting.

This is correct and it is the crux. **Equal-Cost Multi-Path** routing means two
back-to-back traceroutes to the same destination can legitimately traverse
different middle hops — the network is load-balancing across parallel paths.
Naively diffing raw hop lists therefore produces a stream of "hop 7 changed"
events that mean nothing, and a watcher that cries wolf every poll is one people
mute. Muting a security-adjacent watcher is worse than not having it.

**A credible proposal must not do the thing that was rejected.** The rest of
this design is built around that constraint. The short version: *readings are
structural and continuous; alarms are rare and fire only on the parts of a path
that are stable and meaningful.* We never diff raw per-flow hop identity.

## 4. Design

Split by risk, because the two halves are not equally hard.

### Tier 1 — the LAN topology tree (low-risk, no ECMP problem)

The LAN side has no ECMP problem: your gateway is your gateway, and the ARP
table is a stable star rooted at it. This tier is mostly **restructuring data
`netstate` already gathers**, plus light enrichment.

- **Topic:** `net.<host>.topology`, carrying a nested `fields.tree` in exactly
  the shape the USB tailer already uses (`{name, children:[…]}`) — so both
  viewers render it with the recursive tree renderer they *already have* (the
  USB device tree). Zero new rendering primitives.
- **The tree:**
  ```
  <host> (this machine)
  └─ gateway 192.168.1.1  (aa:bb:cc:… )
     ├─ upstream: AS13335 Cloudflare        # from the dns --asn mechanism
     └─ downstream (LAN):
        ├─ 192.168.1.20  iPhone      (first seen 3h ago)
        ├─ 192.168.1.42  rpi4        (new 40s ago)   ← INFO on first sight
        └─ 192.168.1.253 <this host>
  ```
- **Readings vs edges (house discipline):** the tree itself is a periodic
  DEBUG-level structural reading — always there for the window, out of a
  default INFO view. Edges reuse what netstate already judges: a new neighbour
  is one INFO, a **gateway-MAC change is ERROR**. No new alarm classes needed
  for Tier 1; it is a *view* over judgments we already make.
- **Where it lives:** either a small addition to `netstate` (it already has the
  gateway + neighbour collectors) or a self-contained `superlog-topology`
  tailer that copies those collectors in the zero-dep standalone style. See
  [§7](#7-open-questions).

Tier 1 alone satisfies "see the local network as a tree, upstream/downstream,
in its own window," using data we already have, with no new risk. It is the
no-regret half.

### Tier 2 — route monitoring (the half that must answer §3)

- **Topic:** `net.<host>.route.<target>` (one per monitored destination;
  `<target>` sanitized). Run continuously on an interval (default, say, 30–60s
  — slower than the state clock; a route is not an FPS counter).
- **What is a reading (continuous, DEBUG, never alarms):**
  - per-hop RTT and loss, as `metric` readings, keyed by hop **position** and
    address, so the window can chart "hop 3 latency over the last hour" and
    colour the tree by latency. Charting the noisy middle is *fine* — a chart
    absorbs ECMP jitter that an alarm cannot.
  - the current hop list as structure (a `route` sub-tree), so the window shows
    the path. Structure is a reading, not an alarm.
- **What is an edge (rare, WARN/ERROR, with recovery) — and how it dodges the
  ECMP trap:**
  - **Flow-pin the probe.** Use a fixed flow (fixed protocol + fixed
    destination port / ICMP id) so a single monitor doesn't re-hash across ECMP
    paths every run. This makes *one monitor's* path stable enough that a real
    change stands out. (`traceroute` supports pinning the flow; the exact flag
    set is an implementation detail for the build.)
  - **Alarm only on the stable, meaningful facts, behind a stability window**
    (a change must persist N consecutive polls before it speaks — the same
    two-strikes rule netstate already uses for ping loss):
    - the **target became unreachable** (no hop reaches it) → ERROR, recovery
      announced. This is the one that matters most and has nothing to do with
      middle-hop identity.
    - the **path length changed and stayed changed** (e.g. 8 hops → 12 hops for
      N polls) → WARN. A sustained length change is a reroute, not ECMP jitter.
    - a **near-hop went bad** — the first one or two hops (your gateway, your
      ISP's first router) are ECMP-*stable* and are exactly the upstream you
      care about; a near-hop RTT crossing a threshold, or a near-hop changing,
      is real → WARN.
    - **per-hop RTT threshold crossings** on a *stable* hop → WARN, edge-
      triggered with recovery.
  - **What we explicitly never alarm on:** the identity of deep middle hops
    changing between polls. That is ECMP, it is charted, it is never diffed as
    an edge. This is the sentence that keeps the watcher un-muted.
- **Client↔server, both ends:** run it from the bench to a server, or **from a
  remote client over ssh** (`--ssh client1 --to server.example.com`) exactly
  like `ports`/`gpu` — nothing installed on the client, `traceroute` shipped in
  the probe. That is the literal "monitor the route between a client and a
  server" ask, from whichever end you can reach.

### The caution that matters most: path health is NOT service health

A route that resolves cleanly and a port that answers do **not** mean the
service is healthy, and a topology view that paints a node green because the
path to it is up will lie in exactly the outage that matters. Grounding, from a
real bench incident (monitoring a single-homed gRPC service behind a grey
cloud): a proxy's response buffering can starve
long-lived gRPC streams while unary requests stay perfectly healthy, and a
client's backfill makes a starved stream present as "messages arrive within a
few seconds" — indistinguishable from working. A clean traceroute and a
answering endpoint render that node entirely green through its worst outage.

So this capability commits to a rule: **it reports PATH health, and labels it as
such — never SERVICE health.** `net.<host>.route.<target>` says "the path to X
is up / rerouted / slow / unreachable," never "X is healthy." Whether the
service behind the path is actually behaving (a gRPC surface correctly refusing
a plain GET with 415, a stream that delivers on the stream rather than via
backfill) is a *different* probe — the endpoint/HTTP watcher's job, or a future
`--probe` — and the viewer must not merge the two into one green dot. Honest
amber on a reachable-but-unverified node beats a green that isn't earned.

### A tree of connections, not just neighbours (strong Tier-1 addition)

The ARP tree answers "what is on my LAN." A second tree answers a question that
has settled the same argument twice across three sessions — *which remote
endpoint is a local process actually holding a connection to right now?* — the
established outbound connections (`ss -tnp state established` / `lsof -nP -iTCP
-sTCP:ESTABLISHED`), grouped process → remote endpoint, surfaced **over time**.
`netstat` already knows this instant; nothing in the system keeps it. It is the
direct answer to "is my app talking to the dev network or the production one,"
which no route or DNS record can settle. Proposed as `net.<host>.connections`
(a peer topic to `topology`), a DEBUG structural reading like the LAN tree, with
an edge only when a process opens a connection to a *new* remote endpoint it has
not talked to before this run. This is general, not XMTP-specific, and cheap
(one more collector, the same tree renderer).

## 5. Topic conventions

Fits the established `net.<host>.*` namespace ([PROTOCOL.md](../PROTOCOL.md)
topic table) with no new top-level namespace:

| Topic | Carries |
|---|---|
| `net.<host>.topology` | the LAN tree (`fields.tree`), Tier 1 |
| `net.<host>.route.<target>` | per-target route readings + the rare route edges, Tier 2 |

Both are opaque producer-declared strings, so nothing gates adding them; they
get a row in PROTOCOL.md's table when built.

## 6. The viewer window

A new **Topology** window/board in both viewers, off the same `topic=*`
firehose — no new subscription, just a new topic-prefix filter. The recursive
tree renderer already exists for USB in both viewers and is directly reusable:

- **ImGui/C++:** a `topology_state` struct + a `note_topology()` observer
  (filter `net.` + `.topology`/`.route.`) + reuse the existing recursive
  `draw_usb_node`-style renderer + a window block and one menu entry. Ballpark
  the size of the existing `usb` board (~80–130 lines).
- **React:** a `TopologyPanel.tsx` that `JSON.parse`s `fields.tree` and renders
  it with a recursive node renderer (the `DevicePanel` pattern), plus three
  registration lines and one `menu.json` toggle (~130 lines).

What it shows: this host at the root; the gateway and the upstream AS above;
the LAN neighbours below; and, per monitored target, a route sub-tree with hops
coloured by RTT and unreachable/`* * *` hops shown as opaque. One screen that
answers "what is my network, and is the path to X healthy right now."

## 7. Open questions (for the review)

1. **One tailer or two?** Recommend a single new `superlog-topology` doing both
   tiers (one capability, one window, one checklist entry), OR fold Tier 1 into
   `netstate` (it owns the data already) and make Tier 2 a separate
   `superlog-route`. Leaning single new tailer for a clean window story; open to
   folding Tier 1 into netstate to avoid duplicating its collectors.
2. **Privilege.** `traceroute`/ICMP may need setuid or raw-socket capability on
   some systems; `netstate`'s existing traceroute is unprivileged and swallows
   failure to `''`. A hop we can't measure is absent, never zero — but we
   should say plainly in the docs when traceroute needs privilege and degrade
   to "path unavailable" rather than a fake tree.
3. **MAC → vendor.** A vendor label ("Apple", "Raspberry Pi Foundation") makes
   the LAN tree far more legible, but the OUI lookup wants a table and the SDKs/
   tailers are **zero-dependency, no network fetch**. Options: ship a tiny
   curated OUI-prefix table (a few KB, common vendors only), or omit vendor.
   Recommend a small bundled table; decide the size budget.
4. **Interval + politeness.** Continuous traceroute is more traffic than a
   ping. Default interval should be conservative (30–60s), `--interval`
   overridable, and we should not traceroute the deep path more often than the
   near path needs.
5. **Reopening the CHANGELOG decision.** If accepted, this warrants a
   `docs/DECISIONS.md` entry that supersedes the "continuous traceroute
   rejected" note — recording *why the objection no longer applies* (flow-pin +
   stable-hop-only alarms + structure-as-reading), so the reasoning isn't lost.

## 8. Recommendation

Ship **Tier 1 first** — it is cheap, carries no ECMP risk, reuses the USB tree
renderer wholesale, and already delivers the headline ask ("see the local
network as a tree, upstream/downstream, in its own window"). Then build
**Tier 2** with the ECMP-aware alarming above, which is what turns "I think the
route changed" into an event with a timestamp.

When built, each tier follows the full capability checklist (README ×3, an MCP
`guide.json` entry so an agent knows what an empty/!changed topology means, a
PROTOCOL.md topic row, a CHANGELOG entry marking VERIFIED-vs-written, and
subprocess tests against a real hub — with the tools' output mocked the way
`tests/gpu.test.mjs` mocks `nvidia-smi`, since a test host has no fixed
network).

---

*Prior art reused: the USB `fields.tree` renderer (both viewers), the
`net.<host>.*` topic namespace, netstate's macOS/Linux collector branching and
its two-strikes edge discipline, the `--ssh` remote-probe pattern from
`ports`/`gpu`, and the `dns --asn` origin-AS lookup for the upstream node.*
