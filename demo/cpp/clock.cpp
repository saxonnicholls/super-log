//
//  clock.cpp - the C++ demo client
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  One process, both C++ entries onto the pipeline, once a second each:
//
//    cpp.clock         SN_LOG -> snicholls::log lane -> superlog::forward_sink
//    cpp.spdlog.clock  spdlog -> superlog::spdlog_sink
//
//  The spdlog stream is the end-to-end proof that the vendored third_party
//  spdlog+fmt pair actually formats, compiles and ships events - the thing
//  the broken /usr/local pair could not do. The native stream sits beside it
//  so the two paths can be eyeballed against each other on the viewers:
//  same process, same seconds, two topics.
//

#include "event/time_master.hpp"   // ts-moveables: the Legendary TimeMaster

#include <spdlog/sinks/stdout_color_sinks.h>
#include <spdlog/spdlog.h>
#include <spdlog/version.h>
#include <super_log/forward_sink.hpp>
#include <super_log/spdlog_sink.hpp>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <ctime>
#include <memory>
#include <string>

namespace {

// Signal handlers may only touch lock-free atomics; the loop polls.
std::atomic<bool> g_stop{false};
void on_signal(int) { g_stop.store(true, std::memory_order_relaxed); }

// Topic namespace from SUPER_LOG_TOPIC_NS, default "cpp". The Ubuntu
// container runs this same binary as cpp.linux.* - a separate stream, not
// two hosts interleaving into one (topics name streams; two clocks on one
// topic would be two sessions fighting over it).
superlog::transport_config config_for(const char* suffix)
{
    superlog::transport_config cfg;
    const char* ns = std::getenv("SUPER_LOG_TOPIC_NS");
    cfg.topic = std::string(ns && *ns ? ns : "cpp") + suffix;
    // SUPER_LOG_URL is what every other SDK here reads, so it has to work
    // for this one too. Setting it and having seven of nine clients move to
    // the new hub while two keep quietly talking to the old one is precisely
    // the silent-failure this project exists to prevent.
    if (const char* u = std::getenv("SUPER_LOG_URL"); u && *u) {
        std::string rest = u;
        if (const auto at = rest.find("://"); at != std::string::npos)
            rest = rest.substr(at + 3);
        rest = rest.substr(0, rest.find('/'));
        if (const auto colon = rest.rfind(':'); colon != std::string::npos) {
            cfg.host = rest.substr(0, colon);
            cfg.port = static_cast<std::uint16_t>(std::strtol(rest.c_str() + colon + 1, nullptr, 10));
        } else if (!rest.empty()) {
            cfg.host = rest;
        }
    }
    // The older pair still wins if set explicitly, so nothing that already
    // works stops working.
    if (const char* h = std::getenv("SUPER_LOG_HOST"))
        cfg.host = h;
    if (const char* p = std::getenv("SUPER_LOG_PORT"))
        cfg.port = static_cast<std::uint16_t>(std::strtol(p, nullptr, 10));
    return cfg;
}

} // namespace

int main()
{
    // One batcher per topic - a batcher's whole life is one ingest path.
    // Both before the loggers: the lifetime rule (forward_sink.hpp).
    auto bat_native = std::make_shared<superlog::batcher>(config_for(".clock"));
    auto bat_spdlog = std::make_shared<superlog::batcher>(config_for(".spdlog.clock"));

    superlog::origin who;
    who.app = "clock";

    // The native path: SN_LOG onto its own lane, network only ever behind it
    snicholls::log::logger lg;
    lg.add_sink(snicholls::log::console_sink());
    auto net = lg.add_lane("superlog", 1024, snicholls::log::overflow::drop_oldest);
    net.add_sink(superlog::forward_sink(bat_native, who));

    // The spdlog path: our sink beside the console one
    auto slg = spdlog::stdout_color_mt("clock");
    slg->sinks().push_back(std::make_shared<superlog::spdlog_sink_mt>(bat_spdlog, who));

    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    SN_LOGGER_INFO(lg) << "cpp clock up - SN_LOG -> forward_sink, one line a second";
    slg->info("cpp spdlog clock up - spdlog {}.{}.{} / fmt {}.{}.{} -> spdlog_sink, one line a second",
              SPDLOG_VER_MAJOR, SPDLOG_VER_MINOR, SPDLOG_VER_PATCH,
              FMT_VERSION / 10000, FMT_VERSION / 100 % 100, FMT_VERSION % 100);

    // The tick is time_master's job - drift-free periodic scheduling is
    // already written (ts-moveables event/time_master.hpp), and a sleep loop
    // drifts by the cost of its own body where this one never will. tm is
    // declared after the loggers, so its closure outlives nothing it uses.
    std::uint64_t n = 0;
    snicholls::time_master tm;
    tm.add_event(std::chrono::seconds(1), [&] {
        // UTC in every client - the Rust one has no local clock without a
        // crate, so the streams agree on UTC instead
        const std::time_t t = std::time(nullptr);
        char hms[16];
        std::strftime(hms, sizeof hms, "%H:%M:%SZ", std::gmtime(&t));
        ++n;
        SN_LOGGER_INFO(lg).field("tick", n) << "tick " << n << " - the time is " << hms;
        slg->info("tick {} - the time is {}", n, hms);
    });

    // run_once with a bounded wait, so the signal atomic is polled without
    // the handler ever touching the scheduler (stop() is not signal-safe)
    while (!g_stop.load(std::memory_order_relaxed))
        tm.run_once(std::chrono::milliseconds(200));
    tm.stop();

    SN_LOGGER_INFO(lg) << "cpp clock down after " << n << " ticks";
    slg->info("cpp spdlog clock down after {} ticks", n);
    spdlog::shutdown();     // drops the spdlog sink; lg and the batchers
                            // drain in reverse declaration order after
    return 0;
}
