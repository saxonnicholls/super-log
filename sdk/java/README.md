# super-log — the Java SDK

One client for every JVM we run: a service, a CLI, a test harness, an
Android app. Zero dependencies — `HttpURLConnection` and `java.util.logging`
are in the JDK, and a batch POST every 250 ms is the whole transport
([PROTOCOL.md](../../docs/PROTOCOL.md)).

```java
SuperLog log = SuperLog.builder()
        .topic("java.pricer")          // a stream name: java.<app>
        .app("pricer")
        .url("http://192.168.1.20:7451")  // the bench machine
        .development(true)             // exactly one of these two, or it throws
        .production(false)
        .build();

log.info("engine up", SuperLog.fields("venue", "XLON"));
log.metric("fills.per.sec", 58.9);

Logger.getLogger("").addHandler(log.handler());   // everything already logged
log.installUncaughtHandler();                     // and every crash
```

No build tool. `javac` compiles it as it stands:

```sh
javac -d out $(find sdk/java -name '*.java') MyApp.java
```

Drop the sources into a Maven/Gradle project, or `jar cf superlog.jar -C out .`
and put that on the classpath. There is no pom, no gradle file and no
`module-info` on purpose: this repo already has four toolchains and the Java
SDK is six source files that need none of them.

## Modes and policies

Exactly one of `development` / `production` must be true — neither or both
throws `IllegalArgumentException`, deliberately: a logging client you *think*
is off is worse than one that refuses to start. Each mode forwards only what
its policy allows:

| Builder option        | Default        | Meaning |
|-----------------------|----------------|---------|
| `developmentPolicy`   | `Policy.ALL`   | everything, TRACE upwards |
| `productionPolicy`    | `Policy.OFF`   | **nothing** |

Production ships nothing until you say otherwise, because log lines leaving a
release build are a security decision. Want crash triage from production? Set
`productionPolicy(Policy.atLeast(Level.ERROR))` on purpose. Below-policy
events are never serialised, and `OFF` leaves an inert shell: no worker
thread, no sockets, nothing on the wire.

An inert client prints **one** line to stderr saying so, because otherwise it
is indistinguishable from a broken one — nothing arrives, and `dropped()`
reads 0 because nothing was ever queued, which reads as healthy:

```
superlog: production policy is OFF - nothing will be sent to http://127.0.0.1:7333. Set productionPolicy to change that.
```

`status()` is the other half of that answer, and the first thing to print when
events are not arriving:

```java
System.out.println(log.status().toJson());
// {"enabled":true,"mode":"development","policy":"TRACE","url":"http://127.0.0.1:7451",
//  "topic":"java.clock","session":"105e2623d0ed0416","queued":0,"dropped":0}
```

## Behaviour worth relying on

- **It never blocks your program.** Events go into a bounded queue that drops
  **oldest** when full, counted — `dropped()` tells you how many. Measured
  warm, with the hub down so every POST failed: **1.8 µs** to serialise and
  enqueue an event, and 100 000 of them changed nothing about the caller.
  A logger that can stall the program it observes is worse than no logger.
- **Drop-oldest, not drop-newest.** Under a burst the newest line is the one
  most likely to explain it. Flood a queue of 8 with 100 events and the eight
  that arrive are numbers 92–99, with `dropped()` reading 92.
- **A failed POST is counted, not retried.** A retry queue grows without bound
  on a process that outlives the bench; the next batch succeeds or counts again.
- **The last batch is not lost.** A shutdown hook flushes on exit, and
  `close()` drains anything still queued **on the calling thread** — which is
  what makes a goodbye line logged after Ctrl-C survive, since shutdown hooks
  run concurrently and in no defined order.
- **`java.net.http.HttpClient` is deliberately not used.** It starts threads
  that have historically kept a JVM alive after `main` returned.
  `HttpURLConnection` starts none.
- **Do not run a tailer on the same topic** at the same time, or the app's
  lines are reported twice.

## Everything the program already logs

The single most valuable integration point, and the reason a Java service can
go on the bench without being edited: attach the handler to the root logger
and every `java.util.logging` line reaches the hub, keeping its logger name as
`tag` and its level mapped to PROTOCOL.md's six.

```java
Logger root = Logger.getLogger("");
root.addHandler(log.handler());
root.setLevel(java.util.logging.Level.ALL);   // or the JDK filters FINE out
                                              // before any handler sees it
```

