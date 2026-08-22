//
//  superlogd - the super-log hub
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  One process on the dev machine. Producers POST NDJSON chunks to
//  /ingest/:topic; viewers subscribe to ws://host:7333/ws?topic=* and get
//  replay-on-connect plus live fan-out. See docs/PROTOCOL.md for the wire
//  contract - this file is deliberately just configuration around
//  ts-moveables' ws_broadcast_hub, which already does the actual job.
//

#include "http/server.hpp"
#include "http/ws_broadcast_hub.hpp"
#include "logging/logger.hpp"

#include <atomic>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <string>

#if !SNICHOLLS_HAS_WS_BROADCAST_HUB
#error "superlogd needs the ts-moveables WebSocket stack (POSIX-only in phase 1)"
#endif

namespace {

// Signal handlers may only touch lock-free atomics; the main thread polls.
std::atomic<bool> g_stop{false};
void on_signal(int) { g_stop.store(true, std::memory_order_relaxed); }

std::uint16_t port_from_env()
{
    if (const char* p = std::getenv("SUPER_LOG_PORT")) {
        const long v = std::strtol(p, nullptr, 10);
        if (v > 0 && v < 65536)
            return static_cast<std::uint16_t>(v);
    }
    return 7333;
}

} // namespace

int main()
{
    using namespace snicholls;

    const std::uint16_t want_port = port_from_env();

    http::ws_broadcast_hub::config hcfg;
    // Each ring entry is one POSTed chunk (~a quarter second of one stream),
    // so 1024 is minutes of history for a viewer that just connected.
    hcfg.ring_capacity   = 1024;
    hcfg.max_queue_msgs  = 4096;            // a viewer paused in a debugger
    http::ws_broadcast_hub hub{hcfg};

    http::server srv;
    hub.mount(srv);                         // GET /ws?topic=..  +  POST /ingest/:topic

    srv.get("/healthz", [&hub](const http::request&, http::responder r) {
        const auto s = hub.snapshot();
        std::string j = "{\"ok\":true,\"published\":" + std::to_string(s.published) +
                        ",\"delivered\":" + std::to_string(s.delivered) +
                        ",\"dropped\":" + std::to_string(s.dropped) +
                        ",\"subscribers\":" + std::to_string(s.subscribers) +
                        ",\"seq\":" + std::to_string(s.seq) + "}";
        r.send(200, "application/json", std::move(j));
    });

    // Default 0.0.0.0 because phones on the LAN must be able to reach us -
    // but there is no auth, so anyone who can connect can read every stream
    // and publish to any topic. SUPER_LOG_BIND=127.0.0.1 confines the hub
    // to this machine (the demo does exactly that; OS-log streams make it
    // matter). See docs/ARCHITECTURE.md.
    const char* bind_env = std::getenv("SUPER_LOG_BIND");
    const std::string bind_host = bind_env && *bind_env ? bind_env : "0.0.0.0";
    const std::uint16_t port = srv.listen(bind_host, want_port);
    if (port == 0) {
        SN_LOG_ERROR() << "superlogd: cannot listen on " << bind_host << ":" << want_port;
        return 1;
    }

    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    SN_LOG_INFO() << "superlogd listening on 0.0.0.0:" << port;
    SN_LOG_INFO() << "  ingest:  POST http://<host>:" << port << "/ingest/<topic>";
    SN_LOG_INFO() << "  feed:    ws://<host>:" << port << "/ws?topic=*";
    SN_LOG_INFO() << "  health:  GET  http://<host>:" << port << "/healthz";

    std::thread loop([&srv] { srv.run(); });

    // Periodic stats on the console, so a glance at the terminal answers
    // "is anything actually flowing".
    std::uint64_t last_published = 0;
    while (!g_stop.load(std::memory_order_relaxed)) {
        std::this_thread::sleep_for(std::chrono::seconds(10));
        const auto s = hub.snapshot();
        if (s.published != last_published || s.subscribers != 0) {
            SN_LOG_INFO().field("published", s.published)
                         .field("delivered", s.delivered)
                         .field("dropped", s.dropped)
                         .field("subscribers", s.subscribers)
                << "hub";
            last_published = s.published;
        }
    }

    SN_LOG_INFO() << "superlogd shutting down";
    srv.stop();
    loop.join();
    return 0;
}
