//
//  SuperLog.swift
//  super-log - the Swift SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Same contract as the C++, Rust, JS and Python SDKs: events go into a
//  bounded queue from any thread or any task, one worker drains them into
//  NDJSON chunks and POSTs each chunk to superlogd. Producers never block on
//  the network - the queue drops oldest, counted, because a logger that can
//  stall the app it observes is worse than no logger.
//
//      import SuperLog
//
//      let log = try SuperLog(topic: "swift.pricer", app: "pricer",
//                             development: true, production: false)
//      log.info("engine up", fields: ["venue": "XLON"])
//      log.metric("fps", 58.9)
//
//      log.installUncaughtHandler()          // NSExceptions reach the bench
//
//  Foundation only, on purpose (the house rule for the SDKs). The two Swift
//  specifics worth knowing before reading further:
//
//    - the client is a plain class with a lock, not an actor. An actor would
//      make every log call `await`, which is a suspension point - a producer
//      that can be suspended by its logger is a producer the logger can
//      stall, and rule one says it never does. `log.info(...)` is
//      synchronous, cheap, and legal from anywhere.
//    - correlation lives in a `@TaskLocal`, which is the structured-
//      concurrency-safe equivalent of Python's ContextVar: a child task
//      inherits the trace of the task that spawned it, and two concurrent
//      requests cannot borrow each other's id.
//
//  Wire contract: ../../../../docs/PROTOCOL.md
//

import Foundation
import Dispatch

#if canImport(FoundationNetworking)
import FoundationNetworking      // Linux keeps URLSession in a second module
#endif

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

// ------------------------------------------------------------------ levels

public enum Level: String, Sendable, CaseIterable, Comparable {
    case trace = "TRACE"
    case debug = "DEBUG"
    case info = "INFO"
    case warn = "WARN"
    case error = "ERROR"
    case critical = "CRITICAL"

    var rank: Int {
        switch self {
        case .trace: 1
        case .debug: 2
        case .info: 3
        case .warn: 4
        case .error: 5
        case .critical: 6
        }
    }

    public static func < (a: Level, b: Level) -> Bool { a.rank < b.rank }
}

/// What a mode forwards. `.off` makes the client an inert shell.
public enum Policy: Sendable, Equatable {
    case all
    case off
    case atLeast(Level)

    /// One rank above `.critical`, so nothing clears it.
    static let offRank = 7

    var minRank: Int {
        switch self {
        case .all: Level.trace.rank
        case .off: Policy.offRank
        case .atLeast(let l): l.rank
        }
    }

    var name: String {
        switch self {
        case .all: Level.trace.rawValue
        case .off: "OFF"
        case .atLeast(let l): l.rawValue
        }
    }
}

public enum SuperLogError: Error, CustomStringConvertible {
    case modeUndeclared(both: Bool)
    case badURL(String)

    public var description: String {
        switch self {
        case .modeUndeclared(let both):
            "superlog: set exactly one of development / production (got \(both ? "both" : "neither"))"
        case .badURL(let u):
            "superlog: \(u) is not a usable hub URL"
        }
    }
}

/// What a client resolved to - the first thing to print when events are not
/// arriving. `enabled == false` means the mode's policy turned it off, not
/// that the network is broken.
public struct Status: Sendable, CustomStringConvertible {
    public let enabled: Bool
    public let mode: String
    public let policy: String
    public let url: String
    public let topic: String
    public let session: String
    public let queued: Int
    public let dropped: Int

    public var description: String {
        "superlog[\(enabled ? "on" : "OFF")] mode=\(mode) policy=\(policy) "
            + "url=\(url) topic=\(topic) session=\(session) "
            + "queued=\(queued) dropped=\(dropped)"
    }
}

// ------------------------------------------------------------------ client

