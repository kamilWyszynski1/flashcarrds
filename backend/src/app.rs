//! Router assembly and shared application state.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{extract::DefaultBodyLimit, middleware, Router};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use crate::db::Db;
use crate::error;
use crate::gemini::{GeminiClient, GeminiConfig, MAX_REQUEST_BYTES};
use crate::guard::{self, Limits, RateLimiter};
use crate::routes;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub gemini: GeminiClient,
    /// API key and model – environment only, never stored or editable via the API.
    pub gemini_config: GeminiConfig,
    pub limits: Limits,
    pub extract_limiter: RateLimiter,
    /// Expected `Authorization` header value (`Basic …`); `None` = no auth.
    pub basic_auth: Option<String>,
}

impl AppState {
    pub fn new(db: Db, gemini: GeminiClient, gemini_config: GeminiConfig, limits: Limits, basic_auth: Option<String>) -> Self {
        AppState { db, gemini, gemini_config, limits, extract_limiter: RateLimiter::new(limits.extract_per_minute), basic_auth }
    }
}

/// Build the full application: `/api/*` plus the static PWA with SPA fallback.
pub fn build_app(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let api = routes::api_router().fallback(error::api_not_found).layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES));
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
    // Outermost after tracing: anything non-2xx that did not come from an
    // `AppError` (auth 401, 404, extractor rejections) still gets our own log
    // line, so `tower_http`'s `on_failure` is never the only evidence.
    app.layer(middleware::from_fn(error::log_failures)).layer(TraceLayer::new_for_http())
}
