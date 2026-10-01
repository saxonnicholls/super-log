# Packaging

Distribution artifacts for super-log, one directory per channel. Each was
authored and verified locally; the final publish step for three of them
needs an account or repo that only the maintainer can create — those are
called out as **PUBLISH (maintainer)**.

For the full install matrix from a user's point of view (which button, which
command, per platform) see **[docs/INSTALL.md](../docs/INSTALL.md)** — this
file is about how each artefact is built and verified, not how to install
one. The `scripts/install.sh` build-from-clone path and the npm packages
need none of this — see the repo README.

## macos/ — the universal `.pkg` (Intel + Apple Silicon, one file)

`scripts/make_macos_pkg.sh` builds `superlogd` for both `arm64` and
`x86_64` separately, `lipo`s them into one binary, bundles a checksum-
verified Node runtime per architecture (used only when no system `node` is
found), stages every tailer as a PATH wrapper, and runs `pkgbuild` +
`productbuild`. Written specifically because [Homebrew 7.0.0][hb7]
(2026-09-13) moved macOS Intel to Tier 3 — no routine bottle builds — so
`brew install` there now compiles from source or fails; the `.pkg` does not
depend on Homebrew's tier ladder at all.

- Verify: `scripts/make_macos_pkg.sh` — it verifies its own output (expands
  the built `.pkg`, asserts `lipo -archs` reports both architectures,
  asserts every one of the 49 tailer commands is present and executable,
  and actually runs the binary for whichever architecture the build host
  itself is). **VERIFIED** on an x86_64 build host: both architectures
  built and structurally checked, the x86_64 slice actually executed
  (this host cannot execute the arm64 slice — no reverse-Rosetta on
  macOS — so that side is checked with `lipo -archs`/`file`, not run).
- **Signing/notarising:** reads Developer ID identities from
  `super-log-commercial/.credentials/apple.env` if present (or from
  already-exported `APPLE_SIGN_APP`/`APPLE_SIGN_PKG`/`APPLE_NOTARY_PROFILE`
  env vars, which is how CI supplies them). **No Developer ID certificate
  exists yet** (only Xcode-local "Apple Development" ones) — until one
  does, this builds UNSIGNED and says so loudly, because Gatekeeper
  refuses an unsigned `.pkg` on any machine that downloaded it.
- **PUBLISH (maintainer):** attach the `.pkg` to the GitHub release (done
  automatically by `.github/workflows/release.yml` on a tag push) — do not
  link it from the website until it is signed and notarised.

## homebrew/ — `brew install saxonnicholls/tap/super-log`

`super-log.rb` builds the hub + tailers from the v0.4.0 release tarball,
installs the SDK headers, exposes every tailer as a command, and registers
`superlogd` with `brew services`.

- Verify: `brew install --build-from-source packaging/homebrew/super-log.rb`
- **PUBLISH (maintainer):** create `saxonnicholls/homebrew-tap`, copy the
  formula to `Formula/super-log.rb`, push. Bump `url`/`sha256` per release.

## deb/ — `apt`/`dpkg` for Debian & Ubuntu

`build-deb.sh` (run inside the Ubuntu image, since dpkg-deb is Linux-only)
produces `super-log_<version>_<arch>.deb`: the hub binary, SDK headers,
tailers as commands, and a systemd unit enabled by `postinst`.