/// One client per process (or per topic). Cheap to pass around; every method
/// is safe from any thread and any task.
///
/// An enabled client owns a thread and lives until the process ends: it is
/// held by the at-exit registry so its last batch cannot be collected out
/// from under the worker, which is the same bargain Python's
/// `atexit.register` makes. Build one and keep it. Building one per request
/// leaks a thread per request, and no `deinit` can rescue that - the worker
/// holds a reference of its own while it runs, so the only thing that ends a
/// client is `close()`.
public final class SuperLog: @unchecked Sendable {

    /// Over the wire correlation is this header (PROTOCOL.md). A client puts
    /// it on outbound HTTP; a server adopts it for the logs of that request.
    public static let traceHeader = "X-Superlog-Trace"

    /// The trace in force for the current task. Reading it is free; setting
    /// it is only possible through `withTrace`, deliberately - see below.
    @TaskLocal public static var currentTrace: String?

    /// Short, opaque, and enough entropy for one bench session.
    public static func newTraceID() -> String {
        String(format: "%016llx", UInt64.random(in: .min ... .max))
    }

    public let url: String
    public let topic: String
    public let enabled: Bool

    private let mode: String
    private let policy: Policy
    private let minRank: Int
    private let session: String
    private let originJSON: String
    private let ingest: URL
    private let http: URLSession

    private let maxBatch: Int
    private let maxQueue: Int
    private let flushInterval: TimeInterval

    // One lock covers the ring, the counters and the worker's wakeup, which
    // is the whole of the mutable state. NSCondition rather than a bare lock
    // because the worker sleeps on it: a full batch wakes it early, and it
    // times out at the flush interval when the app is quiet.
    private let cond = NSCondition()
    private var ring: [String]
    private var head = 0
    private var count = 0
    private var seq: UInt64 = 0
    private var droppedCount = 0
    private var posting = false
    private var stopped = false
    private let finished = DispatchSemaphore(value: 0)

    public init(
        topic: String = "swift.app",
        app: String = "app",
        url: String = "http://127.0.0.1:7333",
        development: Bool? = nil,
        production: Bool? = nil,
        developmentPolicy: Policy = .all,
        productionPolicy: Policy = .off,
        device: String = "",
        flushMs: Int = 250,
        maxBatch: Int = 256,
        maxQueue: Int = 8192,
        quiet: Bool = false
    ) throws {
        // DEVELOPMENT xor PRODUCTION, enforced - the same rule as the other
        // SDKs. A logging pipeline you *think* is off is worse than one that
        // refuses to start until you decide. Swift has no compile-time way
        // to demand it (there is no `#error` reachable from a caller's build
        // settings), so it fails at init, loudly. A thrown error rather than
        // a precondition: the caller gets to decide whether a misconfigured
        // logger should take the process down, and `try` at one call site is
        // cheaper than a crash in someone's release build.
        let dev = development == true
        let prod = production == true
        guard dev != prod else { throw SuperLogError.modeUndeclared(both: dev) }

        let base = url.hasSuffix("/") ? String(url.dropLast()) : url
        guard let ingestURL = URL(string: base + "/ingest/" + topic),
              ingestURL.host != nil else {
            throw SuperLogError.badURL(url)
        }

        self.url = base
        self.topic = topic
        self.ingest = ingestURL
        self.mode = dev ? "development" : "production"
        self.policy = dev ? developmentPolicy : productionPolicy
        self.minRank = self.policy.minRank
        self.enabled = self.minRank < Policy.offRank
        self.session = String(format: "%016llx", UInt64.random(in: .min ... .max))
        // maxQueue is the caller's memory promise, so it wins: a batch is
        // clamped to fit inside it rather than the queue being quietly grown
        // to fit a batch.
        self.maxQueue = max(1, maxQueue)
        self.maxBatch = max(1, min(maxBatch, self.maxQueue))
        self.flushInterval = Double(flushMs) / 1000.0
        self.ring = [String](repeating: "", count: self.maxQueue)

        // `origin` never changes for the life of a client, so it is built
        // once as text and spliced into every event rather than re-encoded a
        // thousand times a minute.
        var origin = "{\"runtime\":\"swift\",\"app\":" + SuperLog.quoted(app)
            + ",\"platform\":\"" + SuperLog.platformName() + "\""
        if !device.isEmpty { origin += ",\"device\":" + SuperLog.quoted(device) }
        origin += "}"
        self.originJSON = origin

        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 5
        cfg.httpMaximumConnectionsPerHost = 1
        cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        self.http = URLSession(configuration: cfg)

        guard self.enabled else {
            // Say so once. An inert client is otherwise indistinguishable
            // from a broken one: nothing arrives, and dropped() reads 0
            // because nothing was ever queued, which reads as healthy.
            if !quiet {
                let notice = "superlog: \(mode) policy is OFF - nothing will be sent to "
                    + "\(base). Set \(mode)Policy to change that.\n"
                FileHandle.standardError.write(Data(notice.utf8))
            }
            return
        }

        // A dedicated Thread rather than a Task: the worker spends its life
        // blocked on a condition variable or inside a synchronous POST, and
        // blocking a cooperative-pool thread is exactly what the concurrency
        // runtime asks you never to do.
        let worker = Thread { [weak self] in self?.run() }
        worker.name = "superlog"
        worker.stackSize = 256 * 1024
        worker.start()

        SuperLog.registerForExit(self)
    }

