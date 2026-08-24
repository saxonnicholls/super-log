//
//  Policy.java
//  super-log Java SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  What a mode ships: everything, only `level` and up, or nothing at all.
//  The declared mode picks developmentPolicy or productionPolicy; a
//  below-policy event costs one integer compare and is not serialised, not
//  queued, not anything. Metrics ride at INFO, so a policy above INFO drops
//  them too.
//
//  Not an enum, because OFF and ALL are singletons but atLeast() carries a
//  level with it - the same shape as the Rust SDK's Policy::AtLeast(Level).
//

package com.snicholls.superlog;

import java.util.Objects;

public final class Policy {

    /** Everything, TRACE upwards. The development default. */
    public static final Policy ALL = new Policy("TRACE", Level.TRACE.rank());

    /** Nothing at all, and the client becomes an inert shell: no worker
     *  thread, no sockets, no serialisation. The production default,
     *  because log lines leaving a production box are a security decision. */
    public static final Policy OFF = new Policy("OFF", 7);

    private final String name;
    private final int minRank;

    private Policy(String name, int minRank) {
        this.name = name;
        this.minRank = minRank;
    }

    public static Policy atLeast(Level level) {
        Objects.requireNonNull(level, "level");
        return new Policy(level.name(), level.rank());
    }

    public String policyName() {
        return name;
    }

    public int minRank() {
        return minRank;
    }

    @Override
    public String toString() {
        return name;
    }
}
