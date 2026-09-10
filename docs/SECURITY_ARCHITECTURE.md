# Security architecture: the MIT tool vs. super-log Cloud

super-log is two artefacts with two threat models, drawn apart on one line:

> **Is it useful to someone with no account with us?** Yes → it is MIT, and it
> stays on your machine. No → it is Cloud, and it is the only thing that leaves.

This document is the MIT tool's security model in full, and the Cloud tool's at
the level of the contract between them. The Cloud client is a separate,
proprietary package whose source is published for audit; its own repository is
the authority on its internals.

---

## The MIT tool (this repository)

The bar is deliberately modest and explicit: **be no less safe than the logs a
developer already has, and never more dangerous.** Normal logs — `/var/log`,
`~/Library/Logs`, `adb logcat`, `journalctl` — are local-only, enforced by the
OS. So is this.

**The hub binds loopback by default.** `superlogd` listens on `127.0.0.1:7333`;
the OS is the authentication, the same OS already guarding your log files. It
says so at startup, and says something louder when it is *not* loopback. There
is no account and no token, on purpose: without TLS a shared secret crosses the
network in plaintext on every request, and the browser viewer's token would ride
in the URL into history and `Referer`. That is a worse leak than the thing it
pretends to fix. (See the README's *Why the hub has no auth*.)

**Nothing leaves the machine unless you send it.** Tailers read local sources —
files, `journalctl`, `ioreg`, `ss` — and whatever *you* reach over your own ssh.
The hub rebroadcasts on a loopback `/ws`. No tailer and no SDK phones home; the
one command named for the cloud, `superlog login`, opens a browser to a
compile-time-constant URL and **makes no network call of its own** — `strings`
the tool and you find a URL it never connects to.

**Egress can be cut at the hub.** `SUPER_LOG_NO_EGRESS` names topics that are
accepted on the bench but never rebroadcast on `/ws`, never held for `/recent`,
and never journaled — a stream that must exist locally and must never leave the
machine, even to another hub. A version inventory (`host.*.versions`) is a CVE
roadmap and a first-class candidate.

**Production is *pulled*, never pushed.** The ssh tailer and the fleet runner
read remote logs onto your bench over ssh; production never reaches the hub and
the hub is never exposed. That asymmetry is the supported way to watch machines
you do not sit at.

**What it is not.** Not an observability suite, not for production, no
authentication, an in-memory ring. Do not point it at production and walk away —
what makes it unfit is the lack of auth and the in-memory ring, not throughput.

---

## super-log Cloud (the separate, proprietary tool)

Cloud is the paid tier: hosted retention, backups, fleet views. Its bench-side
code is **source-published for audit** — a different, stronger promise than MIT
for the one tool that decides what leaves your machine: the person whose machine
it is can read it. What leaves is enumerable, and cuttable.

**Enrolment is a consent, not a credential.** Two entry points, one shape
(after `gh`'s device flow):

- *A machine you are sitting at* arrives from the browser having signed up and
  paid; the page shows a **single-use enrolment code, valid fifteen minutes**
  (`superlog-cloud login --code …`). The string pasted is not a secret — it is a
  one-time claim on a consent already given in the browser, worth nothing in a
  shell history after it is redeemed or expires.
- *A headless machine* (a Pi, a server, a container) runs `superlog-cloud login`,
  which prints a code and a URL to approve on any other device.
- *CI and images* use an org-owned, expiring `SUPERLOG_CLOUD_TOKEN`.

**The bench token never travels in the open.** It comes back on the enrolment
connection, is written `0600` to `~/.superlog/cloud.json`, and is **never
displayed, never passed as an argument, never put on a clipboard.**

**The uplink composes; it does not collect.** `secure-superlogd` subscribes to
the loopback hub's firehose and forwards frames verbatim — it runs no tailers,
reads no producer's files, owns no streams. It is `superlog-bridge`'s posture
pointed at the cloud, and it honours the hub's per-boot `epoch` so a hub restart
resumes cleanly instead of going silently dead.

**The remote posture is pull-data, not push-command.** Following Tailscale, not
ngrok: the cloud distributes *what to observe*; nothing on the cloud side can
execute a command on your machine, self-update it, or restart it. There is no
remote-management channel that runs code.

---

## The boundary, and why it holds

The MIT tool carries **no cloud code at all** — settled, so the free tool stays
pure and auditable on its own terms. The two commands that touch the cloud are
thin doors: `superlog login` opens a page and returns; `superlog billing` says
*free forever* unless a cloud client is installed on `PATH`, in which case it
hands off. The single place the MIT tool even names the cloud binary is that
hand-off, and it is deliberate and commented.

So the complete honest statement is: **the MIT tool never phones home; the only
bytes that leave are the ones the Cloud uplink sends — a tool you install
separately, can read in full, and can cut any topic from at the hub.**
