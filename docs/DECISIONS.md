# Decisions

Things decided on purpose, with the reasoning, so they can be argued with
rather than rediscovered. A decision without its reasoning is just a
constraint nobody remembers agreeing to.

---

## 1. No authentication. Loopback by default instead.

**Status:** decided, implemented.
**Date:** 2026-08-26.

### The bar

**Be no less safe than the logs a developer already has, and never more
dangerous than them.**

That is the whole standard. It is deliberately modest, because this is a
development tool and not an observability platform — see the README section
that says so at length.

### What the baseline actually is

"Normal logs" means files under `/var/log` and `~/Library/Logs`, `adb
logcat`, the Metro and Xcode consoles, `journalctl`, `docker logs`. Every one
of them is:

- **local only** — not reachable from another machine
- **enforced by the operating system** — filesystem permissions, group
  membership, a USB cable
- **read-only from outside** — you cannot forge a line into someone's
  `/var/log` across a network

### The decision

The hub binds `127.0.0.1` by default. `SUPER_LOG_LAN=1` or an explicit
`SUPER_LOG_BIND` opens it, and a non-loopback bind prints a warning at
startup naming what it means.

Bound to loopback, super-log meets the baseline exactly: the OS is the
authentication, and it is the same OS doing the same job it already does for
your log files. **Adding a login on top of that protects nothing that was
not already protected.**

This was not always true. The hub used to bind `0.0.0.0` while the README
claimed exposure was "a choice, not an accident" — true of `demo/run.sh`,
which pins loopback, and false of the binary the README's own instructions
tell you to run. A security claim the code does not honour is worse than
either alone, and it failed in the quietest possible way: nothing breaks, it
just becomes readable, and writable.

### What was rejected, and why

**A shared secret token.** Rejected on two grounds, either of which is
sufficient.

Without TLS it crosses the network in plaintext on every request, so anyone
who can sniff that network has it after one request and keeps it. It stops
*accidental* access, not an attacker — while the case people imagine it
fixes is precisely an attacker.

And it would *add* a vulnerability that does not exist today. Browsers cannot
set headers on a WebSocket, so the viewer's token must travel in the URL —
into browser history, into `Referer`, into every pasted link and shell
history. Trading a real new leak for protection that plaintext HTTP cannot
sustain is a bad trade.

Cost, for the record: ~90 lines across 30+ files (hub, 8 SDKs, 22 fetch
sites in the tailers, both viewers).

**JWT specifically.** The suggestion came from a codebase where JWT is
correct — an admin server with users, roles and sessions. super-log has none
of those: no users, no roles, no sessions, one developer, one bench. A JWT
with no claims is a bearer token with extra steps.

The decisive objection is mechanical rather than philosophical: it would need
HMAC-SHA256 in **nine languages**, including Fortran and a producer that is
deliberately POSIX `sh` + `curl` + `awk`. JWT and the zero-dependency rule
cannot both hold.

**An in-process IP allowlist.** Planned, then dropped for a better reason
than taste. A route handler cannot see the peer address — it exists only on a
connection-open signal, with no supported way to reject from there, and
closing the raw descriptor would corrupt the server's session state.

That turned out to be the right answer anyway. An allowlist inside the
process is reimplementing `pf` or `nftables` badly: same protection, defeated
by the same attacker, more code, and one more thing to get wrong. It belongs
in the firewall, which most of these machines are already running.

### How the awkward cases are covered without opening anything

Verified rather than assumed, because the intuitive answers are wrong twice
over:

| Case | Answer | Verified |
|---|---|---|
| Android handset | `adb reverse tcp:7333 tcp:7333` — USB, not network | yes, against real hardware |
| iOS handset | `iproxy 7333 7333` (libimobiledevice) | written, not verified |
| Docker on macOS | `host.docker.internal` arrives on the host's **loopback** — needs nothing | yes, tested both ways |
| Docker on macOS, `--network host` | **does not work** — "host" is the Linux VM, so the container's loopback is the VM's | yes, tested |
| Docker on Linux | `--network host` shares the host netns, so loopback works | not tested here |
| Raspberry Pi, servers | **pull** — `tail:ssh`, `gpu --ssh`, `build --ssh`. Nothing installed, no port opened | yes, against real servers |
| An SDK running on another machine | `ssh -R 7333:127.0.0.1:7333` | yes, against a real server |

The pull model is the better default and the reason the fleet support
exists: logs travel *to* the bench over ssh, so the machine being watched
never needs to reach the hub and the hub never needs to be reachable.

### What this does not claim

- It is **not secure against an attacker on your network** if you open it.
  Nothing short of TLS would be, and TLS is a much larger change across
  every client.
- The **write side has no analogue in normal logs**. Nobody can forge lines
  into `/var/log` from across a network. An open hub is the one place that
  stops being true, and for anything used to reconstruct an incident that
  matters more than the read side.
- Loopback protects the port, not the disk. The journal and `/recent` hold
  whatever your machines said, under ordinary file permissions.

### Open questions

Genuinely undecided, and worth other opinions:

1. **Should a token exist at all, for the LAN-device case?** The argument
   against is above. The argument for is that some people will open the port
   regardless, and a weak lock beats none. The counter-counter is that a weak
   lock people believe in is worse than an open door they can see.
2. **Is TLS worth it later?** It is the only thing that actually secures a
   network path. It is also certificates, nine clients, and both viewers.
3. **Should the hub refuse to start on a non-loopback bind without an
   explicit acknowledgement**, rather than warning? Currently it warns.

---

## 2. Bound the replay ring by chunk count, not bytes

**Status:** interim. Retire when ts-moveables bounds it by bytes.

A 20-minute soak (250 Binance streams, ~290 frames/s into one topic) had the
hub holding 66 MB of live, reachable memory for a **single** topic and still
climbing. `leaks(1)` reported no leak; `heap(1)` named the holder as the
per-topic replay ring.

`ring_capacity` bounds that ring by **chunk count only**, while the
subscriber queues beside it are bounded by count *and* bytes. A chunk is
whatever a producer batched, and `max_message_bytes` permits 1 MB, so 1024
chunks was a worst case of a gigabyte per topic.

Dropped to 128 (`SUPER_LOG_REPLAY_CHUNKS`). Peak under identical load went
from 75.9 MB to 30.5 MB, and the curve flattens instead of climbing.

The cost is replay depth, and it is worth stating rather than burying: a
firehose still replays thousands of events on connect, but a quiet
one-event-per-second stream now replays about two minutes of history instead
of about seventeen. Real history was never this ring's job — `/recent` keeps
2000 events per topic and the journal keeps everything.

**The proper fix is a byte budget on the ring**, mirroring `max_queue_bytes`
on the subscriber queues. That lives in ts-moveables. When it lands, this
goes back to 1024: the count and the byte budget bound different things, and
only together do they bound the right one.
