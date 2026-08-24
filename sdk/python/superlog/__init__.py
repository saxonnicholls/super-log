#
#  superlog - the Python SDK
#
#  Copyright 2026 Saxon Herschel Nicholls
#
#  Same contract as the C++, Rust and JS SDKs: events go into a bounded
#  queue from any thread, one worker drains them into NDJSON chunks and
#  POSTs each chunk to superlogd. Producers never block on the network -
#  the queue drops oldest, counted, because a logger that can stall the
#  program it observes is worse than no logger.
#
#      import superlog
#      log = superlog.SuperLog(topic="python.pricer", app="pricer",
#                              development=True)
#      log.info("engine up", fields={"venue": "XLON"})
#
#      logging.getLogger().addHandler(log.handler())   # everything already
#                                                      # logged, forwarded
#      log.install_excepthook()                        # and every crash
#
#  Standard library only, on purpose (the house rule for the SDKs): a
#  debugging tool that needs its own dependency tree resolved before it can
#  tell you why the dependency tree broke is not much of a debugging tool.
#
#  Wire contract: ../../../docs/PROTOCOL.md
#

from __future__ import annotations

import atexit
import contextvars
import http.client
import json
import os
import platform
import random
import socket
import sys
import threading
import time
import traceback
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Mapping, Optional
from urllib.parse import urlparse

__all__ = [
    "SuperLog", "Level", "Policy", "TRACE_HEADER", "new_trace_id",
]

TRACE_HEADER = "X-Superlog-Trace"

# ------------------------------------------------------------------ levels

class Level:
    TRACE = "TRACE"
    DEBUG = "DEBUG"
    INFO = "INFO"
    WARN = "WARN"
    ERROR = "ERROR"
    CRITICAL = "CRITICAL"


_RANK = {Level.TRACE: 1, Level.DEBUG: 2, Level.INFO: 3,
         Level.WARN: 4, Level.ERROR: 5, Level.CRITICAL: 6}
_OFF_RANK = 7


class Policy:
    """What a mode forwards. `OFF` makes the client an inert shell."""
    ALL = "TRACE"
    OFF = "OFF"

    @staticmethod
    def at_least(level: str) -> str:
        return level


# Python's logging levels, mapped to PROTOCOL.md's. WARNING is the odd one:
# everything else in this project spells it WARN.
_FROM_LOGGING = {
    50: Level.CRITICAL, 40: Level.ERROR, 30: Level.WARN,
    20: Level.INFO, 10: Level.DEBUG, 5: Level.TRACE, 0: Level.INFO,
}

# Deep enough to find the throw, short enough not to ship a book per crash.
MAX_STACK_LINES = 40
# Local variables can be the whole answer or the whole liability; these
# names are never shown, whatever they contain.
_SECRET_NAME = ("password", "passwd", "secret", "token", "api_key", "apikey",
                "authorization", "auth", "credential", "private_key", "seed",
                "mnemonic", "cookie", "session")

# Trace lives in a ContextVar, which is the reason this SDK gets correlation
# more right than its siblings: asyncio tasks and threads each inherit a
# copy, so a trace set in one request cannot leak into a concurrent one.
_current_trace: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "superlog_trace", default=None)


def new_trace_id() -> str:
    """Short, opaque, and enough entropy for one bench session."""
    return "%016x" % random.getrandbits(64)


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def _platform() -> str:
    s = platform.system().lower()
    return {"darwin": "macos", "windows": "windows"}.get(s, s or "linux")


def _safe(v: Any) -> str:
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v, default=str)
    except Exception:
        return str(v)


# ----------------------------------------------------------------- client

