/*
 *  superlog.h - the plain C client, header-only, BSD/Winsock sockets and libc.
 *
 *  Copyright 2026 Saxon Herschel Nicholls
 *  SPDX-License-Identifier: MIT
 *
 *  One header, stb-style: include it, compile with the mode declared, done.
 *  No allocation - the caller owns a superlog_t on the stack or in static
 *  storage and the batch buffer lives inside it. C99 plus POSIX sockets,
 *  the Fortran client's wire spoken from the language everything else is
 *  built on.
 *
 *      #include "superlog.h"
 *
 *      superlog_t lg;
 *      superlog_init(&lg, "c.engine", "engine");
 *      superlog_info(&lg, "engine up, port %d", 9000);
 *      superlog_kv(&lg, "ERROR", "no rate", "symbol", "DOGE", NULL);
 *      superlog_metric(&lg, "queue.depth", 17);
 *      superlog_flush(&lg);
 *
 *  The mode is compile-time, exactly as the C++ header: define
 *  SUPERLOG_DEVELOPMENT xor SUPERLOG_PRODUCTION - neither or both refuses
 *  to compile, because deciding is the point - and PRODUCTION compiles
 *  every function here to an empty stub: no sockets, no strings, no code
 *  path for anything to switch back on. A high-security build can prove
 *  the logger absent with `strings`, not trust a flag.
 *
 *  Failures never reach the caller: a logger that can take down the
 *  program it observes is worse than no logger. A hub that is down means
 *  the next batch counts again.
 */

#ifndef SUPERLOG_H
#define SUPERLOG_H

#if defined(SUPERLOG_DEVELOPMENT) && defined(SUPERLOG_PRODUCTION)
#error "superlog: define SUPERLOG_DEVELOPMENT xor SUPERLOG_PRODUCTION, not both - deciding is the point"
#endif
#if !defined(SUPERLOG_DEVELOPMENT) && !defined(SUPERLOG_PRODUCTION)
#error "superlog: define -DSUPERLOG_DEVELOPMENT or -DSUPERLOG_PRODUCTION - there is no default"
#endif

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct superlog {
    char host[256];
    int  port;
    char topic[128];
    char app[64];
    char device[64];
    char session[12];
    unsigned seq;
    int  active;
    size_t len;
    char buf[32768];            /* the batch; one POST when it fills or on flush */
} superlog_t;

/* Linkage for the five public functions: static by default - the header
 * stays header-only for every C consumer - but overridable, so one object
 * file can export the SDK to ANY language with a C FFI:
 *
 *     echo '#include <superlog.h>' > impl.c
 *     cc -DSUPERLOG_API= -DSUPERLOG_DEVELOPMENT -I sdk/c -c impl.c
 *
 * and impl.o links from Zig, COBOL, assembly, anything. */
#ifndef SUPERLOG_API
#define SUPERLOG_API static
#endif

#ifdef SUPERLOG_PRODUCTION

/* The inert shell. Every call collapses to nothing at any optimisation
 * level - there is no wire code in the translation unit at all. */
SUPERLOG_API void superlog_init(superlog_t *lg, const char *topic, const char *app)
{ (void)lg; (void)topic; (void)app; }
SUPERLOG_API void superlog_logf(superlog_t *lg, const char *level, const char *fmt, ...)
{ (void)lg; (void)level; (void)fmt; }
SUPERLOG_API void superlog_kv(superlog_t *lg, const char *level, const char *msg, ...)
{ (void)lg; (void)level; (void)msg; }
SUPERLOG_API void superlog_metric(superlog_t *lg, const char *name, double value)
{ (void)lg; (void)name; (void)value; }
SUPERLOG_API void superlog_flush(superlog_t *lg) { (void)lg; }

#else /* SUPERLOG_DEVELOPMENT */

/* glibc hides gmtime_r and getaddrinfo under strict -std=c99; macOS's lax
 * headers would have let that ship. Best effort here - feature macros only
 * work if no libc header came first, so include this header early (or
 * compile without a strict -std, which is what the repo's scripts do). */
#if !defined(_POSIX_C_SOURCE) || _POSIX_C_SOURCE < 200112L
#undef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200112L
#endif

#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <windows.h>          /* GetSystemTimeAsFileTime, FILETIME */
#  if defined(_MSC_VER)
#    pragma comment(lib, "ws2_32.lib")   /* auto-link Winsock under MSVC */
#  endif
#else
#  include <netdb.h>
#  include <sys/socket.h>
#  include <sys/time.h>
#  include <unistd.h>
#endif
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Windows uses Winsock (send/recv/closesocket, one WSAStartup) and lacks the
 * POSIX time calls; this shim keeps the client below one code path. */
