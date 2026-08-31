#!/bin/sh
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# The whole bench, one command:  ./demo/run.sh   (or: npm run demo)
#
# Every client this repo ships is attempted - C++ through both paths, Rust,
# Go, Python, Java, Swift, Fortran, shell, the two React Native stand-ins and
# the browser page - plus this machine's OS log and both viewers.
#
# Nothing here is required. A missing toolchain is not an error and must not
# be one: a stranger cloning this will not have gfortran, and a demo that
# dies on that teaches them the project is broken rather than that one
# optional client was skipped. So every producer is attempted, every failure
# is caught, and - this is the point - every failure is PUBLISHED to the
# hub as a WARN on demo.launcher.
#
# That is the honest version of a demo: what could not start is on the same
# screen as what did, with the reason, rather than in a terminal nobody
# scrolls back through. It is also a fair test of the thing being
# demonstrated - the first job of a logger is to tell you what did not work.
#
# Close the ImGui window or Ctrl-C to tear everything down.
#
cd "$(dirname "$0")/.."

PORT="${SUPER_LOG_PORT:-7333}"
HUB="http://127.0.0.1:${PORT}"

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
export SUPER_LOG_URL="$HUB"

pids=""
started=""
skipped=""

# ---- the hub itself is the one hard requirement -------------------------
#
# Everything below reports its failures BY logging them, so the hub has to
# exist before anything else is allowed to fail. If this part breaks there
# is nowhere to say so, and the script says it on stderr and stops.

if ! cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1; then
    echo "demo: cmake configure failed. Run it directly to see why:" >&2
    echo "      cmake -S . -B build -DCMAKE_BUILD_TYPE=Release" >&2
    exit 1
fi
if ! cmake --build build --target superlogd -j >/dev/null 2>&1; then
    echo "demo: the hub did not build. Run it directly to see why:" >&2
    echo "      cmake --build build --target superlogd -j" >&2
    exit 1
fi

./build/hub/superlogd &
pids="$pids $!"
i=0
until curl -sf "${HUB}/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 50 ] && { echo "demo: hub did not come up on :${PORT}" >&2; exit 1; }
    sleep 0.1
done

cleanup() {
    trap - EXIT INT TERM
    [ -n "$pids" ] && kill $pids 2>/dev/null
    wait 2>/dev/null
    return 0
}
trap cleanup EXIT INT TERM

# ---- say things, on the bench and on the terminal -----------------------

note() {
    _lvl="$1"; _msg="$2"; _what="$3"
    echo "demo: $_msg" >&2
    ./tailers/bin/superlog-log --development --quiet --url "$HUB" \
        --topic demo.launcher --level "$_lvl" --tag launcher \
        --field "component=$_what" -- "$_msg" 2>/dev/null || true
}

# Run a producer, or say why not. Never returns non-zero: a missing client
# must not end the demo, and `set -e` is deliberately not in force here.
start() {
    _what="$1"; shift
    "$@" &
    pids="$pids $!"
    started="$started $_what"
    note INFO "started $_what" "$_what"
}
skip() {
    skipped="$skipped $1"
    note WARN "$1 not started: $2" "$1"
}
have() { command -v "$1" >/dev/null 2>&1; }

note INFO "demo starting - attempting every client this repo ships" launcher

# ---- C++ (both paths) and the native viewer ------------------------------

if cmake --build build --target superlog_clock_cpp -j >/dev/null 2>&1; then
    start "cpp.clock" ./build/demo/cpp/superlog_clock_cpp
else
    skip "cpp.clock" "the C++ demo target did not build"
fi

# ---- Rust ---------------------------------------------------------------

if ! have cargo; then
    skip "rust.clock" "no cargo on PATH"
elif (cd sdk/rust && cargo build --release --features development --example clock >/dev/null 2>&1); then
    start "rust.clock" ./sdk/rust/target/release/examples/clock
else
    skip "rust.clock" "cargo build failed"
fi

# ---- the JS client, the RN stand-ins and the browser page ---------------

if ! have node; then
    skip "js" "no node on PATH - the stand-ins, browser page, tailers and web viewer all need it"
else
    [ -d node_modules ] || npm install >/dev/null 2>&1
    if npm run build --workspace @super-log/client >/dev/null 2>&1; then
        # The stand-ins share topics with the real Expo app (demo/expo-clock)
        # on purpose - run one or the other. SUPER_LOG_STANDINS=0 when the
        # real app is on the simulators.
        if [ "${SUPER_LOG_STANDINS:-1}" != "0" ]; then
            start "expo.ios.sim" node demo/js/clock.mjs ios
            start "expo.android.emu" node demo/js/clock.mjs android
        else
            skip "expo stand-ins" "SUPER_LOG_STANDINS=0 - expecting the real Expo app"
        fi
        start "web.clock" node demo/web/serve.mjs
    else
        skip "js" "@super-log/client did not build"
    fi
fi

