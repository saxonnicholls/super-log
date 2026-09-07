//
//  superlogd - the super-log hub
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
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

#include <algorithm>
#include <atomic>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

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

// Find `"key"` and return the value of the string that follows it, tolerating
// the whitespace a pretty-printer leaves around the colon. The first version
// scanned for the literal `"level":"` and so was blind to `{"level": "ERROR"}`
// - which is exactly what Python's json.dumps produces by default. A whole
// language's events silently lost their level and trace filtering, and
// nothing looked broken: they arrived, they just could not be found.
inline std::string string_field(const std::string& line, const char* key) noexcept
{
    const std::string needle = std::string("\"") + key + "\"";
    std::size_t at = line.find(needle);
    if (at == std::string::npos)
        return {};
    std::size_t i = at + needle.size();
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t'))
        ++i;
    if (i >= line.size() || line[i] != ':')
        return {};
    ++i;
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t'))
        ++i;
    if (i >= line.size() || line[i] != '"')
        return {};                              // not a string value
    const std::size_t from = ++i;
    // Respect escapes, or a value containing \" ends the scan early.
    for (; i < line.size(); ++i) {
        if (line[i] == '\\') { ++i; continue; }
        if (line[i] == '"') return line.substr(from, i - from);
    }
    return {};
}

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
    const std::string v = string_field(line, "level");
    return v.empty() ? 3 : level_rank(v);       // tolerant-reader default: INFO
}

// Same targeted-scan reasoning as level_of: one field, no parser.
inline std::string trace_of(const std::string& line)
{
    return string_field(line, "trace");
}

// Is this line safe to embed verbatim inside a JSON response? A structural
// scan, not a parser: braces and brackets balanced, strings closed, escapes
// respected, depth back to zero at the end. It cannot prove a line is valid
// JSON, but it catches what actually turns up - truncated frames and log
// lines that merely start with a brace - and the failure mode is safe,
// because anything it rejects gets wrapped as a string instead.
inline bool embeddable_json_object(const std::string& s) noexcept
{
    if (s.size() < 2 || s.front() != '{' || s.back() != '}')
        return false;
    int depth = 0;
    bool in_string = false, escaped = false;
    for (const char c : s) {
        if (in_string) {
            if (escaped)          escaped = false;
            else if (c == '\\')   escaped = true;
            else if (c == '"')    in_string = false;
            else if (static_cast<unsigned char>(c) < 0x20)
                return false;                   // a raw control char is never legal in a JSON string
            continue;
        }
        switch (c) {
        case '"': in_string = true; break;
        case '{': case '[': if (++depth > 64) return false; break;   // absurd nesting is not ours to relay
        case '}': case ']': if (--depth < 0) return false; break;
        default: break;
        }
    }
    return depth == 0 && !in_string;
}

struct recent_event {
    std::uint64_t id = 0;
    std::uint64_t seq = 0;                      // the hub frame this arrived in
    std::string topic;
    std::string line;                           // the event, verbatim
    std::string trace;                          // correlation id, if the producer set one
    int level = 3;
};

