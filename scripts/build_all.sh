#!/bin/sh
#
# build_all.sh - rebuild everything super-log compiles here, in one go.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# The C++ via cmake - the hub (superlogd), the native ImGui viewer
# (superlog_viewer), the header-only SDK compile tests, and any demos that are
# configured - plus the React web viewer via npm. install.sh does build +
# verify + run-at-login; this is JUST the build, all targets, for a fast
# rebuild after editing.
#
#   scripts/build_all.sh              # rebuild everything (incremental)
#   scripts/build_all.sh --clean      # wipe build/ first (from scratch)
#   scripts/build_all.sh --no-viewer  # hub + SDK tests only (headless boxes)
#
set -eu
cd "$(dirname "$0")/.."

VIEWER=ON
for a in "$@"; do
    case "$a" in
        --clean)     echo "build_all: wiping build/"; rm -rf build ;;
        --no-viewer) VIEWER=OFF ;;
        -h|--help)   sed -n '11,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "build_all: unknown option '$a' (try --help)" >&2; exit 2 ;;
    esac
done

command -v cmake >/dev/null || { echo "build_all: cmake not found" >&2; exit 1; }

# JS deps only when missing - `npm ci` is slow and a rebuild rarely needs it.
if [ -f package.json ] && [ ! -d node_modules ]; then
    echo "build_all: node_modules missing - npm ci"
    npm ci
fi

echo "build_all: cmake configure (viewer $VIEWER)"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSUPER_LOG_BUILD_IMGUI_VIEWER="$VIEWER"
echo "build_all: cmake build (all targets)"
cmake --build build -j

# The React web viewer, if its workspace is present.
if [ -f viewer/react/package.json ]; then
    echo "build_all: React web viewer"
    npm run build --workspace @super-log/viewer-react \
      || echo "build_all: web viewer build failed - run 'npm ci' and retry"
fi

echo
echo "build_all: done. Built:"
for f in build/hub/superlogd build/viewer/imgui/superlog_viewer; do
    [ -f "$f" ] && echo "  $f"
done
[ -d viewer/react/dist ] && echo "  viewer/react/dist (web viewer)"
echo
echo "  run the hub:     ./scripts/dev.sh          (or build/hub/superlogd)"
echo "  open the viewer: superlog viewer"
echo "  verify + smoke:  ./scripts/verify-sdks.sh ; ./scripts/smoke.sh"
