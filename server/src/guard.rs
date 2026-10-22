//! Cheap safeguards for a single-user PoC exposed on a LAN / tunnel:
//! an in-memory per-minute limiter for `/api/extract`, optional HTTP Basic
//! auth for the whole app, and the env-driven limits they read.
//!
//! The per-day cap and the pause switch are persisted in the `settings`
//! table (see `repo::extraction_usage`) so they survive restarts.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

const WINDOW: Duration = Duration::from_secs(60);

/// Limits for the extraction endpoint. `0` disables the respective limit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    pub extract_per_minute: u32,
    pub extract_per_day: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { extract_per_minute: 6, extract_per_day: 60 }
    }
}

impl Limits {
    /// `FISZKI_EXTRACT_PER_MINUTE` / `FISZKI_EXTRACT_DAILY_CAP`; unparsable values fall back to defaults.
    pub fn from_env() -> Self {
        let d = Limits::default();
        Limits {
            extract_per_minute: env_num("FISZKI_EXTRACT_PER_MINUTE").unwrap_or(d.extract_per_minute),
            extract_per_day: env_num("FISZKI_EXTRACT_DAILY_CAP").unwrap_or(d.extract_per_day),
        }
    }
}

fn env_num<T: std::str::FromStr>(key: &str) -> Option<T> {
    std::env::var(key).ok().and_then(|v| v.trim().parse().ok())
}

/// Sliding-window limiter: at most `max` events per 60 s.
#[derive(Clone)]
pub struct RateLimiter {
    max: u32,
    hits: Arc<Mutex<VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn new(max_per_minute: u32) -> Self {
        RateLimiter { max: max_per_minute, hits: Arc::new(Mutex::new(VecDeque::new())) }
    }

    /// Consume one slot. `Err(secs)` tells the caller how long to wait.
    pub fn check(&self) -> Result<(), u64> {
        self.check_at(Instant::now())
    }

    fn check_at(&self, now: Instant) -> Result<(), u64> {
        if self.max == 0 {
            return Ok(());
        }
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        while hits.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            hits.pop_front();
        }
        if hits.len() >= self.max as usize {
            let oldest = *hits.front().expect("non-empty");
            let wait = WINDOW.saturating_sub(now.duration_since(oldest));
            return Err(wait.as_secs().max(1));
        }
        hits.push_back(now);
        Ok(())
    }
}

// ----- HTTP Basic auth --------------------------------------------------------

/// Parse `FISZKI_BASIC_AUTH=user:password` into the exact `Authorization`
/// header value we expect from the browser.
pub fn basic_auth_from_env_value(v: &str) -> Result<String> {
    let (user, pass) = v.split_once(':').ok_or_else(|| anyhow!("FISZKI_BASIC_AUTH must look like user:password"))?;
    if user.trim().is_empty() || pass.is_empty() {
        return Err(anyhow!("FISZKI_BASIC_AUTH: user and password must not be empty"));
    }
    if pass.len() < 8 {
        return Err(anyhow!("FISZKI_BASIC_AUTH: password must be at least 8 characters"));
    }
    Ok(format!("Basic {}", base64(format!("{user}:{pass}").as_bytes())))
}

/// Middleware: reject every request (except `/api/health`) that does not
/// carry the expected `Authorization: Basic …` header.
pub async fn require_basic_auth(State(expected): State<Arc<str>>, req: Request, next: Next) -> Response {
    if req.uri().path() == "/api/health" {
        return next.run(req).await;
    }
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| constant_time_eq(h.trim().as_bytes(), expected.as_bytes()));
    if ok {
        return next.run(req).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Basic realm=\"Fiszki\", charset=\"UTF-8\"")],
        Json(json!({ "error": "unauthorized", "message": "authentication required" })),
    )
        .into_response()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Standard base64 (with padding). Tiny on purpose – avoids a dependency.
fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_allows_up_to_max_then_blocks_until_window_passes() {
        let l = RateLimiter::new(2);
        let t0 = Instant::now();
        assert!(l.check_at(t0).is_ok());
        assert!(l.check_at(t0 + Duration::from_secs(1)).is_ok());
        let wait = l.check_at(t0 + Duration::from_secs(2)).unwrap_err();
        assert!((57..=58).contains(&wait), "{wait}");
        // Oldest hit expires after 60 s.
        assert!(l.check_at(t0 + Duration::from_secs(60)).is_ok());
        assert!(l.check_at(t0 + Duration::from_secs(60)).is_err());
    }

    #[test]
    fn limiter_zero_means_unlimited() {
        let l = RateLimiter::new(0);
        let t0 = Instant::now();
        for _ in 0..100 {
            assert!(l.check_at(t0).is_ok());
        }
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64("zażółć:gęślą".as_bytes()), "emHFvMOzxYLEhzpnxJnFm2zEhQ==");
    }

    #[test]
    fn basic_auth_env_parsing() {
        assert_eq!(basic_auth_from_env_value("user:password1").unwrap(), "Basic dXNlcjpwYXNzd29yZDE=");
        // Password may itself contain ':'.
        assert_eq!(basic_auth_from_env_value("u:p:a:s:s:w:o:r:d").unwrap(), format!("Basic {}", base64(b"u:p:a:s:s:w:o:r:d")));
        assert!(basic_auth_from_env_value("nocolon").is_err());
        assert!(basic_auth_from_env_value(":password1").is_err());
        assert!(basic_auth_from_env_value("user:").is_err());
        assert!(basic_auth_from_env_value("user:short").is_err());
    }

    #[test]
    fn limits_default_and_env_override() {
        let d = Limits::default();
        assert!(d.extract_per_minute > 0 && d.extract_per_day > 0);
        // from_env must never panic on garbage.
        std::env::set_var("FISZKI_EXTRACT_PER_MINUTE", "lots");
        std::env::set_var("FISZKI_EXTRACT_DAILY_CAP", " 12 ");
        let l = Limits::from_env();
        assert_eq!(l.extract_per_minute, d.extract_per_minute);
        assert_eq!(l.extract_per_day, 12);
        std::env::remove_var("FISZKI_EXTRACT_PER_MINUTE");
        std::env::remove_var("FISZKI_EXTRACT_DAILY_CAP");
    }
}