    // ------------------------------------------------------------- status

    public func status() -> Status {
        cond.lock()
        let q = count
        let d = droppedCount
        cond.unlock()
        return Status(enabled: enabled, mode: mode, policy: policy.name,
                      url: url, topic: topic, session: session,
                      queued: q, dropped: d)
    }

    /// Events dropped because the queue was full, plus events lost to a
    /// failed POST. 0 does NOT mean healthy: an inert client never queues,
    /// so it never drops.
    public func dropped() -> Int {
        cond.lock()
        defer { cond.unlock() }
        return droppedCount
    }

    // ----------------------------------------------------------- emitting

    public func log(_ level: Level, _ msg: String,
                    fields: [String: String] = [:],
                    tag: String = "", src: String = "") {
        guard level.rank >= minRank else { return }   // not even serialised
        push(encode(level: level, msg: msg, fields: fields,
                    tag: tag, src: src, metric: nil))
    }

    public func trace(_ msg: String, fields: [String: String] = [:], tag: String = "", src: String = "") {
        log(.trace, msg, fields: fields, tag: tag, src: src)
    }
    public func debug(_ msg: String, fields: [String: String] = [:], tag: String = "", src: String = "") {
        log(.debug, msg, fields: fields, tag: tag, src: src)
    }
    public func info(_ msg: String, fields: [String: String] = [:], tag: String = "", src: String = "") {
        log(.info, msg, fields: fields, tag: tag, src: src)
    }
    public func warn(_ msg: String, fields: [String: String] = [:], tag: String = "", src: String = "") {
        log(.warn, msg, fields: fields, tag: tag, src: src)
    }
    public func error(_ msg: String, fields: [String: String] = [:], tag: String = "", src: String = "") {
        log(.error, msg, fields: fields, tag: tag, src: src)
    }
    public func critical(_ msg: String, fields: [String: String] = [:], tag: String = "", src: String = "") {
        log(.critical, msg, fields: fields, tag: tag, src: src)
    }

    /// Telemetry riding the same pipeline (PROTOCOL.md `metric`). Metrics
    /// ship at INFO, so a policy of ERROR silences them along with the
    /// chatter - which is the point of a policy.
    public func metric(_ name: String, _ value: Double, fields: [String: String] = [:]) {
        guard Level.info.rank >= minRank else { return }
        push(encode(level: .info, msg: name, fields: fields,
                    tag: "", src: "", metric: (name, value)))
    }

    // ----------------------------------------------------------- errors

