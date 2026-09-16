# Installing the super-log MCP server

For an AI installer (e.g. Cline). super-log's MCP server is the zero-dependency
Node (>= 18) package `@super-log/mcp`, run over stdio. No build, no API key.

## Add the server

Add this entry under `mcpServers` in the client's MCP settings JSON (for Cline,
that file is `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "super-log": {
      "command": "npx",
      "args": ["-y", "@super-log/mcp"],
      "env": { "SUPER_LOG_URL": "http://127.0.0.1:7333" }
    }
  }
}
```

That is the whole installation. `npx -y @super-log/mcp` fetches and runs the
server; nothing else to configure.

## Requirements

- Node.js >= 18 (for `npx`).
- A running super-log hub (`superlogd`) at `http://127.0.0.1:7333` by default.
  Set `SUPER_LOG_URL` to point elsewhere. The server is read-only; if the tools
  return nothing, the hub is probably not running — check `hub_status`.

## What it provides (read-only)

`hub_status`, `list_streams`, `tail_logs`, `search_logs`, `search_history`,
`wait_for`, `stream_guide` (per-topic documentation), `list_webhooks`, and
`agent_report` (the one write — only to `agent.*` status topics).
