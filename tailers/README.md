# Tailers

Host-side scrapers for streams we cannot (or have not yet) instrumented
in-app. Each reshapes an existing feed into PROTOCOL.md events and batch-POSTs
them to superlogd. Zero dependencies, Node ≥ 18.

## The four React Native streams

```sh
# Android emulator                          -> expo.android.emu
node bin/superlog-tail.mjs android

# Android hardware (find serial: adb devices) -> expo.android.device
node bin/superlog-tail.mjs android --serial R5CT30ABCDE

# iOS Simulator (booted)                    -> expo.ios.sim
node bin/superlog-tail.mjs ios-sim --process Expo

# iOS hardware                              -> expo.ios.device
#   Not wired yet. Two candidate feeds:
#   - pymobiledevice3 syslog live  (pip install pymobiledevice3) - works on iOS 17+
#   - idevicesyslog (brew install libimobiledevice)
#   Either pipes line-per-entry text; the adapter follows the logcat pattern.
```

Noise control: `--process` / `--predicate` (iOS) and logcat's own tag filters
are the first line of defence; the viewers filter the rest. For RN work the
interesting Android tags are usually `ReactNativeJS` and `ReactNative`.

## OS logs, from any machine on the bench

The `os` modes put a machine's *own* operating-system logs on the pipeline,
next to the app streams - "what was the OS doing at that moment". The topic
carries the hostname (`os.<host>`), so any number of machines can point at
the one hub and stay distinguishable:

```sh
# This Mac's unified log, scoped to one process     -> os.<host>
node bin/superlog-tail.mjs os --process MyApp

# Another Mac on the LAN, aimed at the bench hub
node bin/superlog-tail.mjs os --url http://<bench-ip>:7333 --process MyApp

# A Linux box: journald                              -> os.<host>
node bin/superlog-tail.mjs os-linux --unit myapp.service --url http://<bench-ip>:7333
```

`os` defaults to `--level default` (not debug) and warns when run with no
`--process`/`--predicate` - the unfiltered unified log is thousands of lines
a second, and while the tailer batches happily, nobody can read it. journald
mode is **written, not verified** (the machines here are Macs) - expect one
round of fixes against real journald output.

For actual syscall traces (`dtruss`, `ktrace`, `strace`) the unified log is
not the feed - those need root and, on macOS, SIP concessions. Process-scoped
OS logs are what rides this pipeline; a syscall tailer would follow the same
adapter pattern if ever needed.

## App logs: postgres, nginx, redis and friends

A catalog ([bin/app-catalog.mjs](bin/app-catalog.mjs)) knows where ~20
common services keep their logs on macOS and Linux, including both Homebrew
prefixes (`/opt/homebrew` on Apple Silicon, `/usr/local` on Intel), so the
processor question answers itself. Ask what this machine has:

```sh
node bin/superlog-tail.mjs apps          # discovery: what exists here, and how to turn it on
node bin/superlog-tail.mjs app postgres nginx redis
SUPER_LOG_APPS="postgres nginx" ./demo/run.sh
```

Each file becomes its own topic - `app.<host>.<name>` (or
`app.<host>.<name>.<file>` when a service writes several, e.g. nginx's
error and access logs) - and the format is picked per file: postgres,
nginx, nginx-access, apache, redis, mongodb (JSON), log4j (kafka /
zookeeper / elasticsearch), rocksdb, or a keyword-heuristic `generic`.

Anything not in the catalog, or at a custom path, is one command away:

```sh
node bin/superlog-tail.mjs file /srv/app/current/log/production.log
node bin/superlog-tail.mjs file /data/rocksdb/LOG --format rocksdb
```

`tail -F` follows by name, so logrotate does not silently end a stream.
The catalog holds *default* paths only - a service told to log elsewhere
needs `file`, and that is fine.

Remote machines work the same way over ssh (see below): `--app postgres`
expands the catalog's paths on that host, `--file <path>` tails one file.

## OS logs over ssh - machines that are not on the LAN at all

`ssh` mode runs FROM the bench and pulls a remote machine's OS logs over
ssh: nothing is installed remotely, the remote never needs to reach the hub
(so the hub stays loopback-bound), and any host in `~/.ssh/config` works
exactly as `ssh <name>` does:

```sh
node bin/superlog-tail.mjs ssh my-server                 # -> os.my-server
node bin/superlog-tail.mjs ssh user@10.0.1.9 --process MyApp
```

The remote OS is auto-detected (`uname -s`, then `cmd /c ver`) and picks the
feed: macOS `log stream` (`--process`/`--predicate`/`--level` apply), Linux
`journalctl -f -o json` (`--unit` applies; the remote user needs journal
access - `systemd-journal` group or root), Windows a polling `Get-WinEvent`
loop shipped as an encoded PowerShell command (`--winlog`, default System;
Security needs admin). Reconnects forever; a host that is down joins when it
comes up. macOS and Linux are verified live; **Windows is written, not
verified** - no Windows machine on this bench yet.

Privacy note, learned by looking: OS logs carry IPs, hostnames and process
behaviour (the first remote host tailed showed live ssh brute-force traffic
on the first connect). Keep the hub loopback-bound when OS streams are
flowing unless the LAN is actually trusted.

## HTTP/HTTPS calls: superlog-net

A logging reverse proxy ([bin/superlog-net.mjs](bin/superlog-net.mjs)).
Point a client at it instead of the real service and every call lands on
the bench as `net.<host>.<target>` - method, path, status, latency, sizes,
content-type, with 4xx/5xx coloured as WARN/ERROR:

```sh
npm run net -- 9000 http://localhost:3000            # debug your own backend
npm run net -- 9443 https://api.internal             # https target, no certs needed
npm run net -- 9000 http://localhost:3000 --bodies --max-body 2048
```

It terminates the plain-http client hop itself and re-dials the target, so
**HTTPS targets need no certificate work at all** - the proxy handles the
TLS. WebSocket upgrades pass through (the handshake is logged, not the
frames). [demo/curl_clock.sh](../demo/curl_clock.sh) is a worked example:
one http and one https call a second, with deliberate 500s and slow calls
so the viewer has something to colour.

Two deliberate limits, both about not building a surveillance tool by
accident. **Bodies are off by default** (`--bodies` opts in, `--max-body`
caps what is kept) and **secrets are always redacted** - `authorization`,
`cookie`, `set-cookie`, `x-api-key` never reach the bench even with bodies
on. And it only ever sees the port you point it at: intercepting arbitrary
outbound HTTPS you do not control would need a MITM CA installed in the
client's trust store, which is a separate, deliberate decision and not
something this tool does for you.

The in-app `@super-log/client` SDK is always the better source (structured
fields, sessions, real levels). A tailer and the SDK publishing to the *same
topic* at the same time will double-report the app's own console lines — run
one or the other per device.

## Shell scripts: superlog-log

Every other producer here needs something installed. [bin/superlog-log](bin/superlog-log)
needs `sh` and `curl`, which is what a deploy script, a cron job or a box
you have just ssh-ed into actually has. POSIX sh, not bash; no node, no
python, no jq.

```sh
superlog-log --topic deploy.web "rolling back to 1.4.2"
tail -f /var/log/nginx/error.log | superlog-log --topic app.web --level WARN
some-build 2>&1 | superlog-log --topic build.ci --app ci --trace "$TRACE_ID"
superlog-log --status            # the first thing to run when nothing arrives
```

With a message it is one event and one POST. With no message it reads
stdin, one event per line, batched ~50 lines or ~1s per POST - and a
`tail -f` that is interrupted still delivers what it was holding, because
the batch buffer lives in the shell where a trap can reach it.

`--level --topic --app --url --trace --tag --field k=v` shape the event;
`--field` repeats. Quoting is awk's job, so a line carrying `"`, `\`, a tab
or an ANSI escape arrives byte-exact instead of corrupting the batch.

It follows the same **DEVELOPMENT xor PRODUCTION** rule as the SDKs and has
no default: declare `SUPERLOG_MODE=development|production` (the repo `.env`
is the usual place), or it refuses to run. Production ships nothing until
`SUPERLOG_PROD_POLICY` names a level, and an inert run says so on stderr
rather than being silently quiet. [demo/shell/clock.sh](../demo/shell/clock.sh)
is the worked example: the demo clock, on `shell.clock`, in 40 lines of sh.

## History: journal, search, replay

The hub remembers minutes. `superlog-journal` remembers as long as the disk
does - it subscribes to the firehose and appends every envelope frame
verbatim, one per line, so nothing is interpreted on the way in and nothing
is lost. The other two tools are what make that worth having:

