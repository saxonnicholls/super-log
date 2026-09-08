/* Windows CI: the C SDK from the checkout must compile + link with MSVC,
 * exercising the Winsock path in superlog.h (WSAStartup, send/recv,
 * closesocket) and the GetSystemTimeAsFileTime time shim. No hub required -
 * superlog_flush just fails the connect and drops the batch. */
/* the build mode (SUPERLOG_DEVELOPMENT / _PRODUCTION) is set by CMake's -D */
#include <superlog.h>

int main(void)
{
    superlog_t lg;
    superlog_init(&lg, "c.win", "ci");
    superlog_logf(&lg, "INFO", "windows ci %d", 1);
    superlog_metric(&lg, "ci.metric", 1.0);
    superlog_flush(&lg);
    return 0;
}
