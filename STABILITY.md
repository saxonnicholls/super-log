# Stability

super-log is **pre-1.0**. Publishing five packages without saying what is
stable is an implicit promise nobody decided to make, so this says it plainly:
what you can build on, and what will move under you.

The version already tells you the shape of the promise. Under SemVer a `0.x`
release makes no compatibility guarantee at all, and until 1.0 a minor bump
(`0.4` → `0.5`) may carry a breaking change. When it does, the CHANGELOG says
so in words — that is the actual contract, not the version arithmetic.

## What is stable

These are the surfaces other people's code and other people's producers depend
on. They change **additively** within a `0.x` series; a breaking change bumps
the version and is called out in the CHANGELOG.

| Surface | Where |
|---|---|
| **The wire protocol** — the NDJSON event envelope, and the `/ingest`, `/ws`, `/recent`, `/healthz` HTTP surface | [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| **The C SDK** — the documented functions in the public header | `sdk/c/superlog.h` |
| **The C++ SDK** — the documented public functions and the build-mode contract | `sdk/cpp/include/super_log/` |
| **The JS client** — its documented exports | `@super-log/client` |

The wire protocol is the one that matters most: it is the whole point of the
project — the contract between a producer, the hub, and a reader, which are
often three different programs written by three different people. A producer
built against 0.4 keeps talking to a 0.5 hub.

## What is not stable yet

These are refined as the bench learns. They can change in any release, without
a major bump. If you script against them, pin the version.

- **Tailer CLI flags and their human-readable output.** The `superlog <verb>`
  commands and each tailer's flags are tools, not an API. The NDJSON a query
  command emits when piped is closer to a contract — but treat its exact shape
  as `0.x` too, and pin if you parse it.
- **Internal C++ headers** that are not part of the documented SDK surface.
- **The viewers** (ImGui and React) — layout, controls, internal structure.
- **The MCP guide** (`guide.json`) content and the repo's internal file layout.
- **Environment variable names.** Changed only with reason, but not promised.
- **The on-disk journal format.** It is a bounded local record, not durable
  storage and not an audit log; its format may change.

## Getting a fix

Security fixes land on the latest release; there is no long-term-support
branch (see [SECURITY.md](SECURITY.md)). Run the latest `0.x`.
