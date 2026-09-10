#!/bin/sh
#
# release.sh - cut a super-log release to GitHub AND Launchpad, in one go.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# One version, two homes, kept in sync:
#
#   GitHub    - a tagged release with prebuilt binaries attached (.deb for
#               amd64 and arm64, .rpm for x86_64), for a direct download +
#               `apt install ./file` / `dnf install <url>`.
#   Launchpad - a signed SOURCE upload to ppa:super-log/stable; Launchpad
#               then builds the binaries itself for every architecture, so
#               `add-apt-repository ppa:super-log/stable && apt install
#               super-log` works, arm64 (Raspberry Pi) included.
#
# The version is read from package.json. Bump it EVERYWHERE first with one
# command - `scripts/bump-version.sh 0.4.0` - which sets the five package.json,
# CMake, vcpkg, the rpm/deb build scripts, the PPA changelog and the README
# download URLs; then move CHANGELOG.md's "Unreleased" heading and commit. This
# script does NOT invent a version, and refuses to run on a dirty tree or off
# main.
#
#   scripts/bump-version.sh 0.4.0     # FIRST: set the version everywhere
#   scripts/release.sh                # all channels: GitHub + PPA + npm
#   scripts/release.sh github         # just the GitHub release + binaries
#   scripts/release.sh launchpad      # just the signed PPA source upload
#   scripts/release.sh npm            # just the npm publish (verified first)
#   DPUT_OPTS=-s scripts/release.sh launchpad   # dry run (simulate the upload)
#
# The Debian tooling runs in throwaway containers; the GPG SIGNING happens
# here on the host, where your gpg-agent/Keychain can unlock the key - so the
# private key never leaves this machine and never enters a container. When you
# run this, pinentry will ask once to unlock the key.
#
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The signing identity is personal, so it is NOT hardcoded here. Put your GPG
# key id and fingerprint in scripts/release.env (gitignored) or the
# environment - see scripts/release.env.example.
[ -f "$REPO_ROOT/scripts/release.env" ] && . "$REPO_ROOT/scripts/release.env"
KEYID="${SUPER_LOG_SIGN_KEY:?set SUPER_LOG_SIGN_KEY (your GPG key id) in scripts/release.env or the environment}"
FPR="${SUPER_LOG_SIGN_FPR:?set SUPER_LOG_SIGN_FPR (your GPG fingerprint) in scripts/release.env or the environment}"
PPA="${SUPER_LOG_PPA:-ppa:super-log/stable}"
SERIES="${SUPER_LOG_SERIES:-noble}"
IMG_DEB="ubuntu:24.04"
IMG_RPM="fedora:41"

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
DEBREV="1~${SERIES}1"
STAGE="${1:-all}"

say() { printf '\n=== release: %s ===\n' "$*"; }

preflight() {
    say "super-log $VERSION (tag $TAG, ppa $PPA, series $SERIES)"
    # A release ships what is COMMITTED: a dirty tree means the artefacts and the
    # tag would disagree with your working copy. Refuse, rather than ship the gap.
    [ -z "$(git status --porcelain)" ] \
      || { echo "release: working tree is dirty - commit or stash first" >&2; git status --short >&2; exit 1; }
    BR="$(git rev-parse --abbrev-ref HEAD)"
    [ "$BR" = main ] || { echo "release: on branch '$BR', not main - checkout main first" >&2; exit 1; }
    command -v docker >/dev/null || { echo "release: docker is required" >&2; exit 1; }
    if [ "$STAGE" = all ] || [ "$STAGE" = github ]; then
        command -v gh >/dev/null || { echo "release: gh (GitHub CLI) is required for the github stage" >&2; exit 1; }
    fi
    if [ "$STAGE" = all ] || [ "$STAGE" = launchpad ]; then
        gpg --list-secret-keys "$KEYID" >/dev/null 2>&1 \
          || { echo "release: signing key $KEYID not in this keyring" >&2; exit 1; }
    fi
}

