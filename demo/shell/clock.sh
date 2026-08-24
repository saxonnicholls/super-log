#!/bin/sh
#
# clock.sh - the shell demo client
#
# Copyright 2026 Saxon Herschel Nicholls
#
# The same clock the other demo clients run, once a second on topic
# shell.clock, through tailers/bin/superlog-log. The point it makes that
# the others cannot: this producer has no SDK, no runtime and no build
# step. sh and curl are the entire dependency list, which is exactly what
# is on a box you have just ssh-ed into at two in the morning.
#
#   ./demo/shell/clock.sh
#   SUPER_LOG_URL=http://bench:7333 ./demo/shell/clock.sh
#
# What to watch on the bench:
#
#   - the ticks carry a `trace` that also covers the work each tick
#     causes, so one id joins the tick, its pricing pass and its failure -
#     the same story the Python and Go clocks tell with context variables,
#     told here by passing --trace;
#   - the banner arrives as three lines in *one* POST, because the pipe
#     form batches: that is the shape a `tail -f` takes;
#   - every seventh tick fails on purpose, so the viewer has an ERROR row
#     to colour and something for the level filter to find.
#
# Ctrl-C stops it, and the last lines still arrive.
#
set -u
cd "$(dirname "$0")/../.." || exit 1

# This script is a development consumer and says so, the same way the Rust
# demo asks for --features development and the Go one passes Development:
# true. superlog-log refuses to run without a declaration - deciding is the
# point - and an operator can still overrule this from the environment.
export SUPERLOG_MODE="${SUPERLOG_MODE:-development}"
export SUPER_LOG_URL="${SUPER_LOG_URL:-http://127.0.0.1:7333}"

LOG=./tailers/bin/superlog-log
TOPIC="${SUPER_LOG_TOPIC:-shell.clock}"
APP=clock

[ -x "$LOG" ] || { echo "demo: $LOG is missing or not executable" >&2; exit 1; }

# One trace per tick. Correlation ids are opaque (PROTOCOL.md) - 16 hex
# characters here to match what the JS client mints, so a trace from a
# phone and a trace from a shell script look like the same kind of thing.
trace_id() {
    _t=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null |
         awk '{ for (i = 1; i <= NF; i++) printf "%s", $i }')
    if [ -z "$_t" ]; then
        _t=$(awk -v p="$$" -v n="${1:-0}" 'BEGIN {
            srand(); s = srand(); srand(s + p + n)
            printf "%04x%04x%04x%04x", int(rand() * 65536), int(rand() * 65536),
                   int(rand() * 65536), int(rand() * 65536)
        }')
    fi
    printf '%s' "$_t"
}

ticks=0
down() {
    trap - EXIT INT TERM
    "$LOG" --topic "$TOPIC" --app "$APP" --field ticks="$ticks" \
        "shell clock down after $ticks ticks"
    exit 0
}
trap down EXIT INT TERM

"$LOG" --topic "$TOPIC" --app "$APP" --status

# The pipe form, once, so the demo exercises both shapes it has: three
# lines in, one POST out, one hub frame.
printf '%s\n' \
    "shell clock up - one line a second" \
    "host: $(uname -s) $(uname -r) $(uname -m)" \
    "hub: $SUPER_LOG_URL topic: $TOPIC" |
    "$LOG" --topic "$TOPIC" --app "$APP" --level DEBUG --field boot=1

while :; do
    ticks=$((ticks + 1))
    trace=$(trace_id "$ticks")
    now=$(date -u +%H:%M:%SZ)

    "$LOG" --topic "$TOPIC" --app "$APP" --trace "$trace" \
        --field tick="$ticks" "tick $ticks - the time is $now"

    if [ $((ticks % 5)) -eq 0 ]; then
        # Same trace as the tick that caused it, which is the whole
        # correlation story: the viewer filters on it and gets both.
        "$LOG" --topic "$TOPIC" --app "$APP" --level DEBUG --trace "$trace" \
            --tag pricing --field tick="$ticks" "pricing pass $ticks"
    fi

    if [ $((ticks % 7)) -eq 0 ]; then
        # A deliberate failure, quoted the way a real error message is -
        # with the shell metacharacters and the quotes a naive logger
        # would corrupt its own stream on.
        "$LOG" --topic "$TOPIC" --app "$APP" --level ERROR --trace "$trace" \
            --tag pricing --field symbol=DOGE --field tick="$ticks" \
            "pricing failed on tick $ticks: no rate for \"DOGE\" (rates: {\"BTC\", \"ETH\"})"
    fi

    sleep 1
done
