#!/bin/sh
#
#  run.sh - build and run the COBOL clock.
#
#  Copyright 2026 Saxon Herschel Nicholls
#  SPDX-License-Identifier: MIT
#
#  The mode is compiled into the C shim, exactly like any C program -
#  which is the point: a production COBOL binary inherits the C SDK's
#  provably-absent story. Try it:
#
#    SUPERLOG_MODE=production sh demo/cobol/run.sh --build-only
#    strings demo/cobol/clock | grep -c 7333        # 0. It is not in there.
#
set -eu
cd "$(dirname "$0")"

case "${SUPERLOG_MODE:-}" in
  development) DEF=-DSUPERLOG_DEVELOPMENT ;;
  production)  DEF=-DSUPERLOG_PRODUCTION ;;
  *) echo "superlog: SUPERLOG_MODE is '${SUPERLOG_MODE:-}' - declare development or production; there is no default, because deciding is the point." >&2
     exit 2 ;;
esac

cc "$DEF" -I ../../sdk/c -c shim.c -o shim.o
cobc -x -free -o clock clock.cob shim.o

[ "${1:-}" = "--build-only" ] && exit 0
exec ./clock
