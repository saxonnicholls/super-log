//
//  Level.java
//  super-log Java SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The six levels of PROTOCOL.md, ranked 1-based so that an unknown or
//  unmapped level cannot collapse to "ship everything" - the same trick the
//  C++ SDK's mode.hpp plays with its macro ranks.
//

package com.snicholls.superlog;

public enum Level {
    TRACE(1),
    DEBUG(2),
    INFO(3),
    WARN(4),
    ERROR(5),
    CRITICAL(6);

    private final int rank;

    Level(int rank) {
        this.rank = rank;
    }

    public int rank() {
        return rank;
    }

    /** The wire spelling. It is the enum name, and PROTOCOL.md says WARN,
     *  not WARNING - the one place java.util.logging disagrees with us. */
    public String wire() {
        return name();
    }
}
