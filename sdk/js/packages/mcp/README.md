# @super-log/mcp

The bench, as tools a coding agent can call. An agent debugging your app
should be able to ask *what did the logs just say* instead of waiting for a
human to paste lines into a chat.

## Install once, use from every project

The server talks to a hub over HTTP, and the hub is one process for the
whole machine - so this is registered once, not per repo:

```sh
# Claude Code
claude mcp add super-log --scope user -- node /path/to/super-log/sdk/js/packages/mcp/bin/superlog-mcp.mjs

# Point it elsewhere if your hub is not on the default port
claude mcp add super-log --scope user -e SUPER_LOG_URL=http://127.0.0.1:7333 -- \
  node /path/to/super-log/sdk/js/packages/mcp/bin/superlog-mcp.mjs
```

Any MCP client works the same way: run
`node bin/superlog-mcp.mjs` as a stdio server, optionally with
`SUPER_LOG_URL` (default `http://127.0.0.1:7333`).

Because topics name streams, one hub serves every project at once and the
agent narrows with a topic prefix — `node.` for one service, `expo.` for
the phones, `app.` for postgres and nginx.

## The tools

| Tool | For |
|------|-----|
| `hub_status` | Is the bench even running? Distinguishes "hub is down" from "the app logged nothing" — the first thing to check when logs seem missing. |
| `list_streams` | Cheap orientation: which topics are active, their level mix, which ones have errors. Call before tailing so topic names are known, not guessed. |
| `tail_logs` | Recent events, filtered by `topic` / `level` / `contains`, with a cursor (`since`) so repeat calls only return what is new. |
| `search_logs` | Find events by text across the recent window when you know the message but not the stream. |
| `wait_for` | Block until a matching event arrives. Use after triggering an action instead of sleeping and hoping; it starts from *now*, so it cannot be satisfied by something older. |

## Why it is shaped this way

**An agent's context is small and the firehose is not.** One 8-second sample
of a single OS stream on this bench was 8,400 events. So every tool filters
first, caps hard (50 by default, 200 maximum, no override), and returns one
compact line per event rather than raw JSON. `list_streams` exists so an
agent can orient in a paragraph instead of ten thousand rows.

**Dependency-free**, like the other JS packages here: MCP over stdio is
newline-delimited JSON-RPC 2.0, small enough to own outright rather than
pin a toolchain for.

**Read-only.** These tools observe; nothing here can publish, delete, or
change a stream.
