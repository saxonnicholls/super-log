# Installing super-log

Every route to a working bench: the superlogd hub, the 40+ tailers, and the
viewers. Pick one. If you are not sure, use the universal installer.

## The universal installer (recommended)

```sh
curl -fsSL https://super-log.com/install.sh | sh
```

Detects your OS and CPU architecture, downloads the matching prebuilt
artefact from the latest [GitHub release][releases], **verifies its
checksum against the release's `SHA256SUMS` before running anything**, asks
for `sudo` only to actually install, and prints what to do next. This is
the "no toolchain, no Homebrew, just give me a working bench" route — it
covers macOS, Debian/Ubuntu and Fedora/RHEL family.

A pipe-to-shell installer that does not verify what it downloaded is
malware waiting to happen, so the checksum check is not optional: if a
release has no `SHA256SUMS` asset, or the download does not match it, the
script refuses to install anything and says exactly why.

Remove what it installed: `curl -fsSL https://super-log.com/install.sh | sh -s -- --uninstall`

This same file, `scripts/install.sh`, does something else entirely when run
*from inside a clone* — see [Building from source](#building-from-source)
below. It tells the two cases apart by whether it is actually sitting in a
real super-log checkout, not by a flag, because the curl-piped case has
nothing to pass a flag from.

## macOS — the universal `.pkg`

One file, both architectures — Intel and Apple Silicon in a single binary
(`lipo`'d together), so there is one download button, not two.

```sh
curl -fsSL -O https://github.com/saxonnicholls/super-log/releases/latest/download/super-log-<version>-universal.pkg
sudo installer -pkg super-log-<version>-universal.pkg -target /
```

Or download it from the [releases page][releases] and double-click it.

**Why this exists, specifically:** [Homebrew 7.0.0 (2026-09-13)][hb7] moved
macOS Intel to Tier 3 — no routine bottle builds — so `brew install` on an
Intel Mac now compiles from source or fails outright. This `.pkg` does not
depend on Homebrew's tier ladder at all.

**Signing status:** until a Developer ID certificate exists (tracked in the
commercial repo's signing notes), this `.pkg` is built **unsigned**.
**Gatekeeper refuses an unsigned `.pkg` on any machine that downloaded it** —
`sudo installer` on the machine that *built* it works (nothing to
quarantine locally), but a browser download elsewhere will be blocked with
no useful dialog. Don't link this from the website as the macOS button
until that changes; `scripts/make_macos_pkg.sh` prints this same warning,
loudly, every time it builds one unsigned.

What it installs: `superlogd` (the hub) at `/usr/local/superlog/bin`, every
tailer as a `/usr/local/bin/superlog-*` command, the C/C++ SDK headers, and
a bundled Node runtime for whichever architecture ends up running (used only
if no system `node` is found — a system `node` always wins). Building it
yourself: `scripts/make_macos_pkg.sh` (reads this file's own header for what
it verifies and how).

## Debian / Ubuntu / Raspberry Pi OS — `.deb`

```sh
curl -fsSL -O https://github.com/saxonnicholls/super-log/releases/latest/download/super-log_<version>_<arch>.deb   # arch: amd64 or arm64
sudo apt install -y ./super-log_<version>_<arch>.deb
```

Installs the hub, the SDK headers, every tailer as a PATH command, and a
systemd unit for `superlogd` (enabled and started by `postinst`). Ubuntu
users on a PPA-tracked system may prefer:

```sh
sudo add-apt-repository ppa:super-log/stable && sudo apt update && sudo apt install super-log
```

Building it yourself: `scripts/make_linux_packages.sh deb` (wraps
`packaging/deb/build-deb.sh`, which runs inside an Ubuntu container —
`dpkg-deb` is Linux-only).

## Fedora / RHEL / Rocky / Alma / openSUSE — `.rpm`

```sh
curl -fsSL -O https://github.com/saxonnicholls/super-log/releases/latest/download/super-log-<version>-1.<dist>.<arch>.rpm   # arch: x86_64 or aarch64
sudo dnf install -y ./super-log-<version>-1.<dist>.<arch>.rpm
```

`<dist>` is the Fedora release tag the release workflow built against (e.g.
`fc41`) — check the [releases page][releases] for the exact filename rather
than guessing it. Same payload as the `.deb`: hub, headers, tailers,
systemd unit.

Building it yourself: `scripts/make_linux_packages.sh rpm` (wraps
`packaging/rpm/build-rpm.sh` inside a Fedora container — `rpmbuild` is a
Red Hat tool). This is also where the **arm64 (`aarch64`) `.rpm`** comes
from — it did not exist before this installer work; only `x86_64` had ever
been built.

## Homebrew (macOS/Linux, from source)

```sh
brew install saxonnicholls/tap/super-log && brew services start super-log
```

**Intel Mac caveat:** since [Homebrew 7.0.0][hb7] (2026-09-13) demoted
macOS Intel to Tier 3, there is no routine bottle for this formula on
Intel — `brew install` compiles the hub from source there (needs Xcode
command line tools; takes a few minutes) or may fail if the toolchain is
missing entirely. Apple Silicon is unaffected. **If you're on an Intel Mac
and want to skip the compile, use the [universal `.pkg`](#macos--the-universal-pkg)
instead** — it ships prebuilt for both architectures in one file.
Read: [brew.sh/2026/09/13/homebrew-7.0.0/][hb7].

## Building from source

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/saxonnicholls/super-log
cd super-log
./scripts/install.sh             # preflight, build, verify every SDK delivers to a real hub
./scripts/install.sh --persist   # ...and start the hub + default tailers at login, forever
```

This is the same `scripts/install.sh` as the [universal installer](#the-universal-installer-recommended)
above — run from inside the clone it just made, it builds from source
instead of fetching a prebuilt artefact. See the script's own header for
every flag (`--no-viewer`, `--vscode`, `--lan`, `--uninstall`).

## Verifying what you downloaded, by hand

Every release asset is covered by one `SHA256SUMS` file:

```sh
curl -fsSL -O https://github.com/saxonnicholls/super-log/releases/latest/download/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS; use sha256sum -c on Linux
```

## Release asset names

These are stable — do not rename one without updating every download
button that links to it.

| File | Built by |
| --- | --- |
| `super-log-<version>-universal.pkg` | `scripts/make_macos_pkg.sh` |
| `super-log_<version>_amd64.deb` | `packaging/deb/build-deb.sh` |
| `super-log_<version>_arm64.deb` | `packaging/deb/build-deb.sh` |
| `super-log-<version>-1.<dist>.x86_64.rpm` | `packaging/rpm/build-rpm.sh` |
| `super-log-<version>-1.<dist>.aarch64.rpm` | `packaging/rpm/build-rpm.sh` |
| `SHA256SUMS` | `.github/workflows/release.yml`, covering the five above |
| `super-log-<version>.mcpb` | `packaging/mcpb/build-mcpb.sh` (Claude Desktop extension — a different install surface, see [docs/CONNECT.md](CONNECT.md)) |

All five OS-installer artefacts and `SHA256SUMS` are built by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) on
every `vX.Y.Z` tag push and attached to that tag's GitHub Release. See that
workflow's own header for what runs where (macOS runner for the `.pkg`,
Docker + QEMU on an Ubuntu runner for the four Linux legs) and exactly
which secrets turn on signing/notarising.

[releases]: https://github.com/saxonnicholls/super-log/releases
[hb7]: https://brew.sh/2026/09/13/homebrew-7.0.0/
