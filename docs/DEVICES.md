# Putting a device on the bench

A phone, a container, another host on your LAN — anything that can make an HTTP
POST can log to super-log. This is the canonical guide to the device path: how
a device reaches the hub, the one trap that makes device logging silently
never work, and how to tell in seconds which of three things is wrong.

App-specific device setup (a particular React Native app's env var, a build's
own steps, its device ids) lives in that app's own docs and **references this
page** for the general path — the diagnostic sequence here is the source of
truth.

## The short version

An SDK on the device POSTs NDJSON to `POST http://<hub>:7333/ingest/<topic>`,
exactly like a local producer. The only question a device adds is **what
`<hub>` is** — the address that reaches your dev machine from where the code
runs.

| From                  | `<hub>` host |
|-----------------------|--------------|
| iOS Simulator         | `localhost` (shares the Mac's loopback) |
| Android emulator      | `10.0.2.2` (the emulator's alias for the host), or `localhost` after `adb reverse tcp:7333 tcp:7333` |
| Android hardware      | `localhost` after `adb reverse tcp:7333 tcp:7333` over USB; otherwise the Mac's **LAN IP** |
| iOS hardware          | the Mac's **LAN IP** (same Wi-Fi) |
| A container           | `host.docker.internal`, or the host's LAN IP |
| Another host          | the dev machine's **LAN IP** |

The rows that say **LAN IP** are the ones that bite. Read on.

## The loopback trap — why device logging "never worked"

`superlogd` binds `127.0.0.1` by default. That is the right default (see
Security, below), but it means a device POSTing to your Mac's **LAN address**
reaches a socket that **is not listening there**. And the failure is silent at
both ends, by construction:

- **The device can't see it.** A shipped SDK's producer queues on a bounded
  queue and drops when the hub doesn't answer — correct behaviour for a
  release build, which must never block your app or grow memory without limit.
  So the app runs fine and says nothing.
- **The hub can't see it.** It cannot report a connection it never received.
  So the hub is healthy, the viewer is open, other streams flow — and the
  device shows "never reported", forever, with nothing logged anywhere.

Both ends read as healthy while nothing arrives. This is the single most
common reason handset logging appears to have never worked.

## The fix — bind the LAN, and make it stick

On a network you trust, start the hub bound to the LAN:

```sh
SUPER_LOG_LAN=1 superlogd            # bind 0.0.0.0 (all interfaces)
# or, explicitly:
SUPER_LOG_BIND=0.0.0.0 superlogd
```

The hub says which interface it bound to on its first line — if it says
`loopback only`, a device on the LAN cannot reach it, and it tells you so.

**For a persisted bench, put it in the login service, not your shell.** A
one-off `export SUPER_LOG_LAN=1` before starting the hub does not survive a
relaunch: the launchd agent (macOS) and systemd unit (Linux) relaunch the hub
with *their own* environment, so a `KeepAlive`/`Restart` respawn comes back
bound to loopback and your fix "didn't take". Bake it into the service:

```sh
./scripts/install.sh --persist --lan   # LAN binding lives in the login service
```

This is why a persisted loopback hub cannot be repaired by re-running the
normal start command — the singleton check correctly declines to start a
second hub, and the running one keeps its loopback binding. `--persist --lan`
writes `SUPER_LOG_LAN=1` into the plist/unit itself, so every relaunch keeps
it.

## Diagnosing: three checks, in order

When a device won't log, rule the innocent causes out **in this order** before
blaming the SDK. (An agent on the bench can walk this via the MCP
`nothing-is-arriving` playbook.)

**1. Is the topic cut from egress?** If the hub runs with
`SUPER_LOG_NO_EGRESS` naming this topic, the hub is *accepting and dropping* it
on purpose — it will never appear on `/ws` or `/recent`, and that is policy,
not a bug. See [PROTOCOL.md](PROTOCOL.md#egress-policy--super_log_no_egress).

**2. Is the hub bound to the LAN?** This is the loopback trap above. Two
traps make this hard to see, and one check that cannot lie:

- **`ping` is not a valid check.** ICMP to the host succeeds regardless of
  what any TCP socket is bound to — a successful ping tells you nothing about
  whether port 7333 is reachable, and gives a false green.
- **On Android, shell probes mislead.** `toybox` (the default toolbox) has
  neither `nc` nor `wget`, so `nc`/`wget` return "Unknown command" — which
  reads like a connection failure and sends you down the wrong path.
- **The check that cannot lie is the bind address itself:**

  ```sh
  lsof -nP -iTCP:7333 -sTCP:LISTEN    # want *:7333, NOT 127.0.0.1:7333
  ```

  The other reliable one is opening `http://<lan-ip>:7333/healthz` **in the
  device's own browser**. If it renders the JSON, the network path is proven
  and the problem is elsewhere (step 3).

**3. Only now, is it the producer?** With egress and binding ruled out, a
stream that never arrives means the producer is down or never logged. Trigger
the action and `wait_for` a matching event; if it times out, the SDK on the
device isn't sending. Check the SDK's configured hub URL matches the LAN IP
the hub actually bound to — the two are set in different places and nothing
joins them for you.

## Security — why loopback is the default

There is no auth and no TLS: anyone who can reach the port can read every
stream and publish to any topic. So **binding is not the security boundary —
the trusted-LAN assumption is.** Loopback is the default precisely so that
exposure is a deliberate choice, not a surprise sprung by running an install
script. `SUPER_LOG_LAN=1` (or `--persist --lan`) is you making that choice,
on a network you trust. On an untrusted network, keep it loopback and reach
the hub over the ssh tunnel the tailers already use, or `adb reverse` over USB
for an Android handset — neither opens a port to the LAN. See the Security
posture section of the [README](../README.md#security-posture).
