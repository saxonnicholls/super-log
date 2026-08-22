#!/bin/sh
#
# Container entry: journald without systemd-as-PID-1. Start journald by
# hand, feed the clock's console through systemd-cat so the journal has
# something honest in it, and tail it back out with the os-linux tailer as
# os.<hostname> - the Linux half of "OS logs beside app logs", and the live
# verification of that tailer against a real journald.
#
# Copyright 2026 Saxon Herschel Nicholls
#
set -e

[ -s /etc/machine-id ] || systemd-machine-id-setup >/dev/null 2>&1 || true
mkdir -p /run/systemd/journal

JD=/usr/lib/systemd/systemd-journald
[ -x "$JD" ] || JD=/lib/systemd/systemd-journald
"$JD" &

# systemd-cat talks to the stdout stream socket; wait for journald to open it
i=0
until [ -S /run/systemd/journal/stdout ]; do
    i=$((i + 1))
    [ "$i" -gt 50 ] && { echo "entry: journald did not come up" >&2; exit 1; }
    sleep 0.1
done

export SUPER_LOG_URL="http://${SUPER_LOG_HOST:-host.docker.internal}:${SUPER_LOG_PORT:-7333}"
node /opt/superlog/tailers/bin/superlog-tail.mjs os-linux &

# The clock's console rides into the journal, so the same process shows on
# its app topics AND in the OS stream - which is the whole demo.
exec sh -c 'superlog_clock_cpp 2>&1 | systemd-cat -t clock'
