//
//  SuperLogAppender.java - a Log4j 2 appender that forwards to the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The Log4j 2 half of the same story as the Logback appender: an OPTIONAL
//  integration, outside the zero-dependency core, compiled only with
//  log4j-core on the classpath - which an app that wants a Log4j 2 appender
//  already has. It ships no log4j jars; the core SuperLog SDK still compiles
//  against nothing.
//
//  There is a certain irony in a Log4j appender for a project whose security
//  pitch is "the anti-log4j" - so, plainly: this forwards Log4j's already-
//  formatted message text to the bench as data, and the bench never evaluates
//  message content anywhere in its pipeline (docs/SECURITY_ARCHITECTURE.md).
//  Adopting the bench does not re-import the JNDI-lookup class of problem;
//  that lived in the logging library's own message handling, not here.
//
//  Two ways to wire it:
//
//    (1) Programmatic - you already built a SuperLog:
//        SuperLogAppender a = SuperLogAppender.forClient("SuperLog", log);
//        a.start();
//        ((org.apache.logging.log4j.core.Logger) LogManager.getLogger())
//            .addAppender(a);   // or add it to the config's root logger
//
//    (2) Pure log4j2.xml - no code (put this file + log4j-core on the build
//        path and reference the plugin package with packages="..."):
//        <Configuration packages="com.snicholls.superlog.log4j2">
//          <Appenders>
//            <SuperLog name="SUPERLOG" url="http://127.0.0.1:7333"
//                      topic="java.app" app="myapp" mode="development"/>
//          </Appenders>
//          <Loggers><Root level="info"><AppenderRef ref="SUPERLOG"/></Root></Loggers>
//        </Configuration>
//
//  The config path insists on mode = development xor production (or the
//  SUPERLOG_MODE env var): a logging pipeline you *think* is off is worse than
//  one that refuses to start until you decide.
//

package com.snicholls.superlog.log4j2;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.apache.logging.log4j.core.Filter;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.apache.logging.log4j.core.config.plugins.Plugin;
import org.apache.logging.log4j.core.config.plugins.PluginAttribute;
import org.apache.logging.log4j.core.config.plugins.PluginElement;
import org.apache.logging.log4j.core.config.plugins.PluginFactory;

import com.snicholls.superlog.Level;
import com.snicholls.superlog.SuperLog;

@Plugin(name = "SuperLog", category = "Core", elementType = "appender", printObject = true)
public final class SuperLogAppender extends AbstractAppender {

    private final SuperLog log;
    private final boolean ownsClient;

    private SuperLogAppender(String name, Filter filter, SuperLog log, boolean ownsClient) {
        super(name, filter, null, true, Property.EMPTY_ARRAY);
        this.log = log;
        this.ownsClient = ownsClient;
    }

    /** Programmatic path: hand it a client you already built and own. */
    public static SuperLogAppender forClient(String name, SuperLog log) {
        return new SuperLogAppender(name == null ? "SuperLog" : name, null, log, false);
    }

    /** Config path: <SuperLog .../> in log4j2.xml. Returns null (no appender,
     *  nothing on the wire) rather than guess a mode. */
    @PluginFactory
    public static SuperLogAppender createAppender(
            @PluginAttribute("name") String name,
            @PluginAttribute("url") String url,
            @PluginAttribute(value = "topic", defaultString = "java.app") String topic,
            @PluginAttribute(value = "app", defaultString = "app") String app,
            @PluginAttribute("device") String device,
            @PluginAttribute("mode") String mode,
            @PluginElement("Filter") Filter filter) {
        String m = mode != null ? mode : System.getenv("SUPERLOG_MODE");
        boolean dev = "development".equalsIgnoreCase(m);
        boolean prod = "production".equalsIgnoreCase(m);
        if (dev == prod) {
            LOGGER.error("superlog: set mode (or SUPERLOG_MODE) to development or production");
            return null;
        }
        SuperLog.Builder b = SuperLog.builder().topic(topic).app(app)
                .development(dev).production(prod);
        if (url != null) b.url(url);
        if (device != null) b.device(device);
        return new SuperLogAppender(name == null ? "SuperLog" : name, filter, b.build(), true);
    }

    @Override
    public void append(LogEvent e) {
        if (log == null) return;
        Map<String, Object> fields = new LinkedHashMap<>();
        e.getContextData().forEach((k, v) -> fields.put(k, v));    // ThreadContext / MDC
        Throwable t = e.getThrown();
        if (t != null) {
            fields.put("type", t.getClass().getName());
            fields.put("stack", stackString(t));
        }
        String src = null;
        StackTraceElement s = e.getSource();                        // null unless location is on
        if (s != null) src = s.getFileName() + ":" + s.getLineNumber();

        log.log(map(e.getLevel()), e.getMessage().getFormattedMessage(),
                fields.isEmpty() ? null : fields, e.getLoggerName(), src);
    }

    @Override
    public boolean stop(final long timeout, final TimeUnit tu) {
        final boolean stopped = super.stop(timeout, tu);
        // Only close a client we built. One passed in belongs to the program.
        if (ownsClient && log != null) {
            try { log.close(); } catch (Exception ignored) { /* best effort */ }
        }
        return stopped;
    }

    private static String stackString(Throwable t) {
        StringWriter w = new StringWriter();
        t.printStackTrace(new PrintWriter(w));
        return w.toString();
    }

    private static Level map(org.apache.logging.log4j.Level l) {
        if (l == null) return Level.INFO;
        switch (l.getStandardLevel()) {
            case FATAL: return Level.CRITICAL;
            case ERROR: return Level.ERROR;
            case WARN:  return Level.WARN;
            case DEBUG: return Level.DEBUG;
            case TRACE: return Level.TRACE;
            default:    return Level.INFO;      // INFO and everything below WARN it does not name
        }
    }
}
