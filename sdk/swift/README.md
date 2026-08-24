# SuperLog

The Swift SDK: one client for macOS, iOS and anywhere else Foundation runs.
No dependencies — URLSession is in the box, and a batch POST every 250 ms is
the whole transport ([PROTOCOL.md](../../docs/PROTOCOL.md)).

```swift
import SuperLog

let log = try SuperLog(
    url: "http://192.168.1.20:7333",   // the bench machine
    topic: "swift.pricer",             // <runtime>.<app>, like cpp.* and python.*
    app: "pricer",
    development: true,                 // exactly one of these two, or it throws
    production: false
)

log.info("engine up", fields: ["venue": "XLON"])
log.metric("fps", 58.9)
```

The demo client is `demo/swift/clock` — a clock on topic `swift.clock`, with a
metric every fifth tick and a caught error every seventh:

```
swift run --package-path demo/swift/clock clock
```

## Modes and policies

Exactly one of `development` / `production` must be true — neither or both
throws, deliberately: a logging client you *think* is off is worse than one
that refuses to start. Swift offers no compile-time way to demand it, so it
fails at `init`, loudly. Each mode forwards only what its policy allows:

| Option | Default | Meaning |
|--------|---------|---------|
| `developmentPolicy` | `.all` | everything |
| `productionPolicy`  | `.off` | **nothing** |

Production ships nothing until you say otherwise, because log lines leaving a
release build are a security decision. Want crash triage from production? Set
`productionPolicy: .atLeast(.error)` on purpose. Below-policy events are never
serialised, and `.off` leaves an inert shell: no worker thread, nothing on the
wire, and one line on stderr saying so — an inert client is otherwise
indistinguishable from a broken one.

`log.status()` prints what the client resolved to, which is the first thing to
look at when events are not arriving:

```
superlog[on] mode=development policy=TRACE url=http://127.0.0.1:7333
topic=swift.clock session=94d79844e6453131 queued=0 dropped=0
```

## Adding it to an app

```swift
.package(path: "../super-log/sdk/swift")          // or .package(url:from:)
```

then `.product(name: "SuperLog", package: "swift")` in your target — SwiftPM
identifies a path dependency by its **directory name**, so the package is
spelled `swift` even though everything in it is called SuperLog. The same
quirk is why the demo lives in `demo/swift/clock` and not `demo/swift`: two
packages whose directories are both named `swift` cannot see each other.

Sandboxed apps need `com.apple.security.network.client`, and an ATS exception
for the plaintext `http://` hub — `NSAllowsLocalNetworking` covers a hub on
`localhost` or a `.local` name; a bench reached by LAN IP needs
`NSExceptionDomains`. On iOS 14+ the first LAN connection also raises the
local-network permission prompt.

## Behaviour worth relying on

- **It never blocks your app.** Events go into a bounded ring that drops
  oldest when full, counted — `dropped()` tells you how many. Measured on this
  machine: 50 000 `log()` calls in 192 ms, **3.85 µs each**, release build.
  With a queue deliberately set to 8 slots, a 100-event burst produced 84
  counted drops and kept the newest 8, which is the trade in one line.
- **It is a class with a lock, not an actor.** An actor would make every log
  call `await`, and a suspension point is a place your producer can be stalled
  by its logger. `log.info(…)` is synchronous and legal from any thread or
  task.
- **A failed POST is counted, not retried.** A retry queue grows without bound
  on a process that outlives the bench; the next batch succeeds or counts
  again.
- **`dropped()` reading 0 does not prove health.** An inert client never
  queues, so it never drops. Read `status()` first.
- **The last batch leaves.** Clients register an `atexit` flush, so a program
  that runs to completion does not lose what was still queued. `close()` does
  it explicitly; `flush()` is the one call that blocks its caller, on purpose,
  for the moments where the process is about to stop existing.
- **Build one and keep it.** An enabled client owns a thread and is held by
  that at-exit registry until the process ends, so its last batch cannot be
  collected out from under the worker. One per process (or per topic) is the
  shape; one per request leaks a thread per request.

