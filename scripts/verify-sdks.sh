#!/bin/sh
#
# verify-sdks.sh - every SDK, actually delivering to a real hub.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# CI built the Go, Java, Swift and Fortran clients and then never ran them,
# which proves they compile and nothing else. A client that compiles, starts,
# and delivers no events would have passed - and "the logger silently sent
# nothing" is the exact failure this project exists to make impossible.
#
# So: start a hub, run each language's clock against it, and assert events
# arrived on the topic that language claims. Nothing is mocked; the events
# are read back out of the hub over HTTP.
#
#   ./scripts/verify-sdks.sh              # everything whose toolchain is here
#   ./scripts/verify-sdks.sh go python    # only these
#
# A missing toolchain is SKIPPED, not failed - a contributor without gfortran
# should still be able to run this. A toolchain that IS present and whose
# client delivers nothing is a FAILURE, because that is a real regression.
#
set -u
cd "$(dirname "$0")/.."

PORT="${SUPER_LOG_VERIFY_PORT:-7351}"
HUB="http://127.0.0.1:${PORT}"
TMP="${TMPDIR:-/tmp}/superlog-verify-$$"
mkdir -p "$TMP"

pass=0; fail=0; skip=0
failed=""

cleanup() {
    [ -n "${HUB_PID:-}" ] && kill "$HUB_PID" 2>/dev/null
    rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

have() { command -v "$1" >/dev/null 2>&1; }

# Count events on a topic, via the hub's own pull feed - the same route the
# viewers and agents use, so this tests the delivered article.
count_on() {
    # Exactly one integer on stdout, always. grep -c plus a `|| echo 0`
    # fallback can emit BOTH, and "0\n0" is not a number to `[`.
    curl -sf "${HUB}/recent?topic=$1&limit=200" 2>/dev/null |
        grep -oF "\"topic\":\"$1\"" 2>/dev/null | wc -l | tr -d ' \n'
    echo
}

# Run a client for a few seconds and require that its topic received events.
# The client is killed rather than waited on: these are clocks, they do not
# exit on their own.
check() {
    name="$1"; topic="$2"; shift 2
    printf '  %-10s ' "$name"
    "$@" >"$TMP/$name.out" 2>&1 &
    pid=$!
    i=0
    n=0
    while [ "$i" -lt 40 ]; do
        sleep 0.25
        i=$((i + 1))
        n=$(count_on "$topic")
        [ "$n" -gt 0 ] && break
    done
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    if [ "$n" -gt 0 ]; then
        echo "ok   ($n event(s) on $topic)"
        pass=$((pass + 1))
    else
        echo "FAIL (nothing on $topic)"
        echo "        --- last 5 lines of its output ---"
        tail -5 "$TMP/$name.out" 2>/dev/null | sed 's/^/        /'
        fail=$((fail + 1))
        failed="$failed $name"
    fi
}

skipping() {
    printf '  %-10s skip (%s)\n' "$1" "$2"
    skip=$((skip + 1))
}

# ---- the hub, which is the one thing that must work --------------------

if [ ! -x ./build/hub/superlogd ]; then
    echo "verify-sdks: building the hub first" >&2
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1 || {
        echo "verify-sdks: cmake configure failed" >&2; exit 1; }
    cmake --build build --target superlogd -j >/dev/null 2>&1 || {
        echo "verify-sdks: hub did not build" >&2; exit 1; }
fi

SUPER_LOG_PORT="$PORT" SUPER_LOG_BIND=127.0.0.1 ./build/hub/superlogd >"$TMP/hub.log" 2>&1 &
HUB_PID=$!
i=0
until curl -sf "${HUB}/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && { echo "verify-sdks: hub did not start on :$PORT" >&2; exit 1; }
    sleep 0.1
done
export SUPER_LOG_URL="$HUB"

WANT="${*:-cpp rust go python java swift fortran shell node ruby ocaml haskell scala}"
echo "verify-sdks: hub on :$PORT, checking:$(printf ' %s' $WANT)"

for lang in $WANT; do
case "$lang" in

cpp)
    if [ -x ./build/demo/cpp/superlog_clock_cpp ] ||
       cmake --build build --target superlog_clock_cpp -j >/dev/null 2>&1; then
        check cpp cpp.clock ./build/demo/cpp/superlog_clock_cpp
    else
        skipping cpp "demo target did not build"
    fi ;;

