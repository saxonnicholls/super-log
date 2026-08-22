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
#include <deque>
#include <mutex>
#include <string>
#include <string_view>

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

std::size_t size_from_env(const char* name, std::size_t dflt)
{
    if (const char* p = std::getenv(name)) {
        const long v = std::strtol(p, nullptr, 10);
        if (v > 0)
            return static_cast<std::size_t>(v);
    }
    return dflt;
}

// ---------------------------------------------------------------- /recent
//
// The WebSocket feed is the real-time path, but it is only usable by a
// client that can hold a socket open. Agents and scripts want "what
// happened since I last looked" over plain GET, so superlogd keeps its own
// small ring of recent EVENTS (the hub's ring holds frames, is per-topic,
// and is private - and the hub stays stock, see ARCHITECTURE.md).
//
// Each event gets `id`, a monotonic cursor for polling; `seq` is the hub
// frame it arrived in, so a reader can line /recent up with the WS feed.
// One POSTed chunk is many events, so several ids share one seq.

constexpr int level_rank(std::string_view l) noexcept
{
    return l == "TRACE" ? 1 : l == "DEBUG" ? 2 : l == "INFO" ? 3
         : l == "WARN"  ? 4 : l == "ERROR" ? 5 : l == "CRITICAL" ? 6
         : 3;                                   // tolerant-reader default
}

// Just the level, by targeted scan rather than a JSON parse: superlogd must
// build with no submodules (CI enforces it), and one field does not justify
// a dependency. Producers are strict writers, so `"level":"X"` is either
// there or the event has no level and INFO is right.
int level_of(const std::string& line) noexcept
{
    const auto at = line.find("\"level\":\"");
    if (at == std::string::npos)
        return 3;
    const auto from = at + 9;
    const auto to = line.find('"', from);
    return to == std::string::npos ? 3 : level_rank(std::string_view(line).substr(from, to - from));
}

struct recent_event {
    std::uint64_t id = 0;
    std::uint64_t seq = 0;                      // the hub frame this arrived in
    std::string topic;
    std::string line;                           // the event, verbatim
    int level = 3;
};

// Guarded because the ingest route and the /recent route are both server
// handlers: one loop thread today, but a ring that assumes that is a trap
// for whoever adds a worker later.
class recent_ring {
public:
    explicit recent_ring(std::size_t cap) : cap_(cap) {}

    void record(const std::string& topic, std::uint64_t seq, std::string line)
    {
        if (line.empty())
            return;
        std::lock_guard<std::mutex> g(m_);
        recent_event e;
        e.id = ++last_id_;
        e.seq = seq;
        e.topic = topic;
        e.level = level_of(line);
        e.line = std::move(line);
        q_.push_back(std::move(e));
        while (q_.size() > cap_)
            q_.pop_front();
    }

    // Events with id > since, oldest first, at most limit of them.
    std::string query(std::uint64_t since, std::size_t limit,
                      const std::string& topic, int min_level) const
    {
        std::string out = "{\"events\":[";
        std::uint64_t next = since;
        std::size_t n = 0;
        bool first = true;
        std::lock_guard<std::mutex> g(m_);
        // A reader that was away longer than the ring is deep has missed
        // events; say so rather than let it believe it saw everything.
        const bool gap = !q_.empty() && since != 0 && since + 1 < q_.front().id;
        for (const auto& e : q_) {
            if (e.id <= since)
                continue;
            if (n >= limit)
                break;
            if (e.level < min_level)
                { next = e.id; continue; }
            if (!topic.empty() && topic != "*" && e.topic != topic &&
                !(topic.back() == '.' && e.topic.compare(0, topic.size(), topic) == 0))
                { next = e.id; continue; }
            if (!first)
                out += ',';
            first = false;
            out += "{\"id\":" + std::to_string(e.id) +
                   ",\"seq\":" + std::to_string(e.seq) + ",\"topic\":\"";
            snicholls::utils::json_escape(e.topic, out);
            out += "\",\"event\":";
            out += e.line;                      // already JSON; carried verbatim
            out += '}';
            next = e.id;
            ++n;
        }
        out += "],\"next\":" + std::to_string(next) +
               ",\"count\":" + std::to_string(n) +
               ",\"oldest\":" + std::to_string(q_.empty() ? 0 : q_.front().id) +
               ",\"newest\":" + std::to_string(last_id_) +
               ",\"missed\":" + (gap ? "true" : "false") + '}';
        return out;
    }

private:
    mutable std::mutex m_;
    std::deque<recent_event> q_;
    std::size_t cap_;
    std::uint64_t last_id_ = 0;
};

std::uint64_t u64_param(const snicholls::http::request& req, const char* name, std::uint64_t dflt)
{
    const std::string v = req.query_param(name);
    if (v.empty())
        return dflt;
    const long long n = std::strtoll(v.c_str(), nullptr, 10);
    return n < 0 ? dflt : static_cast<std::uint64_t>(n);
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

    // Recent-event ring for GET /recent. ~5k events is a few minutes of a
    // busy bench; SUPER_LOG_RECENT overrides.
    recent_ring recent{size_from_env("SUPER_LOG_RECENT", 5000)};

    // Our own ingest route, registered BEFORE mount(): the router matches in
    // registration order, so this one wins and the hub's identical route is
    // shadowed. It records each event, then publishes the chunk verbatim -
    // the hub still sees exactly what a producer sent, and the WS feed is
    // byte-for-byte what it always was.
    srv.post("/ingest/:topic", [&hub, &recent](const http::request& req, http::responder r) {
        const std::string topic = req.has_param("topic") ? req.param("topic") : std::string("*");
        hub.publish(topic, req.body);
        // The seq the hub just assigned. Handlers run on the loop thread and
        // so does publish(), so this is the frame we published, not a later
        // one - see ws_broadcast_hub::do_publish.
        const std::uint64_t seq = hub.snapshot().seq;
        std::size_t from = 0;
        while (from <= req.body.size()) {
            const std::size_t nl = req.body.find('\n', from);
            const std::size_t end = nl == std::string::npos ? req.body.size() : nl;
            if (end > from)
                recent.record(topic, seq, req.body.substr(from, end - from));
            if (nl == std::string::npos)
                break;
            from = nl + 1;
        }
        r.send(202, "text/plain", "accepted");
    });

    hub.mount(srv);                         // GET /ws?topic=..  (+ a shadowed ingest route)

    // The pull half of the feed: "what happened since I last looked", for
    // readers that cannot hold a socket open - scripts, cron, agents.
    //   /recent?since=<id>&limit=<n>&topic=<t|prefix.>&level=<MIN>
    // Poll with the `next` from the previous answer and nothing is missed
    // or repeated; `missed` says the ring moved past you.
    srv.get("/recent", [&recent](const http::request& req, http::responder r) {
        const std::uint64_t since = u64_param(req, "since", 0);
        std::size_t limit = static_cast<std::size_t>(u64_param(req, "limit", 200));
        if (limit == 0 || limit > 1000)
            limit = 1000;                   // an agent must not be handed the firehose
        const std::string level = req.query_param("level");
        r.send(200, "application/json",
               recent.query(since, limit, req.query_param("topic"),
                            level.empty() ? 1 : level_rank(level)));
    });

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
