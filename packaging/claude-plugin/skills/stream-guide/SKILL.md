---
description: Explain a super-log topic - what its events, metrics and levels mean, the thresholds, and how to read them. Use when the user asks about a super-log stream or topic (e.g. power, dl, build, os, net, gpu) or how to interpret its logs. Calls the super-log MCP stream_guide tool.
---

# super-log stream guide

The super-log bench documents every stream it carries. When the user asks what
a topic means or how to read it, use the `stream_guide` tool from the super-log
MCP server and relay what it returns: what the topic's events and metrics mean,
why a level escalates, the thresholds, the gotchas, and related topics. The
same tool serves step-by-step playbooks (triage, follow-a-trace, silent-stream).

Topic to look up: $ARGUMENTS

- If a topic is given, call `stream_guide` with it and explain the result in
  plain terms for the user's question.
- If no topic is given, call `list_streams` to show what is live and ask which
  one - or call `stream_guide` with no argument for the overview and the list
  of playbooks.

The hub must be running (`superlogd`, on `http://127.0.0.1:7333` by default; set
`SUPER_LOG_URL` to point elsewhere). If the tools return nothing, check
`hub_status` first - "the hub is down" is different from "the topic logged
nothing".
