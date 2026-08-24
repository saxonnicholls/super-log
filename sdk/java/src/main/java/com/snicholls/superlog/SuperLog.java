//
//  SuperLog.java
//  super-log - the Java SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Same contract as the C++, Rust, Python and JS SDKs: events go into a
//  bounded queue from any thread, one daemon worker drains them into NDJSON
//  chunks and POSTs each chunk to superlogd. Producers never block on the
//  network - the queue drops oldest, counted, because a logger that can
//  stall the program it observes is worse than no logger.
//
//      SuperLog log = SuperLog.builder()
//              .topic("java.pricer").app("pricer")
//              .development(true)
//              .build();
//      log.info("engine up", SuperLog.fields("venue", "XLON"));
//
//      Logger.getLogger("").addHandler(log.handler());  // everything already
//                                                       // logged, forwarded
//      log.installUncaughtHandler();                    // and every crash
//
//  JDK only, on purpose (the house rule for the SDKs), which is also why the
//  JSON is hand-rolled in Json.java and the transport is HttpURLConnection
//  rather than java.net.http.HttpClient: HttpURLConnection starts no threads
//  of its own, and a logging client that keeps a JVM alive after main has
//  returned is a bug people spend an afternoon on.
//
//  Compiles with plain `javac` - no build tool, no annotations, no module
//  descriptor. Kotlin callers get the same API; see README.md.
//
//  Wire contract: ../../../../../../../../docs/PROTOCOL.md
//

package com.snicholls.superlog;

import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.logging.Handler;

public final class SuperLog implements AutoCloseable {

    /** The correlation header of PROTOCOL.md. Put it on outbound HTTP and
     *  the service on the other end can log under the same id. */
    public static final String TRACE_HEADER = "X-Superlog-Trace";

    /** Deep enough to find the throw, short enough not to ship a book per
     *  crash. Counts rendered lines, so "Caused by" chains count too. */
    public static final int MAX_STACK_LINES = 40;

    private static final DateTimeFormatter TS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSSSS'Z'")
                             .withZone(ZoneOffset.UTC);

    // One trace id per thread, shared by every client in the JVM, because a
    // trace belongs to the work in flight and not to the logger observing it.
    //
    // InheritableThreadLocal, and not a plain ThreadLocal, because the id has
    // to survive the one hand-off Java code makes constantly: a request
    // thread that spawns a worker to finish the job. A child thread copies
    // the value at construction, so everything the tick starts is already
    // correlated with no plumbing. That is the closest Java gets to Python's
    // ContextVar, and it is honestly weaker in one place: a THREAD POOL
    // inherits from whichever thread happened to create the pool, then keeps
    // whatever value it last held between unrelated tasks. TraceScope
    // restores the previous value on close, which fixes the case where the
    // pooled thread entered the scope itself; it cannot fix work handed to a
    // pool from elsewhere. For executors, wrap the task - see wrap().
    private static final InheritableThreadLocal<String> CURRENT_TRACE =
            new InheritableThreadLocal<>();

    private final boolean enabled;
    private final int minRank;
    private final String mode;
    private final String policy;
    private final String url;
    private final String topic;
    private final String session;
    private final String originJson;
    private final URL endpoint;

    private final int maxBatch;
    private final int maxQueue;
    private final long flushMs;
    private final int connectTimeoutMs;
    private final int readTimeoutMs;

    private final Object lock = new Object();
    private final ArrayDeque<String> queue;
    private final AtomicLong seq = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();
    private int inFlight;                    // guarded by lock, read by flush()
    private boolean stop;                    // guarded by lock
    private final Thread worker;
    private Thread shutdownHook;
    private boolean uncaughtInstalled;

    // ----------------------------------------------------------- construction

    public static Builder builder() {
        return new Builder();
    }

