#!/usr/bin/env python3
#
#  clock.py - the Python demo client
#
#  Copyright 2026 Saxon Herschel Nicholls
#  SPDX-License-Identifier: MIT
#
#  The same clock the other demo clients run, once a second on topic
#  python.clock - and a tour of what the Python SDK does that the others
#  cannot, because Python hands you frames and context variables that C++
#  and JavaScript do not.
#
#    python3 demo/python/clock.py
#    python3 demo/python/clock.py --crash     # uncaught exception + locals
#
#  What to watch on the bench:
#
#    - ticks carry a `trace` that also covers the work they cause, because
#      the trace lives in a ContextVar and every function called inside the
#      scope inherits it without being passed anything;
#    - lines logged through the standard `logging` module arrive too, with
#      no call-site changes - that is the handler;
#    - a caught exception ships its traceback AND the local variables of
#      the frames that failed, which is the difference between knowing that
#      something broke and knowing why;
#    - --crash proves the excepthook: the traceback still reaches stderr and
#      the exit status is unchanged, but the bench has it too.
#

import logging
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))

import superlog  # noqa: E402


def hms() -> str:
    # UTC like every other demo client - the Rust one has no local timezone
    # without a crate, so the streams agree on UTC instead.
    return datetime.now(timezone.utc).strftime("%H:%M:%S") + "Z"


def price_for(symbol: str, qty: int) -> float:
    """Deliberately fails on one input, so the demo has a real traceback
    with real locals rather than a synthetic one."""
    rate = {"BTC": 64000.0, "ETH": 3200.0}[symbol]
    return rate * qty


def main() -> int:
    log = superlog.SuperLog(
        topic="python.clock",
        app="clock",
        url=os.environ.get("SUPER_LOG_URL", "http://127.0.0.1:7333"),
        development=True,
        production=False,
    )

    # Everything already logged through `logging` reaches the bench, with no
    # changes at any call site. This is the whole point of the handler.
    logging.getLogger().addHandler(log.handler())
    logging.getLogger().setLevel(logging.DEBUG)
    stdlib = logging.getLogger("pricer")

    # Every uncaught exception, in any thread, with the locals that caused it.
    log.install_excepthook(capture_locals=True)

    print("superlog: python clock ->", log.status()["url"], "topic", log.status()["topic"])
    log.info("python clock up - one line a second",
             fields={"python": sys.version.split()[0]})

    if "--crash" in sys.argv:
        # Not caught anywhere: the excepthook logs it with locals, stderr
        # still gets the traceback, and the exit status is still 1.
        depth = 3
        symbol = "DOGE"
        price_for(symbol, depth)

    n = 0
    try:
        while True:
            n += 1
            # One trace per tick, inherited by everything the tick calls -
            # no plumbing, because ContextVars carry it down the stack.
            with log.traced() as tid:
                log.info("tick %d - the time is %s" % (n, hms()),
                         fields={"tick": n})
                stdlib.debug("pricing pass %d", n)          # via logging

                if n % 5 == 0:
                    log.metric("clock.uptime_s", float(n))

                if n % 7 == 0:
                    # A caught exception, logged with the frame locals. The
                    # bench shows symbol='DOGE' and qty=n, which is the
                    # actual reason - a stack alone would not say.
                    try:
                        price_for("DOGE", n)
                    except KeyError:
                        log.exception(where="caught", capture_locals=True,
                                      fields={"tick": n, "trace": tid})
                        stdlib.warning("pricing failed on tick %d", n)
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("python clock down after %d ticks" % n)
        log.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
