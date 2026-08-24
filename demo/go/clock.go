// clock.go - the Go demo client
//
// # Copyright 2026 Saxon Herschel Nicholls
//
// The same clock the other demo clients run, once a second on topic
// go.clock, plus the two things a Go service actually wants: the standard
// slog output forwarded with no call-site changes, and a panic in a
// goroutine reaching the bench instead of vanishing.
//
//	go run ./demo/go/clock.go
//	go run ./demo/go/clock.go --crash
package main

import (
	"context"
	"log/slog"
	"os"
	"runtime"
	"time"

	"github.com/saxonnicholls/super-log/sdk/go/superlog"
)

func priceFor(symbol string) (float64, error) {
	rates := map[string]float64{"BTC": 64000, "ETH": 3200}
	v, ok := rates[symbol]
	if !ok {
		return 0, &missingRate{symbol}
	}
	return v, nil
}

type missingRate struct{ symbol string }

func (e *missingRate) Error() string { return "no rate for " + e.symbol }

func main() {
	url := os.Getenv("SUPER_LOG_URL")
	if url == "" {
		url = "http://127.0.0.1:7333"
	}
	log, err := superlog.New(superlog.Config{
		URL: url, Topic: "go.clock", App: "clock", Development: true,
	})
	if err != nil {
		panic(err)
	}
	defer log.Close()

	// Everything already logged through slog reaches the bench, with no
	// changes at any call site. This is the whole point of the handler.
	slog.SetDefault(slog.New(log.SlogHandler(&slog.HandlerOptions{Level: slog.LevelDebug})))

	log.Info("go clock up - one line a second", superlog.F{"go": runtime.Version()})

	if len(os.Args) > 1 && os.Args[1] == "--crash" {
		// A panic in a goroutine is invisible to the main one; Recover puts
		// it on the bench and then re-panics, so the process still dies.
		go func() {
			defer log.Recover("worker")
			var m map[string]int
			m["boom"] = 1 // assignment to nil map
		}()
		time.Sleep(2 * time.Second)
		return
	}

	ticks := 0
	for {
		ticks++
		// One trace per tick, carried by the context - which is how Go
		// passes request-scoped values, so anything this calls inherits it.
		ctx, _ := superlog.WithTrace(context.Background(), "")
		log.LogContext(ctx, superlog.LevelInfo,
			"tick "+time.Now().UTC().Format("15:04:05")+"Z",
			superlog.F{"tick": ticks})
		slog.DebugContext(ctx, "pricing pass", "tick", ticks)

		if ticks%5 == 0 {
			log.Metric("clock.uptime_s", float64(ticks))
		}
		if ticks%7 == 0 {
			if _, err := priceFor("DOGE"); err != nil {
				log.LogContext(ctx, superlog.LevelError, "pricing failed: "+err.Error(),
					superlog.F{"symbol": "DOGE", "tick": ticks})
			}
		}
		time.Sleep(time.Second)
	}
}