#ifdef _WIN32
typedef SOCKET superlog__sock;
#  define SUPERLOG__BADSOCK       INVALID_SOCKET
#  define superlog__sockvalid(fd) ((fd) != INVALID_SOCKET)
#  define superlog__closesock(fd) closesocket(fd)
#  define superlog__gmtime(t, out) gmtime_s((out), (t))   /* note: (tm*, time_t*) */
static void superlog__now(struct timeval *tv) {
    FILETIME ft; ULARGE_INTEGER u;
    GetSystemTimeAsFileTime(&ft);
    u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
    /* FILETIME is 100ns ticks since 1601; shift to microseconds since 1970. */
    unsigned long long us = (u.QuadPart - 116444736000000000ULL) / 10ULL;
    tv->tv_sec  = (long)(us / 1000000ULL);
    tv->tv_usec = (long)(us % 1000000ULL);
}
#else
typedef int superlog__sock;
#  define SUPERLOG__BADSOCK       (-1)
#  define superlog__sockvalid(fd) ((fd) >= 0)
#  define superlog__closesock(fd) close(fd)
#  define superlog__now(tv)        gettimeofday((tv), NULL)
#  define superlog__gmtime(t, out) gmtime_r((t), (out))
#endif
#ifdef MSG_NOSIGNAL
#  define SUPERLOG__SFLAGS MSG_NOSIGNAL   /* a hub restart is a failed POST, not SIGPIPE */
#else
#  define SUPERLOG__SFLAGS 0
#endif

/* ---- internals ------------------------------------------------------- */

static void superlog__iso(char *out, size_t n)
{
    struct timeval tv;
    struct tm tm;
    time_t secs;
    superlog__now(&tv);
    /* tv_sec is a long in Winsock's timeval, but time_t is 64-bit on Windows;
     * copy through a time_t so gmtime_s reads the right width, not 4 bytes. */
    secs = (time_t)tv.tv_sec;
    superlog__gmtime(&secs, &tm);
    snprintf(out, n, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
             tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec, (int)(tv.tv_usec / 1000));
}

/* JSON-escape src into dst, bounded; control characters become \u00xx. */
static void superlog__esc(char *dst, size_t n, const char *src)
{
    size_t o = 0;
    for (; *src && o + 7 < n; src++) {
        unsigned char c = (unsigned char)*src;
        if (c == '"' || c == '\\') { dst[o++] = '\\'; dst[o++] = (char)c; }
        else if (c == '\n') { dst[o++] = '\\'; dst[o++] = 'n'; }
        else if (c == '\r') { dst[o++] = '\\'; dst[o++] = 'r'; }
        else if (c == '\t') { dst[o++] = '\\'; dst[o++] = 't'; }
        else if (c < 0x20) o += (size_t)snprintf(dst + o, n - o, "\\u%04x", c);
        else dst[o++] = (char)c;
    }
    dst[o] = '\0';
}

/* One TCP connect per flush, the OCaml client's bargain: at logging rates
 * a held socket buys nothing, and every error path lands in "drop the
 * batch, the next one counts again". */
SUPERLOG_API void superlog_flush(superlog_t *lg)
{
    struct addrinfo hints, *res = NULL;
    char portstr[16], header[512];
    superlog__sock fd = SUPERLOG__BADSOCK;
    int hlen;

    if (!lg->active || lg->len == 0) return;

#ifdef _WIN32
    { static int wsa = 0;
      if (!wsa) { WSADATA wd; if (WSAStartup(MAKEWORD(2, 2), &wd) == 0) wsa = 1; } }
#endif

    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    snprintf(portstr, sizeof portstr, "%d", lg->port);
    if (getaddrinfo(lg->host, portstr, &hints, &res) != 0 || !res) goto out;
    fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (!superlog__sockvalid(fd)) goto out;
    if (connect(fd, res->ai_addr, (int)res->ai_addrlen) != 0) goto out;

    hlen = snprintf(header, sizeof header,
                    "POST /ingest/%s HTTP/1.1\r\nHost: %s\r\n"
                    "Content-Type: application/x-ndjson\r\n"
                    "Content-Length: %zu\r\nConnection: close\r\n\r\n",
                    lg->topic, lg->host, lg->len);
    if (send(fd, header, hlen, SUPERLOG__SFLAGS) < 0) goto out;
    if (send(fd, lg->buf, (int)lg->len, SUPERLOG__SFLAGS) < 0) goto out;
    /* Read and discard the reply so the hub never sees a reset mid-answer. */
    (void)!recv(fd, header, (int)sizeof header, 0);

out:
    if (superlog__sockvalid(fd)) superlog__closesock(fd);
    if (res) freeaddrinfo(res);
    lg->len = 0;                /* delivered or dropped; either way, gone */
}

static void superlog__append(superlog_t *lg, const char *line, size_t n)
{
    if (n + 1 > sizeof lg->buf) return;             /* one absurd event is not the buffer's problem */
    if (lg->len + n + 1 > sizeof lg->buf) superlog_flush(lg);
    memcpy(lg->buf + lg->len, line, n);
    lg->len += n;
    lg->buf[lg->len++] = '\n';
}

