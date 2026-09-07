/*
 *  clock.c - the plain C demo client.
 *
 *  Copyright 2026 Saxon Herschel Nicholls
 *  SPDX-License-Identifier: MIT
 *
 *  The same clock every other demo client runs, once a second on c.clock:
 *  the tick at INFO, a DEBUG pricing pass, a real ERROR when the pricer
 *  meets the symbol it has no rate for, and an uptime metric - so the
 *  stream demonstrates levels, fields and metrics rather than a heartbeat.
 *
 *      cc -DSUPERLOG_DEVELOPMENT -I sdk/c -o clock demo/c/clock.c && ./clock
 *      ./clock --ticks 6        # stop after six, for scripts
 *
 *  Build it with -DSUPERLOG_PRODUCTION instead and the binary contains no
 *  logging at all - `strings` it and look for /ingest/ to prove the point.
 */

#include "superlog.h"

#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;
static void on_int(int sig) { (void)sig; running = 0; }

static double price_for(const char *symbol)
{
    if (strcmp(symbol, "BTC") == 0) return 64000.0;
    if (strcmp(symbol, "ETH") == 0) return 3200.0;
    return -1.0;                /* the honest C spelling of "no rate" */
}

int main(int argc, char **argv)
{
    superlog_t lg;
    int max_ticks = 0, tick = 0, i;
    char buf[64];

    for (i = 1; i < argc - 1; i++)
        if (strcmp(argv[i], "--ticks") == 0) max_ticks = atoi(argv[i + 1]);

    signal(SIGINT, on_int);
    superlog_init(&lg, "c.clock", "clock");

    printf("superlog: c clock -> c.clock\n");
    superlog_info(&lg, "c clock up - one line a second");

    while (running && (max_ticks == 0 || tick < max_ticks)) {
        time_t now = time(NULL);
        struct tm tm;
        const char *symbol;
        double price;

        tick++;
        gmtime_r(&now, &tm);
        superlog_info(&lg, "tick %d - the time is %02d:%02d:%02dZ",
                      tick, tm.tm_hour, tm.tm_min, tm.tm_sec);

        /* Honestly wrong every 7th tick, the same staged failure as every
         * other clock, so one error lines up across every language. */
        symbol = (tick % 7 == 0) ? "DOGE" : "BTC";
        price = price_for(symbol);
        if (price >= 0) {
            snprintf(buf, sizeof buf, "%.1f", price * 2);
            superlog_kv(&lg, "DEBUG", "pricing pass",
                        "symbol", symbol, "price", buf, NULL);
        } else {
            snprintf(buf, sizeof buf, "%d", tick);
            superlog_kv(&lg, "ERROR", "pricing failed: no rate for DOGE",
                        "symbol", symbol, "tick", buf, NULL);
        }

        if (tick % 5 == 0) superlog_metric(&lg, "clock.uptime_s", (double)tick);

        superlog_flush(&lg);
        sleep(1);
    }

    superlog_info(&lg, "c clock stopping");
    superlog_flush(&lg);
    return 0;
}
