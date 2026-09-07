/*
 *  shim.c - the two dozen lines between COBOL and the bench.
 *
 *  Copyright 2026 Saxon Herschel Nicholls
 *  SPDX-License-Identifier: MIT
 *
 *  GnuCOBOL compiles to C and CALLs C by symbol, so COBOL does not need
 *  a fourteenth SDK - it needs the header-only C SDK's functions exported
 *  as linkable symbols (they are static inline in the header, invisible
 *  across translation units). One static logger, initialised once,
 *  because a COBOL program passing structs by reference to C is more
 *  ceremony than a demo deserves.
 *
 *  The mode is compiled into THIS file: -DSUPERLOG_DEVELOPMENT or
 *  -DSUPERLOG_PRODUCTION, exactly like any C program - so a production
 *  COBOL binary inherits the C SDK's provably-absent story, strings(1)
 *  check included.
 */

#include <superlog.h>

static superlog_t lg;

void cobol_superlog_init(const char *topic, const char *app)
{
    superlog_init(&lg, topic, app);
}

void cobol_superlog_log(const char *level, const char *msg)
{
    superlog_logf(&lg, level, "%s", msg);
}

void cobol_superlog_metric(const char *name, const double *value)
{
    superlog_metric(&lg, name, *value);
}

void cobol_superlog_flush(void)
{
    superlog_flush(&lg);
}
