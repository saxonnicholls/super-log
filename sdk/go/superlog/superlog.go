// Copyright 2026 Saxon Herschel Nicholls

// Package superlog forwards log events to a super-log hub.
//
// Same contract as the C++, Rust, Python and JS SDKs: events go into a
// bounded channel from any goroutine, one worker drains them into NDJSON
// chunks and POSTs each chunk to superlogd. Producers never block on the
// network - the channel drops oldest, counted, because a logger that can
// stall the program it observes is worse than no logger.
//
//	log, _ := superlog.New(superlog.Config{
//	    Topic: "go.pricer", App: "pricer", Development: true,
//	})
//	defer log.Close()
//	log.Info("engine up", superlog.F{"venue": "XLON"})
//
//	slog.SetDefault(slog.New(log.SlogHandler(nil)))  // everything already
//	                                                 // logged, forwarded
//
// Standard library only, on purpose (the house rule for the SDKs): a
// debugging tool that needs its own module graph resolved before it can
// explain why the module graph broke is not much of a debugging tool.
//
// Wire contract: ../../../docs/PROTOCOL.md
package superlog

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// TraceHeader carries a correlation id between tiers (PROTOCOL.md).
const TraceHeader = "X-Superlog-Trace"

// Level names, as PROTOCOL.md spells them.
const (
	LevelTrace    = "TRACE"
	LevelDebug    = "DEBUG"
	LevelInfo     = "INFO"
	LevelWarn     = "WARN"
	LevelError    = "ERROR"
	LevelCritical = "CRITICAL"
	// PolicyOff makes a mode forward nothing at all.
	PolicyOff = "OFF"
)

var rank = map[string]int{
	LevelTrace: 1, LevelDebug: 2, LevelInfo: 3,
	LevelWarn: 4, LevelError: 5, LevelCritical: 6,
}

const offRank = 7

// maxStackLines is deep enough to find the panic, short enough not to ship
// a book per crash.
const maxStackLines = 40

// F is structured extras on an event. Values are stringified, since
// PROTOCOL.md says fields are string-valued.
type F map[string]any

// Config describes one client. Exactly one of Development/Production must
// be true - see New.
type Config struct {
	URL         string // default http://127.0.0.1:7333
	Topic       string // default go.app
	App         string // default app
	Device      string
	Development bool
	Production  bool
	// What each mode forwards: a level name, or PolicyOff. Development
	// defaults to everything; Production defaults to OFF, because log lines
	// leaving a production box are a security decision and nothing here
	// makes it for you.
	DevelopmentPolicy string
	ProductionPolicy  string
	FlushInterval     time.Duration // default 250ms
	MaxBatch          int           // default 256
	MaxQueue          int           // default 8192
	Quiet             bool          // suppress the inert-client notice
}

type traceKeyType struct{}

// traceKey puts the trace in the context, which is how Go carries
// request-scoped values - and is more honest than a goroutine-local would
// be, because Go deliberately has no goroutine locals.
var traceKey traceKeyType

// SuperLog is safe for concurrent use by multiple goroutines.
type SuperLog struct {
	cfg     Config
	url     string
	path    string
	origin  map[string]string
	session string

	minRank int
	enabled bool
	policy  string
	mode    string

	mu      sync.Mutex
	queue   []string
	seq     atomic.Uint64
	dropped atomic.Uint64

	wake   chan struct{}
	done   chan struct{}
	closed sync.Once
	client *http.Client
}

// New creates a client and starts its worker. It returns an error rather
// than panicking on a bad mode: a logging pipeline you *think* is off is
// worse than one that refuses to start until you decide.
func New(cfg Config) (*SuperLog, error) {
	if cfg.Development == cfg.Production {
		which := "neither"
		if cfg.Development {
			which = "both"
		}
		return nil, fmt.Errorf("superlog: set exactly one of Development / Production (got %s)", which)
	}
	if cfg.URL == "" {
		cfg.URL = "http://127.0.0.1:7333"
	}
	if cfg.Topic == "" {
		cfg.Topic = "go.app"
	}
	if cfg.App == "" {
		cfg.App = "app"
	}
	if cfg.DevelopmentPolicy == "" {
		cfg.DevelopmentPolicy = LevelTrace
	}
	if cfg.ProductionPolicy == "" {
		cfg.ProductionPolicy = PolicyOff
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = 250 * time.Millisecond
	}
	if cfg.MaxBatch == 0 {
		cfg.MaxBatch = 256
	}
	if cfg.MaxQueue == 0 {
		cfg.MaxQueue = 8192
	}

	policy := cfg.ProductionPolicy
	mode := "production"
	if cfg.Development {
		policy, mode = cfg.DevelopmentPolicy, "development"
	}
	min := offRank
	if policy != PolicyOff {
		if r, ok := rank[policy]; ok {
			min = r
		} else {
			return nil, fmt.Errorf("superlog: unknown policy %q", policy)
		}
	}

	s := &SuperLog{
		cfg: cfg, url: strings.TrimRight(cfg.URL, "/"),
		path: "/ingest/" + cfg.Topic,
		origin: map[string]string{
			"runtime": "go", "app": cfg.App, "platform": goPlatform(),
		},
		session: randomHex(),
		minRank: min, enabled: min < offRank, policy: policy, mode: mode,
		wake: make(chan struct{}, 1), done: make(chan struct{}),
		// A logger must never be the reason a request hangs, so the POST
		// gets a short timeout of its own rather than the default of none.
		client: &http.Client{Timeout: 5 * time.Second},
	}
	if cfg.Device != "" {
		s.origin["device"] = cfg.Device
	}

	if !s.enabled {
		// Say so once. An inert client is indistinguishable from a broken
		// one: nothing arrives, and Dropped() reads 0 because nothing was
		// ever queued - which reads as healthy.
		if !cfg.Quiet {
			field := "ProductionPolicy"
			if cfg.Development {
				field = "DevelopmentPolicy"
			}
			fmt.Fprintf(os.Stderr,
				"superlog: %s policy is OFF - nothing will be sent to %s. "+
					"Set %s to change that.\n", mode, s.url, field)
		}
		return s, nil
	}
	go s.run()
	return s, nil
}

func goPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	default:
		return runtime.GOOS
	}
}

func randomHex() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%016x", time.Now().UnixNano())
	}
	return fmt.Sprintf("%016x", binary.BigEndian.Uint64(b[:]))
}

// NewTraceID mints a correlation id: short, opaque, and enough entropy for
// one bench session.
func NewTraceID() string { return randomHex() }

// WithTrace returns a context carrying a trace id, minting one when the
// given id is empty. Everything logged with that context - and everything
// it is passed to - shares the id.
func WithTrace(ctx context.Context, id string) (context.Context, string) {
	if id == "" {
		id = NewTraceID()
	}
	return context.WithValue(ctx, traceKey, id), id
}

// TraceFrom reads the trace id out of a context, if any.
func TraceFrom(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if v, ok := ctx.Value(traceKey).(string); ok {
		return v
	}
	return ""
}

// TraceFromRequest adopts an inbound request's trace so a server's logs
// join the caller's story.
func TraceFromRequest(r *http.Request) string { return r.Header.Get(TraceHeader) }

// Status reports what this client resolved to - the first thing to print
// when events are not arriving. Enabled false means the build's policy
// turned it off, not that the network is broken.
func (s *SuperLog) Status() map[string]any {
	s.mu.Lock()
	queued := len(s.queue)
	s.mu.Unlock()
	return map[string]any{
		"enabled": s.enabled, "mode": s.mode, "policy": s.policy,
		"url": s.url, "topic": s.cfg.Topic, "session": s.session,
		"queued": queued, "dropped": s.dropped.Load(),
	}
}

// Dropped counts events lost because the queue was full. Zero does NOT
// mean healthy: an inert client never queues, so it never drops.
func (s *SuperLog) Dropped() uint64 { return s.dropped.Load() }

// ---------------------------------------------------------------- logging

// LogContext emits one event, taking the trace from ctx.
func (s *SuperLog) LogContext(ctx context.Context, level, msg string, fields F) {
	if rank[level] < s.minRank {
		return // below this mode's policy: not even serialised
	}
	ev := map[string]any{
		"v": 1, "ts": time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z"),
		"seq": s.seq.Add(1) - 1, "session": s.session,
		"level": level, "origin": s.origin, "msg": msg,
	}
	if t := TraceFrom(ctx); t != "" {
		ev["trace"] = t
	}
	if len(fields) > 0 {
		out := make(map[string]string, len(fields))
		for k, v := range fields {
			out[k] = stringify(v)
		}
		ev["fields"] = out
	}
	s.push(ev)
}

func (s *SuperLog) Log(level, msg string, fields F) { s.LogContext(nil, level, msg, fields) }

func (s *SuperLog) Trace(msg string, f F)    { s.Log(LevelTrace, msg, f) }
func (s *SuperLog) Debug(msg string, f F)    { s.Log(LevelDebug, msg, f) }
func (s *SuperLog) Info(msg string, f F)     { s.Log(LevelInfo, msg, f) }
func (s *SuperLog) Warn(msg string, f F)     { s.Log(LevelWarn, msg, f) }
func (s *SuperLog) Error(msg string, f F)    { s.Log(LevelError, msg, f) }
func (s *SuperLog) Critical(msg string, f F) { s.Log(LevelCritical, msg, f) }

// Metric is telemetry riding the same pipeline (PROTOCOL.md `metric`).
func (s *SuperLog) Metric(name string, value float64) {
	if rank[LevelInfo] < s.minRank {
		return
	}
	s.push(map[string]any{
		"v": 1, "ts": time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z"),
		"seq": s.seq.Add(1) - 1, "session": s.session, "level": LevelInfo,
		"origin": s.origin, "msg": name,
		"metric": map[string]any{"name": name, "value": value},
	})
}

func stringify(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case error:
		return t.Error()
	default:
		if b, err := json.Marshal(v); err == nil {
			return strings.Trim(string(b), `"`)
		}
		return fmt.Sprint(v)
	}
}