// Guarded because the ingest route and the /recent route are both server
// handlers: one loop thread today, but a ring that assumes that is a trap
// for whoever adds a worker later.
//
// One ring PER TOPIC, not one global ring. A single global FIFO means the
// noisiest producer evicts everyone else: an unscoped Android logcat at
// 600 lines/second erased a whole phone's worth of evidence from this ring
// in minutes, and the people debugging the quiet stream had no idea their
// events had ever arrived. Per-topic rings make a firehose expensive only
// to itself. `id` stays globally monotonic so one cursor still works
// across every stream.
class recent_ring {
public:
    explicit recent_ring(std::size_t cap_per_topic) : cap_(cap_per_topic) {}

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
        e.trace = trace_of(line);
        e.line = std::move(line);
        auto& q = topics_[topic];
        q.push_back(std::move(e));
        while (q.size() > cap_)
            q.pop_front();
    }

    // Events with id > since, oldest first, at most limit of them.
    std::string query(std::uint64_t since, std::size_t limit,
                      const std::string& topic, int min_level,
                      const std::string& trace) const
    {
        std::lock_guard<std::mutex> g(m_);
        // Gather across topics, then order by id: the rings are per-topic
        // but the cursor is global, so a reader still sees one interleaved
        // stream in publish order.
        std::vector<const recent_event*> picked;
        std::uint64_t oldest = 0;
        for (const auto& [name, q] : topics_) {
            if (!q.empty() && (oldest == 0 || q.front().id < oldest))
                oldest = q.front().id;
            if (!topic_matches(topic, name))
                continue;
            for (const auto& e : q) {
                if (e.id <= since || e.level < min_level)
                    continue;
                // A trace query asks one question - "what happened when
                // this action ran" - so it ignores the topic filter's
                // usual job of narrowing to a stream: the whole point is
                // that the answer crosses streams.
                if (!trace.empty() && e.trace != trace)
                    continue;
                picked.push_back(&e);
            }
        }
        std::sort(picked.begin(), picked.end(),
                  [](const recent_event* a, const recent_event* b) { return a->id < b->id; });

        // Oldest-first, but when there are more matches than the caller
        // wants it is the NEWEST that matter - keep the tail.
        const bool truncated = picked.size() > limit;
        if (truncated)
            picked.erase(picked.begin(),
                         picked.begin() + static_cast<std::ptrdiff_t>(picked.size() - limit));

        std::string out = "{\"events\":[";
        bool first = true;
        for (const recent_event* e : picked) {
            if (!first)
                out += ',';
            first = false;
            out += "{\"id\":" + std::to_string(e->id) +
                   ",\"seq\":" + std::to_string(e->seq) + ",\"topic\":\"";
            snicholls::utils::json_escape(e->topic, out);
            out += "\",\"event\":";
            // PROTOCOL.md's tolerant-reader rule makes a non-JSON payload
            // line legal, and a tailer relays plenty of them. Embedding one
            // verbatim made this whole response unparseable and broke every
            // consumer at once - the viewers, the MCP server, any script.
            // So relay JSON as JSON, and wrap anything else the way the
            // rule says a reader should: {"msg": "<the raw line>"}.
            if (embeddable_json_object(e->line)) {
                out += e->line;
            } else {
                out += "{\"msg\":\"";
                snicholls::utils::json_escape(e->line, out);
                out += "\"}";
            }
            out += '}';
        }
        // Advance the cursor past everything considered, not just what was
        // returned, so a filtered poll does not rescan the quiet events.
        // When truncated, stop at what was actually handed over.
        const std::uint64_t next =
            truncated ? picked.back()->id : (last_id_ > since ? last_id_ : since);
        // A reader away longer than the ring is deep has missed events; say
        // so rather than let it believe it saw everything.
        const bool gap = oldest != 0 && since != 0 && since + 1 < oldest;
        out += "],\"next\":" + std::to_string(next) +
               ",\"count\":" + std::to_string(picked.size()) +
               ",\"oldest\":" + std::to_string(oldest) +
               ",\"newest\":" + std::to_string(last_id_) +
               ",\"truncated\":" + (truncated ? "true" : "false") +
               ",\"missed\":" + (gap ? "true" : "false") + '}';
        return out;
    }

private:
    // Exact topic, "*"/empty for all, or a prefix ending in '.'
    static bool topic_matches(const std::string& want, const std::string& name)
    {
        if (want.empty() || want == "*" || want == name)
            return true;
        return want.back() == '.' && name.size() > want.size() &&
               name.compare(0, want.size(), want) == 0;
    }

    mutable std::mutex m_;
    std::unordered_map<std::string, std::deque<recent_event>> topics_;
    std::size_t cap_;
    std::uint64_t last_id_ = 0;

