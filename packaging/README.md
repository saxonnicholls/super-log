# Packaging

Distribution artifacts for super-log, one directory per channel. Each was
authored and verified locally; the final publish step for three of them
needs an account or repo that only the maintainer can create — those are
called out as **PUBLISH (maintainer)**.

The local installer (`scripts/install.sh`) and the npm packages need none
of this — see the repo README.

## homebrew/ — `brew install saxonnicholls/tap/super-log`

`super-log.rb` builds the hub + tailers from the v0.2.0 release tarball,
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

## vcpkg/ — `vcpkg install super-log` (the C SDK)

Scoped to the standalone C header on purpose: it is zero-dependency, so it
is a clean port. The C++ SDK depends on ts-moveables (not a vcpkg port),
so it ships via `find_package(superlog)` from a source/brew install
instead — the portfile's usage note says so.

- Verify: `vcpkg install super-log --overlay-ports=packaging/vcpkg/ports`
  (fill the real `SHA512` first — vcpkg prints it on the initial run).
- **PUBLISH (maintainer):** submit the port to the vcpkg registry, or keep
  it as a documented overlay port for consumers who prefer that.

## The shared keystone

All three native lanes rely on the CMake `-DSUPER_LOG_INSTALL=ON` rules
(hub binary, SDK headers, `find_package(superlog)` config). Any release
tag bump flows to: the three `package.json` versions, the CMake
`project(... VERSION ...)`, the formula `url`/`sha256`, `SUPER_LOG_VERSION`
for the deb, and the `vcpkg.json` version. Keep them in step.