static void superlog__event(superlog_t *lg, const char *level, const char *msg,
                            const char *extra /* ",..." or "" */)
{
    char ts[40], emsg[4096], line[8192];
    int n;
    if (!lg->active) return;
    superlog__iso(ts, sizeof ts);
    superlog__esc(emsg, sizeof emsg, msg);
    n = snprintf(line, sizeof line,
                 "{\"v\":1,\"ts\":\"%s\",\"seq\":%u,\"session\":\"%s\","
                 "\"level\":\"%s\",\"origin\":{\"runtime\":\"c\",\"app\":\"%s\","
                 "\"platform\":\"host\",\"device\":\"%s\"},\"tag\":\"%s\","
                 "\"msg\":\"%s\"%s}",
                 ts, lg->seq++, lg->session, level, lg->app, lg->device,
                 lg->app, emsg, extra);
    if (n > 0 && (size_t)n < sizeof line) superlog__append(lg, line, (size_t)n);
}

/* ---- the API --------------------------------------------------------- */

SUPERLOG_API void superlog_init(superlog_t *lg, const char *topic, const char *app)
{
    const char *url = getenv("SUPER_LOG_URL");
    const char *h;
    char *colon;

    memset(lg, 0, sizeof *lg);
    lg->active = 1;
    lg->port = 7333;
    snprintf(lg->host, sizeof lg->host, "127.0.0.1");
    snprintf(lg->topic, sizeof lg->topic, "%s", topic);
    snprintf(lg->app, sizeof lg->app, "%s", app);
    if (gethostname(lg->device, sizeof lg->device) != 0 || !lg->device[0])
        snprintf(lg->device, sizeof lg->device, "c");
    if ((colon = strchr(lg->device, '.')) != NULL) *colon = '\0';
    snprintf(lg->session, sizeof lg->session, "%08x",
             (unsigned)(getpid() * 2654435761u ^ (unsigned)time(NULL)));

    if (url && strncmp(url, "http://", 7) == 0) {
        h = url + 7;
        snprintf(lg->host, sizeof lg->host, "%s", h);
        if ((colon = strchr(lg->host, '/')) != NULL) *colon = '\0';
        if ((colon = strchr(lg->host, ':')) != NULL) {
            *colon = '\0';
            lg->port = atoi(colon + 1) > 0 ? atoi(colon + 1) : 7333;
        }
    }
}

/* printf-shaped, because that is the C idiom for a message. */
SUPERLOG_API void superlog_logf(superlog_t *lg, const char *level, const char *fmt, ...)
{
    char msg[2048];
    va_list ap;
    if (!lg->active) return;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    superlog__event(lg, level, msg, "");
}

/* Fields as NULL-terminated key/value pairs:
 *   superlog_kv(&lg, "ERROR", "no rate", "symbol", "DOGE", "tick", "7", NULL); */
SUPERLOG_API void superlog_kv(superlog_t *lg, const char *level, const char *msg, ...)
{
    char extra[4096], k[256], v[1024];
    size_t o = 0;
    const char *key, *val;
    va_list ap;
    if (!lg->active) return;
    extra[0] = '\0';
    va_start(ap, msg);
    while ((key = va_arg(ap, const char *)) != NULL &&
           (val = va_arg(ap, const char *)) != NULL) {
        superlog__esc(k, sizeof k, key);
        superlog__esc(v, sizeof v, val);
        /* snprintf returns what it WOULD have written; adding that unclamped let
         * o walk past sizeof extra, after which `extra + o` and the wrapped
         * `sizeof extra - o` write out of bounds. Clamp: if the field does not
         * fit, stop BEFORE o moves, dropping the overflowing field. */
        int n = snprintf(extra + o, sizeof extra - o, "%s\"%s\":\"%s\"",
                         o ? "," : ",\"fields\":{", k, v);
        if (n < 0 || (size_t)n >= sizeof extra - o) break;
        o += (size_t)n;
    }
    va_end(ap);
    if (o) snprintf(extra + o, sizeof extra - o, "}");
    superlog__event(lg, level, msg, extra);
}

/* A reading for the chart: DEBUG, with the metric riding the event. */
SUPERLOG_API void superlog_metric(superlog_t *lg, const char *name, double value)
{
    char en[256], extra[512], msg[300];
    if (!lg->active) return;
    superlog__esc(en, sizeof en, name);
    snprintf(extra, sizeof extra, ",\"metric\":{\"name\":\"%s\",\"value\":%g}", en, value);
    snprintf(msg, sizeof msg, "%s =%g", name, value);
    superlog__event(lg, "DEBUG", msg, extra);
}

#endif /* mode */

/* Level helpers, both modes: they expand onto the stubs in production. */
#define superlog_trace(lg, ...)    superlog_logf((lg), "TRACE",    __VA_ARGS__)
#define superlog_debug(lg, ...)    superlog_logf((lg), "DEBUG",    __VA_ARGS__)
#define superlog_info(lg, ...)     superlog_logf((lg), "INFO",     __VA_ARGS__)
#define superlog_warn(lg, ...)     superlog_logf((lg), "WARN",     __VA_ARGS__)
#define superlog_error(lg, ...)    superlog_logf((lg), "ERROR",    __VA_ARGS__)
#define superlog_critical(lg, ...) superlog_logf((lg), "CRITICAL", __VA_ARGS__)

#ifdef __cplusplus
}
#endif

#endif /* SUPERLOG_H */
