//! super-log Rust SDK
//!
//! Copyright 2026 Saxon Herschel Nicholls
//SPDX-License-Identifier: MIT
//!
//! Events go into a bounded channel from any thread; one worker drains them
//! into NDJSON chunks and POSTs each chunk to superlogd. Producers never
//! block on the network - `try_send` drops (counted) when the channel is
//! full, the same trade the C++ SDK and ts-moveables itself make.
//!
//! ```no_run
//! let log = super_log::SuperLog::new(super_log::Config {
//!     topic: "rust.pricer".into(),
//!     app: "pricer".into(),
//!     ..Default::default()
//! });
//! log.log(super_log::Level::Info, "engine up", None);
//!
//! // with `--features tracing-layer`, hang the same pipeline off tracing:
//! // tracing_subscriber::registry().with(log.layer()).init();
//! ```
//!
//! Enable exactly one of the `development` / `production` features -
//! neither or both is a compile error. Each mode ships what its policy
//! allows (`Config::dev_policy` / `Config::prod_policy`): development
//! defaults to everything, production to nothing - a production build
//! forwards logs only when a dev chose that on purpose, e.g.
//! `prod_policy: Policy::AtLeast(Level::Error)`. A policy of `Off` makes
//! the crate an inert shell (no worker, no serialisation, nothing on the
//! wire).
//!
//! Wire contract: ../../docs/PROTOCOL.md. Verified live against a hub by
//! `examples/clock.rs` (HANDOFF.md ledger).

// DEVELOPMENT xor PRODUCTION, enforced - the same rule as the C++ SDK's
// mode.hpp: a logging pipeline you *think* is off is worse than one that
// will not build until you decide.
#[cfg(all(feature = "development", feature = "production"))]
compile_error!(
    "super-log: features `development` and `production` are both enabled - enable exactly one"
);
#[cfg(not(any(feature = "development", feature = "production")))]
compile_error!(
    "super-log: enable exactly one of the `development` / `production` features (the bench wants --features development)"
);

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub topic: String,
    pub app: String,
    pub device: String,
    pub flush_ms: u64,
    pub max_batch: usize,
    pub max_queue: usize,
    /// What DEVELOPMENT builds forward. Default: everything.
    pub dev_policy: Policy,
    /// What PRODUCTION builds forward. Default: nothing - log lines leaving
    /// a production box are a security decision, so loosen this
    /// deliberately (e.g. `Policy::AtLeast(Level::Error)`), never by default.
    pub prod_policy: Policy,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            host: "127.0.0.1".into(),
            port: 7333,
            topic: "rust.app".into(),
            app: "app".into(),
            device: String::new(),
            flush_ms: 250,
            max_batch: 256,
            max_queue: 8192,
            dev_policy: Policy::All,
            prod_policy: Policy::Off,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Critical,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
            Level::Critical => "CRITICAL",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Level::Trace => 1,
            Level::Debug => 2,
            Level::Info => 3,
            Level::Warn => 4,
            Level::Error => 5,
            Level::Critical => 6,
        }
    }
}

/// What a mode ships: everything, only `level` and up, or nothing at all.
/// The active build mode picks `Config::dev_policy` or `Config::prod_policy`;
/// a below-policy event costs one compare - not serialised, not queued.
/// Metrics ride at INFO, so a policy above INFO drops them too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    All,
    AtLeast(Level),
    Off,
}

impl Policy {
    fn min_rank(self) -> u8 {
        match self {
            Policy::All => 1,
            Policy::AtLeast(l) => l.rank(),
            Policy::Off => 7,
        }
    }
}

const OFF_RANK: u8 = 7;

struct Shared {
    cfg: Config,
    session: String,
    seq: AtomicU64,
    dropped: AtomicU64,
    tx: SyncSender<String>,
    min_rank: u8, // the active mode's policy, resolved once at construction
}

/// Cheap to clone; all clones share one worker.
#[derive(Clone)]
pub struct SuperLog {
    s: Arc<Shared>,
}

