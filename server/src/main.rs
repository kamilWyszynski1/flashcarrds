//! Fiszki server binary.
//!
//! Configuration (environment variables, `.env` is loaded if present):
//!   FISZKI_ADDR                listen address            (default 0.0.0.0:8080)
//!   FISZKI_DB                  SQLite file               (default ./data/fiszki.db)
//!   FISZKI_STATIC              built frontend directory  (default ../frontend/dist, then ./frontend/dist)
//!   FISZKI_BASIC_AUTH          user:password – protect the whole app with HTTP Basic auth (off by default)
//!   FISZKI_EXTRACT_DAILY_CAP   max /api/extract calls per local day (default 60, 0 = unlimited)
//!   FISZKI_EXTRACT_PER_MINUTE  max /api/extract calls per minute   (default 6, 0 = unlimited)
//!   GEMINI_API_KEY             the Gemini API key (required for photo extraction; never stored, not settable from the app)
//!   FISZKI_GEMINI_MODEL        model id                  (default gemini-flash-latest; not settable from the app)
//!   FISZKI_GEMINI_TIMEOUT_SECS per-attempt upstream timeout (default 30)
//!   GEMINI_BASE_URL            override Gemini endpoint (tests / proxies)
//!   RUST_LOG                   tracing filter            (default info)

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use fiszki_server::app::{build_app, AppState};
use fiszki_server::db;
use fiszki_server::gemini::{GeminiClient, GeminiConfig, DEFAULT_TIMEOUT};
use fiszki_server::guard::{self, Limits};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=info")))
        .init();

    let addr: SocketAddr = std::env::var("FISZKI_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()
        .context("FISZKI_ADDR must be host:port")?;
    let db_path = PathBuf::from(std::env::var("FISZKI_DB").unwrap_or_else(|_| "./data/fiszki.db".into()));
    let static_dir = resolve_static_dir();

    let basic_auth = match std::env::var("FISZKI_BASIC_AUTH") {
        Ok(v) if !v.trim().is_empty() => Some(guard::basic_auth_from_env_value(v.trim())?),
        _ => None,
    };
    let limits = Limits::from_env();
    let gemini_config = GeminiConfig::from_env()?;
    let gemini_timeout = match std::env::var("FISZKI_GEMINI_TIMEOUT_SECS") {
        Ok(v) if !v.trim().is_empty() => Duration::from_secs(
            v.trim().parse::<u64>().context("FISZKI_GEMINI_TIMEOUT_SECS must be a number of seconds")?.clamp(5, 300),
        ),
        _ => DEFAULT_TIMEOUT,
    };

    let conn = db::open(Some(&db_path))?;
    tracing::info!(db = %db_path.display(), "database ready");

    let state = AppState::new(
        db::shared(conn),
        GeminiClient::with_timeout(std::env::var("GEMINI_BASE_URL").ok(), gemini_timeout),
        gemini_config.clone(),
        limits,
        basic_auth.clone(),
    );
    let app = build_app(state, static_dir.clone());

    if basic_auth.is_some() {
        tracing::info!("HTTP Basic auth enabled (FISZKI_BASIC_AUTH)");
    } else if !addr.ip().is_loopback() {
        tracing::warn!("no FISZKI_BASIC_AUTH set – anyone who can reach {addr} can use your Gemini key; set it before exposing the port");
    }
    tracing::info!(per_minute = limits.extract_per_minute, per_day = limits.extract_per_day, "extraction limits (0 = unlimited)");
    if gemini_config.api_key.is_some() {
        tracing::info!(model = %gemini_config.model, timeout_secs = gemini_timeout.as_secs(), "Gemini configured (key from GEMINI_API_KEY)");
    } else {
        tracing::warn!(model = %gemini_config.model, "GEMINI_API_KEY not set – photo extraction is disabled");
    }

    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| format!("binding {addr}"))?;
    tracing::info!(%addr, static_dir = ?static_dir, "Fiszki listening – open http://localhost:{}/", addr.port());
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

fn resolve_static_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FISZKI_STATIC") {
        return Some(PathBuf::from(p));
    }
    let candidates = [
        PathBuf::from("../frontend/dist"),
        PathBuf::from("frontend/dist"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../frontend/dist"),
    ];
    candidates.into_iter().find(|p| p.join("index.html").exists()).or_else(|| Some(PathBuf::from("../frontend/dist")))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
