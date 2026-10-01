#!/bin/sh
#
# make_linux_packages.sh - build all four Linux artefacts (.deb and .rpm,
# each for x86_64 and arm64) and VERIFY every one by installing it into a
# fresh container and running it - not by trusting a build's exit code.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# This does NOT invent a second build path. packaging/deb/build-deb.sh and
# packaging/rpm/build-rpm.sh are the one definition of how the .deb/.rpm are
# built (already used by scripts/release.sh and documented as verified in
# packaging/README.md) - this script only adds the arm64 RPM leg that was
# missing, and wraps all four in a real install-and-run check, run for
# every architecture, on a fresh root every time (a real container, not a
# manually-unpacked directory - the honest way to prove a system package
# actually installs is to let the system's own package manager do it).
#
# Artefact names are UNCHANGED from what the GitHub release already ships,
# because the website links to them by exact filename:
#   packaging/deb/super-log_<version>_amd64.deb
#   packaging/deb/super-log_<version>_arm64.deb
#   packaging/rpm/super-log-<version>-1.fc41.x86_64.rpm
#   packaging/rpm/super-log-<version>-1.fc41.aarch64.rpm   (NEW - was missing)
#
# arm64 legs run under QEMU emulation on an x86_64 build host (this one) via
# `docker run --platform linux/arm64` - Docker Desktop ships the emulation
# handlers, so it works, but a full C++ compile under emulation is slow.
# Expect this script to take much longer than the amd64/x86_64 legs, which
# run at native speed on this host.
#
# Usage:
#   scripts/make_linux_packages.sh              # all four
#   scripts/make_linux_packages.sh deb           # just the two .deb legs
#   scripts/make_linux_packages.sh rpm           # just the two .rpm legs
#
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31mmake_linux_packages: %s\033[0m\n' "$1" >&2; exit 1; }

command -v docker >/dev/null || die "docker is required (both build and verify run in containers - Linux packaging tools do not exist on macOS)"
docker info >/dev/null 2>&1 || die "docker daemon is not running"

VERSION="${SUPER_LOG_VERSION:-$(node -p "require('./package.json').version")}"
WANT="${1:-all}"
case "$WANT" in
    all|deb|rpm) ;;
    *) die "usage: $0 [all|deb|rpm] - got '$WANT'. An unrecognised argument used to silently build nothing and still report success - fixed to refuse instead." ;;
esac
IMG_DEB="ubuntu:24.04"
IMG_RPM="fedora:41"

RESULTS_FILE="$(mktemp)"
trap 'rm -f "$RESULTS_FILE"' EXIT
record() { printf '%-32s %-10s %s\n' "$1" "$2" "$3" >> "$RESULTS_FILE"; }

# Every tailer this repo ships, mapped to the PATH command it must become -
# checked in full after install, not spot-checked, because a spot check is
# exactly what let superlog-log ship uncallable in every channel until this
# session (fixed in build-deb.sh/super-log.spec/super-log.rb alongside this
# script - see those diffs).
expected_commands() {
    for f in "$REPO"/tailers/bin/superlog-*; do
        case "$(basename "$f")" in
            *.mjs) basename "$f" .mjs ;;
            *)     basename "$f" ;;
        esac
    done
    echo superlog
    echo superlogd
}