impl SuperLog {
    pub fn new(cfg: Config) -> Self {
        let (tx, rx) = sync_channel::<String>(cfg.max_queue);
        let path = format!("/ingest/{}", cfg.topic);
        let host = cfg.host.clone();
        let port = cfg.port;
        let flush = Duration::from_millis(cfg.flush_ms);
        let max_batch = cfg.max_batch;

        // The build mode picks its policy; the worker exists only when
        // something can ship. cfg! not #[cfg]: both modes stay compiled and
        // borrow-checked, the dead branch just never runs and folds away.
        let active = if cfg!(feature = "development") {
            cfg.dev_policy
        } else {
            cfg.prod_policy
        };
        let min_rank = active.min_rank();
        if min_rank < OFF_RANK {
            std::thread::spawn(move || {
                let mut batch = String::new();
                let mut n = 0usize;
                loop {
                    match rx.recv_timeout(flush) {
                        Ok(line) => {
                            batch.push_str(&line);
                            batch.push('\n');
                            n += 1;
                            if n < max_batch {
                                continue;
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => {
                            // Final flush: nothing queued is lost on exit
                            if !batch.is_empty() {
                                let _ = http_post(&host, port, &path, &batch);
                            }
                            return;
                        }
                    }
                    if !batch.is_empty() {
                        let _ = http_post(&host, port, &path, &batch);
                        batch.clear();
                        n = 0;
                    }
                }
            });
        }

        let session = session_id();
        SuperLog {
            s: Arc::new(Shared {
                cfg,
                session,
                seq: AtomicU64::new(0),
                dropped: AtomicU64::new(0),
                tx,
                min_rank,
            }),
        }
    }

    /// Any thread; never blocks on the network. `fields` are structured
    /// extras per PROTOCOL.md.
    pub fn log(&self, level: Level, msg: &str, fields: Option<&[(&str, &str)]>) {
        self.emit(level, msg, fields, None)
    }

    pub fn metric(&self, name: &str, value: f64) {
        self.emit(Level::Info, name, None, Some(value))
    }

    pub fn dropped(&self) -> u64 {
        self.s.dropped.load(Ordering::Relaxed)
    }

    /// Log every panic, with its location, then let the previous hook run -
    /// so the usual message still reaches stderr and any handler already
    /// installed still fires. Call once at startup:
    ///
    /// ```no_run
    /// # let log = super_log::SuperLog::new(Default::default());
    /// log.install_panic_hook();
    /// ```
    ///
    /// A panic normally unwinds rather than exiting immediately, so the
    /// worker gets its chance to POST; on `panic = "abort"` the process
    /// dies at once and the last batch may not make it - the hook flushes
    /// what it can, which is the same trade every crash reporter makes.
    pub fn install_panic_hook(&self) {
        let log = self.clone();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // The payload is &str or String for the ordinary panic!/expect
            // paths; anything else only has its Display via the hook.
            let msg = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".to_string());
            let loc = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_default();
            let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
            // Blocking, not queued: this thread is unwinding and will not
            // be here for the worker's next tick.
            log.emit_blocking(
                Level::Critical,
                &format!("panic: {msg}"),
                Some(&[("where", "panic"), ("src", loc.as_str()), ("thread", thread.as_str())]),
            );
            previous(info);
        }));
    }

    /// Serialise and POST one event from THIS thread, bypassing the worker.
    /// For the dying process: a panicking thread does not survive to the
    /// worker's next tick, so queueing the event loses it (measured).
    fn emit_blocking(&self, level: Level, msg: &str, fields: Option<&[(&str, &str)]>) {
        if level.rank() < self.s.min_rank {
            return;
        }
        let mut body = self.build_event(level, msg, fields, None);
        body.push('\n');
        let path = format!("/ingest/{}", self.s.cfg.topic);
        let _ = http_post(&self.s.cfg.host, self.s.cfg.port, &path, &body);
    }

    fn emit(&self, level: Level, msg: &str, fields: Option<&[(&str, &str)]>, metric: Option<f64>) {
        if level.rank() < self.s.min_rank {
            return; // below this mode's policy: not even serialised
        }
        let j = self.build_event(level, msg, fields, metric);
        if self.s.tx.try_send(j).is_err() {
            self.s.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn build_event(
        &self,
        level: Level,
        msg: &str,
        fields: Option<&[(&str, &str)]>,
        metric: Option<f64>,
    ) -> String {
        let s = &self.s;
        let seq = s.seq.fetch_add(1, Ordering::Relaxed);
        let mut j = String::with_capacity(160 + msg.len());
        j.push_str("{\"v\":1,\"ts\":\"");
        j.push_str(&iso8601_now());
        j.push_str("\",\"seq\":");
        j.push_str(&seq.to_string());
        j.push_str(",\"session\":\"");
        j.push_str(&s.session);
        j.push_str("\",\"level\":\"");
        j.push_str(level.as_str());
        j.push_str("\",\"origin\":{\"runtime\":\"rust\",\"app\":\"");
        escape(&s.cfg.app, &mut j);
        j.push_str("\",\"platform\":\"");
        j.push_str(platform());
        j.push('"');
        if !s.cfg.device.is_empty() {
            j.push_str(",\"device\":\"");
            escape(&s.cfg.device, &mut j);
            j.push('"');
        }
        j.push_str("},\"msg\":\"");
        escape(msg, &mut j);
        j.push('"');
        if let Some(v) = metric {
            j.push_str(",\"metric\":{\"name\":\"");
            escape(msg, &mut j);
            j.push_str("\",\"value\":");
            j.push_str(&format!("{v}"));
            j.push('}');
        }
        if let Some(fs) = fields {
            j.push_str(",\"fields\":{");
            for (i, (k, v)) in fs.iter().enumerate() {
                if i > 0 {
                    j.push(',');
                }
                j.push('"');
                escape(k, &mut j);
                j.push_str("\":\"");
                escape(v, &mut j);
                j.push('"');
            }
            j.push('}');
        }
        j.push('}');
        j
    }
}

/// The `tracing` bridge - the reason most Rust code needs no changes at all.
#[cfg(feature = "tracing-layer")]
mod layer {
    use super::{Level, SuperLog};
    use tracing::field::{Field, Visit};
    use tracing_subscriber::layer::Context;
    use tracing_subscriber::Layer;

    pub struct SuperLogLayer {
        log: SuperLog,
    }

    impl SuperLog {
        pub fn layer(&self) -> SuperLogLayer {
            SuperLogLayer { log: self.clone() }
        }
    }

    struct MessageVisitor {
        message: String,
        fields: Vec<(String, String)>,
    }

    impl Visit for MessageVisitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            if field.name() == "message" {
                self.message = format!("{value:?}");
            } else {
                self.fields
                    .push((field.name().to_string(), format!("{value:?}")));
            }
        }
    }

    impl<S: tracing::Subscriber> Layer<S> for SuperLogLayer {
        fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
            let mut v = MessageVisitor {
                message: String::new(),
                fields: Vec::new(),
            };
            event.record(&mut v);
            let level = match *event.metadata().level() {
                tracing::Level::TRACE => Level::Trace,
                tracing::Level::DEBUG => Level::Debug,
                tracing::Level::INFO => Level::Info,
                tracing::Level::WARN => Level::Warn,
                tracing::Level::ERROR => Level::Error,
            };
            let fields: Vec<(&str, &str)> = v
                .fields
                .iter()
                .map(|(k, val)| (k.as_str(), val.as_str()))
                .collect();
            // TODO(M2): carry event.metadata().target() as `tag` and
            // file:line as `src` - needs a richer emit() signature.
            self.log.log(
                level,
                &v.message,
                if fields.is_empty() {
                    None
                } else {
                    Some(&fields)
                },
            );
        }
    }
}

