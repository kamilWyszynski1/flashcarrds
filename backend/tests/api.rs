//! End-to-end API tests: a real router over an in-memory SQLite database, and
//! a fake Gemini server for the extraction endpoint.

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use fiszki_server::app::{build_app, AppState};
use fiszki_server::db;
use fiszki_server::gemini::GeminiClient;
use fiszki_server::guard::Limits;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const UNLIMITED: Limits = Limits { extract_per_minute: 0, extract_per_day: 0 };

fn app_full(base_url: Option<String>, env_key: Option<&str>, limits: Limits, basic_auth: Option<String>) -> Router {
    let conn = db::open(None).unwrap();
    let state = AppState::new(db::shared(conn), GeminiClient::new(base_url), env_key.map(String::from), limits, basic_auth);
    build_app(state, None)
}

fn app_with(base_url: Option<String>, env_key: Option<&str>) -> Router {
    app_full(base_url, env_key, UNLIMITED, None)
}

fn app() -> Router {
    app_with(None, None)
}

async fn call(app: &Router, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    let req = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            req.body(Body::from(serde_json::to_vec(&b).unwrap())).unwrap()
        }
        None => req.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into())) };
    (status, v)
}

async fn seed(app: &Router) -> (i64, i64) {
    let (s, u) = call(app, "POST", "/api/units", Some(json!({"name": "Unidad 3 · ¿Dónde está Santiago?"}))).await;
    assert_eq!(s, StatusCode::CREATED, "{u}");
    let unit_id = u["id"].as_i64().unwrap();
    let (s, l) = call(app, "POST", "/api/lessons", Some(json!({"unit_id": unit_id, "name": "3.1 La ciudad"}))).await;
    assert_eq!(s, StatusCode::CREATED, "{l}");
    (unit_id, l["id"].as_i64().unwrap())
}

