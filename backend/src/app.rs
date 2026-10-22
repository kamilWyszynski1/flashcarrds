//! Router assembly and shared application state.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{extract::DefaultBodyLimit, middleware, Router};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use crate::db::Db;
use crate::gemini::{GeminiClient, MAX_REQUEST_BYTES};
use crate::guard::{self, Limits, RateLimiter};
use crate::routes;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub gemini: GeminiClient,
    /// Fallback API key from the environment (the one stored in Settings wins).
    pub env_api_key: Option<String>,
    pub limits: Limits,
    pub extract_limiter: RateLimiter,
    /// Expected `Authorization` header value (`Basic …`); `None` = no auth.
    pub basic_auth: Option<String>,
}

impl AppState {
    pub fn new(db: Db, gemini: GeminiClient, env_api_key: Option<String>, limits: Limits, basic_auth: Option<String>) -> Self {
        AppState { db, gemini, env_api_key, limits, extract_limiter: RateLimiter::new(limits.extract_per_minute), basic_auth }
    }
}

/// Build the full application: `/api/*` plus the static PWA with SPA fallback.
pub fn build_app(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let api = routes::api_router().layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES));
    let mut app = Router::new().nest("/api", api);
    if let Some(dir) = static_dir {
        let index = dir.join("index.html");
        if index.exists() {
            app = app.fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(index)));
        } else {
            tracing::warn!(dir = %dir.display(), "static dir has no index.html – frontend not built? (cd frontend && npm run build)");
        }
    }
    let basic_auth = state.basic_auth.clone();
    let mut app = app.with_state(state);
    if let Some(expected) = basic_auth {
        let expected: Arc<str> = Arc::from(expected);
        app = app.layer(middleware::from_fn_with_state(expected, guard::require_basic_auth));
    }
    app.layer(TraceLayer::new_for_http())
}