# ------------------------------------------------------------------ GitHub
do_github() {
    say "GitHub: tag + release + binaries"
    [ -n "$(git tag -l "$TAG")" ] || git tag -a "$TAG" -m "super-log $VERSION"
    git push origin main
    git push origin "$TAG" 2>/dev/null || true

    say "GitHub: building .deb (amd64, arm64) and .rpm on their own distros"
    docker run --rm --platform linux/amd64 -e SUPER_LOG_VERSION="$VERSION" -v "$REPO_ROOT:/src" -w /src "$IMG_DEB" sh -c \
      'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq nodejs cmake build-essential dpkg-dev git >/dev/null 2>&1 && sh packaging/deb/build-deb.sh'
    docker run --rm --platform linux/arm64 -e SUPER_LOG_VERSION="$VERSION" -v "$REPO_ROOT:/src" -w /src "$IMG_DEB" sh -c \
      'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq nodejs cmake build-essential dpkg-dev git >/dev/null 2>&1 && sh packaging/deb/build-deb.sh'
    docker run --rm --platform linux/amd64 -e SUPER_LOG_VERSION="$VERSION" -v "$REPO_ROOT:/src" -w /src "$IMG_RPM" sh -c \
      'dnf install -y -q rpm-build cmake gcc-c++ make git nodejs libatomic systemd-rpm-macros >/dev/null 2>&1 && sh packaging/rpm/build-rpm.sh'

    DEB_AMD="packaging/deb/super-log_${VERSION}_amd64.deb"
    DEB_ARM="packaging/deb/super-log_${VERSION}_arm64.deb"
    RPM="$(ls packaging/rpm/super-log-${VERSION}-1.*.x86_64.rpm | head -1)"

    if gh release view "$TAG" >/dev/null 2>&1; then
        say "GitHub: release $TAG exists - adding any missing assets (best effort; immutable releases stay as-is)"
        gh release upload "$TAG" "$DEB_AMD" "$DEB_ARM" "$RPM" --clobber 2>/dev/null \
          || echo "release: could not add assets (immutable release?) - leaving as-is"
    else
        say "GitHub: creating release $TAG with binaries"
        gh release create "$TAG" "$DEB_AMD" "$DEB_ARM" "$RPM" \
          --title "super-log $VERSION" \
          --notes "See CHANGELOG.md. Install: sudo apt install ./super-log_${VERSION}_<arch>.deb (Debian/Ubuntu/Pi) or sudo dnf install ./super-log-${VERSION}-1.*.x86_64.rpm (Fedora/RHEL)."
    fi
    say "GitHub: done"
}

