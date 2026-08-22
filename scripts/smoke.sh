#!/bin/sh
#
# The one smoke test - run identically by CI, the Ubuntu image build
# (docker/ubuntu.Dockerfile RUNs this, so an image that exists is an image
# that passed) and any terminal. Starts a scratch hub, pushes events through
# every client that was built, and holds the hub's own counters to account:
# green means the whole chain - SDK -> batcher -> POST -> hub - moved real
# events on this machine, not that things merely compiled.
#
#   BUILD_DIR        where the binaries are (default: build)
#   SUPER_LOG_PORT   scratch hub port (default: 7343 - NOT 7333, so a live
#                    bench on the default port is left alone)
#
set -eu
cd "$(dirname "$0")/.."

BUILD_DIR="${BUILD_DIR:-build}"
export SUPER_LOG_HOST="${SUPER_LOG_HOST:-127.0.0.1}"
export SUPER_LOG_PORT="${SUPER_LOG_PORT:-7343}"

fail() { echo "smoke: FAIL - $1" >&2; [ -f "$BUILD_DIR/smoke-hub.log" ] && tail -5 "$BUILD_DIR/smoke-hub.log" >&2; exit 1; }
stat_of() { curl -sf "http://127.0.0.1:${SUPER_LOG_PORT}/healthz" | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p"; }

[ -x "$BUILD_DIR/hub/superlogd" ] || fail "no superlogd in $BUILD_DIR - build first"

"$BUILD_DIR/hub/superlogd" > "$BUILD_DIR/smoke-hub.log" 2>&1 &
HUB=$!
trap 'kill $HUB 2>/dev/null || true; wait 2>/dev/null || true' EXIT INT TERM

i=0
until curl -sf "http://127.0.0.1:${SUPER_LOG_PORT}/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 50 ] && fail "hub not up on :${SUPER_LOG_PORT}"
    sleep 0.1
done

want=0

# 1. The SDK compile test doubles as the SN_LOG -> forward_sink live path
"$BUILD_DIR/super_log_compile_test" >/dev/null || fail "compile test exited non-zero"
want=$((want + 1))

# 2. The demo client - both C++ paths, one tick each - when it was built
#    (it needs the third_party spdlog+fmt submodules)
if [ -x "$BUILD_DIR/demo/cpp/superlog_clock_cpp" ]; then
    "$BUILD_DIR/demo/cpp/superlog_clock_cpp" >/dev/null 2>&1 &
    CLK=$!
    sleep 2                                     # startup lines + >= 1 tick
    kill "$CLK" 2>/dev/null || true             # SIGTERM: the graceful path
    wait "$CLK" 2>/dev/null || true
    want=$((want + 2))                          # >= one POST per topic
fi

# 3. The Rust clock, same treatment, when a build is lying around (CI tests
#    Rust in its own job; locally this widens the net for free)
if [ -x "sdk/rust/target/release/examples/clock" ]; then
    "sdk/rust/target/release/examples/clock" >/dev/null 2>&1 &
    RCLK=$!
    sleep 2
    kill "$RCLK" 2>/dev/null || true
    wait "$RCLK" 2>/dev/null || true
    want=$((want + 1))
fi

sleep 1                                         # let final batches land
published="$(stat_of published)"
dropped="$(stat_of dropped)"
[ -n "$published" ] || fail "healthz unreadable"
[ "$published" -ge "$want" ] || fail "published=$published, wanted >= $want"
[ "$dropped" -eq 0 ] || fail "hub dropped $dropped"

echo "smoke: ok (published=$published dropped=$dropped port=$SUPER_LOG_PORT)"
