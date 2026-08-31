# Working on super-log

One hub for every log stream on a development bench. Read
[docs/PROTOCOL.md](docs/PROTOCOL.md) before changing anything that touches
the wire, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before moving
anything between the hub and its edges.

## The capability checklist

Every logging capability - a new tailer, a new stream, a new flag that
changes what a stream means - ships with ALL of:

1. **A detailed README.md entry.** Three places, because readers arrive
   three ways: the capability table near the top (the scanning reader), the
   feature prose or watch table (what it does, what the levels mean, the
   incident that earned it), and the command list (one copy-pasteable line).
2. **A detailed MCP entry.** `sdk/js/packages/mcp/guide.json` - what the
   topic's events and metrics mean, how to read them, and the gotchas. An
   agent on this bench must never have to guess what a topic means; it
   queries `stream_guide`. Playbooks live in the same file and are served
   as MCP prompts.
3. A topic row in docs/PROTOCOL.md, a CHANGELOG entry that says what is
   VERIFIED versus merely written, and tests driven as subprocesses against
   a real hub (tests/harness.mjs).

## Conventions

- Zero dependencies in the SDKs and tailers. Node >= 18, plain `node --test`.
- Readings are DEBUG `metric` events; threshold crossings are edge-triggered
  WARN/ERROR that announce recovery too. A watcher that repeats itself every
  poll is a watcher people mute.
- A missing reading stays absent - never report "no sensor" as zero.
- Comments explain decisions and trade-offs, never what the next line does.
- `npm test` must be green before a commit that touches a tool it covers.