## Correlation

`trace` is what says a tap, the HTTP call it made and the failure it caused
are the same story. Here it lives in a `@TaskLocal`, which is the
structured-concurrency-safe equivalent of Python's ContextVar:

```swift
await log.withTrace { tid in
    log.info("user tapped Send")
    var req = URLRequest(url: endpoint)
    req.setValue(tid, forHTTPHeaderField: SuperLog.traceHeader)   // X-Superlog-Trace
    _ = try await URLSession.shared.data(for: req)
}
```

Every child task of that scope inherits the id without being handed it, and
two concurrent requests cannot borrow each other's. There is deliberately no
`setTrace()` to match Python's: a TaskLocal binds for a scope only, so the
leak where one request's id survives into the next request's logs is not
expressible. `SuperLog.currentTrace` reads it; `log.traceID` is the same thing
from an instance.

Verified against the hub: one tick's `GET /recent?trace=<id>` returned all
four of its events, including the DEBUG line logged from a child task that was
passed no id at all.

## Uncaught errors, honestly

```swift
log.installUncaughtHandler()   // NSExceptions
log.installCrashHandler()      // signals - stderr only, see below
```

`installUncaughtHandler()` logs every uncaught **NSException** as CRITICAL
with its `callStackSymbols`, then chains to the handler that was already
installed. That is a real class of crash on Apple platforms — the
`NSInvalidArgumentException` out of AppKit, an unrecognised selector, a KVC
failure — but the name oversells it, so be clear about what it is not: a Swift
`Error` is a return value, not an exception, and a Swift runtime trap
(`fatalError`, a force-unwrapped nil, an array bounds violation, arithmetic
overflow) executes a trap instruction and arrives as a **signal**, where this
handler is never consulted.

`installCrashHandler()` takes SIGSEGV, SIGBUS, SIGFPE and SIGILL, and
**deliberately does not log them to the hub** — the same decision, for the
same reason, as the C++ SDK's
[`exceptions.hpp`](../cpp/include/super_log/exceptions.hpp): a signal handler
may only call async-signal-safe functions, and this client's queue path
allocates, takes a lock and calls into URLSession. A logger that deadlocks the
crashing process is worse than one that says nothing. So the handler does the
one safe thing — a `write(2)` of a fixed string naming the signal — then
restores the default disposition and re-raises, leaving the crash report, core
dump and exit status exactly as they would have been. SIGTRAP is left alone
even though arm64 Swift traps arrive as one: hooking it fights every debugger
you would rather be using. For real crash capture, use a reporter that writes
a minidump from a separate process; that is not this tool's job.

`log.exception(err, where: "checkout")` logs a caught error the same way, at
ERROR, tagged `exception`, with the stack capped at 40 frames. Note whose
stack it is: Swift errors carry none of their own, so the frames are captured
at the *log* site — where the error was handled, not where it was thrown.
That is what `where:` is for.

## No swift-log dependency

Taking one would break the house rule, and a debugging tool that needs its own
dependency graph resolved before it can tell you why the dependency graph
broke is not much of a debugging tool. If your app already uses swift-log,
the bridge is yours to write and it is this long:

```swift
struct SuperLogHandler: LogHandler {
    let slog: SuperLog
    var logLevel: Logger.Level = .trace
    var metadata: Logger.Metadata = [:]
    subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { metadata[key] }
        set { metadata[key] = newValue }
    }
    func log(level: Logger.Level, message: Logger.Message,
             metadata: Logger.Metadata?, source: String,
             file: String, function: String, line: UInt) {
        let mapped: Level = switch level {
        case .trace: .trace
        case .debug: .debug
        case .info, .notice: .info
        case .warning: .warn
        case .error: .error
        case .critical: .critical
        }
        slog.log(mapped, "\(message)",
                 fields: (metadata ?? [:]).mapValues { "\($0)" },
                 tag: source, src: "\(file):\(line)")
    }
}
```

`fields` is `[String: String]` because PROTOCOL.md says structured extras are
string values, and stringifying at the call site is honest about what reaches
the wire.
