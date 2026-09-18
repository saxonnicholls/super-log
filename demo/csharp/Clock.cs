//
//  Clock.cs - the C# demo client.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The same clock every other demo client runs, once a second on
//  csharp.clock. BCL only, like the SDK it exercises.
//
//    SUPERLOG_MODE=development dotnet run --project demo/csharp
//    dotnet run --project demo/csharp -- --ticks 6
//

var rates = new Dictionary<string, double> { ["BTC"] = 64_000.0, ["ETH"] = 3_200.0 };

var maxTicks = 0;
for (var i = 0; i < args.Length - 1; i++)
    if (args[i] == "--ticks") maxTicks = int.Parse(args[i + 1]);

var log = new SuperLog(topic: "csharp.clock", app: "clock");

Console.WriteLine("superlog: csharp clock -> csharp.clock");
log.Info("csharp clock up - one line a second",
         new() { ["dotnet"] = Environment.Version.ToString() });

var running = true;
Console.CancelKeyPress += (_, e) => { e.Cancel = true; running = false; };

var tick = 0;
while (running && (maxTicks == 0 || tick < maxTicks))
{
    tick++;
    log.Info($"tick {tick} - the time is {DateTime.UtcNow:HH:mm:ss}Z",
             new() { ["tick"] = tick.ToString() });

    // Honestly wrong every 7th tick, the same staged failure as every
    // other clock, so one error lines up across every language.
    var symbol = tick % 7 == 0 ? "DOGE" : "BTC";
    if (rates.TryGetValue(symbol, out var rate))
        log.Debug($"pricing pass {tick}",
                  new() { ["symbol"] = symbol, ["price"] = (rate * 2).ToString() });
    else
        log.Error($"pricing failed on tick {tick}: no rate for {symbol}",
                  new() { ["symbol"] = symbol, ["tick"] = tick.ToString() });

    // A demo ALARM so the viewers' Alarms panel has something from C#: raise
    // on the 5-tick mark, recover ten ticks later.
    if (tick % 20 == 5) log.Alarm("csharp demo: thread pool starved", "csharp.demo");
    else if (tick % 20 == 15) log.AlarmClear("csharp.demo");

    if (tick % 5 == 0) log.Metric("clock.uptime_s", tick);
    log.Flush();
    Thread.Sleep(1000);
}

log.Info("csharp clock stopping");
log.Flush();
