//! HTTP API handlers.

use std::sync::MutexGuard;
use std::time::Instant;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app::AppState;
// Request bodies: our extractor (rejections become logged `AppError`s in the
// usual JSON shape). Responses: `axum::Json` above.
use crate::error::{AppError, AppResult, Json as Body};
use crate::gemini::{self, ExtractRequest, GeminiError, ImageInput};
use crate::models::*;
use crate::repo::{self, Backup, CardFilter, CardPatch, NewCard, QueueRequest};
use crate::srs::Grade;

pub fn api_router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/overview", get(get_overview))
        .route("/units", get(list_units).post(create_unit))
        .route("/units/{id}", patch(patch_unit).delete(delete_unit))
        .route("/lessons", get(list_lessons).post(create_lesson))
        .route("/lessons/{id}", get(get_lesson).patch(patch_lesson).delete(delete_lesson))
        .route("/cards", get(list_cards).post(create_card))
        .route("/cards/bulk", post(create_cards_bulk))
        .route("/cards/{id}", get(get_card).patch(patch_card).delete(delete_card))
        .route("/study/queue", get(study_queue))
        .route("/study/review", post(study_review))
        .route("/extract", post(extract))
        .route("/settings", get(get_settings).patch(patch_settings).put(patch_settings))
        .route("/export", get(export))
        .route("/import", post(import))
}

fn lock(state: &AppState) -> AppResult<MutexGuard<'_, Connection>> {
    state.db.lock().map_err(|_| AppError::Internal(anyhow::anyhow!("database mutex poisoned")))
}

fn bad(e: anyhow::Error) -> AppError {
    // Repository validation errors are user errors; anything from rusqlite is internal.
    if e.downcast_ref::<rusqlite::Error>().is_some() {
        AppError::Internal(e)
    } else {
        // `{:#}` keeps any `.context(..)` the repo added, not just the top line.
        AppError::BadRequest(format!("{e:#}"))
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn get_overview(State(s): State<AppState>) -> AppResult<Json<Overview>> {
    let conn = lock(&s)?;
    Ok(Json(repo::overview(&conn)?))
}

// ----- units ---------------------------------------------------------------

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn list_units(State(s): State<AppState>) -> AppResult<Json<Vec<Unit>>> {
    let conn = lock(&s)?;
    Ok(Json(repo::list_units(&conn)?))
}

async fn create_unit(State(s): State<AppState>, Body(b): Body<NameBody>) -> AppResult<(StatusCode, Json<Unit>)> {
    let conn = lock(&s)?;
    Ok((StatusCode::CREATED, Json(repo::create_unit(&conn, &b.name).map_err(bad)?)))
}

async fn patch_unit(State(s): State<AppState>, Path(id): Path<i64>, Body(b): Body<NameBody>) -> AppResult<Json<Unit>> {
    let conn = lock(&s)?;
    repo::rename_unit(&conn, id, &b.name).map_err(bad)?.map(Json).ok_or_else(|| AppError::NotFound(format!("unit {id} not found")))
}

async fn delete_unit(State(s): State<AppState>, Path(id): Path<i64>) -> AppResult<StatusCode> {
    let conn = lock(&s)?;
    if repo::delete_unit(&conn, id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound(format!("unit {id} not found")))
    }
}

// ----- lessons -------------------------------------------------------------

#[derive(Deserialize)]
struct NewLessonBody {
    unit_id: i64,
    name: String,
}

#[derive(Deserialize)]
struct LessonPatchBody {
    name: Option<String>,
    unit_id: Option<i64>,
}

#[derive(Serialize)]
struct LessonDetail {
    #[serde(flatten)]
    lesson: Lesson,
    unit: Unit,
    #[serde(flatten)]
    counts: Counts,
    cards: Vec<Card>,
}

async fn list_lessons(State(s): State<AppState>) -> AppResult<Json<Vec<Lesson>>> {
    let conn = lock(&s)?;
    Ok(Json(repo::list_lessons(&conn)?))
}

async fn create_lesson(State(s): State<AppState>, Body(b): Body<NewLessonBody>) -> AppResult<(StatusCode, Json<Lesson>)> {
    let conn = lock(&s)?;
    Ok((StatusCode::CREATED, Json(repo::create_lesson(&conn, b.unit_id, &b.name).map_err(bad)?)))
}

async fn get_lesson(State(s): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<LessonDetail>> {
    let conn = lock(&s)?;
    let lesson = repo::get_lesson(&conn, id)?.ok_or_else(|| AppError::NotFound(format!("lesson {id} not found")))?;
    let unit = repo::get_unit(&conn, lesson.unit_id)?.ok_or_else(|| AppError::NotFound("unit not found".into()))?;
    let cards = repo::list_cards(&conn, &CardFilter { lesson_id: Some(id), limit: Some(10_000), ..Default::default() })?;
    let mut counts = Counts { total: cards.len() as i64, ..Default::default() };
    for c in &cards {
        match c.status.as_str() {
            "new" => counts.new += 1,
            "due" => counts.due += 1,
            "learning" => counts.learning += 1,
            _ => counts.learned += 1,
        }
    }
    Ok(Json(LessonDetail { lesson, unit, counts, cards }))
}

async fn patch_lesson(State(s): State<AppState>, Path(id): Path<i64>, Body(b): Body<LessonPatchBody>) -> AppResult<Json<Lesson>> {
    let conn = lock(&s)?;
    repo::update_lesson(&conn, id, b.name.as_deref(), b.unit_id)
        .map_err(bad)?
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("lesson {id} not found")))
}