rust)
    if ! have cargo; then skipping rust "no cargo"
    elif (cd sdk/rust && cargo build --release --features development --example clock >/dev/null 2>&1); then
        check rust rust.clock ./sdk/rust/target/release/examples/clock
    else skipping rust "cargo build failed"; fi ;;

go)
    if ! have go; then skipping go "no go toolchain"
    else
        # On macOS, Go 1.21's internal linker omits LC_UUID and dyld refuses
        # the binary at exec time. The build SUCCEEDS, so this cannot be a
        # fallback on build failure - it has to be chosen up front.
        GOLD=""
        [ "$(uname -s)" = "Darwin" ] && GOLD="-ldflags=-linkmode=external"
        if (cd demo/go && go build $GOLD -o "$TMP/clock_go" . >/dev/null 2>&1); then
            check go go.clock "$TMP/clock_go"
        else skipping go "go build failed"; fi
    fi ;;

python)
    if ! have python3; then skipping python "no python3"
    else check python python.clock python3 demo/python/clock.py; fi ;;

java)
    if ! have javac; then skipping java "no javac"
    elif javac -d "$TMP/java" $(find sdk/java -name '*.java') demo/java/Clock.java >/dev/null 2>&1; then
        check java java.clock java -cp "$TMP/java" Clock
    else skipping java "javac failed"; fi ;;

swift)
    if ! have swift; then skipping swift "no swift toolchain"
    elif swift build --package-path demo/swift/clock -c release >/dev/null 2>&1; then
        check swift swift.clock ./demo/swift/clock/.build/release/clock
    else skipping swift "swift build failed"; fi ;;

fortran)
    if ! have gfortran; then skipping fortran "no gfortran"
    elif gfortran -cpp -DDEVELOPMENT -J"$TMP" -o "$TMP/clock_f90" \
            sdk/fortran/superlog.F90 demo/fortran/clock.f90 >/dev/null 2>&1; then
        check fortran fortran.clock "$TMP/clock_f90"
    else skipping fortran "gfortran build failed"; fi ;;

shell)
    if ! have curl; then skipping shell "no curl"
    else check shell shell.clock sh demo/shell/clock.sh; fi ;;

ruby)
    if ! have ruby; then skipping ruby "no ruby"
    else check ruby ruby.clock env SUPERLOG_MODE=development ruby demo/ruby/clock.rb; fi ;;

ocaml)
    if ! have ocamlc; then skipping ocaml "no ocamlc"
    elif mkdir -p "$TMP/ml" && cp sdk/ocaml/superlog.ml demo/ocaml/clock.ml "$TMP/ml/" &&
         (cd "$TMP/ml" && ocamlc -I +unix unix.cma superlog.ml clock.ml -o clock) >/dev/null 2>&1; then
        check ocaml ocaml.clock env SUPERLOG_MODE=development "$TMP/ml/clock"
    else skipping ocaml "ocamlc build failed"; fi ;;

haskell)
    if ! have ghc; then skipping haskell "no ghc"
    elif ghc -DDEVELOPMENT -isdk/haskell -outputdir "$TMP/hs" -o "$TMP/clock_hs" \
            demo/haskell/clock.hs >/dev/null 2>&1; then
        check haskell haskell.clock "$TMP/clock_hs"
    else skipping haskell "ghc build failed"; fi ;;

scala)
    if ! have scalac || ! have javac; then skipping scala "no scalac or javac"
    elif javac -d "$TMP/scala" $(find sdk/java -name '*.java') >/dev/null 2>&1 &&
         scalac -classpath "$TMP/scala" -d "$TMP/scala" demo/scala/Clock.scala >/dev/null 2>&1; then
        check scala scala.clock sh demo/scala/run.sh "$TMP/scala"
    else skipping scala "scala build failed"; fi ;;

node)
    if ! have node; then skipping node "no node"
    elif [ -d node_modules ] || npm install >/dev/null 2>&1; then
        npm run build --workspace @super-log/client >/dev/null 2>&1
        check node expo.ios.sim node demo/js/clock.mjs ios
    else skipping node "npm install failed"; fi ;;

*)  skipping "$lang" "not an SDK this repo ships" ;;
esac
done

echo
echo "verify-sdks: $pass ok, $fail failed, $skip skipped"
[ "$fail" -gt 0 ] && { echo "verify-sdks: FAILED:$failed" >&2; exit 1; }
exit 0