    /// Log a caught error. Swift errors carry no stack of their own, so the
    /// stack is captured here, at the log site: the frames that handled the
    /// failure, not the frames that raised it. That is a real difference
    /// from the C++ and Python SDKs and the reason `where` is worth passing.
    public func exception(_ err: Error, where site: String = "caught",
                          fields: [String: String] = [:],
                          captureStack: Bool = true) {
        var out = fields
        out["where"] = site
        out["type"] = String(describing: type(of: err))
        if captureStack {
            let frames = Thread.callStackSymbols.dropFirst()   // drop this frame
            out["stack"] = frames.prefix(SuperLog.maxStackLines).joined(separator: "\n")
            if frames.count > SuperLog.maxStackLines { out["stack_truncated"] = "true" }
        }
        // Deliberately does not flush: a caught error is not a crash, and
        // rule one outranks getting this particular line out 250 ms sooner.
        log(.error, "\(site): \(type(of: err)): \(err)", fields: out, tag: "exception")
    }

    /// Deep enough to find the throw, short enough not to ship a book.
    public static let maxStackLines = 40

    #if canImport(ObjectiveC)
    /// Log every uncaught **NSException** as CRITICAL, then chain to the
    /// handler that was already installed, so nothing that used to happen
    /// stops happening.
    ///
    /// Be clear about the scope, because the name oversells it: this catches
    /// ObjC exceptions - the `NSInvalidArgumentException` out of AppKit, the
    /// KVC and unrecognised-selector failures, an `NSRangeException` from a
    /// Foundation collection. It does NOT catch a Swift `Error` (those are
    /// returns, not exceptions), and it does NOT catch a Swift runtime trap:
    /// `fatalError`, a force-unwrapped nil, an array bounds violation and an
    /// arithmetic overflow all execute a trap instruction and arrive as a
    /// signal, where this handler is never consulted. See
    /// `installCrashHandler()` for what can honestly be done about those.
    public func installUncaughtHandler() {
        guard enabled else { return }
        uncaughtLock.lock()
        defer { uncaughtLock.unlock() }
        guard uncaughtClient == nil else { return }
        uncaughtClient = self
        previousUncaughtHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { exc in
            if let client = uncaughtClient {
                let frames = exc.callStackSymbols
                var fields = ["where": "uncaught",
                              "type": exc.name.rawValue,
                              "stack": frames.prefix(SuperLog.maxStackLines).joined(separator: "\n")]
                if frames.count > SuperLog.maxStackLines { fields["stack_truncated"] = "true" }
                client.log(.critical,
                           "uncaught \(exc.name.rawValue): \(exc.reason ?? "no reason given")",
                           fields: fields, tag: "exception")
                // The worker drains on its own clock and this process is
                // about to end, so give the POST a moment rather than none.
                client.flush(timeout: 1.5)
            }
            previousUncaughtHandler?(exc)
        }
    }
    #endif

    /// Say on stderr that a fatal signal happened, then die exactly as
    /// before. Deliberately does **not** reach the hub, for the reason the
    /// C++ SDK spells out in `sdk/cpp/include/super_log/exceptions.hpp`: a
    /// signal handler may only call async-signal-safe functions, and this
    /// client's queue path allocates, takes a lock and calls into
    /// URLSession - none of which are. A logger that deadlocks the crashing
    /// process is worse than one that says nothing, so the handler does the
    /// one safe thing, `write(2)` of a fixed string, then restores the
    /// default disposition and re-raises so the crash report, core dump and
    /// exit status are unchanged.
    ///
    /// SIGTRAP is not taken even though arm64 Swift traps arrive as one:
    /// hooking it fights every debugger you would rather be using.
    public func installCrashHandler() {
        for sig in [SIGSEGV, SIGBUS, SIGFPE, SIGILL] {
            signal(sig, onFatalSignal)
        }
    }

    // ------------------------------------------------------- correlation

