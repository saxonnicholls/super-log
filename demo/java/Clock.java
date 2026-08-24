//
//  Clock.java - the Java demo client
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  The same clock the other demo clients run, once a second on topic
//  java.clock - and a tour of what the Java SDK does that the others cannot,
//  because the JVM hands you a logging framework every library already
//  writes to and a default handler for every thread that dies.
//
//    javac -d /tmp/slj $(find sdk/java -name '*.java') demo/java/Clock.java
//    java -cp /tmp/slj Clock
//    java -cp /tmp/slj Clock --crash          # uncaught exception
//    java -cp /tmp/slj Clock --ticks 6        # stop after six, for scripts
//
//  What to watch on the bench:
//
//    - ticks carry a `trace` that also covers the work they cause, because
//      the id lives in an InheritableThreadLocal and a thread started inside
//      the scope inherits it without being passed anything;
//    - lines logged through java.util.logging arrive too, with no call-site
//      changes - that is the handler, and it is the whole reason a Java
//      service can be put on the bench without being edited;
//    - a caught exception ships its stack, plus the inputs that caused it,
//      because Java has no frame locals to capture and the catch site is the
//      only place that knows them;
//    - --crash proves the chained handler: the stack still reaches stderr,
//      the exit status is still 1, and the bench has it too.
//

import com.snicholls.superlog.Level;
import com.snicholls.superlog.SuperLog;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.logging.Logger;

public final class Clock {

    // UTC like every other demo client - the Rust one has no local timezone
    // without a crate, so the streams agree on UTC instead.
    private static final DateTimeFormatter HMS =
            DateTimeFormatter.ofPattern("HH:mm:ss'Z'").withZone(ZoneOffset.UTC);

    private static final Map<String, Double> RATES = Map.of("BTC", 64000.0, "ETH", 3200.0);

    /** Deliberately fails on one input, so the demo has a real stack rather
     *  than a synthetic one. */
    static double priceFor(String symbol, int qty) {
        Double rate = RATES.get(symbol);
        if (rate == null) {
            throw new NoSuchElementException("no rate for " + symbol);
        }
        return rate * qty;
    }

    public static void main(String[] args) throws Exception {
        boolean crash = false;
        int maxTicks = 0;                       // 0 = until Ctrl-C
        for (int i = 0; i < args.length; i++) {
            if ("--crash".equals(args[i])) {
                crash = true;
            } else if ("--ticks".equals(args[i]) && i + 1 < args.length) {
                maxTicks = Integer.parseInt(args[++i]);
            }
        }

        final SuperLog log = SuperLog.builder()
                .topic("java.clock")
                .app("clock")
                .url(System.getenv().getOrDefault("SUPER_LOG_URL", "http://127.0.0.1:7333"))
                .development(true)
                .production(false)
                .build();

        // Everything already logged through java.util.logging reaches the
        // bench, with no changes at any call site. This is the whole point of
        // the handler. The root level has to come down too, or the JDK filters
        // FINE out before any handler sees it.
        Logger root = Logger.getLogger("");
        root.addHandler(log.handler());
        root.setLevel(java.util.logging.Level.ALL);
        Logger stdlib = Logger.getLogger("pricer");

        // Every uncaught exception, in any thread, chained to whatever was
        // installed before.
        log.installUncaughtHandler();

        System.out.println("superlog: java clock -> " + log.status().url()
                + " topic " + log.status().topic());
        log.info("java clock up - one line a second",
                 SuperLog.fields("java", System.getProperty("java.version")));

        if (crash) {
            // Not caught anywhere: the handler logs it, stderr still gets the
            // stack, and the exit status is still 1.
            priceFor("DOGE", 3);
        }

        // Ctrl-C is a shutdown hook here, not a catchable signal, so the hook
        // interrupts main and waits for it - which is the Java shape of
        // Python's `except KeyboardInterrupt`. The goodbye line is logged from
        // main, because hooks run concurrently and a line logged inside one
        // races the SDK's own flushing hook.
        final Thread mainThread = Thread.currentThread();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            mainThread.interrupt();
            try {
                mainThread.join(2000);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }, "clock-shutdown"));

        ExecutorService pool = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "settlement");
            t.setDaemon(true);
            return t;
        });

        int n = 0;
        try {
            while (maxTicks == 0 || n < maxTicks) {
                n++;
                final int tick = n;
                // One trace per tick, inherited by everything the tick starts.
                try (SuperLog.TraceScope scope = log.traceScope()) {
                    log.info("tick " + tick + " - the time is " + HMS.format(Instant.now()),
                             SuperLog.fields("tick", tick));
                    stdlib.fine("pricing pass " + tick);        // via java.util.logging

                    // A pooled thread does NOT inherit the tick's trace - it
                    // was born with the pool - so the task is wrapped, and the
                    // settlement line lands under the same id as its tick.
                    pool.submit(log.wrap(() -> log.log(Level.DEBUG, "settled tick " + tick)));

                    if (tick % 5 == 0) {
                        log.metric("clock.uptime_s", tick);
                    }

                    if (tick % 7 == 0) {
                        try {
                            priceFor("DOGE", tick);
                        } catch (NoSuchElementException e) {
                            // Java has no frame locals to capture, so the
                            // inputs that mattered are named here - the catch
                            // site is the only place that knows them.
                            log.exception(e, "caught",
                                    SuperLog.fields("tick", tick, "symbol", "DOGE",
                                                    "trace", scope.id()));
                            stdlib.warning("pricing failed on tick " + tick);
                        }
                    }
                }
                Thread.sleep(1000);
            }
            log.info("java clock done after " + n + " ticks");
        } catch (InterruptedException stopping) {
            log.info("java clock down after " + n + " ticks");
        } finally {
            pool.shutdownNow();
            log.close();
        }
    }
}