# ---- every other language client ----------------------------------------
#
# Attempted by default, because "one hub for every log stream" is a claim
# that should be visible on first run rather than behind an env var. Each
# compiles in the FOREGROUND and backgrounds the resulting binary: `build &&
# run &` would background the whole chain, so cleanup would kill the wrapper
# shell and leave the clock it started running.

SL_TMP="${TMPDIR:-/tmp}"
for lang in ${SUPER_LOG_LANGS:-c go python java swift fortran shell ruby scala haskell ocaml lean}; do
    case "$lang" in
    c)
        if ! have cc; then skip "c.clock" "no C compiler"
        elif cc -DSUPERLOG_DEVELOPMENT -I sdk/c -o "$SL_TMP/sl_clock_c" demo/c/clock.c >/dev/null 2>&1; then
            start "c.clock" "$SL_TMP/sl_clock_c"
        else skip "c.clock" "cc build failed"; fi ;;
    go)
        if ! have go; then skip "go.clock" "no go toolchain"
        # -linkmode=external: Go 1.21's internal linker omits LC_UUID and
        # current macOS dyld refuses the binary outright.
        elif (cd demo/go && go build -ldflags=-linkmode=external -o "$SL_TMP/sl_clock_go" . >/dev/null 2>&1); then
            start "go.clock" "$SL_TMP/sl_clock_go"
        else skip "go.clock" "go build failed"; fi ;;
    python)
        if ! have python3; then skip "python.clock" "no python3"
        else start "python.clock" python3 demo/python/clock.py; fi ;;
    java)
        if ! have javac; then skip "java.clock" "no javac"
        elif javac -d "$SL_TMP/sl_java" $(find sdk/java -name '*.java') demo/java/Clock.java >/dev/null 2>&1; then
            start "java.clock" java -cp "$SL_TMP/sl_java" Clock
        else skip "java.clock" "javac failed"; fi ;;
    swift)
        if ! have swift; then skip "swift.clock" "no swift toolchain"
        elif swift build --package-path demo/swift/clock -c release >/dev/null 2>&1; then
            start "swift.clock" ./demo/swift/clock/.build/release/clock
        else skip "swift.clock" "swift build failed"; fi ;;
    metal)
        # macOS only, because Metal is. Skipped elsewhere rather than failed.
        if [ "$(uname -s)" != "Darwin" ]; then skip "gpu.metal.clock" "Metal is macOS only"
        elif ! have swift; then skip "gpu.metal.clock" "no swift toolchain"
        elif swift build --package-path demo/metal/gpuclock -c release >/dev/null 2>&1; then
            start "gpu.metal.clock" ./demo/metal/gpuclock/.build/release/gpuclock
        else skip "gpu.metal.clock" "swift build failed"; fi ;;
    fortran)
        if ! have gfortran; then skip "fortran.clock" "no gfortran"
        elif gfortran -cpp -DDEVELOPMENT -J"$SL_TMP" -o "$SL_TMP/sl_clock_f90" \
                sdk/fortran/superlog.F90 demo/fortran/clock.f90 >/dev/null 2>&1; then
            start "fortran.clock" "$SL_TMP/sl_clock_f90"
        else skip "fortran.clock" "gfortran build failed"; fi ;;
    shell)
        if [ ! -f demo/shell/clock.sh ]; then skip "shell.clock" "demo/shell/clock.sh missing"
        elif ! have curl; then skip "shell.clock" "no curl"
        else start "shell.clock" sh demo/shell/clock.sh; fi ;;
    ruby)
        if ! have ruby; then skip "ruby.clock" "no ruby"
        else SUPERLOG_MODE=development start "ruby.clock" ruby demo/ruby/clock.rb; fi ;;
    scala)
        if ! have scalac || ! have javac; then skip "scala.clock" "no scalac (brew install scala)"
        elif javac -d "$SL_TMP/sl_scala" $(find sdk/java -name '*.java') >/dev/null 2>&1 &&
             scalac -classpath "$SL_TMP/sl_scala" -d "$SL_TMP/sl_scala" demo/scala/Clock.scala >/dev/null 2>&1; then
            start "scala.clock" sh demo/scala/run.sh "$SL_TMP/sl_scala"
        else skip "scala.clock" "scala build failed"; fi ;;
    haskell)
        if ! have ghc; then skip "haskell.clock" "no ghc (brew install ghc)"
        elif ghc -DDEVELOPMENT -isdk/haskell -outputdir "$SL_TMP/sl_hs" -o "$SL_TMP/sl_clock_hs" \
                demo/haskell/clock.hs >/dev/null 2>&1; then
            start "haskell.clock" "$SL_TMP/sl_clock_hs"
        else skip "haskell.clock" "ghc build failed"; fi ;;
    lean)
        if ! have lake; then skip "lean.clock" "no lake (elan default stable)"
        elif (cd demo/lean && lake build) >/dev/null 2>&1; then
            SUPERLOG_MODE=development start "lean.clock" ./demo/lean/.lake/build/bin/clock
        else skip "lean.clock" "lake build failed"; fi ;;
    ocaml)
        if ! have ocamlc; then skip "ocaml.clock" "no ocamlc (brew install ocaml)"
        elif mkdir -p "$SL_TMP/sl_ml" && cp sdk/ocaml/superlog.ml demo/ocaml/clock.ml "$SL_TMP/sl_ml/" &&
             (cd "$SL_TMP/sl_ml" && ocamlc -I +unix unix.cma superlog.ml clock.ml -o clock) >/dev/null 2>&1; then
            SUPERLOG_MODE=development start "ocaml.clock" "$SL_TMP/sl_ml/clock"
        else skip "ocaml.clock" "ocamlc build failed"; fi ;;
    *) skip "$lang" "not a client this repo ships" ;;
    esac