# --------------------------------------------------------------- Launchpad
# Build unsigned in a container, sign on the host (key stays local), upload
# from a container. debuild signs the .dsc and the .changes; because signing
# the .dsc changes it, its checksums in the .changes are refreshed before the
# .changes is signed - which is exactly what debsign does, done here so the
# key never has to enter a container.
do_launchpad() {
    say "Launchpad: source package -> $PPA (signed on host; key never leaves this machine)"
    sh packaging/ppa/make-orig-tarball.sh
    ORIG="$REPO_ROOT/../super-log_${VERSION}.orig.tar.gz"
    [ -f "$ORIG" ] || { echo "release: orig tarball not produced at $ORIG" >&2; exit 1; }

    STG="$(mktemp -d)"; trap 'rm -rf "$STG"' EXIT
    cp "$ORIG" "$STG/"
    cp -r packaging/ppa/debian "$STG/debian"

    DSC="super-log_${VERSION}-${DEBREV}.dsc"
    CH="super-log_${VERSION}-${DEBREV}_source.changes"

    # 1) Container: build the UNSIGNED source package. No key inside.
    say "Launchpad: building the unsigned source package"
    docker run --rm --platform linux/amd64 -e VERSION="$VERSION" -v "$STG:/stage" "$IMG_DEB" sh -c '
        set -e; export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null 2>&1
        apt-get install -y -qq devscripts debhelper dpkg-dev >/dev/null 2>&1
        mkdir -p /work && tar xzf "/stage/super-log_${VERSION}.orig.tar.gz" -C /work
        # dpkg-source (3.0 quilt) wants the orig tarball beside the source tree.
        cp "/stage/super-log_${VERSION}.orig.tar.gz" /work/
        cp -r /stage/debian "/work/super-log-${VERSION}/debian"
        cd "/work/super-log-${VERSION}"
        # -S source-only, -sa include the orig, -us -uc unsigned (we sign on
        # the host), -d skip the build-dep check (a source build compiles
        # nothing, so cmake/g++ need not be present here).
        dpkg-buildpackage -S -sa -us -uc -d
        cp ../super-log_${VERSION}-*.dsc ../super-log_${VERSION}-*_source.changes \
           ../super-log_${VERSION}-*.debian.tar.* ../super-log_${VERSION}-*.buildinfo /stage/
    '
    [ -f "$STG/$DSC" ] || { echo "release: expected $DSC not built" >&2; exit 1; }

    # 2) Host: sign the .dsc (gpg-agent unlocks the key - pinentry once).
    say "Launchpad: signing .dsc and .changes locally (pinentry may ask to unlock the key)"
    ( cd "$STG" && gpg --batch --yes --local-user "$KEYID" --clearsign "$DSC" && mv "$DSC.asc" "$DSC" )
    gpg --verify "$STG/$DSC" >/dev/null 2>&1 || { echo "release: .dsc signature failed to verify" >&2; exit 1; }

    # 3) Host: refresh the .changes checksums for the now-signed .dsc, sign it.
    ( cd "$STG"
      SZ="$(wc -c < "$DSC" | tr -d ' ')"
      MD5="$(md5 -q "$DSC" 2>/dev/null || md5sum "$DSC" | cut -d' ' -f1)"
      SHA1="$(shasum -a 1 "$DSC" | cut -d' ' -f1)"
      SHA256="$(shasum -a 256 "$DSC" | cut -d' ' -f1)"
      DSC="$DSC" SZ="$SZ" MD5="$MD5" SHA1="$SHA1" SHA256="$SHA256" perl -0777 -i -pe '
        my $b=$ENV{DSC};
        s/^ [0-9a-f]{32} \d+ (\S+) (\S+) \Q$b\E$/ $ENV{MD5} $ENV{SZ} $1 $2 $b/m;
        s/^ [0-9a-f]{40} \d+ \Q$b\E$/ $ENV{SHA1} $ENV{SZ} $b/m;
        s/^ [0-9a-f]{64} \d+ \Q$b\E$/ $ENV{SHA256} $ENV{SZ} $b/m;
      ' "$CH"
      gpg --batch --yes --local-user "$KEYID" --clearsign "$CH" && mv "$CH.asc" "$CH"
    )
    gpg --verify "$STG/$CH" >/dev/null 2>&1 || { echo "release: .changes signature failed to verify" >&2; exit 1; }
    say "Launchpad: both signatures verify"

    # The public key (not secret) so dput can verify the signature locally
    # before uploading; Launchpad verifies it again server-side.
    gpg --export --armor "$KEYID" > "$STG/pubkey.asc"

    # 4) Container: upload. Only the public key goes in - the signatures made
    # on the host authenticate the upload to Launchpad.
    say "Launchpad: dput ${DPUT_OPTS:-} $PPA"
    docker run --rm --platform linux/amd64 -e PPA="$PPA" -e CH="$CH" -e FPR="$FPR" -e DPUT_OPTS="${DPUT_OPTS:-}" \
      -v "$STG:/stage" "$IMG_DEB" sh -c '
        set -e; export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq dput >/dev/null 2>&1
        gpg --batch --import /stage/pubkey.asc >/dev/null 2>&1
        printf "%s:6:\n" "$FPR" | gpg --batch --import-ownertrust >/dev/null 2>&1
        cd /stage && dput $DPUT_OPTS "$PPA" "$CH"
    '
    say "Launchpad: uploaded - watch https://launchpad.net/~super-log/+archive/ubuntu/stable"
}

# ---------------------------------------------------------------------- npm
# publish_npm.sh does the verification that matters - it PACKS each package,
# installs the tarball into a clean environment, and runs the command a stranger
# would run - before anything reaches the registry. That is the check that would
# have caught the `superlog`-bin-hang. --publish is irreversible after 72h, which
# is exactly why the verification runs first.
do_npm() {
    say "npm: verify (pack + clean-install + run) then publish"
    sh "$REPO_ROOT/scripts/publish_npm.sh" --publish
    say "npm: done"
}

preflight
case "$STAGE" in
    all)       do_github; do_launchpad; do_npm ;;
    github)    do_github ;;
    launchpad) do_launchpad ;;
    npm)       do_npm ;;
    *) echo "usage: scripts/release.sh [all|github|launchpad|npm]" >&2; exit 2 ;;
esac
say "release complete: $VERSION"
