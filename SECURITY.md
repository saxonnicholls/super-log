# Security policy

## Reporting a vulnerability

Mail **security@super-log.com**. Include what you found, how to reproduce
it, and what you believe an attacker gains; a proof-of-concept is worth
more than a severity guess. You will get a human acknowledgement within
three days, and after that an honest running status — "still looking" is
a status, silence is not.

**Coordinated disclosure.** We ask for up to 90 days to ship a fix
before you publish; we will almost always need far less, and if we need
more we will say why and negotiate rather than stall. You are free to
publish after the fix ships or the window lapses, whichever comes first.
Credit is given in the changelog and the fix's commit message unless you
ask to stay anonymous.

**Good-faith research is welcome.** Testing against your own bench and
your own data will never draw a legal threat from this project. Do not
test against other people's benches; a hub you can reach is not an
invitation (see scope, below).

**Fixes are public immediately.** A security fix lands in this
repository the same day it lands anywhere else — including any
commercial service built on this code. There is no window in which
paying customers are patched and this repo is not. That is policy, not
best effort.

## Scope: what is a vulnerability here

This project makes deliberate, documented trade-offs, so the line
between "vulnerability" and "design" is written down rather than argued
case by case:

**In scope — we want these reports:**

- Any way log *content* changes the behaviour of any component in this
  repository: content evaluated, expanded, executed, rendered as
  markup, or smuggled into a query, shell, path, or spreadsheet
  formula. This is the attack class the project exists to exclude
  (README, "Security posture"), and a break in it is the
  highest-severity report we can receive.
- The hub reachable beyond loopback without `SUPER_LOG_LAN=1` or an
  explicit `SUPER_LOG_BIND` — the code contradicting its documented
  posture.
- A production-mode SDK that forwards events anywhere.
- Credential redaction failing: a tailer or proxy that lets an
  `Authorization` header, token-shaped query value, or provider key
  reach the hub.
- Memory-safety defects in the hub or C/C++ SDKs reachable from
  ingested bytes.
- The tolerant reader becoming intolerant: input that crashes, wedges,
  or unboundedly grows any component.

**Out of scope — documented design, not defects:**

- "The hub has no authentication or TLS." Correct, deliberate, and
  argued at length in the README ("Why there is no login"). The hub
  binds loopback by default; the OS is the authentication.
- "Anyone who can reach an opened port can read and publish." That is
  what `SUPER_LOG_LAN=1` means, and the hub says so loudly at startup.
- Reports requiring an attacker who already owns the bench user's
  account — they already have the logs, and everything else.

If you are unsure which side of the line something falls on, report it
anyway; the worst outcome is a polite explanation.

## Verifying releases

Release artifacts ship with checksums and build provenance; see
`.github/workflows/release.yml`. Until signed releases are live, build
from source — the README's clone-and-build path is the supported
distribution.
