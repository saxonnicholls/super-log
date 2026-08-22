//
//  compile_test.cpp - keeps the header-only SDK honest on every build.
//
//  Also a live smoke test: with superlogd running on 7333, running this
//  binary puts three lines and a metric on every connected viewer. Without
//  the hub it still exits cleanly - failed POSTs are counted, never thrown.
//

#include <super_log/forward_sink.hpp>
// Opt-in (-DSUPER_LOG_TEST_SPDLOG=ON): the sink header gates itself on
// __has_include, but a machine can carry a *broken* spdlog - this one does,
// a /usr/local spdlog whose headers no longer match the fmt beside them -
// and the SDK's own gate cannot tell broken from present.
#ifdef SUPERLOG_TEST_SPDLOG
#include <super_log/spdlog_sink.hpp>
#endif

#include <chrono>
#include <cstdio>
#include <memory>
#include <thread>

int main()
{
    superlog::transport_config tcfg;
    tcfg.topic = "cpp.compile-test";
    auto bat = std::make_shared<superlog::batcher>(tcfg);   // before the logger: lifetime rule

    superlog::origin who;
    who.app = "compile-test";

    snicholls::log::logger lg;
    lg.add_sink(snicholls::log::console_sink());
    auto net = lg.add_lane("superlog", 1024, snicholls::log::overflow::drop_oldest);
    net.add_sink(superlog::forward_sink(bat, who));

    SN_LOGGER_INFO(lg) << "super-log C++ SDK compile test";
    SN_LOGGER_WARN(lg).field("answer", 42) << "structured fields ride along";
    lg.metric("compile_test.runs", 1.0);
    lg.flush();
    // Let the batcher's flush tick fire once, so the counters below reflect
    // an actual POST attempt rather than a queue nobody has drained yet
    std::this_thread::sleep_for(std::chrono::milliseconds(400));

    std::printf("ok (dropped=%llu post_failures=%llu)\n",
                (unsigned long long)bat->dropped(),
                (unsigned long long)bat->post_failures());
    return 0;
}
