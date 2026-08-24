#!/bin/sh
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# Build and run the hub, then print how to point everything else at it.
# The pieces are separate processes on purpose - kill any without the others.
set -e
cd "$(dirname "$0")/.."

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build build --target superlogd -j >/dev/null

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "<your-lan-ip>")
PORT="${SUPER_LOG_PORT:-7333}"

cat <<EOF
superlogd starting on port ${PORT}. Point the streams at it:

  web viewer     npm install && npm run viewer          (http://localhost:7334)
  android emu    npm run tail:android
  android hw     adb reverse tcp:${PORT} tcp:${PORT}    # then tail with --serial <hw>
  ios sim        npm run tail:ios-sim
  ios hw         in-app SDK -> http://${LAN_IP}:${PORT} (same Wi-Fi)
  smoke test     ./build/super_log_compile_test
  health         curl http://127.0.0.1:${PORT}/healthz

EOF
exec ./build/hub/superlogd