- Verify: `scripts/make_linux_packages.sh deb` — builds `amd64` and
  `arm64` (arm64 under QEMU emulation on a non-arm64 host), each verified
  by installing into a **fresh container** with the real `apt-get install`
  (so declared `Depends` actually resolve) and then running it: every
  tailer command checked present on PATH (all 49, not a sample), the hub
  answers `/healthz`, and a tailer actually runs. **VERIFIED** this way for
  both architectures. (This also runs `build-deb.sh` directly, unchanged,
  if you only want the raw build — see the docker one-liner in that
  script's own header.)
- **PUBLISH (maintainer):** attach the `.deb` to the GitHub release (done
  automatically by `.github/workflows/release.yml` on a tag push), or host
  an apt repo (reprepro/aptly on a static host or R2) for `apt install
  super-log`.

## rpm/ — `dnf`/`rpm` for Fedora, RHEL, Rocky, Alma & openSUSE

`build-rpm.sh` (run inside a Fedora image, since rpmbuild is a Red Hat
tool) produces `super-log-<version>-1.<dist>.<arch>.rpm`: the same payload
as the .deb — hub binary, SDK headers, tailers as commands, and a systemd
unit with the standard `%post`/`%preun`/`%postun` scriptlets.

- Verify: `scripts/make_linux_packages.sh rpm` — builds `x86_64` **and
  `aarch64`** (the arm64 leg did not exist before; a Fedora user on
  aarch64 had nothing), each verified the same way as the .deb above: a
  fresh container, a real `dnf install`, every tailer command checked
  present on PATH, `/healthz`, a tailer actually running.
  Earlier bugs found by building it for real (still true, still fixed
  here): the hub links `libatomic` (a Build/Requires here and a
  `libatomic1` Depends on the .deb), and `CMAKE_INSTALL_LIBDIR` is pinned
  to `lib` so the header-only `find_package` config lands where `%files`
  names it on Fedora's `lib64` default.
- **PUBLISH (maintainer):** attach the `.rpm` to the GitHub release (done
  automatically by `.github/workflows/release.yml` on a tag push), host a
  dnf repo, or build it on COPR (see the tier ladder below).

## vcpkg/ — `vcpkg install super-log[cpp]` (the C and C++ SDK, incl. Windows)

Two ports here: **`ts-moveables`** (an in-house header-only lib, which already
ships clean CMake install/export) and **`super-log`**. The super-log port's
default install is the zero-dependency C header; the **`cpp` feature** adds
the header-only C++ SDK and depends on the ts-moveables port. The spdlog
sink header is included; the `spdlog` feature (or the consumer's own
`find_package(spdlog)`) compiles it. The hub daemon and Node tailers are
not vcpkg artifacts — they ship via apt/brew/source.

- **VERIFIED** (arm64-osx): `vcpkg install super-log[cpp]` installs
  `ts-moveables` + the C/C++ SDK, and a consumer that does
  `find_package(super-log CONFIG)` + links `superlog::cpp` +
  `#include <super_log/event.hpp>` compiles and links.
  ```sh
  vcpkg install super-log[cpp] --overlay-ports=packaging/vcpkg/ports
  ```
  Note: on a bleeding-edge vcpkg registry, upstream **spdlog** may fail to
  build (a spdlog/fmt/cmake issue, not ours) — that only affects the
  optional `[spdlog]` feature; the core `[cpp]` SDK is ts-moveables-only.
- **PUBLISH (maintainer):** submit both ports to the vcpkg registry (or a
  custom registry), or keep them as the documented overlay for now.

## Getting into the distributions: the tier ladder

The artifacts above are the foundation; this is how they reach `apt
install super-log` and `dnf install super-log` on a stranger's machine.
Three tiers, cheapest first. **The .deb, .rpm and macOS .pkg are all built
and verified — everything below is distribution, and most of it needs a
maintainer account, not more code.**

### Tier 1 — build services (free, no gatekeeper, all architectures)

The fastest route to a real repo, and the one that builds the arm64 that a
Raspberry Pi needs without owning a Pi.

- **Fedora / RHEL / Rocky / Alma → COPR.** A Fedora account, a COPR
  project, point it at this repo's `packaging/rpm/super-log.spec`. COPR
  builds every arch (incl. `aarch64`) and hands users a one-liner: `sudo
  dnf copr enable saxonnicholls/super-log && sudo dnf install super-log`.
  Note: COPR allows network during builds, so the pinned ts-moveables
  fetch works today; an official archive (Tier 3) will not, and needs
  ts-moveables vendored into the source tarball first.
- **Ubuntu / Debian → Launchpad PPA.** A Launchpad account, a PPA, upload
  a source package built from `packaging/deb`. Launchpad builds each
  supported series and arch; users get `sudo add-apt-repository
  ppa:saxonnicholls/super-log && sudo apt install super-log`. The same
  Pi-without-a-Pi benefit (Launchpad builds `arm64`/`armhf`).

### Tier 2 — self-hosted repo + release artifacts (own the whole path)

No third party, but you sign and host.

- **Attach the `.deb`, `.rpm` and `.pkg` to each GitHub release**, plus a
  `SHA256SUMS` covering all of them — done automatically by
  `.github/workflows/release.yml` on a tag push (`scripts/release.sh`
  attaches the `.deb`/`.rpm`/`.mcpb` by hand for the other four homes it
  publishes to; the two are additive, not competing — see that workflow's
  own header). Immediate `curl`-and-install for anyone, and the source of
  truth `scripts/install.sh`'s fetch mode and any future apt/dnf repo pull
  from.
- **A one-line installer** that detects the OS/architecture, downloads the
  right artifact from the latest release, **verifies it against
  `SHA256SUMS` before running anything**, and installs it — the
  htop/ripgrep on-ramp (`curl -fsSL https://super-log.com/install.sh | sh`).
  This is `scripts/install.sh` itself, not a second file: it tells "piped
  from curl, no clone" apart from "run from inside a clone" by whether it
  is actually sitting in a real super-log checkout, and only builds from
  source in the second case.
- **A signed apt/dnf repo** on any static host (GitHub Pages, Cloudflare
  R2, S3): `reprepro` for apt, `createrepo_c` for dnf, one GPG signing
  key. Then the add-repo one-liner and `apt/dnf install super-log` with
  real signature checking. This is the "de facto standard" spelling short
  of the official archives.

### Tier 3 — the official archives (the long game → see the commercial plan)

Debian main, Fedora, EPEL: a sponsor, an ITP/review, Debian Policy
compliance, and a maintenance commitment. Months, and worth it exactly
once demand exists — and gated on **vendoring ts-moveables into the
release tarball** (official builders have no network), the same constraint
Homebrew core hit. The full Tier-3 campaign, sequencing and the Debian-
archive endgame live in the commercial strategy docs
(`super-log-commercial/docs/strategy/07-linux-standard.md`), not here.

### Distro-agnostic shortcut — Snap

A `snapcraft.yaml` bundles Node and the hub into one confined package that
installs the same on every distro (`snap install super-log`), sidestepping
per-distro packaging entirely. A good launch accelerant; not a substitute
for being *in* the archives, which is what "standard" ultimately means.

## The shared keystone

All native lanes rely on the CMake `-DSUPER_LOG_INSTALL=ON` rules (hub
binary, SDK headers, `find_package(superlog)` config). Any release tag
bump flows to: the three `package.json` versions, the CMake
`project(... VERSION ...)`, the formula `url`/`sha256`, `SUPER_LOG_VERSION`
for the deb/rpm, and the `vcpkg.json` version — `scripts/bump-version.sh`
does this in one command. `scripts/make_macos_pkg.sh` and
`scripts/make_linux_packages.sh` read the version straight from
`package.json` at build time (or `SUPER_LOG_VERSION` if set, matching the
deb/rpm scripts), so neither one needed adding to that bump list.

Also fixed this session, in `build-deb.sh`, `super-log.spec` and
`homebrew/super-log.rb` alike: `superlog-log` (the one tailer that is a
plain POSIX shell script, not a `.mjs` — it has to run where there is no
Node at all) was being copied into every package but never getting a PATH
wrapper, because each wrapper-generation loop only globbed `superlog-*.mjs`.
It shipped inert in all three channels until the fix. Found by actually
asserting every tailer lands on PATH in `scripts/make_macos_pkg.sh` and
`scripts/make_linux_packages.sh`'s verify steps, not by spot-checking a
couple of them.

[hb7]: https://brew.sh/2026/09/13/homebrew-7.0.0/
