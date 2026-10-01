# super-log with Xcode

Xcode does not let a third-party plugin add a docked panel or webview the way VS
Code (webviews) and JetBrains IDEs (tool windows) do — Source Editor Extensions
only manipulate source text, and Swift Package plugins run in the build cycle.
So super-log meets Xcode three honest ways: the **agent** reads the bench over
**MCP**, the **build stream** lands on the bench with one pipe, and the **viewer
runs beside** Xcode (it can't live inside it).

## 1. MCP — give Xcode's AI agent the bench (recommended, Xcode 26+)

super-log ships an MCP server, so Xcode's Intelligence/agent can query the whole
bench — `hub_status`, `list_streams`, `tail_logs`, `search_logs`, `stream_guide`,
`search_history` — with no new code.

Add it in **Xcode → Settings → Intelligence** (the coding-assistant / MCP
section), as a local stdio server:

- **Command:** `npx`
- **Arguments:** `-y @super-log/mcp`

(The same server the other editors use; it defaults to the local hub at
`http://127.0.0.1:7333`, override with `SUPER_LOG_URL`.) Once added, ask the
agent things like *"what's erroring on the bench right now?"* or *"tail
`build.*` at WARN"* and it reads super-log directly.

The exact Settings path moves between Xcode releases; if your Xcode exposes MCP
as a config file rather than a UI, the server entry is the same shape as the
starter configs in the repo root (`.cursor/mcp.json`, `.vscode/mcp.json`):
`{ "command": "npx", "args": ["-y", "@super-log/mcp"] }`.

## 2. Build output on the bench (no plugin needed)

**From the command line** — wrap `xcodebuild` (its output, stdin and exit status
pass straight through, like `superlog-build` does for other compilers):

```sh
xcodebuild -scheme MyApp build 2>&1 | superlog tee --topic xcode.build --classify
# or run it under the build watcher, which levels diagnostics by file:line and
# captures sanitizer / crash reports whole:
superlog-build --label xcode -- xcodebuild -scheme MyApp build
```

**Inside Xcode** — add a **Run Script build phase** (Target → Build Phases → +):

```sh
# Tee this build's log to the super-log bench.
exec > >(tee >(/usr/bin/env superlog tee --topic "xcode.build.${TARGET_NAME:-app}" --classify)) 2>&1
```

Or package it as a **Swift Package command plugin** (`swift package superlog-build`)
so a single command builds and lands on the bench — a follow-up if you want the
one-command flow.

## 3. The viewer — beside Xcode, not inside it

Xcode has no API to host super-log's viewer in a panel, so run it alongside:

- `superlog viewer` — the native window (all the boards, the AI panel, Cloud
  sign-in), or
- the browser viewer at the hub.

Put it on a second monitor or Split View next to Xcode; it updates live from the
same hub Xcode's builds are feeding.

## Not this

The legacy unsandboxed `.xcplugin` route (loading a bundle into the Xcode
process) is **out** — Apple removed the loading path, it breaks on every Xcode
update, and it is exactly the kind of un-sandboxed hook this project avoids. MCP
+ the build pipe give you the useful 90% within Apple's supported surface.
