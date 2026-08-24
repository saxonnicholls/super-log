//
//  main.swift - the Swift demo client
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  The same clock the other demo clients run, once a second on topic
//  swift.clock - and a tour of the one thing the Swift SDK does that its
//  siblings cannot, because Swift hands you structured concurrency and the
//  others do not: a trace bound for a scope is inherited by every child
//  task of that scope, so work that runs concurrently still lands under the
//  action that caused it.
//
//    swift run --package-path demo/swift/clock clock
//    swift run --package-path demo/swift/clock clock --ticks 8      # then exit
//    swift run --package-path demo/swift/clock clock --production   # silent
//
//  What to watch on the bench:
//
//    - every tick carries a `trace`, and so does the "pricing pass" line
//      that a *child task* logs - nothing was passed down to it;
//    - every fifth tick is a `metric` event riding the same pipeline;
//    - every seventh tick catches a real error and ships it with the tick
//      and the trace as fields;
//    - --production prints one line to stderr and sends nothing at all,
//      which is the default production policy doing its job.
//

import Foundation
import SuperLog

// Ctrl-C sets a flag and the loop notices. A signal handler may only call
// async-signal-safe functions, so it stores to a sig_atomic_t and does
// nothing else - no print, no logging, no allocation.
enum Interrupt {
    nonisolated(unsafe) static var requested: sig_atomic_t = 0
}

struct PricingError: Error, CustomStringConvertible {
    let symbol: String
    var description: String { "no rate for \(symbol)" }
}

/// Deliberately fails on one input, so the demo has a real thrown error
/// rather than a synthetic one.
func priceFor(_ symbol: String, qty: Int) throws -> Double {
    let rates = ["BTC": 64000.0, "ETH": 3200.0]
    guard let rate = rates[symbol] else { throw PricingError(symbol: symbol) }
    return rate * Double(qty)
}

/// Logged from a child task, with no trace argument anywhere in sight.
func pricingPass(_ log: SuperLog, tick: Int) async {
    log.debug("pricing pass \(tick)", tag: "pricer")
}

// UTC like every other demo client - the Rust one has no local timezone
// without a crate, so the streams agree on UTC instead.
func hms() -> String {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss"
    f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: Date()) + "Z"
}

let args = CommandLine.arguments
let production = args.contains("--production")
let limit: Int = {
    guard let i = args.firstIndex(of: "--ticks"), i + 1 < args.count else { return 0 }
    return Int(args[i + 1]) ?? 0
}()

let log = try SuperLog(
    topic: "swift.clock",
    app: "clock",
    url: ProcessInfo.processInfo.environment["SUPER_LOG_URL"] ?? "http://127.0.0.1:7333",
    development: !production,
    production: production
)

// NSExceptions from Foundation and AppKit; Swift traps are not exceptions
// and never reach it, which is why the crash handler is a separate call.
log.installUncaughtHandler()
log.installCrashHandler()

// Read the flag once before installing the handler: a Swift static is
// initialised lazily, and swift_once is not something to be running for the
// first time inside a signal handler.
_ = Interrupt.requested
signal(SIGINT) { _ in Interrupt.requested = 1 }

print("superlog: swift clock -> \(log.status())")
log.info("swift clock up - one line a second",
         fields: ["swift": "6.2", "ticks": limit == 0 ? "unbounded" : "\(limit)"])

var n = 0
while Interrupt.requested == 0 && (limit == 0 || n < limit) {
    n += 1

    // One trace per tick, inherited by everything the tick spawns - no
    // plumbing, because a TaskLocal flows down the task tree on its own.
    await log.withTrace { tid in
        log.info("tick \(n) - the time is \(hms())", fields: ["tick": "\(n)"])

        async let pass: Void = pricingPass(log, tick: n)
        await pass

        if n % 5 == 0 {
            log.metric("clock.uptime_s", Double(n))
        }
        if n % 7 == 0 {
            do {
                _ = try priceFor("DOGE", qty: n)
            } catch {
                log.exception(error, where: "caught",
                              fields: ["tick": "\(n)", "trace": tid])
                log.warn("pricing failed on tick \(n)", tag: "pricer")
            }
        }
    }

    try await Task.sleep(for: .seconds(1))
}

log.info("swift clock down after \(n) ticks",
         fields: ["dropped": "\(log.dropped())"])
print("superlog: \(log.status())")
log.close()