class SuperLog:
    """One client per process (or per topic). Cheap to pass around; every
    method is safe from any thread."""

    def __init__(
        self,
        topic: str = "python.app",
        app: str = "app",
        url: str = "http://127.0.0.1:7333",
        *,
        development: Optional[bool] = None,
        production: Optional[bool] = None,
        development_policy: str = Policy.ALL,
        production_policy: str = Policy.OFF,
        device: str = "",
        flush_ms: int = 250,
        max_batch: int = 256,
        max_queue: int = 8192,
        quiet: bool = False,
    ) -> None:
        # DEVELOPMENT xor PRODUCTION, enforced - the same rule as the other
        # SDKs. A logging pipeline you *think* is off is worse than one that
        # refuses to start until you decide.
        dev = development is True
        prod = production is True
        if dev == prod:
            raise ValueError(
                "superlog: set exactly one of development / production (got %s)"
                % ("both" if dev else "neither"))

        policy = development_policy if dev else production_policy
        self._min_rank = _OFF_RANK if policy == Policy.OFF else _RANK.get(policy, 1)
        self.enabled = self._min_rank < _OFF_RANK
        self._policy = policy
        self._mode = "development" if dev else "production"

        self.url = url.rstrip("/")
        self.topic = topic
        self._path = "/ingest/" + topic
        self._parsed = urlparse(self.url)
        self._session = "%016x" % random.getrandbits(64)
        self._seq = 0
        self._seq_lock = threading.Lock()
        self._origin = {
            "runtime": "python",
            "app": app,
            "platform": _platform(),
        }
        if device:
            self._origin["device"] = device

        self._max_batch = max_batch
        self._flush_s = flush_ms / 1000.0
        self._dropped = 0
        # maxlen IS the drop-oldest policy: appending to a full deque
        # discards from the other end, which is exactly the trade every SDK
        # here makes, without a lock dance to implement it.
        self._q: deque[str] = deque(maxlen=max_queue)
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._stop = False
        self._worker: Optional[threading.Thread] = None
        self._excepthook_installed = False

        if not self.enabled:
            # Say so once. An inert client is indistinguishable from a broken
            # one: nothing arrives, and dropped() reads 0 because nothing was
            # ever queued, which reads as healthy.
            if not quiet:
                print("superlog: %s policy is OFF - nothing will be sent to %s. "
                      "Set %s_policy to change that."
                      % (self._mode, self.url, self._mode), file=sys.stderr)
            return

        self._worker = threading.Thread(target=self._run, name="superlog",
                                        daemon=True)
        self._worker.start()
        # A daemon thread is killed at exit wherever it stands, so the last
        # batch needs an explicit chance to leave.
        atexit.register(self.close)

    # -------------------------------------------------------------- status

    def status(self) -> dict:
        """What this client resolved to - the first thing to print when
        events are not arriving. `enabled: False` means the build's policy
        turned it off, not that the network is broken."""
        with self._lock:
            queued = len(self._q)
        return {
            "enabled": self.enabled, "mode": self._mode, "policy": self._policy,
            "url": self.url, "topic": self.topic, "session": self._session,
            "queued": queued, "dropped": self._dropped,
        }

    def dropped(self) -> int:
        """Events dropped because the queue was full. 0 does NOT mean
        healthy: an inert client never queues, so it never drops."""
        return self._dropped

    # ----------------------------------------------------------- emitting

    def log(self, level: str, msg: str,
            fields: Optional[Mapping[str, Any]] = None,
            tag: str = "", src: str = "") -> None:
        if _RANK.get(level, 3) < self._min_rank:
            return                      # below policy: not even serialised
        with self._seq_lock:
            seq = self._seq
            self._seq += 1
        ev: dict[str, Any] = {
            "v": 1, "ts": _iso_now(), "seq": seq, "session": self._session,
            "level": level, "origin": self._origin, "msg": msg,
        }
        trace = _current_trace.get()
        if trace:
            ev["trace"] = trace
        if tag:
            ev["tag"] = tag
        if src:
            ev["src"] = src
        if fields:
            ev["fields"] = {str(k): _safe(v) for k, v in fields.items()}
        self._push(json.dumps(ev, default=str, separators=(",", ":")))

    def trace(self, msg: str, **kw: Any) -> None: self.log(Level.TRACE, msg, **kw)
    def debug(self, msg: str, **kw: Any) -> None: self.log(Level.DEBUG, msg, **kw)
    def info(self, msg: str, **kw: Any) -> None: self.log(Level.INFO, msg, **kw)
    def warn(self, msg: str, **kw: Any) -> None: self.log(Level.WARN, msg, **kw)
    def error(self, msg: str, **kw: Any) -> None: self.log(Level.ERROR, msg, **kw)
    def critical(self, msg: str, **kw: Any) -> None: self.log(Level.CRITICAL, msg, **kw)

    def metric(self, name: str, value: float) -> None:
        """Telemetry riding the same pipeline (PROTOCOL.md `metric`)."""
        if _RANK[Level.INFO] < self._min_rank:
            return
        with self._seq_lock:
            seq = self._seq
            self._seq += 1
        ev = {"v": 1, "ts": _iso_now(), "seq": seq, "session": self._session,
              "level": Level.INFO, "origin": self._origin, "msg": name,
              "metric": {"name": name, "value": value}}
        trace = _current_trace.get()
        if trace:
            ev["trace"] = trace
        self._push(json.dumps(ev, default=str, separators=(",", ":")))

    # ---------------------------------------------------------- exceptions

    def exception(self, exc: BaseException | None = None, where: str = "caught",
                  fields: Optional[Mapping[str, Any]] = None,
                  capture_locals: bool = False) -> None:
        """Log an exception with its traceback. `capture_locals` adds the
        local variables of each frame, which is the difference between
        knowing something failed and knowing why - at the cost of putting
        program state on the wire, so it is off by default and redacts
        secret-looking names when on."""
        if exc is None:
            exc = sys.exc_info()[1]
        if exc is None:
            return
        tb = exc.__traceback__
        out = dict(fields or {})
        out["where"] = where
        out["type"] = type(exc).__name__

        lines = traceback.format_exception(type(exc), exc, tb)
        text = "".join(lines).rstrip().split("\n")
        out["stack"] = "\n".join(text[:MAX_STACK_LINES])
        if len(text) > MAX_STACK_LINES:
            out["stack_truncated"] = "true"

        src = ""
        if tb is not None:
            frames = traceback.extract_tb(tb)
            if frames:
                last = frames[-1]
                src = "%s:%d" % (os.path.basename(last.filename), last.lineno)
            if capture_locals:
                out["locals"] = self._frame_locals(tb)

        self.log(Level.ERROR, "%s: %s: %s" % (where, type(exc).__name__, exc),
                 fields=out, tag="exception", src=src)
        self.flush()          # a crash may not survive to the next tick

    @staticmethod
    def _frame_locals(tb: Any, max_frames: int = 5, max_len: int = 200) -> str:
        """Locals from the deepest frames, which is where the answer usually
        is. Values are repr'd and truncated - a log line is not a debugger,
        and a 4MB dataframe repr helps nobody."""
        out = []
        frames = []
        while tb is not None:
            frames.append(tb.tb_frame)
            tb = tb.tb_next
        for frame in frames[-max_frames:]:
            items = []
            for k, v in list(frame.f_locals.items())[:20]:
                if k.startswith("__"):
                    continue
                if any(s in k.lower() for s in _SECRET_NAME):
                    items.append("%s=<redacted>" % k)
                    continue
                try:
                    r = repr(v)
                except Exception:
                    r = "<unreprable %s>" % type(v).__name__
                if len(r) > max_len:
                    r = r[:max_len] + "…"
                items.append("%s=%s" % (k, r))
            if items:
                out.append("%s(): %s" % (frame.f_code.co_name, ", ".join(items)))
        return "\n".join(out)

    def install_excepthook(self, capture_locals: bool = False) -> None:
        """Log every uncaught exception, in the main thread, in other
        threads, and in unraisable contexts - then chain to whatever was
        installed before, so the traceback still reaches stderr and the exit
        status is unchanged."""
        if self._excepthook_installed or not self.enabled:
            return
        self._excepthook_installed = True

        previous = sys.excepthook

        def hook(exc_type, exc, tb):
            try:
                exc.__traceback__ = tb
                self.exception(exc, where="uncaught", capture_locals=capture_locals)
            except Exception:
                pass                      # a logger must never eat the crash
            previous(exc_type, exc, tb)

        sys.excepthook = hook

        # Threads have their own hook since 3.8; without this, a crash in a
        # worker thread is invisible to sys.excepthook and to the bench.
        prev_thread = getattr(threading, "excepthook", None)
        if prev_thread is not None:
            def thook(a):
                try:
                    self.exception(a.exc_value, where="uncaught-thread",
                                   fields={"thread": getattr(a.thread, "name", "?")},
                                   capture_locals=capture_locals)
                except Exception:
                    pass
                prev_thread(a)
            threading.excepthook = thook

        # __del__ and GC-time failures land here and nowhere else.
        prev_unraisable = getattr(sys, "unraisablehook", None)
        if prev_unraisable is not None:
            def uhook(a):
                try:
                    self.exception(a.exc_value, where="unraisable",
                                   fields={"object": repr(a.object)[:200]})
                except Exception:
                    pass
                prev_unraisable(a)
            sys.unraisablehook = uhook

    # ------------------------------------------------------- correlation

    def set_trace(self, trace_id: Optional[str] = None) -> str:
        """Everything logged from here in this context carries this id."""
        tid = trace_id or new_trace_id()
        _current_trace.set(tid)
        return tid

    def clear_trace(self) -> None:
        _current_trace.set(None)

    def trace_id(self) -> Optional[str]:
        return _current_trace.get()

    def traced(self, trace_id: Optional[str] = None):
        """Context manager scoping a trace, restoring whatever was in force:

            with log.traced() as tid:
                log.info("user tapped Send")
                requests.post(url, headers={superlog.TRACE_HEADER: tid})

        ContextVars make this async- and thread-safe for free: a task
        started inside gets its own copy, so concurrent requests cannot
        borrow each other's id."""
        client = self

        class _Scope:
            def __enter__(self) -> str:
                self.tid = trace_id or new_trace_id()
                self.token = _current_trace.set(self.tid)
                return self.tid

            def __exit__(self, *exc: Any) -> bool:
                _current_trace.reset(self.token)
                return False
        return _Scope()

    # ------------------------------------------------- logging integration

    def handler(self, level: int = 0) -> Any:
        """A logging.Handler, so everything the program ALREADY logs reaches
        the bench without touching a single call site - the Python analogue
        of the spdlog sink and the tracing layer."""
        import logging

        client = self

        class SuperLogHandler(logging.Handler):
            def emit(self, record: "logging.LogRecord") -> None:
                try:
                    fields = {}
                    # Anything the caller passed via `extra=` is worth
                    # keeping; the standard attributes are not.
                    standard = logging.LogRecord("", 0, "", 0, "", (), None).__dict__
                    for k, v in record.__dict__.items():
                        if k not in standard and k not in ("message", "asctime"):
                            fields[k] = v
                    if record.exc_info and record.exc_info[1]:
                        exc = record.exc_info[1]
                        fields["type"] = type(exc).__name__
                        fields["stack"] = "".join(
                            traceback.format_exception(*record.exc_info)
                        ).rstrip()[:4000]
                    client.log(
                        _FROM_LOGGING.get(record.levelno, Level.INFO),
                        record.getMessage(),
                        fields=fields or None,
                        tag=record.name,
                        src="%s:%d" % (os.path.basename(record.pathname), record.lineno),
                    )
                except Exception:
                    self.handleError(record)

        h = SuperLogHandler()
        h.setLevel(level)
        return h

    # ------------------------------------------------------------ plumbing

    def _push(self, line: str) -> None:
        with self._wake:
            if len(self._q) == self._q.maxlen:
                self._dropped += 1          # the deque is about to drop one
            self._q.append(line)
            if len(self._q) >= self._max_batch:
                self._wake.notify()

    def _run(self) -> None:
        while True:
            with self._wake:
                if not self._stop and len(self._q) < self._max_batch:
                    self._wake.wait(self._flush_s)
                batch = [self._q.popleft() for _ in range(min(len(self._q), self._max_batch))]
                stopping = self._stop
            if batch:
                self._post("\n".join(batch))
            if stopping:
                with self._lock:
                    rest = list(self._q)
                    self._q.clear()
                if rest:
                    self._post("\n".join(rest))     # nothing queued is lost on exit
                return

    def _post(self, body: str) -> None:
        conn = None
        try:
            host = self._parsed.hostname or "127.0.0.1"
            port = self._parsed.port or (443 if self._parsed.scheme == "https" else 80)
            cls = (http.client.HTTPSConnection if self._parsed.scheme == "https"
                   else http.client.HTTPConnection)
            conn = cls(host, port, timeout=5)
            conn.request("POST", self._path, body=body.encode("utf-8"),
                         headers={"Content-Type": "application/x-ndjson"})
            conn.getresponse().read()
        except (OSError, socket.error, http.client.HTTPException):
            # The hub is down; count, do not retry. A retry queue grows
            # without bound on a process that outlives the bench.
            self._dropped += len(body.split("\n"))
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def flush(self, timeout: float = 2.0) -> None:
        """Send what is queued now. Called on a timer; call it before exit."""
        if not self.enabled:
            return
        deadline = time.monotonic() + timeout
        with self._wake:
            self._wake.notify()
        while time.monotonic() < deadline:
            with self._lock:
                if not self._q:
                    return
            time.sleep(0.02)

    def close(self) -> None:
        if not self.enabled or self._stop:
            return
        with self._wake:
            self._stop = True
            self._wake.notify_all()
        if self._worker is not None:
            self._worker.join(timeout=3.0)
