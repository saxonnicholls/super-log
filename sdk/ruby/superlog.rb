# frozen_string_literal: true
#
#  superlog.rb - the Ruby client, stdlib only.
#
#  Copyright 2026 Saxon Herschel Nicholls
#  SPDX-License-Identifier: MIT
#
#  Zero gems: net/http, json and securerandom all ship with Ruby. The mode
#  comes from SUPERLOG_MODE (development | production) and there is NO
#  default, because deciding is the point - unset raises at require time,
#  and production is an inert shell that sends nothing at all.
#
#    require_relative "superlog"
#    log = SuperLog.new(topic: "ruby.myapp", app: "myapp")
#    log.info("up", port: 3000)
#
#  Rails, and anything else already writing to a ::Logger, needs no new
#  call sites: SuperLog::LoggerAdapter quacks like ::Logger, so
#
#    config.logger = ActiveSupport::BroadcastLogger.new(
#      ActiveSupport::Logger.new($stdout),
#      SuperLog.new(topic: "ruby.myrails", app: "myrails").logger_adapter)
#
#  puts every line Rails already logs on the bench, levels mapped, with no
#  controller edited. (Rails < 7.1 broadcasts via
#  ActiveSupport::Logger.broadcast instead - same adapter.)
#
#  Failures never reach the caller: a logger that can take down the app it
#  observes is worse than no logger. A hub that is down means the next
#  batch counts again.
#

require "json"
require "net/http"
require "securerandom"
require "socket"
require "uri"

class SuperLog
  LEVELS = %w[TRACE DEBUG INFO WARN ERROR CRITICAL].freeze

  def initialize(topic:, app:, url: nil)
    mode = ENV["SUPERLOG_MODE"]
    unless %w[development production].include?(mode)
      abort "superlog: SUPERLOG_MODE is #{mode.inspect} - declare development " \
            "or production; there is no default, because deciding is the point."
    end
    @active = mode == "development"
    @uri = URI(url || ENV.fetch("SUPER_LOG_URL", "http://127.0.0.1:7333"))
    @topic = topic
    @app = app
    @device = Socket.gethostname.split(".").first.to_s.downcase
    @session = SecureRandom.hex(4)
    @seq = 0
    @buffer = []
    @mutex = Mutex.new
    at_exit { flush }
  end

  def log(level, msg, fields = {})
    return unless @active
    line = {
      v: 1, ts: Time.now.utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ"),
      seq: (@seq += 1) - 1, session: @session, level: level.to_s,
      origin: { runtime: "ruby", app: @app, platform: "host", device: @device },
      tag: @app, msg: msg.to_s,
    }
    line[:fields] = fields.transform_keys(&:to_s).transform_values(&:to_s) unless fields.empty?
    push(line)
  end

  def metric(name, value)
    return unless @active
    push({
      v: 1, ts: Time.now.utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ"),
      seq: (@seq += 1) - 1, session: @session, level: "DEBUG",
      origin: { runtime: "ruby", app: @app, platform: "host", device: @device },
      tag: @app, msg: "#{name} =#{value}",
      metric: { name: name.to_s, value: value.to_f },
    })
  end

  def trace(msg, fields = {}) = log("TRACE", msg, fields)
  def debug(msg, fields = {}) = log("DEBUG", msg, fields)
  def info(msg, fields = {})  = log("INFO", msg, fields)
  def warn(msg, fields = {})  = log("WARN", msg, fields)
  def error(msg, fields = {}) = log("ERROR", msg, fields)
  def critical(msg, fields = {}) = log("CRITICAL", msg, fields)

  def flush
    batch = @mutex.synchronize { b = @buffer; @buffer = []; b }
    return if batch.empty? || !@active
    body = batch.map(&:to_json).join("\n")
    http = Net::HTTP.new(@uri.host, @uri.port)
    http.open_timeout = 3
    http.read_timeout = 5
    req = Net::HTTP::Post.new("/ingest/#{@topic}",
                              "content-type" => "application/x-ndjson")
    req.body = body
    http.request(req)
  rescue StandardError
    nil # hub down; the next batch counts again
  end

  # A ::Logger-compatible face, for Rails and everything else that already
  # holds a Logger: add(severity, message, progname), the level methods,
  # and the write-nothing plumbing a BroadcastLogger pokes at.
  def logger_adapter
    LoggerAdapter.new(self)
  end

  class LoggerAdapter
    SEV = { 0 => "DEBUG", 1 => "INFO", 2 => "WARN", 3 => "ERROR",
            4 => "CRITICAL", 5 => "CRITICAL" }.freeze

    def initialize(superlog) = @sl = superlog

    def add(severity, message = nil, progname = nil)
      msg = message || (block_given? ? yield : progname)
      @sl.log(SEV.fetch(severity.to_i, "INFO"), msg.to_s) unless msg.nil?
      true
    end
    alias log add

    def debug(m = nil, &b) = add(0, m, &b)
    def info(m = nil, &b)  = add(1, m, &b)
    def warn(m = nil, &b)  = add(2, m, &b)
    def error(m = nil, &b) = add(3, m, &b)
    def fatal(m = nil, &b) = add(4, m, &b)
    def unknown(m = nil, &b) = add(5, m, &b)

    # Also usable as a raw log DEVICE (Logger.new(adapter)): Logger then
    # hands over formatted lines, so the severity is recovered from the
    # line itself rather than trusted to stay INFO.
    def write(formatted)
      sev = formatted[/\b(DEBUG|INFO|WARN|ERROR|FATAL)\b/, 1] || "INFO"
      msg = formatted.split(" -- ", 2).last.to_s.chomp
      @sl.log(sev == "FATAL" ? "CRITICAL" : sev, msg)
    end
    alias << write

    # The plumbing Rails touches on any logger it is handed.
    attr_accessor :level, :progname, :formatter
    def debug? = true
    def info? = true
    def warn? = true
    def error? = true
    def fatal? = true
    def close = @sl.flush
  end

  private

  def push(line)
    pending = @mutex.synchronize { @buffer << line; @buffer.size }
    flush if pending >= 16
  end
end
