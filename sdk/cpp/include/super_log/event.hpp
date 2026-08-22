//
//  event.hpp
//  super-log C++ SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  One event, one NDJSON line - the serialisation half of the SDK, shared by
//  the snicholls::log forward sink and the spdlog sink so the two cannot
//  drift. The schema is docs/PROTOCOL.md; this file is its C++ writer.
//

#ifndef super_log_event_hpp
#define super_log_event_hpp

#include "logging/logger.hpp"   // ts-moveables: record, level, format_time
#include "utils/json.hpp"       // ts-moveables: the one json_escape

#include <cstdint>
#include <cstdio>
#include <random>
#include <string>
#include <utility>
#include <vector>

namespace superlog {

// Who is speaking. Fill it once at startup; every event carries it.
struct origin {
    std::string runtime  = "cpp";
    std::string app      = "app";
    std::string platform =
#if defined(__APPLE__)
        "macos";
#elif defined(_WIN32)
        "windows";
#else
        "linux";
#endif
    std::string device;             // hostname, board name - human-readable
};

// One random id per process run. seq is meaningless without it - see
// PROTOCOL.md on ordering.
inline std::string make_session()
{
    std::random_device rd;
    char buf[17];
    std::snprintf(buf, sizeof buf, "%08x%08x", rd(), rd());
    return buf;
}

namespace detail {

using ::snicholls::utils::json_escape;

inline void append_kv(std::string& j, const char* key, const std::string& v)
{
    j += ",\"";
    j += key;
    j += "\":\"";
    json_escape(v, j);
    j += '"';
}

inline void append_origin(std::string& j, const origin& o)
{
    j += ",\"origin\":{\"runtime\":\"";
    json_escape(o.runtime, j);
    j += "\",\"app\":\"";
    json_escape(o.app, j);
    j += "\",\"platform\":\"";
    json_escape(o.platform, j);
    j += '"';
    if (!o.device.empty()) {
        j += ",\"device\":\"";
        json_escape(o.device, j);
        j += '"';
    }
    j += '}';
}

} // namespace detail

// A snicholls::log::record, re-shaped into a super-log event. The record's
// own to_json() is close but not the same schema - this one adds origin and
// session, and nests fields, because the hub serves readers that never saw
// the C++ side.
inline std::string to_event_json(const snicholls::log::record& r,
                                 const origin& o, const std::string& session)
{
    using snicholls::log::to_string;
    std::string j = "{\"v\":1,\"ts\":\"";
    j += snicholls::log::detail::format_time(r.when);
    j += "\",\"seq\":";
    j += std::to_string(r.seq);
    detail::append_kv(j, "session", session);
    j += ",\"level\":\"";
    j += to_string(r.level);
    j += '"';
    detail::append_origin(j, o);
    if (!r.logger.empty())
        detail::append_kv(j, "tag", r.logger);
    detail::append_kv(j, "msg", r.message);
    if (r.is_metric) {
        // The record's message is the metric name; it stays in msg too, so a
        // reader that only looks at metric.name is not blind and vice versa.
        char v[40];
        std::snprintf(v, sizeof v, "\",\"value\":%.17g}", r.value);
        j += ",\"metric\":{\"name\":\"";
        detail::json_escape(r.message, j);
        j += v;
    }
    if (!r.fields.empty()) {
        j += ",\"fields\":{";
        bool first = true;
        for (const auto& f : r.fields) {
            if (!first)
                j += ',';
            first = false;
            j += '"';
            detail::json_escape(f.first, j);
            j += "\":\"";
            detail::json_escape(f.second, j);
            j += '"';
        }
        j += '}';
    }
    if (r.file && *r.file) {
        std::string src = snicholls::log::detail::basename(r.file);
        src += ':';
        src += std::to_string(r.line);
        detail::append_kv(j, "src", src);
    }
    j += '}';
    return j;
}

// The same event, built from parts - for the spdlog sink and anything else
// that is not holding a snicholls::log::record.
inline std::string make_event_json(const char* level, const std::string& msg,
                                   const origin& o, const std::string& session,
                                   std::uint64_t seq,
                                   const std::string& tag = std::string(),
                                   const std::string& src = std::string())
{
    std::string j = "{\"v\":1,\"ts\":\"";
    j += snicholls::log::detail::format_time(std::chrono::system_clock::now());
    j += "\",\"seq\":";
    j += std::to_string(seq);
    detail::append_kv(j, "session", session);
    j += ",\"level\":\"";
    j += level;
    j += '"';
    detail::append_origin(j, o);
    if (!tag.empty())
        detail::append_kv(j, "tag", tag);
    detail::append_kv(j, "msg", msg);
    if (!src.empty())
        detail::append_kv(j, "src", src);
    j += '}';
    return j;
}

} // namespace superlog

#endif /* super_log_event_hpp */
