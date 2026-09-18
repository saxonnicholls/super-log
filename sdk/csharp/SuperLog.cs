//
//  SuperLog.cs - the C# client, BCL only.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Zero NuGet: HttpClient and System.Text.Json ship with .NET. One file,
//  dropped into any project - a console app, ASP.NET, a Unity project on
//  a .NET profile, an Xbox Dev Mode UWP build; everywhere .NET goes, this
//  goes. The mode comes from SUPERLOG_MODE (development | production) and
//  there is NO default, because deciding is the point - unset throws at
//  construction, and production is an inert shell that sends nothing.
//
//    var log = new SuperLog(topic: "csharp.myapp", app: "myapp");
//    log.Info("up", new() { ["port"] = "3000" });
//    log.Metric("queue.depth", 17);
//    log.Flush();
//
//  Failures never reach the caller: a logger that can take down the app
//  it observes is worse than no logger. A hub that is down means the next
//  batch counts again.
//

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;

public sealed class SuperLog
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };

    private readonly bool _active;
    private readonly string _url;
    private readonly string _topic;
    private readonly string _app;
    private readonly string _device;
    private readonly string _session;
    private readonly List<string> _buffer = new();
    private readonly object _lock = new();
    private long _seq;

    public SuperLog(string topic, string app, string? url = null)
    {
        var mode = Environment.GetEnvironmentVariable("SUPERLOG_MODE") ?? "";
        if (mode != "development" && mode != "production")
            throw new InvalidOperationException(
                $"superlog: SUPERLOG_MODE is '{mode}' - declare development or " +
                "production; there is no default, because deciding is the point.");
        _active = mode == "development";
        _url = url ?? Environment.GetEnvironmentVariable("SUPER_LOG_URL")
                   ?? "http://127.0.0.1:7333";
        _topic = topic ?? throw new ArgumentNullException(nameof(topic));
        _app = app ?? throw new ArgumentNullException(nameof(app));
        _device = Environment.MachineName.Split('.')[0].ToLowerInvariant();
        _session = Guid.NewGuid().ToString("N")[..8];
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Flush();
    }

    public void Trace(string msg, Dictionary<string, string>? fields = null) => Log("TRACE", msg, fields);
    public void Debug(string msg, Dictionary<string, string>? fields = null) => Log("DEBUG", msg, fields);
    public void Info(string msg, Dictionary<string, string>? fields = null) => Log("INFO", msg, fields);
    public void Warn(string msg, Dictionary<string, string>? fields = null) => Log("WARN", msg, fields);
    public void Error(string msg, Dictionary<string, string>? fields = null) => Log("ERROR", msg, fields);
    public void Critical(string msg, Dictionary<string, string>? fields = null) => Log("CRITICAL", msg, fields);

    private static string AlarmKey(string k)
    {
        var sb = new StringBuilder();
        foreach (var ch in (k ?? "").ToLowerInvariant())
            sb.Append((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
                      || ch == '.' || ch == '_' || ch == '-' ? ch : '-');
        return sb.Length == 0 ? "alarm" : sb.ToString();
    }

    /// <summary>Raise a first-class ALARM straight into the viewers' Alarms
    /// panel - the deliberate "this is an alarm", not a WARN a rule must catch.
    /// It lands on alert.native.&lt;key&gt; (deduped by fields.key), posted
    /// immediately, OUTSIDE the batch AND the mode gate: an alarm you asked for
    /// must not go quiet in production (SUPER_LOG_ALARMS=0 mutes). CRITICAL (P0)
    /// by default. See PROTOCOL.md.</summary>
    public void Alarm(string msg, string? key = null, string level = "CRITICAL")
    {
        if (Environment.GetEnvironmentVariable("SUPER_LOG_ALARMS") == "0") return;
        var k = AlarmKey(!string.IsNullOrEmpty(key) ? key! : msg);
        string line;
        using (var ms = new System.IO.MemoryStream())
        {
            using (var w = new Utf8JsonWriter(ms))
            {
                w.WriteStartObject();
                w.WriteNumber("v", 1);
                w.WriteString("ts", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"));
                w.WriteNumber("seq", _seq++);
                w.WriteString("session", _session);
                w.WriteString("level", level);
                w.WriteStartObject("origin");
                w.WriteString("runtime", "csharp");
                w.WriteString("app", _app);
                w.WriteString("platform", "host");
                w.WriteString("device", _device);
                w.WriteEndObject();
                w.WriteString("tag", "alarm");
                w.WriteString("msg", msg);
                w.WriteStartObject("fields");
                w.WriteString("key", k);
                w.WriteEndObject();
                w.WriteEndObject();
            }
            line = Encoding.UTF8.GetString(ms.ToArray());
        }
        try
        {
            using var content = new StringContent(line, Encoding.UTF8, "application/x-ndjson");
            Http.PostAsync($"{_url}/ingest/alert.native.{k}", content).GetAwaiter().GetResult();
        }
        catch
        {
            // hub down; an alarm that could not be delivered is not retried here
        }
    }

    /// <summary>Clear a raised alarm: an INFO the blotter reads as RECOVERED.</summary>
    public void AlarmClear(string key) => Alarm($"RECOVERED: {AlarmKey(key)}", key, "INFO");

    public void Log(string level, string msg, Dictionary<string, string>? fields = null)
    {
        if (!_active) return;
        Push(Line(level, msg, fields, metricName: null, metricValue: 0));
    }

    public void Metric(string name, double value)
    {
        if (!_active) return;
        Push(Line("DEBUG", $"{name} ={value}", null, name, value));
    }

    public void Flush()
    {
        if (!_active) return;
        string body;
        lock (_lock)
        {
            if (_buffer.Count == 0) return;
            body = string.Join("\n", _buffer);
            _buffer.Clear();
        }
        try
        {
            using var content = new StringContent(body, Encoding.UTF8, "application/x-ndjson");
            Http.PostAsync($"{_url}/ingest/{_topic}", content)
                .GetAwaiter().GetResult();
        }
        catch
        {
            // hub down; the next batch counts again
        }
    }

    private string Line(string level, string msg,
                        Dictionary<string, string>? fields,
                        string? metricName, double metricValue)
    {
        using var ms = new System.IO.MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteNumber("v", 1);
            w.WriteString("ts", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"));
            w.WriteNumber("seq", _seq++);
            w.WriteString("session", _session);
            w.WriteString("level", level);
            w.WriteStartObject("origin");
            w.WriteString("runtime", "csharp");
            w.WriteString("app", _app);
            w.WriteString("platform", "host");
            w.WriteString("device", _device);
            w.WriteEndObject();
            w.WriteString("tag", _app);
            w.WriteString("msg", msg);
            if (fields is { Count: > 0 })
            {
                w.WriteStartObject("fields");
                foreach (var (k, v) in fields) w.WriteString(k, v);
                w.WriteEndObject();
            }
            if (metricName is not null)
            {
                w.WriteStartObject("metric");
                w.WriteString("name", metricName);
                w.WriteNumber("value", metricValue);
                w.WriteEndObject();
            }
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    private void Push(string line)
    {
        bool full;
        lock (_lock)
        {
            _buffer.Add(line);
            full = _buffer.Count >= 16;
        }
        if (full) Flush();
    }
}
