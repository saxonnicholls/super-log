# Connect super-log to your AI assistant

super-log ships an **MCP server** — `@super-log/mcp`, a zero-dependency Node ≥18
**stdio** server that wraps your local hub with read-only log tools (`hub_status`,
`list_streams`, `tail_logs`, `search_logs`, `search_history`, `wait_for`,
`stream_guide`, plus `agent_report` and `list_webhooks`). It works in **any
MCP-capable client** — the config is the same everywhere.

**Prerequisite:** a running hub. The server talks to `http://127.0.0.1:7333` by
default; set `SUPER_LOG_URL` to point elsewhere. See the README for starting the
hub (`superlogd`).

## The universal server entry

Every client below takes the same thing — only the file location and the
wrapper key differ:

```jsonc
{ "command": "npx", "args": ["-y", "@super-log/mcp"], "env": { "SUPER_LOG_URL": "http://127.0.0.1:7333" } }
```

Once it is in the [MCP Registry](https://registry.modelcontextprotocol.io) as
`com.super-log/super-log`, most clients can also discover and install it in-app
by name — no hand-editing.

## Per-client setup

### Claude Code
```sh
claude mcp add super-log -- npx -y @super-log/mcp
# once in the registry:
claude mcp add com.super-log/super-log
```

### Claude Desktop
Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):
```json
{ "mcpServers": { "super-log": { "command": "npx", "args": ["-y", "@super-log/mcp"] } } }
```
Or install the one-click `.mcpb` extension from the GitHub release (Settings →
Connectors → Add Extension).

### Cursor
`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):
```json
{ "mcpServers": { "super-log": { "command": "npx", "args": ["-y", "@super-log/mcp"] } } }
```
Or use the one-click **Add to Cursor** deeplink (see the README badge).

### VS Code (GitHub Copilot, agent mode)
`.vscode/mcp.json` in the workspace, or "MCP: Add Server" from the command
palette. MCP tools are available in **agent mode**, not Ask mode.
```json
{ "servers": { "super-log": { "command": "npx", "args": ["-y", "@super-log/mcp"] } } }
```

### Cline
`cline_mcp_settings.json` (Cline → MCP Servers → Configure), or install from the
Cline MCP Marketplace:
```json
{ "mcpServers": { "super-log": { "command": "npx", "args": ["-y", "@super-log/mcp"] } } }
```

### Windsurf
`~/.codeium/windsurf/mcp_config.json` (Settings → Cascade → MCP → View Raw
Config):
```json
{ "mcpServers": { "super-log": { "command": "npx", "args": ["-y", "@super-log/mcp"] } } }
```

### Zed
`settings.json` — Zed calls them context servers (native stdio):
```json
{ "context_servers": { "super-log": { "source": "custom", "command": "npx", "args": ["-y", "@super-log/mcp"] } } }
```

### Continue
A YAML file under `.continue/mcpServers/` (agent mode only):
```yaml
name: super-log
command: npx
args: ["-y", "@super-log/mcp"]
type: stdio
```

### LibreChat
`librechat.yaml` — stdio servers must be declared here (not via the admin API);
restart LibreChat after editing:
```yaml
mcpServers:
  super-log:
    type: stdio
    command: npx
    args: ["-y", "@super-log/mcp"]
```

### Gemini CLI
`~/.gemini/settings.json` (or `.gemini/settings.json` per-project):
```json
{ "mcpServers": { "super-log": { "command": "npx", "args": ["-y", "@super-log/mcp"], "env": { "SUPER_LOG_URL": "http://127.0.0.1:7333" } } } }
```
Or one command: `gemini mcp add -e SUPER_LOG_URL=http://127.0.0.1:7333 super-log npx -y @super-log/mcp`.
(Google is folding Gemini CLI into "Antigravity CLI"; the MCP config is
unchanged.)

## From your own agent (SDKs)

**OpenAI Agents SDK** (Python):
```python
from agents.mcp import MCPServerStdio
server = MCPServerStdio(params={"command": "npx", "args": ["-y", "@super-log/mcp"]})
# agent = Agent(..., mcp_servers=[server])
```

**Google ADK** (Python):
```python
from google.adk.tools.mcp_tool import McpToolset, StdioConnectionParams
from mcp import StdioServerParameters
toolset = McpToolset(connection_params=StdioConnectionParams(
    server_params=StdioServerParameters(command="npx", args=["-y", "@super-log/mcp"]), timeout=30))
```

## Ollama and OpenRouter

Neither runs MCP servers themselves — they are model backends. Reach them
through a client that supports **both** an Ollama/OpenRouter backend **and**
local MCP: **LibreChat**, **Continue**, or **Cline** (configured above) all
qualify. Point the client's model at Ollama/OpenRouter and add super-log as the
MCP server.

## Notes

- **Read-only** by construction (the one exception is `agent_report`, which
  writes only to `agent.*` status topics).
- **Environment:** `SUPER_LOG_URL` (hub base URL, default
  `http://127.0.0.1:7333`), `SUPER_LOG_JOURNAL` (journal directory for
  `search_history`, default `./superlog-journal`).
- **`stream_guide`** returns per-topic docs and playbooks so the agent never has
  to guess what a stream means — ask it about any topic (e.g. `power`, `dl`,
  `build`).