public:
    /** How many distinct streams have been seen - the cheapest answer to
     *  "is everything still reporting". */
    std::size_t topic_count() const
    {
        std::lock_guard<std::mutex> g(m_);
        return topics_.size();
    }
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
    // Each ring entry is one POSTed chunk, so this is a count of CHUNKS and
    // not of events or of bytes - which is the whole reason it is not 1024
    // any more. A chunk is whatever a producer chose to batch: the SDKs send
    // ~250ms or 256 events, and a firehose (250 Binance streams) makes those
    // 64-256KB each. At 1024 the replay ring alone held 66MB for ONE topic on
    // a 20-minute soak, on its way to ~118MB, and max_message_bytes allows
    // 1MB chunks - so the true worst case was a gigabyte per topic. The
    // subscriber queues are bounded by bytes as well as count; this ring is
    // bounded by count only, so the count has to be the conservative one.
    //
    // 128 chunks is still thousands of events of replay - far more than a
    // freshly-opened viewer needs to look non-blank, which is all this ring
    // is for. Real history lives in /recent (its own per-topic ring) and in
    // the journal, both of which are cheaper per event than a retained chunk.
    // This goes back to 1024 the moment ts-moveables bounds the ring by BYTES
    // as well as by count - the two bound different things and only together
    // bound the right one. Until then the count carries the whole budget.
    hcfg.ring_capacity   = size_from_env("SUPER_LOG_REPLAY_CHUNKS", 128);
    hcfg.max_queue_msgs  = 4096;            // a viewer paused in a debugger
    http::ws_broadcast_hub hub{hcfg};

    http::server srv;

    // Recent-event ring for GET /recent. ~5k events is a few minutes of a
    // busy bench; SUPER_LOG_RECENT overrides.
    // Per topic, so a firehose is expensive only to itself.
    recent_ring recent{size_from_env("SUPER_LOG_RECENT", 2000)};

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
                            level.empty() ? 1 : level_rank(level),
                            req.query_param("trace")));
    });

    // uptime and version answer the question the counters cannot: "did this
    // restart?" A hub that restarted has counters starting from zero, which
    // reads identically to a quiet bench unless it can say how long it has
    // been up. Convention borrowed from the health routes in the sibling
    // projects, so anything already scraping those finds what it expects.
    const auto started = std::chrono::steady_clock::now();
    srv.get("/healthz", [&hub, started, &recent](const http::request&, http::responder r) {
        const auto s = hub.snapshot();
        const auto up = std::chrono::duration_cast<std::chrono::seconds>(
                            std::chrono::steady_clock::now() - started).count();
        std::string j = "{\"ok\":true,\"status\":\"ok\""
                        ",\"version\":\"" SUPERLOG_VERSION "\""
                        ",\"uptime_seconds\":" + std::to_string(up) +
                        ",\"published\":" + std::to_string(s.published) +
                        ",\"delivered\":" + std::to_string(s.delivered) +
                        ",\"dropped\":" + std::to_string(s.dropped) +
                        ",\"subscribers\":" + std::to_string(s.subscribers) +
                        ",\"topics\":" + std::to_string(recent.topic_count()) +
                        ",\"seq\":" + std::to_string(s.seq) + "}";
        r.send(200, "application/json", std::move(j));
    });

    // Default 0.0.0.0 because phones on the LAN must be able to reach us -
    // but there is no auth, so anyone who can connect can read every stream
    // and publish to any topic. SUPER_LOG_BIND=127.0.0.1 confines the hub
    // to this machine (the demo does exactly that; OS-log streams make it
    // matter). See docs/ARCHITECTURE.md.
    // LOOPBACK by default. This used to be 0.0.0.0 "because phones on the LAN
    // must be able to reach us", and the README claimed exposure was a choice
    // rather than an accident - which was true of the demo script, which pins
    // loopback, and false of this binary, which is what the README's own
    // piece-by-piece instructions tell you to run.
    //
    // The hub has no authentication: anyone who can reach the port reads every
    // stream and can publish to any topic. Once OS logs, ssh auth failures and
    // service logs are on the bench, the convenient default and the dangerous
    // one were the same default, and it failed silently - nothing breaks, it
    // just quietly becomes readable. Opening it up is now something you type.
    const char* bind_env = std::getenv("SUPER_LOG_BIND");
    const char* lan_env = std::getenv("SUPER_LOG_LAN");
    const std::string bind_host =
        bind_env && *bind_env      ? bind_env
        : (lan_env && *lan_env)    ? "0.0.0.0"
                                   : "127.0.0.1";
    // listen() THROWS on a failed bind rather than returning 0, so the
    // zero check below is not enough on its own: an already-used port -
    // the single most common thing to go wrong on a first run, and on any
    // restart that races the previous process shutting down - surfaced as
    // "libc++abi: terminating due to uncaught exception". That is a crash
    // report for a condition with an obvious remedy.
    std::uint16_t port = 0;
    try {
        port = srv.listen(bind_host, want_port);
    } catch (const std::exception& e) {
        SN_LOG_ERROR() << "superlogd: cannot listen on " << bind_host << ':' << want_port
                       << " - " << e.what();
        SN_LOG_ERROR() << "  another superlogd is probably already running. "
                          "Check with: lsof -i :" << want_port;
        SN_LOG_ERROR() << "  or choose another port: SUPER_LOG_PORT=" << (want_port + 1)
                       << " superlogd";
        return 1;
    }
    if (port == 0) {
        SN_LOG_ERROR() << "superlogd: cannot listen on " << bind_host << ':' << want_port;
        return 1;
    }

    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    SN_LOG_INFO() << "superlogd listening on " << bind_host << ':' << port;
    // Say it plainly when it is reachable from elsewhere. A one-line notice
    // at startup is the difference between an informed choice and a surprise.
    if (bind_host != "127.0.0.1" && bind_host != "localhost" && bind_host != "::1") {
        SN_LOG_WARN() << "  REACHABLE FROM THE NETWORK on " << bind_host << ':' << port
                      << " - there is no authentication, so anyone who can reach";
        SN_LOG_WARN() << "  this port can read every stream and publish to any topic.";
    } else {
        SN_LOG_INFO() << "  loopback only. Devices on the LAN need SUPER_LOG_LAN=1"
                         " (or SUPER_LOG_BIND=0.0.0.0) - see docs/ARCHITECTURE.md.";
    }
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