    /// Everything logged inside `body` carries `id`, including anything the
    /// child tasks of `body` log, and nothing outside it does.
    ///
    /// There is no `setTrace()` to match Python's, and that is the point: a
    /// `@TaskLocal` can only be bound for the extent of a scope, so the leak
    /// class where one request's id survives into the next request's logs is
    /// not expressible here. Pass the id you get to outbound HTTP as
    /// `SuperLog.traceHeader` and the server's logs join the same story.
    @discardableResult
    public func withTrace<R>(_ id: String? = nil,
                             _ body: (String) throws -> R) rethrows -> R {
        let tid = id ?? SuperLog.newTraceID()
        return try SuperLog.$currentTrace.withValue(tid) { try body(tid) }
    }

    @discardableResult
    public func withTrace<R>(_ id: String? = nil,
                             _ body: (String) async throws -> R) async rethrows -> R {
        let tid = id ?? SuperLog.newTraceID()
        return try await SuperLog.$currentTrace.withValue(tid) { try await body(tid) }
    }

    /// The trace in force right here, or nil. Handy for stamping the header
    /// on a request you are about to send from deep inside a scope.
    public var traceID: String? { SuperLog.currentTrace }

    // ---------------------------------------------------------- encoding

    private func encode(level: Level, msg: String, fields: [String: String],
                        tag: String, src: String, metric: (String, Double)?) -> String {
        cond.lock()
        let n = seq
        seq &+= 1
        cond.unlock()

        // Field order follows the table in PROTOCOL.md. Compact - no space
        // after a colon or a comma - like every SDK here: the hub's field
        // scan tolerates whitespace, but nothing on the wire is improved by
        // carrying it.
        var out = "{\"v\":1,\"ts\":\"" + SuperLog.isoNow() + "\",\"seq\":\(n)"
        out += ",\"session\":\"" + session + "\",\"level\":\"" + level.rawValue + "\""
        out += ",\"origin\":" + originJSON
        if !tag.isEmpty { out += ",\"tag\":" + SuperLog.quoted(tag) }
        if let t = SuperLog.currentTrace { out += ",\"trace\":" + SuperLog.quoted(t) }
        out += ",\"msg\":" + SuperLog.quoted(msg)
        if !fields.isEmpty {
            out += ",\"fields\":{"
            var first = true
            // Sorted, so two runs of the same code produce byte-identical
            // lines. Dictionary order is not stable across processes and a
            // log you cannot diff is a log you argue with.
            for key in fields.keys.sorted() {
                if !first { out += "," }
                first = false
                out += SuperLog.quoted(key) + ":" + SuperLog.quoted(fields[key]!)
            }
            out += "}"
        }
        if let m = metric {
            // JSON has no NaN and no Infinity. Emitting null makes a broken
            // reading visibly broken on the bench; emitting 0 would make it
            // invisibly wrong, which is the worse failure.
            let v = m.1.isFinite ? String(m.1) : "null"
            out += ",\"metric\":{\"name\":" + SuperLog.quoted(m.0) + ",\"value\":\(v)}"
        }
        if !src.isEmpty { out += ",\"src\":" + SuperLog.quoted(src) }
        out += "}"
        return out
    }