```sh
npm run journal -- --max-files 40                # write, and never fill the volume
npm run search  -- --since 2h --level ERROR      # read it back
npm run replay  -- --since 03:00 --until 04:00   # put it back on the wire
```

### superlog-search - "what happened at 3am"

Same filters as the hub's `/recent`, over files instead of a ring, printing
the same line the viewers print:

```sh
node bin/superlog-search.mjs --since 2h --level ERROR
node bin/superlog-search.mjs --topic expo. --contains "order 7" --limit 50
node bin/superlog-search.mjs --trace 9f1c0a2b7d4e5f60      # one tap, every stream
node bin/superlog-search.mjs --since 03:00 --until 04:00 --count
node bin/superlog-search.mjs --topic cpp. --json | jq .
```

`--since`/`--until` take `30m`, `2h`, `3d`, `03:00`, `2026-08-22` or a full
ISO stamp. `--topic` is exact or a prefix ending in a dot, `--level` is a
minimum, `--contains` is case-insensitive and reaches the whole event (field
values and all), `--trace` crosses topics on purpose. `--count` gives totals
per topic instead of lines, `--json` gives the raw events one per line, and
`.ndjson.gz` files are read as they are.

**Bounded by default**, because an unfiltered grep over a journal measured in
gigabytes is how a terminal hangs. `--limit` (200) keeps the *newest*
matches, the way `/recent` truncates, and the footer says how many there
really were; `--head` keeps the oldest instead and stops reading early, which
is the escape hatch when the journal is far bigger than the question.
Reading is a line at a time over a stream - a 1.0 GB journal searched here
peaked at 147 MB of RSS - and a line that is not JSON is skipped and counted,
never fatal, so a journal killed mid-write still reads.

One subtlety worth knowing: the time window is on **hub arrival** time,
while the line shows the **producer's** `ts`. On a healthy bench they agree
to the millisecond. When a phone's clock is wrong they do not, and
PROTOCOL.md is clear about which of the two is truth.

### superlog-replay - put it back on the wire

```sh
node bin/superlog-replay.mjs                                  # original pace
node bin/superlog-replay.mjs --speed 0                        # flat out
node bin/superlog-replay.mjs --since 03:00 --until 04:00 --speed 10
node bin/superlog-replay.mjs --topic expo. --prefix replay.   # own topics
```

Payloads are re-POSTed byte for byte, so `seq`, `session`, `ts` and `trace`
all still line up and last night's incident arrives exactly as it happened -
which is the point, and also the hazard: **nothing downstream can tell a
replay from live**. Hence the unmissable banner on stderr, and `--prefix`,
which republishes to `replay.<topic>` when a stream of its own is the honest
answer. Long silences are compressed to 10s by default (`--max-gap`) so an
overnight journal does not replay overnight; the banner says when it does.
`--dry-run` counts without publishing.

Filtering is per **frame**, not per event: splitting a POSTed batch would
mean rewriting it, and a rewritten record is not a replay.

### Retention

`superlog-journal` rotates by size (`--rotate-mb`, 64 by default) and keeps
everything unless told otherwise - losing history nobody asked to lose is
worse than a full folder. `--max-files N` and `--max-days D` prune the
oldest on every rotation (and at startup). Only files this writer created
(`superlog-<stamp>.ndjson[.gz]`) are ever candidates: a retention sweep that
can delete a stranger's file is a bug waiting for someone's data.

Agents get the same history through the MCP server's `search_history` tool -
same filters, capped at 50/200 like the rest of them.

### Scoping the Android tailer

`logcat` is the whole **system** log, not your app's: an OEM handset can push
600+ lines a second, most of it vendor services, and it will bury the app you
came to read. Scope it:

```sh
node bin/superlog-tail.mjs android --app com.example.app   # resolves the pid
node bin/superlog-tail.mjs android --pid 12345             # if you have it
```

Emulator vs hardware is **detected**, not guessed - the serial shape, then
`ro.kernel.qemu` / `ro.build.characteristics` - so a handset pinned with
`ANDROID_SERIAL` (which adb honours, and so does this tailer) lands on
`expo.android.device`, not the emulator topic. `--serial` still wins, and
`origin.device` carries the real model.
