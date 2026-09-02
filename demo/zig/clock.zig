//
//  clock.zig - the Zig demo client.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Zig needs no SDK at all: @cImport reads sdk/c/superlog.h directly and
//  Zig inherits the C SDK whole - the mode define, the provably-absent
//  production story, everything. @cImport is bindings, not bodies, so the
//  header is compiled once as C with external linkage
//  (-DSUPERLOG_API=, the same one-object route any FFI language takes):
//
//    echo '#include <superlog.h>' > impl.c
//    cc -DSUPERLOG_API= -DSUPERLOG_DEVELOPMENT -I sdk/c -c impl.c
//    zig build-exe demo/zig/clock.zig impl.o -I sdk/c -lc && ./clock
//
const std = @import("std");
const c = @cImport({
    @cDefine("SUPERLOG_DEVELOPMENT", "1");
    @cDefine("SUPERLOG_API", ""); // extern declarations; impl.o has the bodies
    @cInclude("superlog.h");
    // libc's sleep, because std's has moved twice across Zig versions
    // and the C SDK already links libc anyway.
    @cInclude("unistd.h");
});

pub fn main() void {
    var lg: c.superlog_t = undefined;
    c.superlog_init(&lg, "zig.clock", "clock");
    c.superlog_logf(&lg, "INFO", "zig clock up - one line a second");
    std.debug.print("superlog: zig clock -> zig.clock\n", .{});

    var tick: c_int = 0;
    while (true) {
        tick += 1;
        c.superlog_logf(&lg, "INFO", "tick %d - counted in Zig", tick);

        // Honestly wrong every 7th tick, the same staged failure as every
        // other clock, so one error lines up across every language.
        if (@rem(tick, 7) == 0) {
            c.superlog_logf(&lg, "ERROR",
                "pricing failed on tick %d: no rate for DOGE", tick);
        } else {
            c.superlog_logf(&lg, "DEBUG", "pricing pass %d", tick);
        }

        if (@rem(tick, 5) == 0)
            c.superlog_metric(&lg, "clock.uptime_s", @floatFromInt(tick));

        c.superlog_flush(&lg);
        _ = c.sleep(1);
    }
}