| java.util.logging | super-log |
|-------------------|-----------|
| above `SEVERE`    | `CRITICAL` |
| `SEVERE`          | `ERROR` |
| `WARNING`         | `WARN` |
| `INFO`            | `INFO` |
| `CONFIG`, `FINE`  | `DEBUG` |
| `FINER`, `FINEST` | `TRACE` |

JUL has no fatal level, so only a custom level above `SEVERE` reaches
`CRITICAL`. A `LogRecord` carries no file and no line — it infers class and
method by walking the stack — so `src` gets `Class.method`, the truest thing
available, rather than a `file:line` nobody can trust. A `thrown` throwable
becomes `fields.stack` and `fields.type`.

The handler ignores records emitted on the client's own worker thread. The
JDK's HTTP stack logs through JUL, so without that guard a line written while
POSTing a batch would be queued and POSTed, which writes another line: the
handler would feed the queue that feeds it.

`handler().close()` flushes but does **not** close the client — `LogManager`
closes handlers at exit, and that would silence a client the program is still
using.

### SLF4J / Logback, without the dependency

The SDK compiles against nothing, so an SLF4J appender cannot ship here: it
would not compile without a jar on the classpath. It is twenty lines in *your*
project, which already has that jar. Logback:

```java
// src/main/java/…/SuperLogAppender.java  — in the app, not in the SDK
public final class SuperLogAppender extends AppenderBase<ILoggingEvent> {
    private final SuperLog log;
    public SuperLogAppender(SuperLog log) { this.log = log; }

    @Override protected void append(ILoggingEvent e) {
        Map<String, Object> fields = new LinkedHashMap<>(e.getMDCPropertyMap());
        IThrowableProxy t = e.getThrowableProxy();
        if (t != null) {
            fields.put("type", t.getClassName());
            fields.put("stack", ThrowableProxyUtil.asString(t));
        }
        log.log(map(e.getLevel()), e.getFormattedMessage(), fields,
                e.getLoggerName(), null);
    }

    private static Level map(ch.qos.logback.classic.Level l) {
        switch (l.toInt()) {
            case ch.qos.logback.classic.Level.ERROR_INT: return Level.ERROR;
            case ch.qos.logback.classic.Level.WARN_INT:  return Level.WARN;
            case ch.qos.logback.classic.Level.DEBUG_INT: return Level.DEBUG;
            case ch.qos.logback.classic.Level.TRACE_INT: return Level.TRACE;
            default:                                     return Level.INFO;
        }
    }
}
```

Wire it once at startup:

```java
ch.qos.logback.classic.Logger root =
        (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
SuperLogAppender a = new SuperLogAppender(log);
a.setContext(root.getLoggerContext());
a.start();
root.addAppender(a);
```

If your app routes SLF4J to `java.util.logging` (`slf4j-jdk14`), skip all of
that: `log.handler()` already sees those lines.

## Correlation

`trace` is what says a tap, an HTTP call, a database write and four log
streams are the same story. One id per user action, carried unchanged by
everything it causes, and over the wire it is the `X-Superlog-Trace` header —
exposed as `SuperLog.TRACE_HEADER`.

```java
try (SuperLog.TraceScope s = log.traceScope()) {
    log.info("user tapped Send");
    conn.setRequestProperty(SuperLog.TRACE_HEADER, s.id());   // the service
}                                                             // logs under
                                                              // the same id
log.traced(id -> { … });          // the lambda form
String r = log.tracedCall(id -> fetch(id));
```

The id lives in an **`InheritableThreadLocal`**, which is the right trade for
Java and worth being precise about. A child thread copies the value when it is
created, so the one hand-off Java code makes constantly — a request thread
that spawns a worker to finish the job — stays correlated with no plumbing.
That is as close as Java gets to Python's `ContextVar`. It is honestly weaker
in one place: **a thread pool inherits from whichever thread created the
pool**, and then keeps whatever value it last held between unrelated tasks.
`TraceScope.close()` restores the previous value, which fixes the case where
the pooled thread entered the scope itself; it cannot fix work *handed* to a
pool from elsewhere. Wrap those:

```java
pool.submit(log.wrap(() -> charge(order)));      // Runnable or Callable
```

`wrap` captures the id at submit time and restores the thread's previous id
afterwards, so a pooled thread is never left holding an id from a request that
finished ten minutes ago.

## Every uncaught exception

```java
log.installUncaughtHandler();
```

