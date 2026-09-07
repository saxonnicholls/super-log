//
//  spdlog_sink.hpp
//  super-log C++ SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The same pipeline, entered from spdlog - for the codebases that already
//  log through it and should not have to change to be on the dev-bench
//  screen. Compiles to nothing when spdlog is not on the include path, so
//  the SDK never makes spdlog a dependency of anyone who did not ask.
//
//      auto bat = std::make_shared<superlog::batcher>(
//          superlog::transport_config{.topic = "cpp.pricer"});
//      superlog::origin who;
//      who.app = "pricer";
//
//      auto lg = spdlog::default_logger();
//      lg->sinks().push_back(
//          std::make_shared<superlog::spdlog_sink_mt>(bat, who));
//
//  spdlog already serialises calls through the sink mutex and (async mode)
//  its own queue, and enqueue() never blocks, so this sink adds no threading
//  story of its own.
//

#ifndef super_log_spdlog_sink_hpp
#define super_log_spdlog_sink_hpp

#if defined(__has_include)
#if __has_include(<spdlog/sinks/base_sink.h>)
#define SUPERLOG_HAS_SPDLOG 1
#endif
#endif
#ifndef SUPERLOG_HAS_SPDLOG
#define SUPERLOG_HAS_SPDLOG 0
#endif

#if SUPERLOG_HAS_SPDLOG

#include "event.hpp"
#include "transport.hpp"

#include <spdlog/details/log_msg.h>
#include <spdlog/sinks/base_sink.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

namespace superlog {

namespace detail {

inline const char* level_name(spdlog::level::level_enum l) noexcept
{
    switch (l) {
    case spdlog::level::trace:    return "TRACE";
    case spdlog::level::debug:    return "DEBUG";
    case spdlog::level::info:     return "INFO";
    case spdlog::level::warn:     return "WARN";
    case spdlog::level::err:      return "ERROR";
    case spdlog::level::critical: return "CRITICAL";
    default:                      return "INFO";
    }
}

// mode.hpp policy ranks (SUPERLOG_LEVEL_*); unknown maps to INFO like above
inline int level_rank(spdlog::level::level_enum l) noexcept
{
    switch (l) {
    case spdlog::level::trace:    return SUPERLOG_LEVEL_TRACE;
    case spdlog::level::debug:    return SUPERLOG_LEVEL_DEBUG;
    case spdlog::level::info:     return SUPERLOG_LEVEL_INFO;
    case spdlog::level::warn:     return SUPERLOG_LEVEL_WARN;
    case spdlog::level::err:      return SUPERLOG_LEVEL_ERROR;
    case spdlog::level::critical: return SUPERLOG_LEVEL_CRITICAL;
    default:                      return SUPERLOG_LEVEL_INFO;
    }
}

} // namespace detail

template <typename Mutex>
class spdlog_sink final : public spdlog::sinks::base_sink<Mutex> {
public:
    spdlog_sink(std::shared_ptr<batcher> b, origin o,
                std::string session = make_session())
        : b_(std::move(b)), o_(std::move(o)), session_(std::move(session))
    {
    }

protected:
    void sink_it_(const spdlog::details::log_msg& msg) override
    {
#if !SUPERLOG_ENABLED
        (void)msg;                               // policy OFF: not even serialised
        return;
#else
        if (detail::level_rank(msg.level) < SUPERLOG_MIN_LEVEL)
            return;                              // below this mode's policy
        std::string src;
        if (msg.source.filename) {
            src = snicholls::log::detail::basename(msg.source.filename);
            src += ':';
            src += std::to_string(msg.source.line);
        }
        b_->enqueue(make_event_json(
            detail::level_name(msg.level),
            std::string(msg.payload.data(), msg.payload.size()),
            o_, session_,
            seq_.fetch_add(1, std::memory_order_relaxed),
            std::string(msg.logger_name.data(), msg.logger_name.size()),
            src));
#endif
    }

    void flush_() override {}                    // the batcher flushes on its own clock

private:
    std::shared_ptr<batcher> b_;
    origin o_;
    std::string session_;
    // Its own counter, not the record clock spdlog keeps private: per-session
    // monotonic is all PROTOCOL.md asks of seq.
    std::atomic<std::uint64_t> seq_{0};
};

using spdlog_sink_mt = spdlog_sink<std::mutex>;
using spdlog_sink_st = spdlog_sink<spdlog::details::null_mutex>;

} // namespace superlog

#endif /* SUPERLOG_HAS_SPDLOG */
#endif /* super_log_spdlog_sink_hpp */
