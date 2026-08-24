//
//  Status.java
//  super-log Java SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  What a client resolved to - the first thing to print when events are not
//  arriving. `enabled == false` means the declared mode's policy turned it
//  off, not that the network is broken; `dropped` reading 0 does not mean
//  healthy, because an inert client never queues, so it never drops.
//
//  A record, so it is one line to construct and reads the same from Kotlin.
//

package com.snicholls.superlog;

public record Status(
        boolean enabled,
        String mode,
        String policy,
        String url,
        String topic,
        String session,
        int queued,
        long dropped) {

    /** Compact JSON, for pasting into a bug report or an issue. */
    public String toJson() {
        StringBuilder b = new StringBuilder(160);
        b.append("{\"enabled\":").append(enabled)
         .append(",\"mode\":");
        Json.quoted(mode, b);
        b.append(",\"policy\":");
        Json.quoted(policy, b);
        b.append(",\"url\":");
        Json.quoted(url, b);
        b.append(",\"topic\":");
        Json.quoted(topic, b);
        b.append(",\"session\":");
        Json.quoted(session, b);
        b.append(",\"queued\":").append(queued)
         .append(",\"dropped\":").append(dropped)
         .append('}');
        return b.toString();
    }
}