    private static func quoted(_ s: String) -> String {
        var out = "\""
        out.reserveCapacity(s.utf8.count + 2)
        for ch in s.unicodeScalars {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                // Raw control characters are the one thing that turns a
                // tailer's line into a parse error downstream.
                if ch.value < 0x20 {
                    out += String(format: "\\u%04x", ch.value)
                } else {
                    out.unicodeScalars.append(ch)
                }
            }
        }
        return out + "\""
    }

    // ------------------------------------------------------------ plumbing

    private func push(_ line: String) {
        cond.lock()
        if count == maxQueue {
            // The ring IS the drop-oldest policy: overwrite the head and
            // step past it. Bounded memory, no reallocation under burst, and
            // the newest events - the ones nearest whatever just went wrong
            // - are the ones that survive.
            ring[head] = line
            head = (head + 1) % maxQueue
            droppedCount += 1
        } else {
            ring[(head + count) % maxQueue] = line
            count += 1
        }
        if count >= maxBatch { cond.signal() }
        cond.unlock()
    }

    /// Caller holds the lock.
    private func drainLocked(_ upTo: Int) -> [String] {
        let n = min(upTo, count)
        guard n > 0 else { return [] }
        var batch = [String]()
        batch.reserveCapacity(n)
        for i in 0 ..< n {
            batch.append(ring[(head + i) % maxQueue])
            ring[(head + i) % maxQueue] = ""
        }
        head = (head + n) % maxQueue
        count -= n
        return batch
    }

    private func run() {
        while true {
            cond.lock()
            if !stopped && count < maxBatch {
                cond.wait(until: Date().addingTimeInterval(flushInterval))
            }
            let batch = drainLocked(maxBatch)
            let stopping = stopped
            posting = !batch.isEmpty
            cond.unlock()

            if !batch.isEmpty {
                post(batch)
                cond.lock(); posting = false; cond.unlock()
            }
            if stopping {
                cond.lock()
                let rest = drainLocked(Int.max)
                cond.unlock()
                if !rest.isEmpty { post(rest) }   // nothing queued is lost on exit
                finished.signal()
                return
            }
        }
    }

    private func post(_ batch: [String]) {
        var req = URLRequest(url: ingest)
        req.httpMethod = "POST"
        req.setValue("application/x-ndjson", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(batch.joined(separator: "\n").utf8)

        let done = DispatchSemaphore(value: 0)
        let outcome = Outcome()
        let task = http.dataTask(with: req) { _, response, err in
            if err != nil { outcome.fail() }
            else if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                outcome.fail()
            }
            done.signal()
        }
        task.resume()
        if done.wait(timeout: .now() + 10) == .timedOut {
            task.cancel()
            outcome.fail()
        }
        if outcome.failed {
            // The hub is down; count, do not retry. A retry queue grows
            // without bound on a process that outlives the bench.
            cond.lock()
            droppedCount += batch.count
            cond.unlock()
        }
    }

    /// Send what is queued now, and wait for it. The one call here that
    /// blocks its caller, on purpose: it exists for the moments where the
    /// process is about to stop existing.
    public func flush(timeout: TimeInterval = 2.0) {
        guard enabled else { return }
        let deadline = Date().addingTimeInterval(timeout)
        cond.lock()
        cond.signal()
        cond.unlock()
        while Date() < deadline {
            cond.lock()
            let idle = count == 0 && !posting
            cond.unlock()
            if idle { return }
            Thread.sleep(forTimeInterval: 0.02)
        }
    }

    /// Drain and stop the worker. Safe to call twice; called for you at
    /// exit, so a demo that runs to completion does not lose its last batch.
    public func close() {
        guard enabled else { return }
        cond.lock()
        if stopped { cond.unlock(); return }
        stopped = true
        cond.broadcast()
        cond.unlock()
        _ = finished.wait(timeout: .now() + 3)
    }

    // ------------------------------------------------------------- helpers

    /// ISO-8601 UTC with microseconds. Built by arithmetic rather than
    /// DateFormatter because a formatter is a shared mutable object that
    /// would need its own lock on the hot path, and ISO8601DateFormatter
    /// stops at milliseconds anyway - PROTOCOL.md welcomes the extra digits.
    ///
    /// The digits are laid into a byte buffer rather than run through
    /// String(format:), which measured at roughly 10 us a call - most of the
    /// cost of logging one event, spent on a timestamp whose shape never
    /// changes.
    private static func isoNow() -> String {
        let t = Date().timeIntervalSince1970
        var secs = Int(t.rounded(.down))
        var micros = Int(((t - Double(secs)) * 1_000_000).rounded())
        if micros >= 1_000_000 { micros -= 1_000_000; secs += 1 }
        let days = secs / 86400
        let sod = secs - days * 86400
        let (y, m, d) = civilFromDays(days)

        // YYYY-MM-DDTHH:MM:SS.ffffffZ, 27 bytes.
        var b = [UInt8](repeating: UInt8(ascii: "0"), count: 27)
        b[4] = UInt8(ascii: "-")
        b[7] = UInt8(ascii: "-")
        b[10] = UInt8(ascii: "T")
        b[13] = UInt8(ascii: ":")
        b[16] = UInt8(ascii: ":")
        b[19] = UInt8(ascii: ".")
        b[26] = UInt8(ascii: "Z")
        put(&b, y, at: 0, width: 4)
        put(&b, m, at: 5, width: 2)
        put(&b, d, at: 8, width: 2)
        put(&b, sod / 3600, at: 11, width: 2)
        put(&b, (sod % 3600) / 60, at: 14, width: 2)
        put(&b, sod % 60, at: 17, width: 2)
        put(&b, micros, at: 20, width: 6)
        return String(decoding: b, as: UTF8.self)
    }

    private static func put(_ b: inout [UInt8], _ value: Int, at offset: Int, width: Int) {
        var v = value
        var i = offset + width - 1
        while i >= offset {
            b[i] = UInt8(ascii: "0") + UInt8(v % 10)
            v /= 10
            i -= 1
        }
    }

    /// Days since the Unix epoch to a civil date - Howard Hinnant's
    /// algorithm, the same one ts-moveables uses.
    private static func civilFromDays(_ z0: Int) -> (Int, Int, Int) {
        var z = z0
        z += 719468
        let era = (z >= 0 ? z : z - 146096) / 146097
        let doe = z - era * 146097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        return (m <= 2 ? y + 1 : y, m, d)
    }

    private static func platformName() -> String {
        #if os(macOS)
        "macos"
        #elseif os(iOS)
        "ios"
        #elseif os(tvOS)
        "tvos"
        #elseif os(watchOS)
        "watchos"
        #elseif os(Windows)
        "windows"
        #else
        "linux"
        #endif
    }

    // Registered clients are flushed at exit. This holds a strong reference
    // for the life of the process, exactly as Python's atexit.register does:
    // one client per process is the documented shape, and a logger that is
    // collected while its last batch is still queued helps nobody.
    private static func registerForExit(_ client: SuperLog) {
        exitLock.lock()
        defer { exitLock.unlock() }
        liveClients.append(client)
        if !atexitInstalled {
            atexitInstalled = true
            atexit { SuperLog.closeAll() }
        }
    }

    private static func closeAll() {
        exitLock.lock()
        let clients = liveClients
        liveClients.removeAll()
        exitLock.unlock()
        for c in clients { c.close() }
    }
}

