#!/bin/sh
#
# make-orig-tarball.sh - assemble a network-free super-log source tarball.
#
# Copyright 2026 Saxon Nicholls
# SPDX-License-Identifier: MIT
#
# A Launchpad PPA (and Debian proper) build with NO network access, but
# super-log's build pulls two things over the wire: ts-moveables by pinned
# commit (FetchContent) and the third_party/{fmt,spdlog,json} submodules.
# This bundles all three into one orig tarball so the build fetches nothing:
#
#   * the super-log source at HEAD (git archive - no .git, no build dirs)
#   * third_party/{fmt,spdlog,json} submodule CONTENTS (git archive omits
#     these - they are gitlinks - so they are added explicitly)
#   * vendor/ts-moveables at the exact pinned SHA the CMake uses
#
# The ImGui viewer's submodules (imgui, glfw) are left out on purpose: the
# package builds the hub with the viewer OFF, so they are dead weight.
#
# Produces ../super-log_<version>.orig.tar.gz (the name dpkg-source wants).
# Run from the repo root; needs network ONCE here to read the pinned SHA if
# the sibling ts-moveables checkout does not already have it. The BUILD that
# consumes the tarball needs none.
#
#   sh packaging/ppa/make-orig-tarball.sh
#
set -eu

cd "$(git rev-parse --show-toplevel)"
REPO="$(pwd)"

# Keep this SHA in lockstep with TS_MOVEABLES_GIT_TAG in the top CMakeLists.
PIN="$(sed -n 's/.*TS_MOVEABLES_GIT_TAG "\([0-9a-f]*\)".*/\1/p' CMakeLists.txt | head -1)"
VERSION="$(sed -n 's/.*"version": "\([0-9.]*\)".*/\1/p' package.json | head -1)"
[ -n "$PIN" ] || { echo "make-orig: could not read the pinned ts-moveables SHA from CMakeLists.txt" >&2; exit 1; }
[ -n "$VERSION" ] || { echo "make-orig: could not read the version from package.json" >&2; exit 1; }

TSM="${TS_MOVEABLES_DIR:-$REPO/../TSMoveables}"
[ -d "$TSM/.git" ] || { echo "make-orig: no ts-moveables checkout at $TSM (set TS_MOVEABLES_DIR)" >&2; exit 1; }
git -C "$TSM" cat-file -e "$PIN^{commit}" 2>/dev/null \
  || { echo "make-orig: pinned SHA $PIN not in $TSM - run: git -C $TSM fetch --all" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
TOP="$STAGE/super-log-$VERSION"
mkdir -p "$TOP"

echo "make-orig: super-log $VERSION source (git archive HEAD)"
git archive HEAD | tar -x -C "$TOP"

# git archive skips submodule contents (they are gitlinks). Add just the ones
# the hub needs, from each submodule's own checked-out HEAD.
for sub in fmt spdlog json; do
    [ -f "third_party/$sub/CMakeLists.txt" ] \
      || { echo "make-orig: submodule third_party/$sub is empty - run: git submodule update --init third_party/$sub" >&2; exit 1; }
    echo "make-orig: bundling third_party/$sub"
    rm -rf "$TOP/third_party/$sub"
    mkdir -p "$TOP/third_party/$sub"
    git -C "third_party/$sub" archive HEAD | tar -x -C "$TOP/third_party/$sub"
done
# The viewer-only submodules are not built by the package; drop them so the
# tarball is not carrying a windowing toolkit no one here compiles.
rm -rf "$TOP/third_party/imgui" "$TOP/third_party/glfw"

echo "make-orig: vendoring ts-moveables @ $PIN"
mkdir -p "$TOP/vendor/ts-moveables"
git -C "$TSM" archive "$PIN" | tar -x -C "$TOP/vendor/ts-moveables"

OUT="$REPO/../super-log_${VERSION}.orig.tar.gz"
( cd "$STAGE" && tar czf "$OUT" "super-log-$VERSION" )
echo "make-orig: wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "make-orig: contains the hub source, fmt/spdlog/json, and ts-moveables - fetches nothing at build time"