done

# ---- machines and services ----------------------------------------------

if have node; then
    # This Mac's own OS logs beside the app streams (topic os.<host>). Kernel
    # messages, not the whole unified log - unfiltered is thousands of lines a
    # second and unreadable; kernel is the "what is the OS doing" feed at a
    # human rate. SUPER_LOG_OS_PROCESS widens or narrows it.
    start "os.$(hostname -s 2>/dev/null || echo local)" \
        node tailers/bin/superlog-tail.mjs os --process "${SUPER_LOG_OS_PROCESS:-kernel}"

    # Remote machines' OS logs over ssh (topic os.<name> each): OS
    # auto-detected, nothing installed remotely, logs travel over ssh so the
    # hub stays loopback-bound. Off unless you name hosts - defaulting to a
    # real box would make a stranger's first run open with a connection error.
    for h in ${SUPER_LOG_SSH_HOSTS:-}; do
        start "os.$h" node tailers/bin/superlog-tail.mjs ssh "$h"
    done

    # This repository's own git activity, so a commit made while the demo is
    # running appears on the bench next to the build it triggered. It is the
    # cheapest demonstration of why a git stream belongs here at all: "what
    # changed" and "what then broke" on one screen, in order.
    if [ -d .git ]; then
        start "git.super-log" node tailers/bin/superlog-git.mjs \
            --repo "$PWD" --topic git.super-log
    fi

    # Power and thermals (topic power.<host>). macOS only, and on macOS it is
    # NOT optional: this machine sat at 1258% aggregate CPU - eleven saturated
    # cores, one VS Code extension - until the fans said so, and it has
    # crashed under runaway draw. Watts need root (see
    # scripts/install-power-tailer.sh); without that the tailer still
    # publishes thermal pressure, aggregate CPU and the top consumers, so it
    # starts regardless and says in-band what is missing.
    if [ "$(uname -s)" = "Darwin" ]; then
        start "power.$(hostname -s 2>/dev/null || echo local)" \
            node tailers/bin/superlog-power.mjs
        # The machine's own life events - crashes, panics, shutdown causes,
        # volume renames, sleep/wake. Also NOT optional on macOS: this bench
        # crashed four times with the evidence sitting unread in
        # DiagnosticReports, and its last shutdown cause was -108.
        start "sys.$(hostname -s 2>/dev/null || echo local)" \
            node tailers/bin/superlog-sys.mjs
    fi

    # Well-known app logs on THIS machine (postgres, nginx, redis, ...):
    # `superlog-tail apps` shows what exists here.
    if [ -n "${SUPER_LOG_APPS:-}" ]; then
        start "apps" node tailers/bin/superlog-tail.mjs app ${SUPER_LOG_APPS}
    fi
fi

# ---- viewers ------------------------------------------------------------

if have node; then
    start "viewer.react" npm run viewer
else
    skip "viewer.react" "no node on PATH"
fi

# ---- what actually happened ---------------------------------------------

n_started=$(echo $started | wc -w | tr -d ' ')
n_skipped=$(echo $skipped | wc -w | tr -d ' ')
if [ "$n_skipped" -gt 0 ]; then
    note WARN "$n_started client(s) started, $n_skipped skipped:$skipped" launcher
else
    note INFO "$n_started client(s) started, none skipped" launcher
fi

sleep 2
if have open; then
    open "http://localhost:7334"                # the viewer
    open "http://localhost:7335"                # the browser clock (web.clock)
fi

# The native viewer runs in the FOREGROUND, not exec: closing its window must
# still run the cleanup trap. If it did not build, hold here instead so the
# rest of the demo keeps running.
if [ -x ./build/viewer/imgui/superlog_viewer ] ||
   cmake --build build --target superlog_viewer -j >/dev/null 2>&1; then
    ./build/viewer/imgui/superlog_viewer
else
    note WARN "viewer.imgui not started: it did not build (glfw/OpenGL headers?)" viewer.imgui
    echo "demo: running without the native viewer - Ctrl-C to stop" >&2
    wait
fi
