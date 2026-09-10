#!/bin/sh
#
# bump-version.sh - set the release version everywhere, in one command.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# The version used to live in ~15 files (five package.json, CMake, vcpkg, the
# rpm/deb build scripts, the PPA changelog, the README download URLs) and a
# release meant editing each by hand and hoping they matched. This does it once:
#
#   scripts/bump-version.sh 0.4.0
#
# It is idempotent-ish: it reads the CURRENT version from the root package.json
# and replaces exactly that string in the files that carry it. After it runs,
# review the diff, move CHANGELOG.md's "Unreleased" heading to the new version,
# commit, and run scripts/release.sh.
#
set -eu

NEW="${1:?usage: scripts/bump-version.sh <new-version>   e.g. 0.4.0}"
echo "$NEW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo "bump: '$NEW' is not a semver x.y.z" >&2; exit 2; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
OLD="$(node -p "require('./package.json').version")"
[ "$OLD" != "$NEW" ] || { echo "bump: already at $NEW"; exit 0; }
echo "bump: $OLD -> $NEW"

# 1) Every package.json version field (JSON-precise, so nothing else is touched).
for p in package.json tailers/package.json viewer/react/package.json \
         sdk/js/packages/client/package.json sdk/js/packages/mcp/package.json; do
    [ -f "$p" ] || continue
    node -e 'const f=process.argv[1],fs=require("fs");const j=JSON.parse(fs.readFileSync(f));
             if(j.version){j.version=process.argv[2];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");console.log("  "+f)}' "$p" "$NEW"
done

# 2) vcpkg port manifest (JSON).
VCPKG="packaging/vcpkg/ports/super-log/vcpkg.json"
[ -f "$VCPKG" ] && node -e 'const f=process.argv[1],fs=require("fs");const j=JSON.parse(fs.readFileSync(f));
    j.version=process.argv[2];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");console.log("  "+f)' "$VCPKG" "$NEW"

# 3) The version-bearing text files: replace the exact OLD string. These files
#    exist to carry the version, so a plain substitution is safe here.
for f in CMakeLists.txt .github/ci/windows/CMakeLists.txt \
         packaging/deb/build-deb.sh packaging/rpm/build-rpm.sh \
         packaging/rpm/super-log.spec packaging/README.md packaging/ppa/README.md; do
    [ -f "$f" ] || continue
    if grep -q "$OLD" "$f"; then
        OLD="$OLD" NEW="$NEW" perl -0777 -i -pe 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' "$f"
        echo "  $f"
    fi
done

# 4) README download URLs only (vX, _X_, -X-, /X/) - not any prose that may
#    happen to contain the number.
if grep -qE "v$OLD|_${OLD}_|-${OLD}-|/${OLD}/" README.md; then
    OLD="$OLD" NEW="$NEW" perl -i -pe '
        my ($o,$n)=($ENV{OLD},$ENV{NEW});
        s/v\Q$o\E/v$n/g; s/_\Q$o\E_/_${n}_/g; s/-\Q$o\E-/-$n-/g; s{/\Q$o\E/}{/$n/}g;' README.md
    echo "  README.md (download URLs)"
fi

# 5) A fresh Debian changelog stanza, taken from the existing maintainer line.
CH="packaging/ppa/debian/changelog"
if [ -f "$CH" ]; then
    SERIES="${SUPER_LOG_SERIES:-noble}"
    MAINT="$(grep -m1 '^ -- ' "$CH" | sed 's/^ -- //; s/  .*$//')"
    DATE="$(date -R 2>/dev/null || date '+%a, %d %b %Y %H:%M:%S %z')"
    TMP="$(mktemp)"
    {
        printf 'super-log (%s-1~%s1) %s; urgency=medium\n\n' "$NEW" "$SERIES" "$SERIES"
        printf '  * New upstream release %s.\n\n' "$NEW"
        printf ' -- %s  %s\n\n' "$MAINT" "$DATE"
        cat "$CH"
    } > "$TMP"
    mv "$TMP" "$CH"
    echo "  $CH (new stanza)"
fi

echo ""
echo "bump: done. Now:  git diff   ->   move CHANGELOG.md 'Unreleased' to $NEW"
echo "                  git commit ->   scripts/release.sh"
