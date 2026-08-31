# frozen_string_literal: true
#
#  clock.rb - the Ruby demo client.
#
#  Copyright 2026 Saxon Herschel Nicholls
#  SPDX-License-Identifier: MIT
#
#  The same clock every other demo client runs, once a second on
#  ruby.clock, plus the thing the Ruby SDK exists to show: lines written
#  to a plain ::Logger arrive too, through the adapter, with no call site
#  changed - which is the whole Rails story in one line.
#
#    SUPERLOG_MODE=development ruby demo/ruby/clock.rb
#    ruby demo/ruby/clock.rb --ticks 6      # stop after six, for scripts
#

require_relative "../../sdk/ruby/superlog"
require "logger"

RATES = { "BTC" => 64_000.0, "ETH" => 3_200.0 }.freeze

max_ticks = ARGV.each_cons(2).find { |a, _| a == "--ticks" }&.last.to_i

log = SuperLog.new(topic: "ruby.clock", app: "clock")

# The adapter IS a ::Logger, drop-in: hand it to anything that expects one
# - which is exactly what config.logger = ... does in Rails.
stdlib = log.logger_adapter

puts "superlog: ruby clock -> ruby.clock"
log.info("ruby clock up - one line a second", ruby: RUBY_VERSION)

tick = 0
running = true
trap("INT") { running = false }

while running && (max_ticks.zero? || tick < max_ticks)
  tick += 1
  log.info("tick #{tick} - the time is #{Time.now.utc.strftime('%H:%M:%SZ')}",
           tick: tick)

  # Honestly wrong every 7th tick, the same staged failure as every other
  # clock, so one error lines up across every language on the bench.
  symbol = (tick % 7).zero? ? "DOGE" : "BTC"
  if (rate = RATES[symbol])
    log.debug("pricing pass #{tick}", symbol: symbol, price: rate * 2)
  else
    log.error("pricing failed on tick #{tick}: no rate for #{symbol}",
              symbol: symbol, tick: tick)
  end

  # Through the stdlib Logger - the adapter's job, and the Rails story.
  stdlib.info("stdlib logger line #{tick}") if (tick % 5).zero?
  log.metric("clock.uptime_s", tick) if (tick % 5).zero?

  log.flush
  sleep 1
end

log.info("ruby clock stopping")
log.flush