#[tokio::test]
async fn health_and_empty_overview() {
    let app = app();
    let (s, v) = call(&app, "GET", "/api/health", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["ok"], true);
    let (s, v) = call(&app, "GET", "/api/overview", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["total"], 0);
    assert_eq!(v["units"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn groups_cards_and_overview_flow() {
    let app = app();
    let (unit_id, lesson_id) = seed(&app).await;

    // Validation errors are 400 with a message.
    let (s, v) = call(&app, "POST", "/api/units", Some(json!({"name": "  "}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(v["message"].as_str().unwrap().contains("empty"));
    let (s, _) = call(&app, "POST", "/api/lessons", Some(json!({"unit_id": 999, "name": "x"}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Bulk create (what the Review screen does).
    let (s, v) = call(
        &app,
        "POST",
        "/api/cards/bulk",
        Some(json!({"lesson_id": lesson_id, "cards": [
            {"front": "la plaza", "back": "plac", "example": "La plaza está en el centro."},
            {"front": "el barrio", "back": "dzielnica"}
        ]})),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    assert_eq!(v["created"], 2);
    let (s, v) = call(&app, "POST", "/api/cards/bulk", Some(json!({"lesson_id": lesson_id, "cards": []}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let (s, v) = call(&app, "POST", "/api/cards/bulk", Some(json!({"lesson_id": lesson_id, "cards": [{"front": "", "back": "x"}]}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");

    // Single create + lesson detail.
    let (s, c) = call(&app, "POST", "/api/cards", Some(json!({"lesson_id": lesson_id, "front": "la calle", "back": "ulica"}))).await;
    assert_eq!(s, StatusCode::CREATED, "{c}");
    let card_id = c["id"].as_i64().unwrap();
    assert_eq!(c["status"], "new");
    let (s, d) = call(&app, "GET", &format!("/api/lessons/{lesson_id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(d["name"], "3.1 La ciudad");
    assert_eq!(d["unit"]["id"], unit_id);
    assert_eq!(d["total"], 3);
    assert_eq!(d["new"], 3);
    assert_eq!(d["cards"].as_array().unwrap().len(), 3);

    // Search across both sides.
    let (_, v) = call(&app, "GET", "/api/cards?q=ULICA", None).await;
    assert_eq!(v.as_array().unwrap().len(), 1);
    let (_, v) = call(&app, "GET", "/api/cards?status=due", None).await;
    assert_eq!(v.as_array().unwrap().len(), 0);
    let (s, _) = call(&app, "GET", "/api/cards?status=nope", None).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Patch, 404s, delete.
    let (s, v) = call(&app, "PATCH", &format!("/api/cards/{card_id}"), Some(json!({"back": "ulica (miasto)"}))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["back"], "ulica (miasto)");
    let (s, _) = call(&app, "PATCH", "/api/cards/4242", Some(json!({"back": "x"}))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = call(&app, "DELETE", &format!("/api/cards/{card_id}"), None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = call(&app, "DELETE", &format!("/api/cards/{card_id}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Overview reflects the tree.
    let (_, o) = call(&app, "GET", "/api/overview", None).await;
    assert_eq!(o["total"], 2);
    assert_eq!(o["units"][0]["lessons"][0]["total"], 2);
    assert_eq!(o["units"][0]["lessons"][0]["name"], "3.1 La ciudad");

    // Rename + move lesson into a new unit, then cascade-delete.
    let (_, u2) = call(&app, "POST", "/api/units", Some(json!({"name": "Unidad 4"}))).await;
    let (s, l) = call(&app, "PATCH", &format!("/api/lessons/{lesson_id}"), Some(json!({"name": "4.1 La ciudad", "unit_id": u2["id"]}))).await;
    assert_eq!(s, StatusCode::OK, "{l}");
    assert_eq!(l["unit_id"], u2["id"]);
    let (s, _) = call(&app, "DELETE", &format!("/api/units/{}", u2["id"]), None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, o) = call(&app, "GET", "/api/overview", None).await;
    assert_eq!(o["total"], 0);
}

#[tokio::test]
async fn study_queue_and_review_flow() {
    let app = app();
    let (_unit_id, lesson_id) = seed(&app).await;
    let cards: Vec<Value> = (0..3).map(|i| json!({"front": format!("w{i}"), "back": "x"})).collect();
    call(&app, "POST", "/api/cards/bulk", Some(json!({"lesson_id": lesson_id, "cards": cards}))).await;

    let (s, q) = call(&app, "GET", &format!("/api/study/queue?scope=lesson:{lesson_id}"), None).await;
    assert_eq!(s, StatusCode::OK, "{q}");
    let items = q.as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["direction"], "forward");
    assert_eq!(items[0]["preview_labels"]["good"], "1 day");
    let first = items[0]["card"]["id"].as_i64().unwrap();

    let (s, r) = call(&app, "POST", "/api/study/review", Some(json!({"card_id": first, "grade": "good", "direction": "forward"}))).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["card"]["status"], "learned");
    assert_eq!(r["due_label"], "1 day");
    // Previews describe the *next* review of this (now graduated) card.
    assert_eq!(r["preview_labels"]["again"], "10 min", "{r}");
    assert!(r["preview"]["good"].as_i64().unwrap() > 86_400, "{r}");

    // A lapse re-queues the card in-session; its previews must reflect the relearning state.
    let (s, r) = call(&app, "POST", "/api/study/review", Some(json!({"card_id": first, "grade": "again"}))).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["card"]["status"], "learning");
    assert_eq!(r["due_label"], "10 min");
    assert_eq!(r["preview_labels"]["good"], "1 day", "{r}");
    assert_eq!(r["preview_labels"]["again"], "1 min", "{r}");

    let (s, r) = call(&app, "POST", "/api/study/review", Some(json!({"card_id": first, "grade": "meh"}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{r}");
    let (s, _) = call(&app, "POST", "/api/study/review", Some(json!({"card_id": 9999, "grade": "good"}))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Reviewed card is no longer in the due queue (relearning, due in 10 min); overview counts two reviews today.
    let (_, q) = call(&app, "GET", &format!("/api/study/queue?scope=lesson:{lesson_id}"), None).await;
    assert_eq!(q.as_array().unwrap().len(), 2);
    let (_, o) = call(&app, "GET", "/api/overview", None).await;
    assert_eq!(o["reviews_today"], 2);
    assert_eq!(o["new_studied_today"], 1);

    // Explicit ids ("repeat the missed").
    let (_, q) = call(&app, "GET", &format!("/api/study/queue?ids={first}"), None).await;
    assert_eq!(q.as_array().unwrap().len(), 1);
    let (s, _) = call(&app, "GET", "/api/study/queue?scope=bogus", None).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn settings_mask_key_and_env_fallback() {
    let app = app();
    let (_, s) = call(&app, "GET", "/api/settings", None).await;
    assert_eq!(s["gemini_api_key_set"], false);
    assert_eq!(s["front_lang"], "Español");
    let (st, s) = call(&app, "PATCH", "/api/settings", Some(json!({"gemini_api_key": "AIzaSecret9876", "front_lang": "Polski", "back_lang": "English"}))).await;
    assert_eq!(st, StatusCode::OK, "{s}");
    assert_eq!(s["gemini_api_key_set"], true);
    assert_eq!(s["gemini_api_key_hint"], "…9876");
    assert!(s.get("gemini_api_key").is_none(), "key must never be returned");
    assert_eq!(s["front_lang"], "Polski");
    let (st, _) = call(&app, "PATCH", "/api/settings", Some(json!({"study_direction": "diagonal"}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let app_env = app_with(None, Some("env-key"));
    let (_, s) = call(&app_env, "GET", "/api/settings", None).await;
    assert_eq!(s["gemini_api_key_set"], true);
}

#[tokio::test]
async fn export_then_import_into_fresh_db() {
    let app = app();
    let (_u, lesson_id) = seed(&app).await;
    call(&app, "POST", "/api/cards/bulk", Some(json!({"lesson_id": lesson_id, "cards": [{"front": "hola", "back": "cześć"}]}))).await;
    let (s, backup) = call(&app, "GET", "/api/export", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(backup["units"][0]["lessons"][0]["cards"][0]["front"], "hola");

    let fresh = app_with(None, None);
    let (s, rep) = call(&fresh, "POST", "/api/import", Some(backup.clone())).await;
    assert_eq!(s, StatusCode::OK, "{rep}");
    assert_eq!(rep["cards_created"], 1);
    let (_, rep) = call(&fresh, "POST", "/api/import", Some(backup)).await;
    assert_eq!(rep["cards_created"], 0);
    assert_eq!(rep["cards_skipped"], 1);
}

// ---------------------------------------------------------------------------
// Extraction against a fake Gemini endpoint
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct FakeGemini {
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    reply: Arc<Mutex<Option<(u16, Value)>>>,
}

async fn fake_generate(
    State(f): State<FakeGemini>,
    axum::extract::Path(model): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let key = headers.get("x-goog-api-key").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    f.requests.lock().unwrap().push((format!("{model}|{key}"), body));
    let (code, v) = f.reply.lock().unwrap().clone().unwrap_or((
        200,
        json!({"candidates":[{"content":{"parts":[{"text": json!({"cards":[
            {"front":"hace sol","back":"jest słonecznie","confidence":0.95},
            {"front":"hace sol","back":"dup","confidence":0.9},
            {"front":"está nublado","back":"jest pochmurno","confidence":0.4},
            {"front":"El Paraguas","back":"parasol","example":"Llevo el paraguas.","confidence":0.99}
        ]}).to_string()}]},"finishReason":"STOP"}]}),
    ));
    (StatusCode::from_u16(code).unwrap(), Json(v))
}

async fn start_fake_gemini() -> (String, FakeGemini) {
    let fake = FakeGemini::default();
    let router = Router::new()
        .route("/v1beta/models/{model}", post(fake_generate))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}/v1beta"), fake)
}

#[tokio::test]
async fn extract_requires_key_validates_images_and_marks_duplicates() {
    let (base, fake) = start_fake_gemini().await;
    let app = app_with(Some(base), None);
    let (_u, lesson_id) = seed(&app).await;
    call(&app, "POST", "/api/cards/bulk", Some(json!({"lesson_id": lesson_id, "cards": [{"front": "el paraguas", "back": "parasol"}]}))).await;

    let img = json!({"mime_type": "image/jpeg", "data": "/9j/4AAQ"});

    // No key configured → 400 with actionable message.
    let (s, v) = call(&app, "POST", "/api/extract", Some(json!({"images": [img], "hint": "only the box"}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    assert!(v["message"].as_str().unwrap().contains("Settings"));

    call(&app, "PATCH", "/api/settings", Some(json!({"gemini_api_key": "test-key", "gemini_model": "gemini-test"}))).await;

    // Bad images.
    let (s, _) = call(&app, "POST", "/api/extract", Some(json!({"images": [], "hint": ""}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = call(&app, "POST", "/api/extract", Some(json!({"images": [{"mime_type": "text/plain", "data": "x"}]}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Happy path.
    let (s, v) = call(&app, "POST", "/api/extract", Some(json!({"images": [img], "hint": "only the box"}))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let cards = v["cards"].as_array().unwrap();
    assert_eq!(cards.len(), 3, "exact duplicate front from the model is dropped: {v}");
    assert_eq!(cards[0]["front"], "hace sol");
    assert!(cards[0]["existing_in"].is_null());
    assert_eq!(cards[1]["confidence"], 0.4);
    assert_eq!(cards[2]["front"], "El Paraguas");
    assert_eq!(cards[2]["existing_in"], "3.1 La ciudad", "case-insensitive duplicate detection");
    assert!(cards[2]["existing_card_id"].is_i64());
    assert_eq!(v["model"], "gemini-test");

    // The fake saw the right model, key, prompt and image.
    let (meta, body) = fake.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(meta, "gemini-test:generateContent|test-key");
    let prompt = body["contents"][0]["parts"][0]["text"].as_str().unwrap();
    assert!(prompt.contains("only the box"));
    assert!(prompt.contains("Español"));
    assert_eq!(body["contents"][0]["parts"][1]["inline_data"]["mime_type"], "image/jpeg");
    assert_eq!(body["generationConfig"]["response_mime_type"], "application/json");

    // Upstream errors surface as 502 with Gemini's message.
    *fake.reply.lock().unwrap() = Some((429, json!({"error": {"message": "Quota exceeded"}})));
    let (s, v) = call(&app, "POST", "/api/extract", Some(json!({"images": [img]}))).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "{v}");
    assert!(v["message"].as_str().unwrap().contains("Quota exceeded"));

    // Garbage answer → 502 too, never 500.
    *fake.reply.lock().unwrap() = Some((200, json!({"candidates": [{"content": {"parts": [{"text": "lol"}]}}]})));
    let (s, v) = call(&app, "POST", "/api/extract", Some(json!({"images": [img]}))).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "{v}");
}

#[tokio::test]
async fn extract_uses_env_key_when_settings_has_none() {
    let (base, fake) = start_fake_gemini().await;
    let app = app_with(Some(base), Some("env-key"));
    let img = json!({"mime_type": "image/png", "data": "iVBORw0KGgo="});
    let (s, v) = call(&app, "POST", "/api/extract", Some(json!({"images": [img]}))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let reqs = fake.requests.lock().unwrap();
    assert!(reqs[0].0.ends_with("|env-key"));
}

// ---------------------------------------------------------------------------
// Safeguards
// ---------------------------------------------------------------------------

#[tokio::test]
async fn extract_pause_switch_and_daily_cap() {
    let (base, fake) = start_fake_gemini().await;
    let app = app_full(Some(base), Some("env-key"), Limits { extract_per_minute: 0, extract_per_day: 2 }, None);
    let img = json!({"mime_type": "image/png", "data": "iVBORw0KGgo="});
    let body = json!({"images": [img]});

    // Settings expose the cap and zero usage.
    let (_, s) = call(&app, "GET", "/api/settings", None).await;
    assert_eq!(s["extract_daily_cap"], 2, "{s}");
    assert_eq!(s["extractions_today"], 0);
    assert_eq!(s["extraction_paused"], false);

    // Paused → 409, nothing reaches Gemini, nothing is counted.
    let (st, s) = call(&app, "PATCH", "/api/settings", Some(json!({"extraction_paused": true}))).await;
    assert_eq!(st, StatusCode::OK, "{s}");
    assert_eq!(s["extraction_paused"], true);
    let (st, v) = call(&app, "POST", "/api/extract", Some(body.clone())).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"], "paused");
    assert!(v["message"].as_str().unwrap().contains("Settings"));
    assert_eq!(fake.requests.lock().unwrap().len(), 0);
    let (_, s) = call(&app, "GET", "/api/settings", None).await;
    assert_eq!(s["extractions_today"], 0);
    call(&app, "PATCH", "/api/settings", Some(json!({"extraction_paused": false}))).await;

    // 1st OK, 2nd fails upstream (still counted), 3rd hits the cap without touching Gemini.
    let (st, _) = call(&app, "POST", "/api/extract", Some(body.clone())).await;
    assert_eq!(st, StatusCode::OK);
    *fake.reply.lock().unwrap() = Some((500, json!({"error": {"message": "boom"}})));
    let (st, _) = call(&app, "POST", "/api/extract", Some(body.clone())).await;
    assert_eq!(st, StatusCode::BAD_GATEWAY);
    *fake.reply.lock().unwrap() = None;
    let (st, v) = call(&app, "POST", "/api/extract", Some(body.clone())).await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "{v}");
    assert_eq!(v["error"], "rate_limited");
    assert!(v["message"].as_str().unwrap().contains("Daily"), "{v}");
    assert_eq!(fake.requests.lock().unwrap().len(), 2);
    let (_, s) = call(&app, "GET", "/api/settings", None).await;
    assert_eq!(s["extractions_today"], 2);
    assert_eq!(s["extractions_total"], 2);

    // Invalid input and a missing key are rejected before anything is counted.
    let (st, _) = call(&app, "POST", "/api/extract", Some(json!({"images": []}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (_, s) = call(&app, "GET", "/api/settings", None).await;
    assert_eq!(s["extractions_today"], 2);
}

#[tokio::test]
async fn extract_per_minute_limiter() {
    let (base, fake) = start_fake_gemini().await;
    let app = app_full(Some(base), Some("env-key"), Limits { extract_per_minute: 2, extract_per_day: 0 }, None);
    let body = json!({"images": [{"mime_type": "image/png", "data": "iVBORw0KGgo="}]});
    for _ in 0..2 {
        let (st, v) = call(&app, "POST", "/api/extract", Some(body.clone())).await;
        assert_eq!(st, StatusCode::OK, "{v}");
    }
    let (st, v) = call(&app, "POST", "/api/extract", Some(body.clone())).await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "{v}");
    assert!(v["message"].as_str().unwrap().contains("wait"), "{v}");
    assert_eq!(fake.requests.lock().unwrap().len(), 2);
    // A blocked request is not counted against the daily usage.
    let (_, s) = call(&app, "GET", "/api/settings", None).await;
    assert_eq!(s["extractions_today"], 2);
    assert_eq!(s["extract_daily_cap"], 0, "0 = unlimited is reported as-is");
}

#[tokio::test]
async fn settings_validate_model_name() {
    let app = app();
    let (_, s) = call(&app, "GET", "/api/settings", None).await;
    assert_eq!(s["gemini_model"], "gemini-flash-latest", "default must be a currently served alias");
    let (st, v) = call(&app, "PATCH", "/api/settings", Some(json!({"gemini_model": "gemini 2.5 flash"}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    assert!(v["message"].as_str().unwrap().contains("model name"), "{v}");
    let (st, v) = call(&app, "PATCH", "/api/settings", Some(json!({"gemini_model": "models/gemini-2.5-pro"}))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["gemini_model"], "gemini-2.5-pro");
    let (_, v) = call(&app, "PATCH", "/api/settings", Some(json!({"gemini_model": ""}))).await;
    assert_eq!(v["gemini_model"], "gemini-flash-latest", "empty resets to default");
}

async fn call_with_auth(app: &Router, path: &str, auth: Option<&str>) -> (StatusCode, Option<String>, Value) {
    let mut req = Request::builder().method("GET").uri(path);
    if let Some(a) = auth {
        req = req.header("authorization", a);
    }
    let resp = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let status = resp.status();
    let challenge = resp.headers().get("www-authenticate").map(|v| v.to_str().unwrap().to_string());
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    (status, challenge, v)
}

#[tokio::test]
async fn basic_auth_protects_everything_except_health() {
    // "user:password1"
    let expected = fiszki_server::guard::basic_auth_from_env_value("user:password1").unwrap();
    let app = app_full(None, None, UNLIMITED, Some(expected.clone()));

    let (st, _, v) = call_with_auth(&app, "/api/health", None).await;
    assert_eq!(st, StatusCode::OK, "{v}");

    let (st, challenge, v) = call_with_auth(&app, "/api/overview", None).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "{v}");
    assert!(challenge.unwrap().starts_with("Basic realm="));
    assert_eq!(v["error"], "unauthorized");

    let (st, _, _) = call_with_auth(&app, "/api/overview", Some("Basic dXNlcjp3cm9uZw==")).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "wrong password");
    let (st, _, _) = call_with_auth(&app, "/api/overview", Some("Bearer dXNlcjpwYXNzd29yZDE=")).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "wrong scheme");

    let (st, _, v) = call_with_auth(&app, "/api/overview", Some(&expected)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["total"], 0);

    // Unknown routes (would be the SPA) are also behind auth.
    let (st, _, _) = call_with_auth(&app, "/settings", None).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    // Off by default.
    let open = app_with(None, None);
    let (st, _, _) = call_with_auth(&open, "/api/overview", None).await;
    assert_eq!(st, StatusCode::OK);
}
