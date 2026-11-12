#!/bin/sh
#
# build-deb.sh - build a super-log .deb, inside Ubuntu.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# dpkg-deb lives on Debian/Ubuntu, not macOS, so this is meant to run in
# the repo's own Ubuntu image (the same one CI uses) - the honest way to
# build a Linux package is on Linux:
#
#   docker run --rm -v "$PWD:/src" -w /src ubuntu:24.04 \
#       sh -c 'apt-get update && apt-get install -y nodejs cmake build-essential dpkg-dev && sh packaging/deb/build-deb.sh'
#
# It produces super-log_<version>_<arch>.deb in packaging/deb/. Install
# with `sudo dpkg -i`, or host it in an apt repo. Ships: the hub binary,
# the SDK headers, all the tailers under /usr/lib/super-log, wrapper
# commands on PATH, and a systemd unit for the hub (enabled by postinst).
#
set -eu
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
VERSION="${SUPER_LOG_VERSION:-0.5.2}"
ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "build-deb: building the hub"
# Fresh build dir every time. This runs bind-mounted at /src, so a build-deb/
# left by a local run - carrying a FetchContent _deps pinned to an OLDER
# ts-moveables - would be reused and silently misbuild against the wrong
# version. A release must fetch the pinned ts-moveables, not whatever was here.
rm -rf build-deb
cmake -S . -B build-deb -DCMAKE_BUILD_TYPE=Release \
    -DSUPER_LOG_INSTALL=ON -DSUPER_LOG_BUILD_IMGUI_VIEWER=OFF \
    -DCMAKE_INSTALL_PREFIX=/usr >/dev/null
cmake --build build-deb --target superlogd -j >/dev/null
DESTDIR="$STAGE" cmake --install build-deb >/dev/null

# The tailers: zero-dependency Node scripts under /usr/lib/super-log, each
# a wrapper on PATH. Not every tailer is a .mjs - superlog-log is a plain
# POSIX shell script (it has to run where there is no Node at all), so it
# is glob-matched separately and installed as itself, not node-wrapped.
# (Found by actually asserting every tailer lands on PATH, not just a
# couple of spot-checked ones: the .mjs-only glob here silently dropped it
# from every one of deb/rpm/Homebrew until this fix.)
mkdir -p "$STAGE/usr/lib/super-log" "$STAGE/usr/bin"
cp tailers/bin/* "$STAGE/usr/lib/super-log/"
for f in "$STAGE"/usr/lib/super-log/superlog-*.mjs; do
    name="$(basename "$f" .mjs)"
    printf '#!/bin/sh\nexec node /usr/lib/super-log/%s "$@"\n' "$(basename "$f")" > "$STAGE/usr/bin/$name"
    chmod 0755 "$STAGE/usr/bin/$name"
done
for f in "$STAGE"/usr/lib/super-log/superlog-*; do
    case "$f" in *.mjs) continue ;; esac
    name="$(basename "$f")"
    ln -sf "/usr/lib/super-log/$name" "$STAGE/usr/bin/$name"
done
printf '#!/bin/sh\nexec node /usr/lib/super-log/superlog.mjs "$@"\n' > "$STAGE/usr/bin/superlog"
chmod 0755 "$STAGE/usr/bin/superlog"

# The systemd unit and the control metadata.
mkdir -p "$STAGE/usr/lib/systemd/system" "$STAGE/DEBIAN"
cp packaging/deb/superlogd.service "$STAGE/usr/lib/systemd/system/superlogd.service"
sed "s/@VERSION@/$VERSION/; s/@ARCH@/$ARCH/" packaging/deb/control.in > "$STAGE/DEBIAN/control"
cp packaging/deb/postinst "$STAGE/DEBIAN/postinst"
cp packaging/deb/prerm "$STAGE/DEBIAN/prerm"
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm"

OUT="packaging/deb/super-log_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT"
echo "build-deb: wrote $OUT"
dpkg-deb --info "$OUT" | sed -n '1,12p'