Installs a default `Thread.UncaughtExceptionHandler` and **chains** to
whatever was installed before, so nothing that used to happen stops happening:
the stack still reaches stderr, and the exit status is still 1. The event is
`ERROR`, tagged `exception`, with `fields.where = "uncaught"`, the failing
thread's name, and the stack — including `Caused by` chains — in
`fields.stack`, capped at 40 lines. It flushes before returning, because the
JVM is usually about to die.

If nothing was installed before, the handler prints exactly what the JVM would
have. It does **not** delegate to `ThreadGroup.uncaughtException`: the root
group's implementation looks the default handler back up and calls it, which
is an infinite recursion.

`log.exception(e, "where", fields)` logs a caught throwable the same way. Java
hands out no frame locals, so unlike the Python SDK this cannot say what the
values were — name the inputs that mattered in `fields` at the catch site,
which is the only place that knows them.

## From Kotlin

This is the audience that matters for Android, so the API is shaped for it:
a builder (Kotlin cannot use Java named arguments), single-abstract-method
parameters that take a trailing lambda, and `AutoCloseable` everywhere Kotlin
would reach for `use`.

```kotlin
val log = SuperLog.builder()
    .topic("android.wallet")
    .app("wallet")
    .url("http://10.0.2.2:7333")
    .development(BuildConfig.DEBUG)
    .production(!BuildConfig.DEBUG)
    .build()

log.info("checkout mounted", mapOf("user" to "42"))
log.metric("fps", 58.9)

log.traced { id ->                              // SAM conversion, so this is
    log.info("user tapped Send")                // a trailing lambda
    request.addHeader(SuperLog.TRACE_HEADER, id)
}

log.traceScope().use { scope ->                 // or the scoped form
    log.warn("slow path", mapOf("trace" to scope.id()))
}

val s = log.status()
println("${s.topic()} -> ${s.url()} dropped=${s.dropped()}")
```

`SuperLog` is `AutoCloseable`, so `SuperLog.builder()…build().use { }` works
for a short-lived tool. A long-lived app should keep one client and let the
shutdown hook flush it.

`SuperLog.fields("k", v, "k2", v2)` builds the map when a literal `mapOf` is
noisier, and takes `Any` values — everything is stringified, because
PROTOCOL.md says field values are strings so a reader never has to guess a
type it did not ask for.

### On Android

- Topic `android.<app>`; `origin.platform` reports **`android`** by itself
  (Dalvik/ART identify themselves), and `origin.runtime` is `java`.
- The hub is on your machine, not the phone: `10.0.2.2:7333` from the
  emulator, or `localhost` after `adb reverse tcp:7333 tcp:7333`, or the
  Mac's LAN IP from hardware — the table at the end of PROTOCOL.md.
- `android.permission.INTERNET`, and `android:usesCleartextTraffic="true"`
  (or a `network_security_config` exception for the bench's IP), because the
  hub speaks plain HTTP on a LAN.
- `production(!BuildConfig.DEBUG)` and the default `OFF` policy mean a
  released APK sends nothing. That is the point.
- The JUL handler works on Android but most Android code writes to
  `android.util.Log`, which no handler can intercept. Either log through the
  client at the call sites that matter, or put a tailer on `adb logcat` and
  use the `expo.android.*` topics — the host-side tailer sees everything the
  device prints, including native crashes an in-process client cannot survive.

## Verified

Against a live `superlogd` (`SUPER_LOG_PORT=7451`), by `demo/java/Clock.java`:
all six levels arrive; `trace` appears on every event inside a scope and on a
thread started inside it; `metric` carries its `{name,value}` object; JUL lines
arrive with `tag` and `src` and no call-site changes; a caught exception
carries its multi-line stack intact through the hand-rolled escaping; `--crash`
prints its stack to stderr, exits 1, *and* reaches the hub; a `PRODUCTION`
client sends zero events while printing its one notice; and a full queue drops
oldest, counted.

```sh
SUPER_LOG_PORT=7451 ./build/hub/superlogd &
javac -d /tmp/slj $(find sdk/java -name '*.java') demo/java/Clock.java
SUPER_LOG_URL=http://127.0.0.1:7451 java -cp /tmp/slj Clock
SUPER_LOG_URL=http://127.0.0.1:7451 java -cp /tmp/slj Clock --crash
curl -s 'http://127.0.0.1:7451/recent?limit=50'
```
