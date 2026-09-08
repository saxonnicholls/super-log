// Windows CI: the C++ SDK from the checkout must compile + link with MSVC,
// exercising the Winsock path in transport.hpp (WSAStartup, socket_t,
// send/recv, closesocket). forward_sink.hpp pulls transport.hpp; ts-moveables
// comes from the vcpkg overlay port. No hub required - the batcher's worker
// thread just fails its POSTs and counts them.
// the build mode (SUPERLOG_DEVELOPMENT / _PRODUCTION) is set by CMake's -D
#include <super_log/forward_sink.hpp>

int main()
{
    superlog::transport_config cfg;
    superlog::batcher b(cfg);
    b.enqueue("{\"v\":1}");
    b.flush_now();
    return 0;
}
