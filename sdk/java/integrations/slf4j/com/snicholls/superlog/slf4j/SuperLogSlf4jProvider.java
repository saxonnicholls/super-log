//
//  SuperLogSlf4jProvider.java - the SLF4J 2.0 service provider: super-log AS
//  your logging backend.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  This is the drop-in REPLACEMENT, not a bolt-on. SLF4J 2.0 loads exactly one
//  SLF4JServiceProvider off the classpath (ServiceLoader). Put superlog-slf4j
//  there in place of logback-classic / log4j-slf4j2-impl / slf4j-jdk14 and
//  every org.slf4j.Logger call in the program lands on the bench - no call
//  sites change, no config file to port. Apps on the log4j 2 API reach it
//  through the standard log4j-to-slf4j bridge; apps on java.util.logging
//  through jul-to-slf4j. Compiles against slf4j-api only.
//
//  Configuration is by env var / system property, because a service provider
//  is auto-loaded before any of the app's own code runs:
//
//    SUPERLOG_MODE / -Dsuperlog.mode         development | production
//    SUPER_LOG_URL / -Dsuperlog.url          hub URL (default 127.0.0.1:7333)
//    -Dsuperlog.topic                        default java.slf4j
//    -Dsuperlog.app                          default app
//    -Dsuperlog.device                       optional
//
//  A logging BACKEND must not throw during initialize() - that would leave the
//  program with no logging at all - so, unlike the config-driven appenders,
//  mode defaults to development (ships everything) when unset, with a one-line
//  notice, rather than refusing to start. Set production explicitly to go quiet.
//

package com.snicholls.superlog.slf4j;

import org.slf4j.ILoggerFactory;
import org.slf4j.IMarkerFactory;
import org.slf4j.helpers.BasicMDCAdapter;
import org.slf4j.helpers.BasicMarkerFactory;
import org.slf4j.spi.MDCAdapter;
import org.slf4j.spi.SLF4JServiceProvider;

import com.snicholls.superlog.SuperLog;

public final class SuperLogSlf4jProvider implements SLF4JServiceProvider {

    // The SLF4J API version this provider is built for; SLF4J compares the
    // major.minor and warns on a mismatch. 2.0.x is the target.
    private static final String REQUESTED_API_VERSION = "2.0.99";

    private ILoggerFactory loggerFactory;
    private IMarkerFactory markerFactory;
    private MDCAdapter mdcAdapter;

    @Override public ILoggerFactory getLoggerFactory() { return loggerFactory; }
    @Override public IMarkerFactory getMarkerFactory() { return markerFactory; }
    @Override public MDCAdapter getMDCAdapter()        { return mdcAdapter; }
    @Override public String getRequestedApiVersion()   { return REQUESTED_API_VERSION; }

    @Override
    public void initialize() {
        final String mode = prop("superlog.mode", System.getenv("SUPERLOG_MODE"));
        final boolean prod = "production".equalsIgnoreCase(mode);
        if (mode == null || mode.isEmpty()) {
            System.err.println("superlog-slf4j: SUPERLOG_MODE unset; defaulting to "
                    + "development (set it to production to go quiet).");
        }

        final SuperLog.Builder b = SuperLog.builder()
                .topic(prop("superlog.topic", "java.slf4j"))
                .app(prop("superlog.app", "app"))
                .development(!prod).production(prod);
        final String url = prop("superlog.url", System.getenv("SUPER_LOG_URL"));
        if (url != null) b.url(url);
        final String device = prop("superlog.device", null);
        if (device != null) b.device(device);

        this.loggerFactory = new SuperLogLoggerFactory(b.build());
        this.markerFactory = new BasicMarkerFactory();
        this.mdcAdapter = new BasicMDCAdapter();
    }

    private static String prop(String key, String dflt) {
        final String v = System.getProperty(key);
        return v != null ? v : dflt;
    }
}
