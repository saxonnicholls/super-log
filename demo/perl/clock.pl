#!/usr/bin/env perl

#
#  clock.pl - the Perl demo client.
#
#  Copyright 2026 Saxon Herschel Nicholls
#  SPDX-License-Identifier: MIT
#
#  The same clock every other demo client runs, once a second on
#  perl.clock - core modules only, like the SDK it exercises.
#
#    SUPERLOG_MODE=development perl demo/perl/clock.pl
#    perl demo/perl/clock.pl --ticks 6      # stop after six, for scripts
#

use strict;
use warnings;
use FindBin ();
use lib "$FindBin::Bin/../../sdk/perl";
use SuperLog;
use POSIX ();

my %RATES = (BTC => 64_000.0, ETH => 3_200.0);

my $max_ticks = 0;
for my $i (0 .. $#ARGV - 1) {
    $max_ticks = 0 + $ARGV[$i + 1] if $ARGV[$i] eq '--ticks';
}

my $log = SuperLog->new(topic => 'perl.clock', app => 'clock');

print "superlog: perl clock -> perl.clock\n";
$log->info('perl clock up - one line a second', { perl => "$]" });

my $running = 1;
local $SIG{INT} = sub { $running = 0 };

my $tick = 0;
while ($running && (!$max_ticks || $tick < $max_ticks)) {
    $tick++;
    $log->info("tick $tick - the time is "
                 . POSIX::strftime('%H:%M:%SZ', gmtime),
               { tick => $tick });

    # Honestly wrong every 7th tick, the same staged failure as every
    # other clock, so one error lines up across every language.
    my $symbol = $tick % 7 == 0 ? 'DOGE' : 'BTC';
    if (my $rate = $RATES{$symbol}) {
        $log->debug("pricing pass $tick", { symbol => $symbol,
                                            price  => $rate * 2 });
    } else {
        $log->error("pricing failed on tick $tick: no rate for $symbol",
                    { symbol => $symbol, tick => $tick });
    }

    $log->metric('clock.uptime_s', $tick) if $tick % 5 == 0;
    $log->flush;
    sleep 1;
}

$log->info('perl clock stopping');
$log->flush;
