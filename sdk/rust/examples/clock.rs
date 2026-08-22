//! The Rust demo client: the wall clock once a second, topic `rust.clock`,
//! via `SuperLog::log` with a structured field, plus an uptime metric every
//! fifth tick so the metric path is on screen too.
//!
//! With the hub up:  cargo run --release --features development --example clock

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super_log::{Config, Level, SuperLog};

// UTC in every demo client - std alone cannot know the local timezone, and
// four streams that agree on UTC beat three local ones and this one not.
fn hms_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let sod = secs % 86_400;
    format!("{:02}:{:02}:{:02}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

fn main() {
    let mut cfg = Config {
        topic: "rust.clock".into(),
        app: "clock".into(),
        ..Default::default()
    };
    if let Ok(h) = std::env::var("SUPER_LOG_HOST") {
        cfg.host = h;
    }
    if let Ok(p) = std::env::var("SUPER_LOG_PORT").map(|p| p.parse()) {
        if let Ok(p) = p {
            cfg.port = p;
        }
    }
    let log = SuperLog::new(cfg);

    log.log(Level::Info, "rust clock up - one line a second", None);
    let mut n: u64 = 0;
    loop {
        n += 1;
        let tick = n.to_string();
        log.log(
            Level::Info,
            &format!("tick {n} - the time is {}", hms_utc()),
            Some(&[("tick", tick.as_str())]),
        );
        if n % 5 == 0 {
            log.metric("clock.uptime_s", n as f64);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}
