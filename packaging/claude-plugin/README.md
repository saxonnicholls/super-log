# super-log — Claude Code plugin

Reads your local [super-log](https://github.com/saxonnicholls/super-log) bench
from Claude. Installing it wires up the super-log **MCP server** (read-only log
tools) and a **`/super-log:stream-guide`** skill that explains what any topic
means.

## Install

```
/plugin marketplace add saxonnicholls/super-log
/plugin install super-log@super-log
```

## What you get

**Tools** (from the `@super-log/mcp` server, fetched via `npx` on first use):

| Tool | For |
| --- | --- |
| `hub_status` | Is the hub up, and what is live |
| `list_streams` | Which topics are live, their level mix and errors |
| `tail_logs` | Recent events by topic/level/text, with a cursor |
| `search_logs` | Find recent events by text |
| `search_history` | The on-disk journal — hours or days |
| `wait_for` | Block until a matching event arrives |
| `list_webhooks` | Alarm-gateway routes with public URLs and health |
| `agent_report` | Post your agent status to the agents blotter |
| `stream_guide` | Per-topic docs and playbooks, on demand |

**Skill:** `/super-log:stream-guide <topic>` — e.g. `/super-log:stream-guide power`.

## Requirements

- A running hub: `superlogd` on `http://127.0.0.1:7333` by default. Set
  `SUPER_LOG_URL` in the server's environment to point elsewhere.
- Node ≥ 18 (for `npx -y @super-log/mcp`).

Read-only by construction (the one exception is `agent_report`, which writes
only to `agent.*` status topics). Full per-client setup for other assistants is
in [docs/CONNECT.md](https://github.com/saxonnicholls/super-log/blob/main/docs/CONNECT.md).