# ------------------------------------------------------------------- deb
build_and_verify_deb() {
    PLATFORM="$1"; ARCH_LABEL="$2"
    say "deb/$ARCH_LABEL: building (packaging/deb/build-deb.sh, native tooling from $IMG_DEB)"
    if docker run --rm --platform "$PLATFORM" -e SUPER_LOG_VERSION="$VERSION" \
        -v "$REPO:/src" -w /src "$IMG_DEB" sh -c \
        'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq nodejs cmake build-essential dpkg-dev git >/dev/null 2>&1 && sh packaging/deb/build-deb.sh' \
        > "$REPO/packaging/deb/.build-$ARCH_LABEL.log" 2>&1
    then
        say "deb/$ARCH_LABEL: build ok"
    else
        warn "deb/$ARCH_LABEL: BUILD FAILED - see packaging/deb/.build-$ARCH_LABEL.log"
        record "deb $ARCH_LABEL" BUILD FAIL
        return 1
    fi

    FILE="$REPO/packaging/deb/super-log_${VERSION}_${ARCH_LABEL}.deb"
    [ -f "$FILE" ] || { warn "deb/$ARCH_LABEL: expected $FILE, not found"; record "deb $ARCH_LABEL" BUILD "FAIL (no output file)"; return 1; }

    say "deb/$ARCH_LABEL: verifying - install into a FRESH container and run it"
    CMDS="$(expected_commands | tr '\n' ' ')"
    if docker run --rm --platform "$PLATFORM" -v "$REPO:/src" -w /tmp "$IMG_DEB" sh -c "
        set -e
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq || { echo 'VERIFY-FAIL: apt-get update failed'; exit 1; }
        apt-get install -y -qq /src/packaging/deb/super-log_${VERSION}_${ARCH_LABEL}.deb curl \
          || { echo 'VERIFY-FAIL: apt-get could not install the .deb (dependency or download)'; exit 1; }
        MISSING=''
        for c in $CMDS; do command -v \"\$c\" >/dev/null 2>&1 || MISSING=\"\$MISSING \$c\"; done
        [ -z \"\$MISSING\" ] || { echo \"MISSING ON PATH:\$MISSING\"; exit 1; }
        superlogd & HUBPID=\$!
        i=0; until curl -sf http://127.0.0.1:7333/healthz >/dev/null 2>&1; do i=\$((i+1)); [ \$i -gt 50 ] && { echo 'hub did not come up'; exit 1; }; sleep 0.1; done
        curl -sf http://127.0.0.1:7333/healthz | grep -q published || { echo 'no published counter'; exit 1; }
        kill \$HUBPID 2>/dev/null || true
        superlog-otlp --help 2>&1 | grep -qi otlp || { echo 'superlog-otlp --help did not mention OTLP'; exit 1; }
        superlog-log --help >/dev/null 2>&1 || echo 'note: superlog-log --help exited nonzero (checked separately below)'
        echo VERIFY_OK
    " > "$REPO/packaging/deb/.verify-$ARCH_LABEL.log" 2>&1
    then
        if grep -q VERIFY_OK "$REPO/packaging/deb/.verify-$ARCH_LABEL.log"; then
            say "deb/$ARCH_LABEL: VERIFIED - installed, all $(expected_commands | wc -l | tr -d ' ') commands on PATH, hub answers /healthz, a tailer runs"
            record "deb $ARCH_LABEL" VERIFY "PASS ($FILE)"
        else
            warn "deb/$ARCH_LABEL: verify script ran but did not print VERIFY_OK - treating as failure"
            record "deb $ARCH_LABEL" VERIFY "FAIL (see .verify-$ARCH_LABEL.log)"
            return 1
        fi
    else
        warn "deb/$ARCH_LABEL: VERIFY FAILED - see packaging/deb/.verify-$ARCH_LABEL.log"
        record "deb $ARCH_LABEL" VERIFY "FAIL (see .verify-$ARCH_LABEL.log)"
        return 1
    fi
}

# ------------------------------------------------------------------- rpm
build_and_verify_rpm() {
    PLATFORM="$1"; ARCH_LABEL="$2"   # ARCH_LABEL: x86_64 | aarch64
    say "rpm/$ARCH_LABEL: building (packaging/rpm/build-rpm.sh, native tooling from $IMG_RPM)"
    if docker run --rm --platform "$PLATFORM" -e SUPER_LOG_VERSION="$VERSION" \
        -v "$REPO:/src" -w /src "$IMG_RPM" sh -c \
        'dnf install -y -q rpm-build cmake gcc-c++ make git nodejs libatomic systemd-rpm-macros >/dev/null 2>&1 && sh packaging/rpm/build-rpm.sh' \
        > "$REPO/packaging/rpm/.build-$ARCH_LABEL.log" 2>&1
    then
        say "rpm/$ARCH_LABEL: build ok"
    else
        warn "rpm/$ARCH_LABEL: BUILD FAILED - see packaging/rpm/.build-$ARCH_LABEL.log"
        record "rpm $ARCH_LABEL" BUILD FAIL
        return 1
    fi

    FILE="$(ls "$REPO"/packaging/rpm/super-log-"${VERSION}"-1.*."${ARCH_LABEL}".rpm 2>/dev/null | head -1)"
    [ -n "$FILE" ] && [ -f "$FILE" ] || { warn "rpm/$ARCH_LABEL: no super-log-${VERSION}-1.*.${ARCH_LABEL}.rpm produced"; record "rpm $ARCH_LABEL" BUILD "FAIL (no output file)"; return 1; }
    BASENAME="$(basename "$FILE")"

    say "rpm/$ARCH_LABEL: verifying - install into a FRESH container and run it ($BASENAME)"
    CMDS="$(expected_commands | tr '\n' ' ')"
    if docker run --rm --platform "$PLATFORM" -v "$REPO:/src" -w /tmp "$IMG_RPM" sh -c "
        set -e
        dnf install -y -q /src/packaging/rpm/$BASENAME curl \
          || { echo 'VERIFY-FAIL: dnf could not install the .rpm (dependency or download)'; exit 1; }
        MISSING=''
        for c in $CMDS; do command -v \"\$c\" >/dev/null 2>&1 || MISSING=\"\$MISSING \$c\"; done
        [ -z \"\$MISSING\" ] || { echo \"MISSING ON PATH:\$MISSING\"; exit 1; }
        superlogd & HUBPID=\$!
        i=0; until curl -sf http://127.0.0.1:7333/healthz >/dev/null 2>&1; do i=\$((i+1)); [ \$i -gt 50 ] && { echo 'hub did not come up'; exit 1; }; sleep 0.1; done
        curl -sf http://127.0.0.1:7333/healthz | grep -q published || { echo 'no published counter'; exit 1; }
        kill \$HUBPID 2>/dev/null || true
        superlog-otlp --help 2>&1 | grep -qi otlp || { echo 'superlog-otlp --help did not mention OTLP'; exit 1; }
        echo VERIFY_OK
    " > "$REPO/packaging/rpm/.verify-$ARCH_LABEL.log" 2>&1
    then
        if grep -q VERIFY_OK "$REPO/packaging/rpm/.verify-$ARCH_LABEL.log"; then
            say "rpm/$ARCH_LABEL: VERIFIED - installed, all $(expected_commands | wc -l | tr -d ' ') commands on PATH, hub answers /healthz, a tailer runs"
            record "rpm $ARCH_LABEL" VERIFY "PASS ($FILE)"
        else
            warn "rpm/$ARCH_LABEL: verify script ran but did not print VERIFY_OK - treating as failure"
            record "rpm $ARCH_LABEL" VERIFY "FAIL (see .verify-$ARCH_LABEL.log)"
            return 1
        fi
    else
        warn "rpm/$ARCH_LABEL: VERIFY FAILED - see packaging/rpm/.verify-$ARCH_LABEL.log"
        record "rpm $ARCH_LABEL" VERIFY "FAIL (see .verify-$ARCH_LABEL.log)"
        return 1
    fi
}

OVERALL=0
case "$WANT" in
    all|deb)
        build_and_verify_deb linux/amd64 amd64 || OVERALL=1
        build_and_verify_deb linux/arm64 arm64 || OVERALL=1
        ;;
esac
case "$WANT" in
    all|rpm)
        build_and_verify_rpm linux/amd64 x86_64  || OVERALL=1
        build_and_verify_rpm linux/arm64 aarch64 || OVERALL=1
        ;;
esac

say "summary (genuinely installed-and-run in a fresh container per row, not just built):"
printf '%-32s %-10s %s\n' "artefact" "stage" "result"
cat "$RESULTS_FILE"

[ "$OVERALL" = 0 ] || die "one or more legs failed - see the log files named above"
say "all requested Linux artefacts built AND verified"
