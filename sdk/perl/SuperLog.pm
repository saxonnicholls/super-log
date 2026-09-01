package SuperLog;

#
#  SuperLog.pm - the Perl client, core modules only.
#
#  Copyright 2026 Saxon Herschel Nicholls
#  SPDX-License-Identifier: MIT
#
#  Zero CPAN: HTTP::Tiny (core since 5.14), JSON::PP, Time::HiRes and
#  Sys::Hostname all ship with Perl. The mode comes from SUPERLOG_MODE
#  (development | production) and there is NO default, because deciding is
#  the point - unset dies at construction, and production is an inert
#  shell that sends nothing at all.
#
#    use lib "sdk/perl";
#    use SuperLog;
#    my $log = SuperLog->new(topic => "perl.myapp", app => "myapp");
#    $log->info("up", { port => 3000 });
#
#  Failures never reach the caller: a logger that can take down the script
#  it observes is worse than no logger. A hub that is down means the next
#  batch counts again.
#

use strict;
use warnings;

use HTTP::Tiny     ();
use JSON::PP       ();
use Sys::Hostname  ();
use Time::HiRes    ();

our $VERSION = '0.1';

my $JSON = JSON::PP->new->canonical->utf8;

sub new {
    my ($class, %opt) = @_;
    my $mode = $ENV{SUPERLOG_MODE} // '';
    unless ($mode eq 'development' || $mode eq 'production') {
        die "superlog: SUPERLOG_MODE is '$mode' - declare development or "
          . "production; there is no default, because deciding is the point.\n";
    }
    my ($host) = split /\./, lc(Sys::Hostname::hostname());
    my $self = {
        active  => $mode eq 'development',
        url     => $opt{url} // $ENV{SUPER_LOG_URL} // 'http://127.0.0.1:7333',
        topic   => $opt{topic} // die("superlog: topic is required\n"),
        app     => $opt{app}   // die("superlog: app is required\n"),
        device  => $host,
        session => sprintf('%08x', int(Time::HiRes::time() * 1e6) & 0xffffffff),
        seq     => 0,
        buffer  => [],
        http    => HTTP::Tiny->new(timeout => 5),
    };
    return bless $self, $class;
}

sub _ts {
    my ($s, $us) = Time::HiRes::gettimeofday();
    my @t = gmtime($s);
    return sprintf('%04d-%02d-%02dT%02d:%02d:%02d.%03dZ',
                   $t[5] + 1900, $t[4] + 1, $t[3], $t[2], $t[1], $t[0],
                   int($us / 1000));
}

sub log {
    my ($self, $level, $msg, $fields) = @_;
    return unless $self->{active};
    my %line = (
        v => 1, ts => _ts(), seq => $self->{seq}++, session => $self->{session},
        level => "$level",
        origin => { runtime => 'perl', app => $self->{app},
                    platform => 'host', device => $self->{device} },
        tag => $self->{app}, msg => "$msg",
    );
    if (ref $fields eq 'HASH' && %$fields) {
        $line{fields} = { map { ("$_" => "$fields->{$_}") } keys %$fields };
    }
    $self->_push(\%line);
    return;
}

sub metric {
    my ($self, $name, $value) = @_;
    return unless $self->{active};
    $self->_push({
        v => 1, ts => _ts(), seq => $self->{seq}++, session => $self->{session},
        level => 'DEBUG',
        origin => { runtime => 'perl', app => $self->{app},
                    platform => 'host', device => $self->{device} },
        tag => $self->{app}, msg => "$name =$value",
        metric => { name => "$name", value => 0 + $value },
    });
    return;
}

sub trace    { my $s = shift; $s->log('TRACE',    @_) }
sub debug    { my $s = shift; $s->log('DEBUG',    @_) }
sub info     { my $s = shift; $s->log('INFO',     @_) }
sub warn     { my $s = shift; $s->log('WARN',     @_) }
sub error    { my $s = shift; $s->log('ERROR',    @_) }
sub critical { my $s = shift; $s->log('CRITICAL', @_) }

sub flush {
    my ($self) = @_;
    my $batch = $self->{buffer};
    $self->{buffer} = [];
    return unless $self->{active} && @$batch;
    my $body = join "\n", map { $JSON->encode($_) } @$batch;
    # Failures are swallowed on purpose; the hub being down is the hub's
    # problem, and the next batch counts again.
    eval {
        $self->{http}->post(
            "$self->{url}/ingest/$self->{topic}",
            { headers => { 'content-type' => 'application/x-ndjson' },
              content => $body });
    };
    return;
}

sub _push {
    my ($self, $line) = @_;
    push @{ $self->{buffer} }, $line;
    $self->flush if @{ $self->{buffer} } >= 16;
    return;
}

sub DESTROY { my ($self) = @_; eval { $self->flush }; return }

1;
