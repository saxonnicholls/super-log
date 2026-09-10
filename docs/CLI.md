# The `superlog` CLI

One command, a verb, a thing: `superlog <command> [args]`. It reads the bench,
manages the tailers, pipes a stream onto the hub, and opens the cloud door.

Run `superlog help` for the same, in the terminal. Every tailer also still runs
directly as `npm run <name>` from the repo — this is the friendlier front door
to the same files.

## Read the bench

These answer *what does the bench look like right now* — the latest state per
key, the way the viewer panels do. On a terminal they print a readable line
each; **piped (or with `--json`) they emit NDJSON, one event per line, so `| jq`
just works.**

| Command | Shows |
|---------|-------|
| `superlog status [tailer]` | what tailers are running, and the hub's health |
| `superlog alarms`      | firing and recovered alarms |
| `superlog servers`     | every machine that has spoken |
| `superlog versions`    | the version inventory, per host |
| `superlog prs`         | pull requests being watched |
| `superlog rpc`         | RPC node health, per provider |
| `superlog topology`    | the network as a tree, per host |
| `superlog connections` | outbound connections, per host |
| `superlog ports`       | listening sockets, per host |
| `superlog webhooks`    | webhook deliveries |
| `superlog agents`      | agents on the bench |
| `superlog devices`     | USB device trees, per host |
| `superlog gpu`         | GPU metrics, per card |

```console
$ superlog alarms | jq -r 'select(.level=="ERROR") | .msg'
$ superlog servers | jq -r '.topic'
```

## Manage tailers

A started tailer runs in the background with its pid and log tracked under
`~/.superlog`, so `stop`, `restart`, `status` and `logs` have something real to
act on.

| Command | Does |
|---------|------|
| `superlog start <tailer> [opts]` | start a tailer in the background |
| `superlog stop <tailer>`         | stop it |
| `superlog restart <tailer>`      | stop, then start with the same options |
| `superlog enable <tailer> [opts]`| **always**: keep it alive across crashes *and* reboots |
| `superlog disable <tailer>`      | turn that off |
| `superlog status [tailer]`       | what is running (every `superlog-*` process, however started), and the hub's health |
| `superlog logs <tailer>`         | follow a running tailer's log (`tail -f`) |
| `superlog list`                  | every tailer there is, with a one-line description |

`enable` is the persistent counterpart to `start`: it installs a keep-alive
service the platform's own manager supervises — a **launchd** agent
(`~/Library/LaunchAgents/com.super-log.<tailer>.plist`, `KeepAlive`) on macOS, a
**systemd** `--user` unit (`Restart=always`) on Linux — so the tailer restarts on
crash and comes back at login. On Linux, `loginctl enable-linger` makes it
survive logout/reboot without a session. `disable` stops and removes it.

```console
$ superlog enable versions --ssh web1     # keep this one alive, forever
$ superlog disable versions
```

```console
$ superlog start vitals
started vitals (pid 41290)  logs: superlog logs vitals
$ superlog start versions --ssh web1     # options pass straight through
$ superlog status
$ superlog stop vitals
```

## Streams and cloud

| Command | Does |
|---------|------|
| `<command> \| superlog tee [opts] [FILE...]` | tee(1) with the hub as an extra output |
| `superlog login`   | open super-log Cloud in your browser (no network call of its own) |
| `superlog billing` | your plan — **free forever** unless you are on Cloud |

```console
$ make 2>&1 | superlog tee --topic build.local
$ ./deploy.sh 2>&1 | superlog tee --topic deploy --classify out.log
```

`tee` options: `--topic NAME` (default `tee.<host>`), `--level LEVEL` (default
`INFO`), `--classify` (read the level from each line), `--app NAME`, `--trace
ID`, `-a`/`--append`, `--quiet`, and any `FILE...` to also write to, exactly as
`tee`.

## Meta

| Command | Does |
|---------|------|
| `superlog help`, `--help`, `-h` | the command list |
| `superlog --version`            | the version |

## Notes

- **The hub URL** is `http://127.0.0.1:7333` by default; set `SUPER_LOG_URL` to
  point the read commands and `status` elsewhere.
- **State** lives under `~/.superlog/`: `run/<name>.json` (pid + args) and
  `log/<name>.log` (a started tailer's output).
- A bare word that names a **panel** reads the bench (`superlog alarms`); a bare
  word that names a **tailer** asks you to `superlog start` it, so the two never
  collide.
