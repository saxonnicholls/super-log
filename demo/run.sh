#!/bin/sh
#
# The four-client clock demo: C++ (through spdlog and the vendored
# third_party spdlog+fmt pair), Rust, and the two React Native stand-ins
# (ios / android via @super-log/client) each log the time once a second into
# one superlogd - watched side by side in the React viewer
# (http://localhost:7334) and the native ImGui viewer.
#
# One command, whole bench:  ./demo/run.sh   (or: npm run demo)
# Close the ImGui window or Ctrl-C to tear everything down.
#
set -e
cd "$(dirname "$0")/.."

PORT="${SUPER_LOG_PORT:-7333}"

# Loopback by default: the canned demo needs no LAN (the stand-ins, the
# browser page and the Docker producer all reach loopback), the hub has no
# auth, and once OS logs are on the bench "anyone on the Wi-Fi can read
# every stream" stops being a shrug. SUPER_LOG_LAN=1 opens it up for real
# phones - see docs/ARCHITECTURE.md before doing that on a network you do
# not control.
if [ -n "${SUPER_LOG_LAN:-}" ]; then
    export SUPER_LOG_BIND="${SUPER_LOG_BIND:-0.0.0.0}"
    export SUPER_LOG_WEB_BIND="${SUPER_LOG_WEB_BIND:-0.0.0.0}"
    echo "demo: SUPER_LOG_LAN set - hub and web demo listen on all interfaces"
else
    export SUPER_LOG_BIND="${SUPER_LOG_BIND:-127.0.0.1}"
    export SUPER_LOG_WEB_BIND="${SUPER_LOG_WEB_BIND:-127.0.0.1}"
fi

# ---- build everything first, so the run is start start start, not wait
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --target superlogd superlog_clock_cpp superlog_viewer -j
[ -d node_modules ] || npm install
npm run build --workspace @super-log/client
(cd sdk/rust && cargo build --release --features development --example clock)

# ---- separate processes on purpose: kill any without the others
pids=""
cleanup() {
    trap - EXIT INT TERM
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

./build/hub/superlogd &
pids="$pids $!"
i=0
until curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 50 ] && { echo "demo: hub did not come up on :${PORT}" >&2; exit 1; }
    sleep 0.1
done

./build/demo/cpp/superlog_clock_cpp &
pids="$pids $!"
./sdk/rust/target/release/examples/clock &
pids="$pids $!"
# The RN stand-ins share topics with the real Expo app (demo/expo-clock) on
# purpose - so run one or the other: SUPER_LOG_STANDINS=0 when the real
# app is on the simulators.
if [ "${SUPER_LOG_STANDINS:-1}" != "0" ]; then
    node demo/js/clock.mjs ios &
    pids="$pids $!"
    node demo/js/clock.mjs android &
    pids="$pids $!"
fi
node demo/web/serve.mjs &
pids="$pids $!"
# The other language clients, off by default: each needs its own toolchain
# and a compile, which would make the common demo slow and make a missing
# compiler look like a broken demo. SUPER_LOG_LANGS="go python fortran" and
# so on; anything whose toolchain is absent is named and skipped.
#
# Each compiles in the foreground and runs the resulting binary in the
# background. `build && run &` would background the whole chain, so cleanup
# would kill the wrapper shell and leave the clock it started running.
SL_TMP="${TMPDIR:-/tmp}"
skip() { echo "demo: $1 - skipping $2" >&2; }
for lang in ${SUPER_LOG_LANGS:-}; do
    case "$lang" in
    go)
        # -linkmode=external: Go 1.21's internal linker omits LC_UUID and
        # current macOS dyld refuses the binary outright.
        command -v go >/dev/null || { skip "no go toolchain" go; continue; }
        (cd demo/go && go build -ldflags=-linkmode=external -o "$SL_TMP/sl_clock_go" .) \
            || { skip "go build failed" go; continue; }
        "$SL_TMP/sl_clock_go" &
        pids="$pids $!" ;;
    python)
        command -v python3 >/dev/null || { skip "no python3" python; continue; }
        python3 demo/python/clock.py &
        pids="$pids $!" ;;
    fortran)
        command -v gfortran >/dev/null || { skip "no gfortran" fortran; continue; }
        gfortran -cpp -DDEVELOPMENT -J"$SL_TMP" -o "$SL_TMP/sl_clock_f90" \
            sdk/fortran/superlog.F90 demo/fortran/clock.f90 \
            || { skip "gfortran build failed" fortran; continue; }
        "$SL_TMP/sl_clock_f90" &
        pids="$pids $!" ;;
    java)
        command -v javac >/dev/null || { skip "no javac" java; continue; }
        javac -d "$SL_TMP/sl_java" $(find sdk/java -name '*.java') demo/java/Clock.java \
            || { skip "javac failed" java; continue; }
        java -cp "$SL_TMP/sl_java" Clock &
        pids="$pids $!" ;;
    swift)
        command -v swift >/dev/null || { skip "no swift toolchain" swift; continue; }
        swift build --package-path demo/swift/clock -c release \
            || { skip "swift build failed" swift; continue; }
        ./demo/swift/clock/.build/release/clock &
        pids="$pids $!" ;;
    shell)
        [ -f demo/shell/clock.sh ] || { skip "demo/shell/clock.sh absent" shell; continue; }
        sh demo/shell/clock.sh &
        pids="$pids $!" ;;
    *) echo "demo: unknown SUPER_LOG_LANGS entry '$lang'" >&2 ;;
    esac
done
# This Mac's own OS logs beside the app streams (topic os.<host>). Kernel
# messages, not the whole unified log - unfiltered is thousands of lines a
# second and unreadable; kernel is the "what is the OS doing" feed at a
# human rate. SUPER_LOG_OS_PROCESS widens or narrows it.
node tailers/bin/superlog-tail.mjs os --process "${SUPER_LOG_OS_PROCESS:-kernel}" &
pids="$pids $!"
# Remote machines' OS logs over ssh (topic os.<name> each): OS auto-detected,
# nothing installed remotely, logs travel over ssh so the hub stays loopback.
# my-server is this bench's box; SUPER_LOG_SSH_HOSTS="a b c" for others,
# SUPER_LOG_SSH_HOSTS= (empty) for none. Unreachable hosts just retry.
for h in ${SUPER_LOG_SSH_HOSTS-my-server}; do
    node tailers/bin/superlog-tail.mjs ssh "$h" &
    pids="$pids $!"
done
# Well-known app logs on THIS machine (postgres, nginx, redis, ... - the
# catalog): `node tailers/bin/superlog-tail.mjs apps` shows what exists
# here; SUPER_LOG_APPS="postgres nginx" turns them on.
if [ -n "${SUPER_LOG_APPS:-}" ]; then
    node tailers/bin/superlog-tail.mjs app ${SUPER_LOG_APPS} &
    pids="$pids $!"
fi
npm run viewer &
pids="$pids $!"

sleep 2
if command -v open >/dev/null 2>&1; then
    open "http://localhost:7334"                # the viewer
    open "http://localhost:7335"                # the browser clock (web.clock)
fi

# Foreground, not exec: closing the window must still run the cleanup trap
./build/viewer/imgui/superlog_viewer
