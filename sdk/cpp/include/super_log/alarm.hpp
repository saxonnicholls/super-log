//
//  alarm.hpp - SN_ALARM: raise a first-class super-log ALARM from code.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A log line is a record; an ALARM is a demand for attention. Until now the
//  only way into the viewers' Alarms panel was superlog-alert's rules watching
//  your streams, or a production webhook through the superlog-alarm gateway -
//  so from code the best you could do was write a WARN and hope a rule caught
//  it. SN_ALARM says it outright:
//
//      SN_ALARM("settlement engine unreachable");   // fires, P0, in the panel
//      SN_ALARM_CLEAR("settlement engine unreachable");   // clears it
//
//  It emits onto alert.native.<key> - the third alert.* source beside the
//  rules engine (alert.<rule>) and the gateway (alert.inbound.*) - which the
//  Alarms panel reads and dedups by fields.key. The rules engine ignores
//  alert.* by design (its loop guard), so a native alarm never triggers a
//  rule. One firing is ONE event; SN_ALARM keys off the call site and, unless
//  you pass your own key, fires ONCE on the rising edge - a hot loop does not
//  become a flood. Recovery (SN_ALARM_CLEAR) closes it with an INFO the panel
//  reads as "RECOVERED".
//
//  This is the local, in-process door: it POSTs straight to the hub, so the
//  cross-process dedup/repeat-count/recovery accounting the superlog-alarm
//  gateway does is NOT applied here - route production alarms through the
//  gateway when you need that. It is also deliberately NOT gated by the
//  dev/prod level policy (mode.hpp): an alarm you asked for is the one thing
//  that must not go quiet in production. Set SUPER_LOG_ALARMS=0 to mute.
//
#ifndef super_log_alarm_hpp
#define super_log_alarm_hpp

#include "event.hpp"       // make_event_json, origin, make_session
#include "transport.hpp"   // detail::http_post

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <set>
#include <string>

namespace superlog {

// The hub to alarm, from SUPER_LOG_URL (the same var every SDK reads), default
// 127.0.0.1:7333. Parsed the way the demo clients parse it, kept local so a
// caller need not construct a transport just to raise an alarm.
inline void alarm_endpoint(std::string& host, std::uint16_t& port)
{
    host = "127.0.0.1";
    port = 7333;
    const char* u = std::getenv("SUPER_LOG_URL");
    if (!u || !*u)
        return;
    std::string s = u;
    if (const auto at = s.find("://"); at != std::string::npos)
        s = s.substr(at + 3);
    s = s.substr(0, s.find('/'));
    if (const auto colon = s.rfind(':'); colon != std::string::npos) {
        host = s.substr(0, colon);
        port = static_cast<std::uint16_t>(std::strtoul(s.c_str() + colon + 1, nullptr, 10));
    } else if (!s.empty()) {
        host = s;
    }
}

// A key becomes a topic segment: lowercased, only [a-z0-9._-], the rest to '-'.
inline std::string alarm_key_sanitize(const std::string& k)
{
    std::string o;
    o.reserve(k.size());
    for (char c : k) {
        if (c >= 'A' && c <= 'Z') o += static_cast<char>(c - 'A' + 'a');
        else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                 c == '.' || c == '_' || c == '-') o += c;
        else o += '-';
    }
    return o.empty() ? std::string("alarm") : o;
}

// The raw raise: one alarm event at `level` onto alert.native.<key>. CRITICAL
// (P0) by default; pass "ERROR" (P1) or "WARN" (P2) to lower it.
inline bool alarm_raise(const std::string& key, const std::string& msg,
                        const char* level = "CRITICAL")
{
    if (const char* off = std::getenv("SUPER_LOG_ALARMS"); off && std::string(off) == "0")
        return false;

    static const std::string session = make_session();
    static std::atomic<std::uint64_t> seq{0};

    origin o;                                   // runtime/platform default here
    if (const char* app = std::getenv("SUPER_LOG_APP"); app && *app) o.app = app;
    if (const char* dev = std::getenv("SUPER_LOG_DEVICE"); dev && *dev) o.device = dev;

    const std::string k = alarm_key_sanitize(key);
    const std::string body =
        make_event_json(level, msg, o, session, seq.fetch_add(1), "alarm", "",
                        {{"key", k}}) + "\n";

    std::string host;
    std::uint16_t port;
    alarm_endpoint(host, port);
    return detail::http_post(host, port, "/ingest/alert.native." + k, body);
}

// Recovery: an INFO the Alarms panel reads as closing the firing on this key.
inline bool alarm_clear(const std::string& key, const std::string& msg = std::string())
{
    return alarm_raise(key, msg.empty() ? ("RECOVERED: " + alarm_key_sanitize(key)) : msg,
                       "INFO");
}

// Edge-triggered raise for the bare SN_ALARM(msg) form keyed by call site: the
// first hit fires, repeats are swallowed until a matching clear, so the same
// line in a tight loop is ONE alarm, not a flood. An explicit key
// (SN_ALARM_KEY) skips this and is yours to edge-trigger as you see fit.
inline bool alarm_raise_once(const std::string& key, const std::string& msg)
{
    static std::mutex m;
    static std::set<std::string> firing;
    {
        std::lock_guard<std::mutex> g(m);
        if (!firing.insert(key).second)
            return false;                       // already firing on this key
    }
    return alarm_raise(key, msg);
}

inline bool alarm_clear_once(const std::string& key, const std::string& msg = std::string())
{
    static std::mutex m;
    static std::set<std::string> firing;        // shares intent with alarm_raise_once
    (void)m;
    return alarm_clear(key, msg);
}

} // namespace superlog

// The call-site key (file:line) for the bare form, stringified through one
// level of indirection so __LINE__ expands.
#define SUPERLOG_ALARM_STR_(x) #x
#define SUPERLOG_ALARM_STR(x)  SUPERLOG_ALARM_STR_(x)
#define SUPERLOG_ALARM_SITE    (__FILE__ ":" SUPERLOG_ALARM_STR(__LINE__))

// SN_ALARM(msg)            - P0, keyed by call site, fires once on the edge.
// SN_ALARM_KEY(key, msg)   - your own dedup key, fires every call.
// SN_ALARM_CLEAR(key)      - recovery for an explicit key.
#define SN_ALARM(msg)           ::superlog::alarm_raise_once(SUPERLOG_ALARM_SITE, (msg))
#define SN_ALARM_CLEAR_SITE()   ::superlog::alarm_clear(SUPERLOG_ALARM_SITE)
#define SN_ALARM_KEY(key, msg)  ::superlog::alarm_raise((key), (msg))
#define SN_ALARM_CLEAR(key)     ::superlog::alarm_clear((key))

#endif // super_log_alarm_hpp
