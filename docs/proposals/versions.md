# Proposal: superlog-versions — the stack's versions, logged, and their changes

**Status:** SCOPED & APPROVED for a v1 build (decisions settled 2026-09-09,
[§9](#9-decisions-settled-2026-09-09)); not yet built.
**Date:** 2026-09-09.
**Scope:** an OSS / MIT bench tailer. The *advice* layer is explicitly a
commercial concern — see [§4](#4-the-osscommercial-split-the-point-of-this-doc).

The ask: log the versions of everything under a dev bench — OS, compilers and
toolchains, libraries, databases, and hardware/firmware — so that the one
question behind half of "it worked yesterday" has an answer on the bench:
**what changed.**

---

## 1. Why versions are a *log*, not a static readout

A version list looks static, which is exactly why nobody watches it — and why a
silent bump costs a day. `gcc` went 13.1→13.2 on a routine update and the build
started miscompiling; `postgres` went 15→16 and a query plan changed; the
kernel updated and a driver stopped loading; `node` 18 aged out. None of those
announced themselves.

The version that hides best is the one on the **hardware**. A five-person team
once burned **three days** — fifteen person-days — on an **FPGA** toolchain /
bitstream mismatch: the board was running a bitstream the current toolchain no
longer produced, the two versions disagreed silently, and nothing on the bench
said so. A single "the deployed bitstream (`v2.3.1`) predates this toolchain
(`v2.4`)" line would have ended it in a minute. That class of failure — where
the *installed* version and the *deployed* version drift apart unseen — is the
one this earns its keep on.

So this is a **snapshot-and-diff** tailer, the same shape
as `netstate`/`dns`/`ports`: a silent baseline, then **a version CHANGE is the
event.** "gcc 13.1 → 13.2", "postgres 15.4 → 16.1", "kernel updated", "openssl
gone" — edge-triggered, and each one is a lead for whatever broke right after.

## 2. What it captures

Grouped, because the privilege and the value differ by group.

- **OS** — kernel/build, distro + release. `uname`, `/etc/os-release`, macOS
  `sw_vers`, Windows `ver`/`systeminfo`. *No privilege.*
- **Toolchains / compilers** — `gcc`, `clang`, `rustc`, `go`, `node`, `python`,
  `java`/`javac`, `swift`, `dotnet`, `cmake`, `git`, `docker`, `kubectl`, and
  **FPGA/HDL toolchains** (Vivado, Quartus, Vitis, Lattice Radiant,
  yosys/nextpnr) — the `--version` of whatever is installed. *No privilege.*
  The **version manager** matters as much as the tool: `node` and `python` are
  the worst offenders because nvm/pyenv/asdf and virtualenvs make the *active*
  version per-shell and invisible — which is precisely why a poll (not a
  package-manager hook) is the right mechanism, and why they are the v1 start.
- **Deployed / device versions** — the version actually **running on the
  hardware**, not merely installed: an FPGA's loaded **bitstream**, a device's
  **firmware**, a version register read over JTAG or a vendor tool. This is
  config-driven — the user supplies the probe command per device and the tailer
  runs it and diffs the result — because there is no universal way to ask a
  board "what are you running". It is the hardest capture and the highest value:
  the *installed-vs-deployed* drift is the FPGA failure in §1, and it generalises
  to any embedded target with a version register.
- **Databases** — `postgres`/`psql`, `mysql`, `redis`, `sqlite`, `mongod`:
  server version via `--version` or `SELECT version()`. *No privilege (a
  `SELECT version()` needs a connection, not root).*
- **Key libraries** — system libs that decide compatibility: glibc/libc,
  openssl, and (v2) the **dependency graph from lockfiles** —
  `package-lock.json`, `Cargo.lock`, `poetry.lock`/`requirements.txt`, `go.sum`.
  Lockfiles are the fine-grained "library versions", and the richest input to
  the commercial CVE layer — but they are per-project and large, so v1 does the
  toolchain and v2 does the lockfiles.
- **Hardware / firmware** — CPU model + microcode, RAM, GPU model + driver,
  disk model, and **BIOS/UEFI version**. macOS `system_profiler`/`sysctl`;
  Linux `lscpu`/`lshw`/`/sys`; the BIOS/microcode part needs `dmidecode`
  (root) — so hardware splits into an unprivileged tier (model/driver) and a
  privileged one (BIOS/microcode), on the `superlog-power` sudo model.

## 3. The bench discipline

- **Baseline is silent; changes speak.** `--once` prints the full inventory
  (INFO); the running tailer publishes only diffs after the first poll.
- **Cadence is slow** — versions change on the timescale of package updates,
  not seconds. Default poll every few minutes (or on demand); a version check is
  cheap but not free (it spawns a `--version` per tool).
- **Edges:** a version **changed** → INFO, a **major** bump → WARN (majors break
  things), a tool that **disappeared** → WARN ("gcc is gone"), a **new** tool →
  INFO. A missing tool is a fact, reported once, never re-nagged.
- **Readings:** the inventory itself rides `fields.versions` (or a tree) so a
  viewer window can show the whole stack at a glance and diff two hosts.

## 4. The OSS/commercial split (the point of this doc)

This is where the free and paid lines are unusually clean, and it is what the
commercial agent should build on:

- **OSS (this tailer) — DETECT · LOG · DIFF.** It ships the *facts*: "here are
  your versions, across every host on the bench, and here is the moment any of
  them changed." That alone is valuable — a version diff between a working and a
  broken box, or a timeline of "what updated right before it broke", with no
  advice attached.
- **COMMERCIAL (the AI advisor) — REASON over the facts.** Everything that needs
  a *knowledge base* is the paid layer:
  - **EOL**: "node 18 is end-of-life in N weeks", "CentOS 7 is dead".
  - **CVEs**: "your openssl is affected by CVE-…", matched against the logged
    versions (and, with the v2 lockfiles, the whole dependency graph).
  - **Known-bad combinations**: "this gcc + glibc miscompiles", "this CUDA +
    driver is unsupported", "postgres 16 changed this default".
  - **Drift**: "prod and dev differ by a postgres MINOR — that is very likely
    your bug", across the fleet.
  - **Upgrade advice**: what to bump, in what order, and what it will break.

  The seam sells itself: the free tier tells you *what you have and when it
  changed*; the paid tier tells you *what is wrong with it and what to do* — an
  advisor, not a crippled logger. It maps cleanly onto the commercial "Cloud"
  retention story (keep the version timeline; reason over it).

## 5. Topic convention & the wire contract

Fits the `host.<name>.*` namespace ([PROTOCOL.md](../PROTOCOL.md), beside
`host.<name>.vitals`):

| Topic | Carries |
|---|---|
| `host.<name>.versions` | the per-host inventory (one topic, a `category` field — not five topics) and the change events |
| `deps.<repo>.<name>` (v2) | the **lockfile dependency graph, keyed by REPO not host** — the same repo on three machines is one graph, and one machine holds twenty repos, so per-host is the wrong shape |

**The version-fact shape (settled with the commercial consumer, so the advisor
can be built against v1 without a later wire change).** Each fact carries:

- `category` — `os` | `toolchain` | `runtime` | `library` | `database` |
  `hardware` | `firmware` | `deployed`.
- `tool` — the thing (`clang`, `openssl`, `postgres`).
- `raw` — the version string **verbatim**, always.
- `version` — a normalized, **orderable** form (CVE ranges are inclusive/
  exclusive comparisons); when normalization fails, **omit it and set
  `unorderable: true`** — never a lossy guess (a version that can't be ordered
  is one the advisor must refuse to judge, and it needs to know that).
- `purl` — a package-URL where one is **honestly constructible**
  (`pkg:deb/ubuntu/openssl@3.0.13`, `pkg:pypi/requests@2.31.0`,
  `pkg:generic/clang@17.0.6`), **omitted where not** — an absent purl is fine, a
  guessed one is poison. It is what CVE feeds key on, so it is the single
  highest-value field.
- `provenance` — how it was obtained: `--version` | `pkgmgr:<apt|brew|dnf>` |
  `header` | `elf` | `dylib` | `probe`. **"Compiled against" and "installed" are
  different facts and incidents live in that gap** (Saxon's own spdlog/fmt case).
- `scope` — `system` | `user` | `project` | `container`; without it, a project
  pinning its own toolchain reads as drift that is not drift.
- `state` — `present` | `absent`. **Absence is explicit, never omitted or
  implied as zero** — "no clang" and "old clang" lead to opposite advice.

On a **change** event, carry **both `before` and `after`** — the transition is
what an incident correlates against; the advisor must not have to reconstruct it
from two snapshots.

**Refinements settled with the consumer (super-log-62), now built:** each fact
also carries `scheme` (`semver` | `pep440` | `calver` | `opaque`) so the advisor
uses the matching comparator, not a guess; the binary's install `mtime` (the
"what changed right before it broke" signal, free because it's computed anyway);
and the fact's identity is **(host, tool, scope, path)** — path in the key so a
system tool and a brewed one are two facts, not one that flickers. The full
inventory is **republished every poll** as a DEBUG reading carrying `versions`
(distinguishable from a change, which carries `change`), so an advisor joining
late has current state without waiting for a bump. **Absence is a positive
fact**: `state: absent` means in-the-watched-set-and-not-installed; a tool
*missing from the array* means not-checked (unknown) — the two lead to opposite
advice and must never be collapsed. When both a compiled-against and an installed
version are discoverable, **two facts are emitted** (same tool, different
`provenance`), never one — the incident lives in that gap.

## 6. Config — what to watch

Auto-detect the common set (the toolchains/DBs/OS/hardware above), plus a
project config for the bespoke ("watch our vendored `ffmpeg`, our house
`protoc`") — the pattern the other tailers already use (`rpc.json`,
`fleet.json`, …). `--ssh` to inventory a remote box with nothing installed
(the `gpu`/`ports` pattern), which is exactly how you diff dev against prod.

## 7. Cross-platform & the zero-dependency line

Like `superlog-gpu` needs `nvidia-smi`, this shells out to each tool's
`--version` and to OS/hardware commands — detect, then degrade honestly when a
tool is absent (one line, never a crash). Version strings are gloriously
inconsistent, so the parser is tolerant: capture the first version-shaped token
and keep the raw line too. macOS/Linux first-class; Windows best-effort
(`ver`, `systeminfo`, `--version` still works under Node).

## 8. Security (version disclosure)

A precise version list is a gift to an attacker (it names your exploitable
CVEs), so `host.<name>.versions` is a first-class candidate for the egress cut —
`SUPER_LOG_NO_EGRESS=host.*.versions` keeps it on the machine, and the docs will
say so for anything but a trusted bench.

**Egress, settled with the commercial consumer:** the cut is **absolute** — a
cut topic is served to nothing on `/ws` and `/recent`, honoured without
exception. The commercial upload is therefore an upload-side opt-in **filter
inside the cloud shipper** — one audited transport that simply does not forward
the versions family unless separately consented — **not** a second channel that
reads around the cut. Two independent consents (don't cut the topic; enrol the
upload), neither inheriting nor defeating the other. So the same data the CVE
layer reasons over never broadcasts, and the enterprise-reviewer answer is one
clean sentence: same audited path as everything else, only if you turn it on.

## 9. Decisions (settled 2026-09-09)

1. **Lockfiles are v2, not v1.** The toolchain/OS/DB/hardware set is small,
   stable and universal — a clean, immediately-useful v1. Lockfiles are
   per-project, huge and format-varied, and a raw list of thousands of deps is
   noise without the CVE layer — so they land in **v2, alongside the commercial
   advisor** that makes them useful.
2. **Hardware privilege is split.** Ship the **unprivileged tier** (CPU/GPU/RAM/
   disk models, driver versions, OS, toolchains, DBs) — ~90% of the value, no
   root. **BIOS/UEFI/microcode** is an **opt-in privileged add** (`--firmware`,
   `dmidecode`/root), on the `superlog-power` model. The tailer never gates on
   root.
3. **Slow poll (default ~5 min) + an on-demand poke; no package-manager hooks.**
   A poll catches every change however it happened — manual installs and
   especially per-shell version managers (nvm/rbenv/asdf), which apt/brew/dnf
   hooks miss. It is simple, cross-platform, and cheap (the diff is empty almost
   every time). A refresh poke (the USB tailer's pattern) forces a re-check after
   an install, and a tool's `--version` is only re-run when its binary path/mtime
   changed.
4. **The OSS tailer ships ZERO EOL/CVE/known-bad knowledge.** That knowledge is
   the commercial agent's, for three reasons: it is the free/paid seam; a CVE/EOL
   feed is a perpetual maintenance burden the MIT repo must not carry; and a
   *stale* feed is worse than none — "you're safe" from month-old data is the
   "absence rendered as fact" sin. Facts never go stale; advice does.

   **Refinement — detection is OSS, interpretation is commercial.** The tailer
   does everything that needs **no knowledge base**, which includes **cross-host
   drift DETECTION** ("dev and prod differ on a postgres minor" is a pure
   comparison — a fact, a fair WARN). What it must not do is **interpret** —
   which version is right, what the CVE is, what breaks. Detection ships free;
   interpretation is the paid layer.

## 10. Recommendation

Ship the OSS tailer in two steps: **v1** the toolchain/OS/DB/hardware inventory
with change-diffing and a viewer window (no advice, no knowledge base — pure
facts), then **v2** the lockfile dependency graph. Hand the **advice layer**
(EOL/CVE/known-bad/drift) to the commercial agent as a service that consumes
`host.<name>.versions` — it needs a maintained knowledge base, which is exactly
what a paid tier is for, and exactly the value-add you described.

When built, the OSS tailer follows the full capability checklist (README ×3, an
MCP `guide.json` entry stating it is facts-not-advice and egress-sensitive, a
PROTOCOL.md topic row, a CHANGELOG entry marking VERIFIED-vs-written, and
subprocess tests against a real hub with the `--version` tools mocked the way
`tests/gpu.test.mjs` mocks `nvidia-smi`).

---

*Prior art reused: the `netstate`/`dns`/`ports` silent-baseline-then-diff
discipline; the `gpu`/`ports` "detect the tool, degrade honestly" and `--ssh`
remote patterns; the `superlog-power` privileged-add model for BIOS/microcode;
and the egress cut (`SUPER_LOG_NO_EGRESS`) as the recommended control for a
version topic.*
