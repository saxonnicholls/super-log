//
//  SuperLogLoggerFactory.java - one Logger per name, all on one client.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//

package com.snicholls.superlog.slf4j;

import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.ILoggerFactory;
import org.slf4j.Logger;

import com.snicholls.superlog.SuperLog;

final class SuperLogLoggerFactory implements ILoggerFactory {

    private final SuperLog log;
    private final ConcurrentHashMap<String, Logger> cache = new ConcurrentHashMap<>();

    SuperLogLoggerFactory(SuperLog log) { this.log = log; }

    @Override
    public Logger getLogger(String name) {
        return cache.computeIfAbsent(name, n -> new SuperLogLogger(n, log));
    }
}
