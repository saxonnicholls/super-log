//
//  SuperLogAppender.java - a Logback appender that forwards to the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  This is an OPTIONAL integration, not part of the zero-dependency core. It
//  compiles only with logback-classic on the classpath - which an app that
//  wants a Logback appender already has - so it lives outside sdk/java/src and
//  ships no logback jars of its own. The core SuperLog SDK still compiles
//  against nothing; this reaches the far larger audience the SDK's own name
//  half-promises (most Java shops route through logback/log4j2 via SLF4J, not
//  raw java.util.logging).
//
//  Two ways to wire it:
//
//    (1) Programmatic - you already built a SuperLog:
//        SuperLogAppender a = new SuperLogAppender(log);
//        ch.qos.logback.classic.Logger root =
//            (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(ROOT_LOGGER_NAME);
//        a.setContext(root.getLoggerContext()); a.start(); root.addAppender(a);
//
//    (2) Pure logback.xml - no code:
//        <appender name="SUPERLOG" class="com.snicholls.superlog.logback.SuperLogAppender">
//          <url>http://127.0.0.1:7333</url><topic>java.app</topic>
//          <app>myapp</app><mode>development</mode>
//        </appender>
//        <root level="INFO"><appender-ref ref="SUPERLOG"/></root>
//
//  A logging pipeline you *think* is off is worse than one that refuses to
//  start until you decide, so the config path demands mode = development xor
//  production (or the SUPERLOG_MODE env var) and reports an error rather than
//  guessing.
//

package com.snicholls.superlog.logback;

import java.util.LinkedHashMap;
import java.util.Map;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import ch.qos.logback.core.AppenderBase;

import com.snicholls.superlog.Level;
import com.snicholls.superlog.SuperLog;

public final class SuperLogAppender extends AppenderBase<ILoggingEvent> {

    private SuperLog log;
    private boolean ownsClient;                 // did WE build it (config path)?

    // Set by logback from <url>/<topic>/<app>/<mode>/<device> in logback.xml.
    private String url, topic = "java.app", app = "app", device, mode;

    /** Config path: logback instantiates it, then calls the setters and start(). */
    public SuperLogAppender() {}

    /** Programmatic path: hand it a client you already built and own. */
    public SuperLogAppender(SuperLog log) { this.log = log; }

    public void setSuperLog(SuperLog log)  { this.log = log; }
    public void setUrl(String v)           { this.url = v; }
    public void setTopic(String v)         { this.topic = v; }
    public void setApp(String v)           { this.app = v; }
    public void setDevice(String v)        { this.device = v; }
    public void setMode(String v)          { this.mode = v; }

    @Override
    public void start() {
        if (log == null) {
            // The config path: build a client from the element values, once,
            // insisting on an explicit mode - the same rule the core SDK makes.
            String m = mode != null ? mode : System.getenv("SUPERLOG_MODE");
            boolean dev = "development".equalsIgnoreCase(m);
            boolean prod = "production".equalsIgnoreCase(m);
            if (dev == prod) {
                addError("superlog: set <mode> (or SUPERLOG_MODE) to development or production");
                return;                          // stays stopped: nothing on the wire
            }
            SuperLog.Builder b = SuperLog.builder().topic(topic).app(app)
                    .development(dev).production(prod);
            if (url != null) b.url(url);
            if (device != null) b.device(device);
            log = b.build();
            ownsClient = true;
        }
        super.start();
    }

    @Override
    protected void append(ILoggingEvent e) {
        if (log == null) return;
        Map<String, Object> fields = new LinkedHashMap<>(e.getMDCPropertyMap());
        IThrowableProxy t = e.getThrowableProxy();
        if (t != null) {
            fields.put("type", t.getClassName());
            fields.put("stack", ThrowableProxyUtil.asString(t));
        }
        // The call site, when logback captured it (it does lazily; asking here
        // is what triggers the capture). file:line, the way every SDK reports src.
        String src = null;
        StackTraceElement[] caller = e.getCallerData();
        if (caller != null && caller.length > 0)
            src = caller[0].getFileName() + ":" + caller[0].getLineNumber();

        // tag = the logger name, so a bench filter can narrow to one logger.
        log.log(map(e.getLevel()), e.getFormattedMessage(),
                fields.isEmpty() ? null : fields, e.getLoggerName(), src);
    }

    @Override
    public void stop() {
        // Only close a client we built. One passed in belongs to the program,
        // which may still be using it after logback shuts this appender down.
        if (ownsClient && log != null) {
            try { log.close(); } catch (Exception ignored) { /* best effort */ }
        }
        super.stop();
    }

    private static Level map(ch.qos.logback.classic.Level l) {
        switch (l.toInt()) {
            case ch.qos.logback.classic.Level.ERROR_INT: return Level.ERROR;
            case ch.qos.logback.classic.Level.WARN_INT:  return Level.WARN;
            case ch.qos.logback.classic.Level.DEBUG_INT: return Level.DEBUG;
            case ch.qos.logback.classic.Level.TRACE_INT: return Level.TRACE;
            default:                                      return Level.INFO;   // INFO, and ALL below WARN-ish
        }
    }
}
