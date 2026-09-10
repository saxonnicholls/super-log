# Security policy

## Reporting a vulnerability

Email **security@super-log.com**. Please do not open a public issue for a
security report.

Include what you need to make it real: the affected file and version, how to
reproduce it, and the impact you observed. A proof-of-concept helps. We aim to
acknowledge within a few days.

We will work with you on a fix and coordinated disclosure, and credit you if you
would like to be named.

## What super-log is, and the threat model it aims at

super-log is a **local developer tool**, not a production service. Its bar is
deliberate and explicit: **be no less safe than the logs a developer already
has, and never more dangerous.**

- **The hub binds loopback (`127.0.0.1`) by default.** There is no
  authentication and no TLS: on loopback, the operating system is the
  authentication, the same OS already guarding your log files. Exposing the hub
  to a network (`SUPER_LOG_LAN=1` / `SUPER_LOG_BIND=0.0.0.0`) is opt-in, printed
  loudly at startup, and means anyone who can reach the port can read every
  stream and publish to any topic. Do not do it on an untrusted network.
- **Production is pulled, not pushed.** The ssh tailer and the fleet runner read
  remote logs onto your bench over ssh; production never needs to reach the hub.
- **Egress can be cut.** `SUPER_LOG_NO_EGRESS` names topics that are accepted on
  the bench but never rebroadcast, recorded or journaled — a stream that must
  exist locally and never leave the machine.
- **`superlog login` makes no network call** of its own — it opens a browser to
  a compile-time-constant URL. The cloud client is a separate package.

The full model, and how it differs from super-log Cloud, is in
[docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md).

## Known limitations

- **A browser is not fully a boundary.** Because browsers do not apply the
  same-origin policy to WebSockets, a web page can attempt to reach a
  loopback-bound hub. Treat the machine running the hub as you would the machine
  holding your `/var/log`: software already on it is inside the boundary. Origin
  restrictions on the hub's WebSocket are being tightened; until then, be aware
  that "loopback" protects you from the network, not from your own browser.
- **The hub keeps recent events in memory** (a bounded ring) plus an optional
  on-disk journal. It is not durable storage and not an audit log.

## Supported versions

super-log is pre-1.0. Security fixes land on the latest release; there is no
long-term-support branch yet. Run the latest version.