async fn delete_lesson(State(s): State<AppState>, Path(id): Path<i64>) -> AppResult<StatusCode> {
    let conn = lock(&s)?;
    if repo::delete_lesson(&conn, id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound(format!("lesson {id} not found")))
    }
}

// ----- cards ---------------------------------------------------------------

#[derive(Deserialize)]
struct NewCardBody {
    lesson_id: i64,
    #[serde(flatten)]
    card: NewCard,
}

#[derive(Deserialize)]
struct BulkBody {
    lesson_id: i64,
    cards: Vec<NewCard>,
}

#[derive(Serialize)]
struct BulkResult {
    created: usize,
    ids: Vec<i64>,
    lesson: Lesson,
}

async fn list_cards(State(s): State<AppState>, Query(f): Query<CardFilter>) -> AppResult<Json<Vec<Card>>> {
    let conn = lock(&s)?;
    Ok(Json(repo::list_cards(&conn, &f).map_err(bad)?))
}

async fn get_card(State(s): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Card>> {
    let conn = lock(&s)?;
    repo::get_card(&conn, id)?.map(Json).ok_or_else(|| AppError::NotFound(format!("card {id} not found")))
}

async fn create_card(State(s): State<AppState>, Body(b): Body<NewCardBody>) -> AppResult<(StatusCode, Json<Card>)> {
    let conn = lock(&s)?;
    Ok((StatusCode::CREATED, Json(repo::create_card(&conn, b.lesson_id, &b.card).map_err(bad)?)))
}

async fn create_cards_bulk(State(s): State<AppState>, Body(b): Body<BulkBody>) -> AppResult<(StatusCode, Json<BulkResult>)> {
    if b.cards.is_empty() {
        return Err(AppError::BadRequest("no cards to save".into()));
    }
    if b.cards.len() > 500 {
        return Err(AppError::BadRequest("too many cards in one request (max 500)".into()));
    }
    let conn = lock(&s)?;
    let ids = repo::create_cards(&conn, b.lesson_id, &b.cards).map_err(bad)?;
    let lesson = repo::get_lesson(&conn, b.lesson_id)?.ok_or_else(|| AppError::NotFound("lesson not found".into()))?;
    Ok((StatusCode::CREATED, Json(BulkResult { created: ids.len(), ids, lesson })))
}

async fn patch_card(State(s): State<AppState>, Path(id): Path<i64>, Body(p): Body<CardPatch>) -> AppResult<Json<Card>> {
    let conn = lock(&s)?;
    repo::update_card(&conn, id, &p).map_err(bad)?.map(Json).ok_or_else(|| AppError::NotFound(format!("card {id} not found")))
}

async fn delete_card(State(s): State<AppState>, Path(id): Path<i64>) -> AppResult<StatusCode> {
    let conn = lock(&s)?;
    if repo::delete_card(&conn, id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound(format!("card {id} not found")))
    }
}

// ----- study ---------------------------------------------------------------

async fn study_queue(State(s): State<AppState>, Query(q): Query<QueueRequest>) -> AppResult<Json<Vec<StudyItem>>> {
    let conn = lock(&s)?;
    Ok(Json(repo::study_queue(&conn, &q).map_err(bad)?))
}

#[derive(Deserialize)]
struct ReviewBody {
    card_id: i64,
    grade: String,
    direction: Option<String>,
}

async fn study_review(State(s): State<AppState>, Body(b): Body<ReviewBody>) -> AppResult<Json<ReviewResult>> {
    let grade = Grade::parse(&b.grade).ok_or_else(|| AppError::BadRequest(format!("unknown grade '{}'", b.grade)))?;
    let conn = lock(&s)?;
    repo::apply_review(&conn, b.card_id, grade, b.direction.as_deref())
        .map_err(bad)?
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("card {} not found", b.card_id)))
}

// ----- extraction (Gemini) --------------------------------------------------

#[derive(Deserialize)]
struct ExtractBody {
    images: Vec<ImageInput>,
    #[serde(default)]
    hint: String,
}

#[derive(Serialize)]
struct ExtractResponse {
    cards: Vec<ExtractedCard>,
    model: String,
    hint: String,
}

