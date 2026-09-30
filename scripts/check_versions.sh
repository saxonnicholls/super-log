#!/usr/bin/env bash
# check_versions.sh - every place the bench hardcodes its version must agree.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
#   ./scripts/check_versions.sh            # do they all agree with package.json?
#   ./scripts/check_versions.sh 0.5.0      # ...and is that the version?
#
# WHY. On 2026-09-28 six shipping components carried five different numbers,
# because the version lives in a CMake file, four package.json files, a shell
# default and a Homebrew URL, and nothing ever compared them. The release
# workflow calls this FIRST, so a tag that disagrees with the tree fails in
# fifteen seconds instead of after twenty minutes of building artefacts nobody
# can use - and long before anything irreversible is published.
#
# The commercial repo's scripts/version.sh is what SETS them all. This only
# checks, so it can live here in the open half and run in CI.

set -eu

cd "$(dirname "$0")/.."

WANT="${1:-}"
FAIL=0

say()  { printf '  %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*" >&2; FAIL=1; }

# Each reader prints the version it finds, or nothing. A reader that prints
# nothing is a failure in itself: it means the file moved or its shape changed,
# and silently checking six things when you meant seven is how the drift got in.
read_json()  { node -p "require('./$1').version" 2>/dev/null || true; }
read_cmake() { sed -nE 's/^[[:space:]]*VERSION[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' CMakeLists.txt | head -1; }
read_deb()   { sed -nE 's/.*SUPER_LOG_VERSION:-([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' packaging/deb/build-deb.sh | head -1; }
read_brew()  { sed -nE 's#.*/tags/v([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz.*#\1#p' packaging/homebrew/super-log.rb | head -1; }

declare -a NAMES=()
declare -a FOUND=()

add() { NAMES+=("$1"); FOUND+=("$2"); }

add "package.json"                     "$(read_json package.json)"
add "tailers/package.json"             "$(read_json tailers/package.json)"
add "sdk/js/packages/mcp/package.json" "$(read_json sdk/js/packages/mcp/package.json)"
add "viewer/react/package.json"        "$(read_json viewer/react/package.json)"
add "CMakeLists.txt"                   "$(read_cmake)"
add "packaging/deb/build-deb.sh"       "$(read_deb)"
add "packaging/homebrew/super-log.rb"  "$(read_brew)"

# The reference is package.json unless one was named, because that is the file
# make_macos_pkg.sh and the rpm spec already DERIVE from.
REF="${WANT:-${FOUND[0]}}"
[ -n "$REF" ] || { echo "FAIL could not read a version from package.json" >&2; exit 1; }

echo "expecting $REF"
i=0
while [ "$i" -lt "${#NAMES[@]}" ]; do
    n="${NAMES[$i]}"; v="${FOUND[$i]}"
    if [ -z "$v" ]; then
        bad "$n - no version could be read (the file moved, or its shape changed)"
    elif [ "$v" != "$REF" ]; then
        bad "$n - $v"
    else
        say "ok   $n - $v"
    fi
    i=$((i + 1))
done

# A derived version cannot drift, so these are checked for still being derived
# rather than for their value. If somebody hardcodes one, the guarantee is gone
# and this is where it gets noticed.
if ! grep -q 'require(./package.json).version\|package.json...version' scripts/make_macos_pkg.sh 2>/dev/null; then
    bad "scripts/make_macos_pkg.sh no longer derives its version from package.json"
else
    say "ok   scripts/make_macos_pkg.sh derives its version (cannot drift)"
fi
if ! grep -q '%{version}' packaging/rpm/super-log.spec 2>/dev/null; then
    bad "packaging/rpm/super-log.spec no longer takes %{version} from the build"
else
    say "ok   packaging/rpm/super-log.spec takes %{version} from the build (cannot drift)"
fi

if [ "$FAIL" -ne 0 ]; then
    echo
    echo "Versions disagree. Set them all with the commercial repo's" >&2
    echo "  ./scripts/version.sh $REF" >&2
    exit 1
fi

echo
echo "every hardcoded version reads $REF"
