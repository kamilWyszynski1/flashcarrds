//! Application errors mapped to HTTP responses.
//!
//! Every non-2xx response is logged here, with the full error chain
//! (`{:#}` – context lines joined by ": "), *before* the response is built, so
//! the generic `tower_http` `on_failure` line is never the only evidence.

use std::time::Instant;

use axum::{
    extract::{rejection::JsonRejection, FromRequest, Request},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::de::DeserializeOwned;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    BadRequest(String),
    /// Request body over `MAX_REQUEST_BYTES` (413; reported as `bad_request`
    /// to the client, which only needs the message).
    #[error("{0}")]
    PayloadTooLarge(String),
    /// Something we depend on (Gemini) failed. The chain is user-safe: it is
    /// built from [`crate::gemini::GeminiError`] plus request context (model,
    /// image count / sizes, latency) and never contains the key.
    #[error("{0:#}")]
    Upstream(anyhow::Error),
    /// Per-minute / per-day extraction limit hit.
    #[error("{0}")]
    TooManyRequests(String),
    /// Extraction switched off in Settings.
    #[error("{0}")]
    Paused(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("not found".into()),
            other => AppError::Internal(other.into()),
        }
    }
}

/// `Display` of `e` followed by each `source()`, joined by ": " – the same
/// shape as anyhow's `{:#}`, for errors that are not `anyhow::Error`.
pub fn chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(src) = cur {
        s.push_str(": ");
        s.push_str(&src.to_string());
        cur = src.source();
    }
    s
}

/// Marker extension: this response was already logged by [`AppError`]; the
/// [`log_failures`] middleware skips it.
#[derive(Clone, Copy, Debug)]
pub struct Logged;

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, kind) = match &self {
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::PayloadTooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, "bad_request"),
            AppError::Upstream(_) => (StatusCode::BAD_GATEWAY, "upstream"),
            AppError::TooManyRequests(_) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            AppError::Paused(_) => (StatusCode::CONFLICT, "paused"),
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        // Full chain for the log; the client gets the same text except for
        // internal errors, whose details stay on the server.
        let detail = match &self {
            AppError::Internal(e) | AppError::Upstream(e) => format!("{e:#}"),
            other => other.to_string(),
        };
        match &self {
            AppError::Internal(e) => tracing::error!(status = status.as_u16(), kind, error = %detail, debug = ?e, "request failed"),
            AppError::Upstream(_) => tracing::error!(status = status.as_u16(), kind, error = %detail, "request failed"),
            _ => tracing::warn!(status = status.as_u16(), kind, error = %detail, "request rejected"),
        }
        let message = match &self {
            AppError::Internal(_) => "internal server error".to_string(),
            _ => detail,
        };
        let mut resp = (status, axum::Json(json!({ "error": kind, "message": message }))).into_response();
        resp.extensions_mut().insert(Logged);
        resp
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// `axum::Json` for request bodies, with the rejection mapped to [`AppError`]
/// so a malformed body, a missing `content-type` or a body over the limit is
/// (a) logged like every other failure and (b) returned in our JSON error
/// shape instead of axum's plain text. Use `axum::Json` for responses.
pub struct Json<T>(pub T);

impl<T, S> FromRequest<S> for Json<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(v)) => Ok(Json(v)),
            Err(rej) => Err(json_rejection(rej)),
        }
    }
}

fn json_rejection(rej: JsonRejection) -> AppError {
    // `body_text()` is axum's one-line description and already includes the
    // serde error; walking `source()` as well would repeat it.
    match rej {
        JsonRejection::MissingJsonContentType(_) => AppError::BadRequest("request body must be JSON (send `content-type: application/json`)".into()),
        JsonRejection::JsonSyntaxError(e) => AppError::BadRequest(format!("request body is not valid JSON: {}", e.body_text())),
        JsonRejection::JsonDataError(e) => AppError::BadRequest(format!("request body has the wrong shape: {}", e.body_text())),
        JsonRejection::BytesRejection(e) => {
            // `LengthLimitError` is wrapped in a `BytesRejection::FailedToBufferBody`.
            let text = chain(&e);
            if text.contains("length limit") {
                AppError::PayloadTooLarge(format!("request body is too large (max {} MB); send fewer or smaller images", crate::gemini::MAX_REQUEST_BYTES / 1024 / 1024))
            } else {
                AppError::BadRequest(format!("could not read request body: {}", e.body_text()))
            }
        }
        other => AppError::BadRequest(format!("bad request: {}", other.body_text())),
    }
}

/// Fallback for `/api/*` paths that match no route: a JSON 404 (logged like
/// every other `AppError`) instead of the SPA's `index.html` with a 200.
pub async fn api_not_found(method: axum::http::Method, axum::extract::OriginalUri(uri): axum::extract::OriginalUri) -> AppError {
    AppError::NotFound(format!("no API route for {method} {}", uri.path()))
}

/// Middleware: log every non-2xx/3xx response that did not come from
/// [`AppError`] (Basic-auth 401, unknown `/api` route, `Path`/`Query`
/// rejections, …). `/api` failures are `warn`, everything else (static files)
/// is `debug`.
pub async fn log_failures(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let started = Instant::now();
    let resp = next.run(req).await;
    let status = resp.status();
    if (status.is_client_error() || status.is_server_error()) && resp.extensions().get::<Logged>().is_none() {
        let latency_ms = started.elapsed().as_millis() as u64;
        if status.is_server_error() {
            tracing::error!(%method, %path, status = status.as_u16(), latency_ms, "request failed (no handler error attached)");
        } else if path.starts_with("/api/") {
            tracing::warn!(%method, %path, status = status.as_u16(), latency_ms, "request rejected (before the handler)");
        } else {
            tracing::debug!(%method, %path, status = status.as_u16(), latency_ms, "static request failed");
        }
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_joins_sources_like_anyhow_alternate() {
        let io = std::io::Error::new(std::io::ErrorKind::TimedOut, "operation timed out");
        let e: anyhow::Error = anyhow::Error::new(io).context("sending request").context("extraction failed");
        assert_eq!(format!("{e:#}"), "extraction failed: sending request: operation timed out");
        assert_eq!(chain(e.as_ref()), "extraction failed: sending request: operation timed out");
        let plain = std::io::Error::other("boom");
        assert_eq!(chain(&plain), "boom");
    }

    #[test]
    fn upstream_display_is_full_chain() {
        let e = AppError::Upstream(anyhow::anyhow!("HTTP 503 UNAVAILABLE: high demand").context("Gemini extraction failed (model=x)"));
        assert_eq!(e.to_string(), "Gemini extraction failed (model=x): HTTP 503 UNAVAILABLE: high demand");
    }
}