async fn extract(State(s): State<AppState>, Body(b): Body<ExtractBody>) -> AppResult<Json<ExtractResponse>> {
    gemini::validate_images(&b.images).map_err(|e| AppError::BadRequest(e.to_string()))?;
    let hint = b.hint.chars().take(gemini::MAX_HINT_CHARS).collect::<String>();
    let model = s.gemini_config.model.clone();
    let api_key = s.gemini_config.api_key.clone().ok_or_else(|| AppError::BadRequest(GeminiError::NoApiKey.to_string()))?;
    let image_bytes: Vec<usize> = b.images.iter().map(ImageInput::approx_bytes).collect();

    // Grab what we need from the DB and apply the safeguards, then release the
    // lock before the slow network call.
    let settings = {
        let conn = lock(&s)?;
        if repo::extraction_paused(&conn)? {
            return Err(AppError::Paused("Extraction is paused – switch it back on in Settings".into()));
        }
        let settings = repo::get_settings(&conn)?;

        let cap = s.limits.extract_per_day;
        let now = crate::db::now();
        let usage = repo::extraction_usage(&conn, now)?;
        if cap > 0 && usage.today >= cap {
            return Err(AppError::TooManyRequests(format!("Daily extraction limit reached ({cap}/day) – try again tomorrow")));
        }
        if let Err(wait) = s.extract_limiter.check() {
            return Err(AppError::TooManyRequests(format!("Too many extractions in a row – wait {wait}s and try again")));
        }
        let usage = repo::record_extraction(&conn, now)?;
        tracing::info!(today = usage.today, total = usage.total, cap, model = %model, images = b.images.len(), ?image_bytes, hint_chars = hint.chars().count(), "extraction");
        settings
    };

    let req = ExtractRequest { images: &b.images, hint: &hint, front_lang: &settings.front_lang, back_lang: &settings.back_lang };
    let started = Instant::now();
    let mut cards = match s.gemini.extract(&api_key, &model, &req).await {
        Ok(cards) => cards,
        Err(GeminiError::NoApiKey) => return Err(AppError::BadRequest(GeminiError::NoApiKey.to_string())),
        Err(e) => {
            // One chain with everything a reader needs: stage/status (from the
            // GeminiError Display + its `source`), plus the request shape and
            // total latency. `AppError::Upstream` logs it with `{:#}` and sends
            // the same text to the UI.
            let sizes = image_bytes.iter().map(|b| format!("{} KB", b / 1024)).collect::<Vec<_>>().join(", ");
            let ctx = format!(
                "Gemini extraction failed at stage '{}' (model {}, {} image{} [{}], hint {} chars, {} ms)",
                e.stage(),
                model,
                b.images.len(),
                if b.images.len() == 1 { "" } else { "s" },
                sizes,
                hint.chars().count(),
                started.elapsed().as_millis()
            );
            return Err(AppError::Upstream(anyhow::Error::new(e).context(ctx)));
        }
    };

    // Mark duplicates so the UI can pre-uncheck them.
    {
        let conn = lock(&s)?;
        let existing = repo::existing_fronts(&conn)?;
        let mut seen = std::collections::HashSet::new();
        cards.retain(|c| seen.insert(repo::normalize_front(&c.front)));
        for c in &mut cards {
            if let Some((id, lesson)) = existing.get(&repo::normalize_front(&c.front)) {
                c.existing_in = Some(lesson.clone());
                c.existing_card_id = Some(*id);
            }
        }
    }
    tracing::info!(cards = cards.len(), model = %model, latency_ms = started.elapsed().as_millis() as u64, "extraction ok");
    Ok(Json(ExtractResponse { cards, model, hint }))
}

// ----- settings / backup ------------------------------------------------------

/// Fill in the read-only, server-side parts of the settings view.
fn decorate_settings(s: &AppState, mut st: Settings) -> Settings {
    st.gemini_api_key_set = s.gemini_config.api_key.is_some();
    st.gemini_model = s.gemini_config.model.clone();
    st.extract_daily_cap = s.limits.extract_per_day;
    st
}

async fn get_settings(State(s): State<AppState>) -> AppResult<Json<Settings>> {
    let st = {
        let conn = lock(&s)?;
        repo::get_settings(&conn)?
    };
    Ok(Json(decorate_settings(&s, st)))
}

async fn patch_settings(State(s): State<AppState>, Body(p): Body<SettingsPatch>) -> AppResult<Json<Settings>> {
    let st = {
        let conn = lock(&s)?;
        repo::patch_settings(&conn, &p).map_err(bad)?
    };
    Ok(Json(decorate_settings(&s, st)))
}

async fn export(State(s): State<AppState>) -> AppResult<Json<Backup>> {
    let conn = lock(&s)?;
    Ok(Json(repo::export(&conn)?))
}

async fn import(State(s): State<AppState>, Body(b): Body<Backup>) -> AppResult<Json<repo::ImportReport>> {
    let conn = lock(&s)?;
    Ok(Json(repo::import(&conn, &b).map_err(bad)?))
}