    /** Convenience for the fields map, so a call site stays one line in both
     *  languages: fields("venue", "XLON", "px", 101.5). */
    public static Map<String, Object> fields(Object... kv) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            out.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return out;
    }

    /** Short, opaque, and enough entropy for one bench session. */
    public static String newTraceId() {
        return String.format("%016x", ThreadLocalRandom.current().nextLong());
    }

    private SuperLog(Builder b) {
        // DEVELOPMENT xor PRODUCTION, enforced - the same rule as the other
        // SDKs. A logging pipeline you *think* is off is worse than one that
        // refuses to start until you decide.
        if (b.development == b.production) {
            throw new IllegalArgumentException(
                    "superlog: set exactly one of development / production (got "
                    + (b.development ? "both" : "neither") + ")");
        }

        Policy p = b.development ? b.developmentPolicy : b.productionPolicy;
        this.mode = b.development ? "development" : "production";
        this.policy = p.policyName();
        this.minRank = p.minRank();
        this.enabled = this.minRank < Policy.OFF.minRank();

        String u = b.url == null ? "" : b.url.trim();
        while (u.endsWith("/")) {
            u = u.substring(0, u.length() - 1);
        }
        this.url = u;
        this.topic = b.topic;
        this.session = String.format("%016x", ThreadLocalRandom.current().nextLong());
        this.maxBatch = b.maxBatch;
        this.maxQueue = b.maxQueue;
        this.flushMs = b.flushMs;
        this.connectTimeoutMs = b.connectTimeoutMs;
        this.readTimeoutMs = b.readTimeoutMs;
        this.queue = new ArrayDeque<>(Math.min(b.maxQueue, 1024));

        // The origin block never changes, so it is rendered once here rather
        // than on every event - it is a third of the bytes of a short line.
        StringBuilder o = new StringBuilder(96);
        o.append("{\"runtime\":\"java\",\"app\":");
        Json.quoted(b.app, o);
        o.append(",\"platform\":");
        Json.quoted(platform(), o);
        if (b.device != null && !b.device.isEmpty()) {
            o.append(",\"device\":");
            Json.quoted(b.device, o);
        }
        o.append('}');
        this.originJson = o.toString();

        // Fail here, loudly, rather than silently dropping every event later
        // because the URL was a typo.
        URL parsed = null;
        if (this.enabled) {
            try {
                parsed = new URL(this.url + "/ingest/" + this.topic);
            } catch (Exception e) {
                throw new IllegalArgumentException(
                        "superlog: bad url " + this.url + " (" + e.getMessage() + ")", e);
            }
        }
        this.endpoint = parsed;

        if (!this.enabled) {
            // Say so once. An inert client is indistinguishable from a broken
            // one: nothing arrives, and dropped() reads 0 because nothing was
            // ever queued, which reads as healthy.
            if (!b.quiet) {
                System.err.println("superlog: " + mode + " policy is OFF - nothing will be sent to "
                        + this.url + ". Set " + mode + "Policy to change that.");
            }
            this.worker = null;
            return;
        }

        this.worker = new Thread(this::run, "superlog");
        this.worker.setDaemon(true);
        this.worker.start();

        // A daemon thread is killed at exit wherever it stands, so the last
        // batch needs an explicit chance to leave.
        this.shutdownHook = new Thread(this::close, "superlog-shutdown");
        try {
            Runtime.getRuntime().addShutdownHook(this.shutdownHook);
        } catch (IllegalStateException alreadyShuttingDown) {
            this.shutdownHook = null;
        }
    }

    // ---------------------------------------------------------------- status

    public Status status() {
        int queued;
        synchronized (lock) {
            queued = queue.size();
        }
        return new Status(enabled, mode, policy, url, topic, session, queued, dropped.get());
    }

    /** Events dropped because the queue was full, plus events lost to a POST
     *  the hub did not accept. 0 does NOT mean healthy: an inert client never
     *  queues, so it never drops. */
    public long dropped() {
        return dropped.get();
    }

    public boolean isEnabled() {
        return enabled;
    }

    public String topic() {
        return topic;
    }

    public String url() {
        return url;
    }

    public String session() {
        return session;
    }

    // -------------------------------------------------------------- emitting

    public void log(Level level, String msg) {
        emit(level, msg, null, null, null, null, 0);
    }

    public void log(Level level, String msg, Map<String, ?> fields) {
        emit(level, msg, fields, null, null, null, 0);
    }

    public void log(Level level, String msg, Map<String, ?> fields, String tag, String src) {
        emit(level, msg, fields, tag, src, null, 0);
    }

    public void trace(String msg)                       { log(Level.TRACE, msg); }
    public void trace(String msg, Map<String, ?> f)     { log(Level.TRACE, msg, f); }
    public void debug(String msg)                       { log(Level.DEBUG, msg); }
    public void debug(String msg, Map<String, ?> f)     { log(Level.DEBUG, msg, f); }
    public void info(String msg)                        { log(Level.INFO, msg); }
    public void info(String msg, Map<String, ?> f)      { log(Level.INFO, msg, f); }
    public void warn(String msg)                        { log(Level.WARN, msg); }
    public void warn(String msg, Map<String, ?> f)      { log(Level.WARN, msg, f); }
    public void error(String msg)                       { log(Level.ERROR, msg); }
    public void error(String msg, Map<String, ?> f)     { log(Level.ERROR, msg, f); }
    public void critical(String msg)                    { log(Level.CRITICAL, msg); }
    public void critical(String msg, Map<String, ?> f)  { log(Level.CRITICAL, msg, f); }

    /** Telemetry riding the same pipeline (PROTOCOL.md `metric`). It rides at
     *  INFO, so a policy above INFO drops metrics with everything else. */
    public void metric(String name, double value) {
        Map<String, ?> extra = null;
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            // Json.number writes 0 for these; the real value goes in a field
            // so the reading is not silently a lie.
            extra = fields("value", Double.toString(value));
        }
        emit(Level.INFO, name, extra, null, null, name, value);
    }

    private void emit(Level level, String msg, Map<String, ?> fields,
                      String tag, String src, String metricName, double metricValue) {
        if (level.rank() < minRank) {
            return;                       // below policy: not even serialised
        }
        StringBuilder b = new StringBuilder(224);
        b.append("{\"v\":1,\"ts\":\"").append(TS.format(Instant.now()))
         .append("\",\"seq\":").append(seq.getAndIncrement())
         .append(",\"session\":\"").append(session)
         .append("\",\"level\":\"").append(level.wire())
         .append("\",\"origin\":").append(originJson);

        String tid = CURRENT_TRACE.get();
        if (tid != null && !tid.isEmpty()) {
            b.append(",\"trace\":");
            Json.quoted(tid, b);
        }
        if (tag != null && !tag.isEmpty()) {
            b.append(",\"tag\":");
            Json.quoted(tag, b);
        }
        if (src != null && !src.isEmpty()) {
            b.append(",\"src\":");
            Json.quoted(src, b);
        }
        b.append(",\"msg\":");
        Json.quoted(msg == null ? "" : msg, b);

        if (metricName != null) {
            b.append(",\"metric\":{\"name\":");
            Json.quoted(metricName, b);
            b.append(",\"value\":");
            Json.number(metricValue, b);
            b.append('}');
        }
        if (fields != null && !fields.isEmpty()) {
            b.append(",\"fields\":{");
            boolean first = true;
            for (Map.Entry<String, ?> e : fields.entrySet()) {
                if (!first) {
                    b.append(',');
                }
                first = false;
                Json.quoted(String.valueOf(e.getKey()), b);
                b.append(':');
                // PROTOCOL.md says fields are string values, everywhere, so a
                // reader never has to guess a type it did not ask for.
                Json.quoted(e.getValue() == null ? "null" : String.valueOf(e.getValue()), b);
            }
            b.append('}');
        }
        b.append('}');
        enqueue(b.toString());
    }

    // ------------------------------------------------------------ exceptions

    public void exception(Throwable t) {
        exception(t, "caught", null);
    }

    public void exception(Throwable t, String where) {
        exception(t, where, null);
    }

    /** Log a throwable with its stack. Java hands out no frame locals, so
     *  unlike the Python SDK this cannot say what the values were - put the
     *  inputs that mattered in `fields` at the catch site, which is the only
     *  place that knows them. */
    public void exception(Throwable t, String where, Map<String, ?> extra) {
        if (t == null) {
            return;
        }
        Map<String, Object> f = new LinkedHashMap<>();
        if (extra != null) {
            f.putAll(extra);
        }
        f.put("where", where == null ? "caught" : where);
        f.put("type", t.getClass().getName());

        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String[] lines = sw.toString().replace("\r\n", "\n").trim().split("\n");
        StringBuilder stack = new StringBuilder();
        int n = Math.min(lines.length, MAX_STACK_LINES);
        for (int i = 0; i < n; i++) {
            if (i > 0) {
                stack.append('\n');
            }
            stack.append(lines[i].trim());
        }
        f.put("stack", stack.toString());
        if (lines.length > MAX_STACK_LINES) {
            f.put("stack_truncated", "true");
        }

        String src = "";
        StackTraceElement[] frames = t.getStackTrace();
        if (frames.length > 0 && frames[0].getFileName() != null) {
            src = frames[0].getFileName() + ":" + frames[0].getLineNumber();
        }

        String message = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
        emit(Level.ERROR, (where == null ? "caught" : where) + ": "
                + t.getClass().getSimpleName() + ": " + message, f, "exception", src, null, 0);
        flush(2000);                   // a crash may not survive to the next tick
    }

    /** Log every uncaught exception, in any thread, then chain to whatever was
     *  installed before - so the stack still reaches stderr and the exit
     *  status is unchanged. */
    public synchronized void installUncaughtHandler() {
        if (uncaughtInstalled || !enabled) {
            return;
        }
        uncaughtInstalled = true;
        final Thread.UncaughtExceptionHandler previous =
                Thread.getDefaultUncaughtExceptionHandler();

        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                exception(e, "uncaught", fields("thread", t.getName()));
            } catch (Throwable ignored) {
                // a logger must never eat the crash
            }
            if (previous != null) {
                previous.uncaughtException(t, e);
            } else {
                // NOT ThreadGroup.uncaughtException: the root group's
                // implementation looks the default handler back up and calls
                // it, which is this lambda, which is an infinite recursion.
                // These two lines are what the JVM would have printed.
                System.err.print("Exception in thread \"" + t.getName() + "\" ");
                e.printStackTrace(System.err);
            }
        });
    }

    // ----------------------------------------------------------- correlation

    /** Everything logged from this thread, and from threads it starts from
     *  here on, carries this id. */
    public String setTrace() {
        return setTrace(newTraceId());
    }

    public String setTrace(String traceId) {
        String tid = (traceId == null || traceId.isEmpty()) ? newTraceId() : traceId;
        CURRENT_TRACE.set(tid);
        return tid;
    }

    public void clearTrace() {
        CURRENT_TRACE.remove();
    }

    public String traceId() {
        return CURRENT_TRACE.get();
    }

    /**
     * The scoped form, for try-with-resources - the Java shape of Python's
     * `with log.traced()`:
     *
     * <pre>
     *   try (SuperLog.TraceScope s = log.traceScope()) {
     *       log.info("user tapped Send");
     *       conn.setRequestProperty(SuperLog.TRACE_HEADER, s.id());
     *   }
     * </pre>
     *
     * close() restores the id that was in force, so scopes nest.
     */
    public TraceScope traceScope() {
        return new TraceScope(newTraceId());
    }

    public TraceScope traceScope(String traceId) {
        return new TraceScope((traceId == null || traceId.isEmpty()) ? newTraceId() : traceId);
    }

    /** The lambda form, which is what Kotlin callers want: log.traced { id -> }. */
    public void traced(Consumer<String> body) {
        try (TraceScope s = traceScope()) {
            body.accept(s.id());
        }
    }

    /** Same, for work that returns something. A separate name rather than an
     *  overload: two functional-interface overloads make a bare lambda
     *  ambiguous at the call site, in Java and in Kotlin. */
    public <T> T tracedCall(Function<String, T> body) {
        try (TraceScope s = traceScope()) {
            return body.apply(s.id());
        }
    }

    /**
     * Carry the current trace into a task that will run on another thread.
     * Executors are the hole in InheritableThreadLocal: a pooled thread
     * inherited its value from whoever created the pool, and keeps whatever
     * it last held between unrelated tasks. Wrap at submit time and the id
     * travels with the work instead:
     *
     * <pre>pool.submit(log.wrap(() -&gt; charge(order)));</pre>
     */
    public Runnable wrap(Runnable body) {
        final String captured = CURRENT_TRACE.get();
        return () -> {
            final String previous = CURRENT_TRACE.get();
            applyTrace(captured);
            try {
                body.run();
            } finally {
                applyTrace(previous);
            }
        };
    }

    public <T> Callable<T> wrap(Callable<T> body) {
        final String captured = CURRENT_TRACE.get();
        return () -> {
            final String previous = CURRENT_TRACE.get();
            applyTrace(captured);
            try {
                return body.call();
            } finally {
                applyTrace(previous);
            }
        };
    }

    private static void applyTrace(String tid) {
        if (tid == null) {
            CURRENT_TRACE.remove();       // remove, not set(null), so a pooled
        } else {                          // thread is not left holding a value
            CURRENT_TRACE.set(tid);
        }
    }

    public static final class TraceScope implements AutoCloseable {
        private final String id;
        private final String previous;

        private TraceScope(String id) {
            this.previous = CURRENT_TRACE.get();
            this.id = id;
            CURRENT_TRACE.set(id);
        }

        public String id() {
            return id;
        }

        @Override
        public void close() {
            applyTrace(previous);
        }
    }

    // --------------------------------------------------- logging integration

    /**
     * A java.util.logging.Handler, so everything the program ALREADY logs
     * reaches the bench without touching a single call site - the Java
     * analogue of the spdlog sink, the tracing layer and Python's
     * logging.Handler, and the single most valuable integration point here.
     *
     * <pre>Logger.getLogger("").addHandler(log.handler());</pre>
     */
    public Handler handler() {
        return new JulHandler(this);
    }

    public Handler handler(java.util.logging.Level level) {
        Handler h = new JulHandler(this);
        h.setLevel(level);
        return h;
    }

    /** The handler asks this so a log line emitted by the JDK's own HTTP
     *  code, on our worker thread, cannot feed the queue that produced it. */
    boolean isWorkerThread() {
        return Thread.currentThread() == worker;
    }

    // ---------------------------------------------------------------- plumbing

    private void enqueue(String line) {
        synchronized (lock) {
            if (queue.size() >= maxQueue) {
                queue.pollFirst();        // drop OLDEST: the newest line is the
                dropped.incrementAndGet();// one most likely to explain the burst
            }
            queue.addLast(line);
            if (queue.size() >= maxBatch) {
                lock.notifyAll();
            }
        }
    }

    private List<String> take() {
        List<String> batch = new ArrayList<>(Math.min(queue.size(), maxBatch));
        for (int i = 0; i < maxBatch; i++) {
            String s = queue.pollFirst();
            if (s == null) {
                break;
            }
            batch.add(s);
        }
        return batch;
    }

    private void run() {
        while (true) {
            List<String> batch;
            boolean stopping;
            synchronized (lock) {
                if (!stop && queue.size() < maxBatch) {
                    try {
                        lock.wait(flushMs);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                batch = take();
                stopping = stop;
                inFlight = batch.size();
            }
            if (!batch.isEmpty()) {
                post(batch);
            }
            synchronized (lock) {
                inFlight = 0;
                lock.notifyAll();
            }
            if (stopping) {
                drainHere();              // nothing queued is lost on exit
                return;
            }
        }
    }

    private void drainHere() {
        while (true) {
            List<String> rest;
            synchronized (lock) {
                rest = take();
            }
            if (rest.isEmpty()) {
                return;
            }
            post(rest);
        }
    }

    private void post(List<String> batch) {
        StringBuilder body = new StringBuilder(batch.size() * 224);
        for (int i = 0; i < batch.size(); i++) {
            if (i > 0) {
                body.append('\n');
            }
            body.append(batch.get(i));
        }
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) endpoint.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setConnectTimeout(connectTimeoutMs);
            conn.setReadTimeout(readTimeoutMs);
            conn.setFixedLengthStreamingMode(bytes.length);
            conn.setRequestProperty("Content-Type", "application/x-ndjson");
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
            int code = conn.getResponseCode();
            // Drain the body even though nothing reads it, or the connection
            // cannot be reused and every batch pays a new handshake.
            try (InputStream in = (code >= 400 ? conn.getErrorStream() : conn.getInputStream())) {
                if (in != null) {
                    byte[] sink = new byte[512];
                    while (in.read(sink) > 0) {
                        // discard
                    }
                }
            }
            if (code < 200 || code >= 300) {
                dropped.addAndGet(batch.size());
            }
        } catch (Exception e) {
            // The hub is down; count, do not retry. A retry queue grows
            // without bound on a process that outlives the bench.
            dropped.addAndGet(batch.size());
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    // ------------------------------------------------------------ lifecycle

    public boolean flush() {
        return flush(2000);
    }

    /** Send what is queued now and wait for the POST carrying it to finish.
     *  Waiting for the in-flight batch, not just for an empty queue, is the
     *  difference between a crash report that arrives and one that does not.
     *  Returns false on timeout. */
    public boolean flush(long timeoutMs) {
        if (!enabled || isWorkerThread()) {
            return true;
        }
        final long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
        synchronized (lock) {
            lock.notifyAll();
        }
        while (System.nanoTime() < deadline) {
            synchronized (lock) {
                if (queue.isEmpty() && inFlight == 0) {
                    return true;
                }
                try {
                    lock.wait(10);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        return false;
    }

    /** Idempotent, and safe to call from a shutdown hook. */
    @Override
    public void close() {
        if (!enabled) {
            return;
        }
        Thread w;
        synchronized (lock) {
            stop = true;
            lock.notifyAll();
            w = worker;
        }
        if (w != null && w != Thread.currentThread() && w.isAlive()) {
            try {
                w.join(3000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        // Whatever is still queued goes out on the caller's thread. This is
        // what makes a late line survive - a goodbye logged after Ctrl-C, an
        // exception thrown inside another shutdown hook - because hooks run
        // concurrently and in no defined order, so the worker may already
        // have drained and exited by the time that line is written.
        drainHere();
        Thread hook = shutdownHook;
        shutdownHook = null;
        if (hook != null && hook != Thread.currentThread()) {
            try {
                Runtime.getRuntime().removeShutdownHook(hook);
            } catch (IllegalStateException shuttingDown) {
                // already in shutdown; nothing to remove
            }
        }
    }

    // --------------------------------------------------------------- helpers

    private static String platform() {
        // Dalvik/ART report themselves here, and an Android build wants
        // platform "android" so the viewer groups it with the phones.
        String vm = System.getProperty("java.vm.name", "");
        if (vm.toLowerCase().contains("dalvik") || vm.toLowerCase().contains("art")
                || System.getProperty("java.vendor", "").toLowerCase().contains("android")) {
            return "android";
        }
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("mac") || os.contains("darwin")) {
            return "macos";
        }
        if (os.contains("win")) {
            return "windows";
        }
        if (os.contains("linux")) {
            return "linux";
        }
        return os.isEmpty() ? "linux" : os.replace(' ', '-');
    }

    // --------------------------------------------------------------- builder

    /** A builder rather than a constructor with ten arguments, because Kotlin
     *  cannot use Java named arguments and a positional call of that width is
     *  unreadable from either language. */
    public static final class Builder {
        private String topic = "java.app";
        private String app = "app";
        private String url = defaultUrl();
        private boolean development;
        private boolean production;
        private Policy developmentPolicy = Policy.ALL;
        private Policy productionPolicy = Policy.OFF;
        private String device = "";
        private long flushMs = 250;
        private int maxBatch = 256;
        private int maxQueue = 8192;
        private int connectTimeoutMs = 2000;
        private int readTimeoutMs = 5000;
        private boolean quiet;

        private static String defaultUrl() {
            // Honoured because every desktop and CI runner can set it. An
            // Android app cannot, which is why an explicit url() still wins.
            String env = System.getenv("SUPER_LOG_URL");
            return (env == null || env.isEmpty()) ? "http://127.0.0.1:7333" : env;
        }

        public Builder topic(String v)              { this.topic = v; return this; }
        public Builder app(String v)                { this.app = v; return this; }
        public Builder url(String v)                { this.url = v; return this; }
        public Builder development(boolean v)       { this.development = v; return this; }
        public Builder production(boolean v)        { this.production = v; return this; }
        public Builder developmentPolicy(Policy v)  { this.developmentPolicy = v; return this; }
        public Builder productionPolicy(Policy v)   { this.productionPolicy = v; return this; }
        public Builder device(String v)             { this.device = v; return this; }
        public Builder flushMs(long v)              { this.flushMs = v; return this; }
        public Builder maxBatch(int v)              { this.maxBatch = v; return this; }
        public Builder maxQueue(int v)              { this.maxQueue = v; return this; }
        public Builder connectTimeoutMs(int v)      { this.connectTimeoutMs = v; return this; }
        public Builder readTimeoutMs(int v)         { this.readTimeoutMs = v; return this; }
        public Builder quiet(boolean v)             { this.quiet = v; return this; }

        public SuperLog build() {
            return new SuperLog(this);
        }
    }
}