#[cfg(feature = "tracing-layer")]
pub use layer::SuperLogLayer;

// ---------------------------------------------------------------- plumbing

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "linux"
    }
}

fn session_id() -> String {
    // Random enough for a per-run id without pulling a crates.io RNG:
    // address-space entropy XOR nanosecond clock.
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;
    let a = &t as *const _ as u64;
    format!("{:016x}", (a.rotate_left(32) ^ t) | 1)
}

/// Just enough escaping for a JSON string - the same set as
/// snicholls::utils::json_escape, kept in sync by PROTOCOL.md.
fn escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}

/// ISO-8601 UTC from the system clock. Days-from-epoch to civil date is the
/// standard Howard Hinnant algorithm.
fn iso8601_now() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() as i64;
    let nanos = d.subsec_nanos();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{nanos:09}Z")
}

/// One POST, one connection - mirrors the C++ SDK's transport, and swaps for
/// a streaming socket when the hub grows WS ingest (HANDOFF.md, M5).
fn http_post(host: &str, port: u16, path: &str, body: &str) -> std::io::Result<()> {
    let mut stream = TcpStream::connect((host, port))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes())?;
    let mut buf = [0u8; 64];
    let _ = stream.read(&mut buf);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_matches_protocol() {
        let mut out = String::new();
        escape("a\"b\\c\nd\x01", &mut out);
        assert_eq!(out, "a\\\"b\\\\c\\nd\\u0001");
    }

    #[test]
    fn policy_ranks_order() {
        assert_eq!(Policy::All.min_rank(), Level::Trace.rank());
        assert_eq!(
            Policy::AtLeast(Level::Error).min_rank(),
            Level::Error.rank()
        );
        assert!(Level::Critical.rank() < Policy::Off.min_rank());
        // ERROR policy: ships error+critical, drops warn and below
        let min = Policy::AtLeast(Level::Error).min_rank();
        assert!(Level::Error.rank() >= min && Level::Critical.rank() >= min);
        assert!(Level::Warn.rank() < min && Level::Info.rank() < min);
    }

    #[test]
    fn iso8601_shape() {
        let ts = iso8601_now();
        assert_eq!(ts.len(), 30);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }
}
