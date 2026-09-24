//
//  SuperLogLogger.java - one SLF4J Logger, forwarding to the bench.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Part of the SLF4J *provider* (superlog-slf4j): the drop-in BACKEND. Where
//  the logback/log4j2 appenders sit BESIDE an existing framework, this
//  REPLACES it - remove logback-classic (or log4j-slf4j2-impl) from the
//  classpath, drop this in, and every org.slf4j.Logger call in the program,
//  and every log4j2-API/JUL call bridged onto SLF4J, reaches the bench with no
//  code change. Compiles against slf4j-api only.
//

package com.snicholls.superlog.slf4j;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.LinkedHashMap;
import java.util.Map;

import org.slf4j.MDC;
import org.slf4j.Marker;
import org.slf4j.event.Level;
import org.slf4j.helpers.LegacyAbstractLogger;
import org.slf4j.helpers.MessageFormatter;

import com.snicholls.superlog.SuperLog;

final class SuperLogLogger extends LegacyAbstractLogger {

    // LegacyAbstractLogger is Serializable, so this class is too whether or
    // not anyone intends to serialize a logger. Declaring the id is what
    // -Xlint:serial asks for, and it costs nothing: without it the compiler
    // computes one from the class's shape, so adding a field later would
    // silently break any stream that did contain one.
    private static final long serialVersionUID = 1L;

    private final transient SuperLog log;

    SuperLogLogger(String name, SuperLog log) {
        this.name = name;                       // AbstractLogger's protected field
        this.log = log;
    }

    // SLF4J does its own nothing here; the SuperLog client applies the mode
    // policy, so every level is "enabled" as far as this facade is concerned.
    @Override public boolean isTraceEnabled()          { return true; }
    @Override public boolean isTraceEnabled(Marker m)  { return true; }
    @Override public boolean isDebugEnabled()          { return true; }
    @Override public boolean isDebugEnabled(Marker m)  { return true; }
    @Override public boolean isInfoEnabled()           { return true; }
    @Override public boolean isInfoEnabled(Marker m)   { return true; }
    @Override public boolean isWarnEnabled()           { return true; }
    @Override public boolean isWarnEnabled(Marker m)   { return true; }
    @Override public boolean isErrorEnabled()          { return true; }
    @Override public boolean isErrorEnabled(Marker m)  { return true; }

    @Override
    protected String getFullyQualifiedCallerName() { return null; }

    @Override
    protected void handleNormalizedLoggingCall(Level level, Marker marker,
                                               String pattern, Object[] args, Throwable t) {
        final String msg = (args != null && args.length > 0)
                ? MessageFormatter.basicArrayFormat(pattern, args)
                : pattern;

        Map<String, Object> fields = null;
        final Map<String, String> mdc = MDC.getCopyOfContextMap();
        if (mdc != null && !mdc.isEmpty()) fields = new LinkedHashMap<>(mdc);
        if (t != null) {
            if (fields == null) fields = new LinkedHashMap<>();
            fields.put("type", t.getClass().getName());
            fields.put("stack", stack(t));
        }

        // tag = the logger name, so a bench filter can narrow to one logger.
        log.log(map(level), msg, fields, name, null);
    }

    private static String stack(Throwable t) {
        StringWriter w = new StringWriter();
        t.printStackTrace(new PrintWriter(w));
        return w.toString();
    }

    // SLF4J has no FATAL/CRITICAL of its own; ERROR is its ceiling.
    private static com.snicholls.superlog.Level map(Level l) {
        switch (l) {
            case ERROR: return com.snicholls.superlog.Level.ERROR;
            case WARN:  return com.snicholls.superlog.Level.WARN;
            case INFO:  return com.snicholls.superlog.Level.INFO;
            case DEBUG: return com.snicholls.superlog.Level.DEBUG;
            case TRACE: return com.snicholls.superlog.Level.TRACE;
            default:    return com.snicholls.superlog.Level.INFO;
        }
    }
}
