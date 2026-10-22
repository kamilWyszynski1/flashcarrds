//! Fiszki server binary.
//!
//! Configuration (environment variables, `.env` is loaded if present):
//!   FISZKI_ADDR                listen address            (default 0.0.0.0:8080)
//!   FISZKI_DB                  SQLite file               (default ./data/fiszki.db)
//!   FISZKI_STATIC              built frontend directory  (default ../frontend/dist, then ./frontend/dist)
//!   FISZKI_BASIC_AUTH          user:password – protect the whole app with HTTP Basic auth (off by default)
//!   FISZKI_EXTRACT_DAILY_CAP   max /api/extract calls per local day (default 60, 0 = unlimited)
//!   FISZKI_EXTRACT_PER_MINUTE  max /api/extract calls per minute   (default 6, 0 = unlimited)
//!   GEMINI_API_KEY             fallback API key (Settings screen value takes precedence)
//!   GEMINI_BASE_URL            override Gemini endpoint (tests / proxies)
//!   RUST_LOG                   tracing filter            (default info)

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use fiszki_server::app::{build_app, AppState};
use fiszki_server::db;
use fiszki_server::gemini::GeminiClient;
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

    let conn = db::open(Some(&db_path))?;
    tracing::info!(db = %db_path.display(), "database ready");

    let state = AppState::new(
        db::shared(conn),
        GeminiClient::new(std::env::var("GEMINI_BASE_URL").ok()),
        std::env::var("GEMINI_API_KEY").ok().filter(|k| !k.trim().is_empty()),
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