// ------------------------------------------------------------- panics

// Recover logs a panic and re-panics, so it belongs at the top of a
// goroutine:
//
//	go func() { defer log.Recover("worker"); work() }()
//
// It re-panics deliberately. A logger that swallows a panic changes the
// program's behaviour, and a crash that silently becomes a no-op is worse
// than a crash.
func (s *SuperLog) Recover(where string) {
	r := recover()
	if r == nil {
		return
	}
	stack := strings.Split(string(debug.Stack()), "\n")
	if len(stack) > maxStackLines {
		stack = stack[:maxStackLines]
	}
	s.Log(LevelCritical, fmt.Sprintf("panic in %s: %v", where, r), F{
		"where": where, "stack": strings.Join(stack, "\n"),
	})
	s.Flush(2 * time.Second) // this goroutine may not survive to the next tick
	panic(r)
}

// ------------------------------------------------------- slog integration

type slogHandler struct {
	s     *SuperLog
	attrs []slog.Attr
	group string
	opts  slog.HandlerOptions
}

// SlogHandler returns a slog.Handler, so everything the program ALREADY
// logs reaches the bench without touching a single call site - the Go
// analogue of the spdlog sink and Python's logging.Handler.
func (s *SuperLog) SlogHandler(opts *slog.HandlerOptions) slog.Handler {
	h := &slogHandler{s: s}
	if opts != nil {
		h.opts = *opts
	}
	return h
}

func (h *slogHandler) Enabled(_ context.Context, l slog.Level) bool {
	return rank[fromSlog(l)] >= h.s.minRank
}

func fromSlog(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return LevelError
	case l >= slog.LevelWarn:
		return LevelWarn
	case l >= slog.LevelInfo:
		return LevelInfo
	default:
		return LevelDebug
	}
}

func (h *slogHandler) Handle(ctx context.Context, r slog.Record) error {
	fields := F{}
	for _, a := range h.attrs {
		fields[a.Key] = a.Value.Any()
	}
	r.Attrs(func(a slog.Attr) bool {
		key := a.Key
		if h.group != "" {
			key = h.group + "." + key
		}
		fields[key] = a.Value.Any()
		return true
	})
	if len(fields) == 0 {
		fields = nil
	}
	h.s.LogContext(ctx, fromSlog(r.Level), r.Message, fields)
	return nil
}

func (h *slogHandler) WithAttrs(as []slog.Attr) slog.Handler {
	n := *h
	n.attrs = append(append([]slog.Attr{}, h.attrs...), as...)
	return &n
}

func (h *slogHandler) WithGroup(name string) slog.Handler {
	n := *h
	if h.group != "" {
		name = h.group + "." + name
	}
	n.group = name
	return &n
}

// ------------------------------------------------------------- plumbing

func (s *SuperLog) push(ev map[string]any) {
	// Compact by construction: encoding/json emits no spaces, which is what
	// every SDK here does - smaller on the wire and one less thing for a
	// reader's field scan to cope with.
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	s.mu.Lock()
	if len(s.queue) >= s.cfg.MaxQueue {
		// Drop OLDEST: the newest events are the ones describing whatever
		// is going wrong right now.
		s.queue = s.queue[1:]
		s.dropped.Add(1)
	}
	s.queue = append(s.queue, string(b))
	full := len(s.queue) >= s.cfg.MaxBatch
	s.mu.Unlock()
	if full {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
}

func (s *SuperLog) take() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.queue) == 0 {
		return nil
	}
	n := len(s.queue)
	if n > s.cfg.MaxBatch {
		n = s.cfg.MaxBatch
	}
	batch := s.queue[:n]
	s.queue = append([]string{}, s.queue[n:]...)
	return batch
}

func (s *SuperLog) run() {
	t := time.NewTicker(s.cfg.FlushInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
		case <-s.wake:
		case <-s.done:
			for b := s.take(); b != nil; b = s.take() {
				s.post(b) // nothing queued is lost on exit
			}
			return
		}
		if b := s.take(); b != nil {
			s.post(b)
		}
	}
}

func (s *SuperLog) post(batch []string) {
	body := strings.NewReader(strings.Join(batch, "\n"))
	req, err := http.NewRequest(http.MethodPost, s.url+s.path, body)
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	resp, err := s.client.Do(req)
	if err != nil {
		// The hub is down; count, do not retry. A retry queue grows without
		// bound on a process that outlives the bench.
		s.dropped.Add(uint64(len(batch)))
		return
	}
	resp.Body.Close()
}

// Flush waits, up to timeout, for the queue to drain.
func (s *SuperLog) Flush(timeout time.Duration) {
	if !s.enabled {
		return
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		n := len(s.queue)
		s.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Close drains what is queued and stops the worker.
func (s *SuperLog) Close() {
	if !s.enabled {
		return
	}
	s.closed.Do(func() {
		close(s.done)
		time.Sleep(50 * time.Millisecond) // let the final drain run
	})
}
