//
//  forward_sink.hpp
//  super-log C++ SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The bridge from snicholls::log to superlogd, and it is three lines because
//  the logger was designed for sinks like this one. Attach it to its own lane
//  so the network can only ever fall behind by itself:
//
//      auto bat = std::make_shared<superlog::batcher>(
//          superlog::transport_config{.topic = "cpp.moveables"});
//      superlog::origin who;
//      who.app = "moveables-demo";
//
//      snicholls::log::logger lg;
//      lg.add_sink(snicholls::log::console_sink());        // local, as before
//      auto net = lg.add_lane("superlog", 8192, snicholls::log::overflow::drop_oldest);
//      net.add_sink(superlog::forward_sink(bat, who));
//
//      SN_LOGGER_INFO(lg) << "this line is on every screen in the room";
//
//  Lifetime: declare the batcher BEFORE the logger. Destruction runs in
//  reverse, the lane drains through this sink on teardown, and the sink must
//  still have somewhere to enqueue - the same one rule as every ts-moveables
//  sink (see the logger.hpp header comment).
//

#ifndef super_log_forward_sink_hpp
#define super_log_forward_sink_hpp

#include "event.hpp"
#include "transport.hpp"

#include <functional>
#include <memory>
#include <string>
#include <utility>

namespace superlog {

inline std::function<void(const snicholls::log::record&)>
forward_sink(std::shared_ptr<batcher> b, origin o, std::string session = make_session())
{
    return [b = std::move(b), o = std::move(o),
            session = std::move(session)](const snicholls::log::record& r) {
        // The mode's policy (mode.hpp): a below-threshold record costs one
        // compare - not serialised, not queued. snicholls::log ranks match
        // ours off by one (trace = 0 there, 1 here).
        if (static_cast<int>(r.level) + 1 < SUPERLOG_MIN_LEVEL)
            return;
        b->enqueue(to_event_json(r, o, session));
    };
}

} // namespace superlog

#endif /* super_log_forward_sink_hpp */
