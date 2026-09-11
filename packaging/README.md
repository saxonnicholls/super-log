# Packaging

Distribution artifacts for super-log, one directory per channel. Each was
authored and verified locally; the final publish step for three of them
needs an account or repo that only the maintainer can create — those are
called out as **PUBLISH (maintainer)**.

The local installer (`scripts/install.sh`) and the npm packages need none
of this — see the repo README.

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

- Verify (from the repo root):
  ```sh
  docker run --rm -v "$PWD:/src" -w /src ubuntu:24.04 sh -c \
    'apt-get update && apt-get install -y nodejs cmake build-essential dpkg-dev && sh packaging/deb/build-deb.sh'
  ```
  (Confirmed building a valid .deb this way.)
- **PUBLISH (maintainer):** attach the `.deb` to the GitHub release for
  direct download, or host an apt repo (reprepro/aptly on a static host or
  R2) for `apt install super-log`.

## rpm/ — `dnf`/`rpm` for Fedora, RHEL, Rocky, Alma & openSUSE

`build-rpm.sh` (run inside a Fedora image, since rpmbuild is a Red Hat
tool) produces `super-log-<version>-1.<dist>.<arch>.rpm`: the same payload
as the .deb — hub binary, SDK headers, tailers as commands, and a systemd
unit with the standard `%post`/`%preun`/`%postun` scriptlets.

- Verify (from the repo root):
  ```sh
  docker run --rm -v "$PWD:/src" -w /src fedora:41 sh -c \
    'dnf install -y rpm-build cmake gcc-c++ make git nodejs libatomic systemd-rpm-macros && sh packaging/rpm/build-rpm.sh'
  ```
  **VERIFIED** end to end: builds the package, then a fresh
  `fedora:41` container `dnf install`s the resulting `.rpm`, the binaries
  land on PATH, and `superlogd` answers `/healthz`. Two real bugs were
  found by building it for real — the hub links `libatomic` (now a
  Build/Requires here and a `libatomic1` Depends on the .deb), and
  `CMAKE_INSTALL_LIBDIR` is pinned to `lib` so the header-only
  `find_package` config lands where `%files` names it on Fedora's `lib64`
  default.
- **PUBLISH (maintainer):** attach the `.rpm` to the GitHub release,
  host a dnf repo, or build it on COPR (see the tier ladder below).

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
Three tiers, cheapest first. **The .deb and .rpm are built and verified —
everything below is distribution, and most of it needs a maintainer
account, not more code.**

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

- **Attach the `.deb` and `.rpm` to each GitHub release** (`gh release
  upload vX.Y.Z super-log_*.deb super-log-*.rpm`). Immediate `curl`-and-
  install for anyone, and the source of truth a repo or installer pulls
  from.
- **A one-line installer** that detects the distro, downloads the right
  artifact from the latest release and installs it — the htop/ripgrep
  on-ramp (`curl -fsSL https://super-log.com/install.sh | sh`). Distinct
  from `scripts/install.sh`, which builds from source.
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

All three native lanes rely on the CMake `-DSUPER_LOG_INSTALL=ON` rules
(hub binary, SDK headers, `find_package(superlog)` config). Any release
tag bump flows to: the three `package.json` versions, the CMake
`project(... VERSION ...)`, the formula `url`/`sha256`, `SUPER_LOG_VERSION`
for the deb, and the `vcpkg.json` version. Keep them in step.
