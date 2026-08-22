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
#   Not wired yet (HANDOFF M4). Two candidate feeds:
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
