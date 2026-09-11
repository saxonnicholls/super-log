#!/bin/sh
#
# build-rpm.sh - build a super-log .rpm, inside Fedora/Rocky.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# rpmbuild is a Red Hat tool, so this runs in a Red Hat container - the
# honest way to build an RPM is on an RPM distro:
#
#   docker run --rm -v "$PWD:/src" -w /src fedora:41 \
#       sh -c 'dnf install -y rpm-build cmake gcc-c++ make git nodejs libatomic systemd-rpm-macros && sh packaging/rpm/build-rpm.sh'
#
# Produces super-log-<version>-1.*.rpm in packaging/rpm/. Install with
# `sudo dnf install ./...rpm` (or rpm -i), host in a dnf repo, or push to
# COPR. Ships the same payload as the .deb: hub, headers, tailers, unit.
#
set -eu
cd "$(dirname "$0")/../.."
VERSION="${SUPER_LOG_VERSION:-0.4.0}"
TOP="$(mktemp -d)"
trap 'rm -rf "$TOP"' EXIT
mkdir -p "$TOP/BUILD" "$TOP/RPMS" "$TOP/SPECS"

echo "build-rpm: rpmbuild ($VERSION)"
# --build-in-place: build from the bind-mounted tree, no tarball dance.
rpmbuild --define "_topdir $TOP" \
         --define "version $VERSION" \
         --build-in-place \
         -bb packaging/rpm/super-log.spec

OUT="$(find "$TOP/RPMS" -name '*.rpm' | head -1)"
cp "$OUT" "packaging/rpm/$(basename "$OUT")"
echo "build-rpm: wrote packaging/rpm/$(basename "$OUT")"
rpm -qip "packaging/rpm/$(basename "$OUT")" | sed -n '1,10p'
echo "--- files ---"
rpm -qlp "packaging/rpm/$(basename "$OUT")" | head -12