/// A box for the POST outcome. The completion handler runs on URLSession's
/// queue while this thread waits, so the flag crosses threads and the Swift
/// 6 checker is right to insist it be guarded.
private final class Outcome: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var failed: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func fail() { lock.lock(); value = true; lock.unlock() }
}

private let exitLock = NSLock()
nonisolated(unsafe) private var liveClients: [SuperLog] = []
nonisolated(unsafe) private var atexitInstalled = false

#if canImport(ObjectiveC)
private let uncaughtLock = NSLock()
nonisolated(unsafe) private var uncaughtClient: SuperLog?
nonisolated(unsafe) private var previousUncaughtHandler: (@convention(c) (NSException) -> Void)?
#endif

// Everything below runs in a signal handler, where the only legal calls are
// the async-signal-safe ones. write(2), signal(2) and raise(3) are; String,
// allocation and this file's lock are not, so none of them appear.
private func onFatalSignal(_ sig: Int32) {
    writeRaw("super-log: fatal ")
    switch sig {
    case SIGSEGV: writeRaw("SIGSEGV")
    case SIGBUS: writeRaw("SIGBUS")
    case SIGFPE: writeRaw("SIGFPE")
    case SIGILL: writeRaw("SIGILL")
    default: writeRaw("signal")
    }
    writeRaw(" - not logged to the hub (signal handlers cannot allocate)\n")
    signal(sig, SIG_DFL)
    raise(sig)
}

private func writeRaw(_ s: StaticString) {
    s.withUTF8Buffer { buf in
        _ = write(2, buf.baseAddress, buf.count)
    }
}
