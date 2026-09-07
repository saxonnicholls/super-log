//
//  JulHandler.java
//  super-log Java SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The java.util.logging bridge - the reason most Java code needs no changes
//  at all. Attach it to the root logger and every line the program already
//  writes reaches the bench, keeping its logger name as `tag` and its level
//  mapped to PROTOCOL.md's six.
//
//      Logger root = Logger.getLogger("");
//      root.addHandler(log.handler());
//      root.setLevel(java.util.logging.Level.ALL);   // or FINE handler-side
//
//  java.util.logging and not SLF4J because it is in the JDK: an SLF4J
//  appender would be twenty lines, and twenty lines that do not compile
//  without a jar on the classpath. README.md has that appender in full, for
//  projects that already depend on SLF4J.
//

package com.snicholls.superlog;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.logging.Formatter;
import java.util.logging.Handler;
import java.util.logging.LogRecord;
import java.util.logging.SimpleFormatter;

final class JulHandler extends Handler {

    private final SuperLog client;
    // Only for formatMessage(): it is the one piece of JDK code that resolves
    // {0} parameters and resource bundles the way every JUL consumer expects.
    private final Formatter messages = new SimpleFormatter();

    JulHandler(SuperLog client) {
        this.client = client;
        setLevel(java.util.logging.Level.ALL);
    }

    @Override
    public void publish(LogRecord record) {
        if (record == null || !isLoggable(record)) {
            return;
        }
        // The JDK's own HTTP stack logs through JUL. Without this, a line it
        // writes while POSTing a batch would be queued and POSTed, which
        // writes another line: the handler would feed the queue that feeds it.
        if (client.isWorkerThread()) {
            return;
        }
        try {
            Map<String, Object> fields = null;
            Throwable thrown = record.getThrown();
            if (thrown != null) {
                fields = new LinkedHashMap<>();
                fields.put("type", thrown.getClass().getName());
                StringWriter sw = new StringWriter();
                thrown.printStackTrace(new PrintWriter(sw));
                String[] lines = sw.toString().replace("\r\n", "\n").trim().split("\n");
                StringBuilder stack = new StringBuilder();
                int n = Math.min(lines.length, SuperLog.MAX_STACK_LINES);
                for (int i = 0; i < n; i++) {
                    if (i > 0) {
                        stack.append('\n');
                    }
                    stack.append(lines[i].trim());
                }
                fields.put("stack", stack.toString());
                if (lines.length > SuperLog.MAX_STACK_LINES) {
                    fields.put("stack_truncated", "true");
                }
            }
            client.log(map(record.getLevel()),
                       messages.formatMessage(record),
                       fields,
                       record.getLoggerName(),
                       source(record));
        } catch (Exception e) {
            reportError(null, e, java.util.logging.ErrorManager.WRITE_FAILURE);
        }
    }

    @Override
    public void flush() {
        client.flush();
    }

    /** Does not close the client: a Handler does not own the pipeline it
     *  writes to, and LogManager closes handlers at exit - which would
     *  silence a client the program is still using. */
    @Override
    public void close() {
        client.flush();
    }

    /** PROTOCOL.md's table, from the other side. JUL has no fatal level, so
     *  SEVERE is ERROR and only a custom level above it reaches CRITICAL. */
    private static Level map(java.util.logging.Level level) {
        int v = level == null ? 800 : level.intValue();
        if (v > 1000) {
            return Level.CRITICAL;
        }
        if (v >= 1000) {
            return Level.ERROR;          // SEVERE
        }
        if (v >= 900) {
            return Level.WARN;           // WARNING
        }
        if (v >= 800) {
            return Level.INFO;           // INFO
        }
        if (v >= 500) {
            return Level.DEBUG;          // CONFIG, FINE
        }
        return Level.TRACE;              // FINER, FINEST, and anything below
    }

    /** JUL carries no file and no line - it infers class and method by
     *  walking the stack - so `src` gets the truest thing available,
     *  Class.method, rather than a file:line nobody can trust. */
    private static String source(LogRecord record) {
        String cls = record.getSourceClassName();
        if (cls == null || cls.isEmpty()) {
            return "";
        }
        int dot = cls.lastIndexOf('.');
        String shortName = dot < 0 ? cls : cls.substring(dot + 1);
        String method = record.getSourceMethodName();
        return method == null || method.isEmpty() ? shortName : shortName + "." + method;
    }
}
