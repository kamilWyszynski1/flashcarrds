//! Gemini client used to turn a photo of a textbook page into card pairs.
//!
//! The API key never leaves the server: the browser uploads the (downscaled)
//! image here, and this module calls the Generative Language REST API with
//! structured (JSON-schema) output so the result is machine-parseable.
//!
//! Key and model are server configuration only (`GEMINI_API_KEY`,
//! `FISZKI_GEMINI_MODEL`); they are deliberately not editable from the app so
//! that a leaked Basic-auth password cannot be used to swap or read them.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::models::ExtractedCard;

pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// `gemini-flash-latest` is an alias Google keeps pointing at the current
/// Flash model, so a fresh install works without knowing today's version.
pub const DEFAULT_MODEL: &str = "gemini-flash-latest";

/// Upper bound for one Gemini call. Extraction normally takes 2–8 s; anything
/// longer is the model being overloaded and the UI should say so instead of
/// spinning. Overridable with `FISZKI_GEMINI_TIMEOUT_SECS`.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// A `503 UNAVAILABLE` ("high demand") that comes back this quickly is worth
/// one automatic retry; a slow failure already ate the user's patience.
const RETRY_IF_FASTER_THAN: Duration = Duration::from_secs(10);
/// Pause before the retry (scaled down to `timeout / 10` for short timeouts).
const RETRY_BACKOFF: Duration = Duration::from_millis(1500);
/// Do not bother retrying if less than this is left of the per-call budget.
const MIN_RETRY_BUDGET: Duration = Duration::from_millis(500);

/// How much of an upstream body we keep for logs / error chains. Gemini's own
/// error message lives in the first few hundred bytes; 2 KB also covers the
/// `details` block without flooding the log with a 100 KB answer.
pub const BODY_LOG_LIMIT: usize = 2048;

/// Accept `gemini-2.5-flash`, `models/gemini-flash-latest`, etc.; reject
/// anything that cannot be a model id so a typo fails at startup with a clear
/// message rather than as a 404 from Gemini.
pub fn clean_model(m: &str) -> Result<String> {
    let m = m.trim();
    let m = m.strip_prefix("models/").unwrap_or(m);
    if m.is_empty() {
        return Err(anyhow!("model name must not be empty"));
    }
    if m.len() > 80 {
        return Err(anyhow!("model name is too long (max 80 characters)"));
    }
    if !m
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
    {
        return Err(anyhow!(
            "model name may only contain letters, digits, '-', '.' and '_' (e.g. {DEFAULT_MODEL})"
        ));
    }
    Ok(m.to_string())
}

/// Server-side Gemini configuration (env only – see module docs).
#[derive(Debug, Clone)]
pub struct GeminiConfig {
    /// `GEMINI_API_KEY`; `None` disables extraction with a clear 400.
    pub api_key: Option<String>,
    /// `FISZKI_GEMINI_MODEL`, already validated with [`clean_model`].
    pub model: String,
}

impl Default for GeminiConfig {
    fn default() -> Self {
        GeminiConfig {
            api_key: None,
            model: DEFAULT_MODEL.to_string(),
        }
    }
}

impl GeminiConfig {
    /// Read `GEMINI_API_KEY` and `FISZKI_GEMINI_MODEL`; a malformed model name
    /// is a startup error (better than every extraction failing with a 404).
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("GEMINI_API_KEY")
            .ok()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());
        let model = match std::env::var("FISZKI_GEMINI_MODEL") {
            Ok(m) if !m.trim().is_empty() => {
                clean_model(&m).map_err(|e| anyhow!("FISZKI_GEMINI_MODEL: {e}"))?
            }
            _ => DEFAULT_MODEL.to_string(),
        };
        Ok(GeminiConfig { api_key, model })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInput {
    /// e.g. "image/jpeg"
    pub mime_type: String,
    /// base64 (no data: prefix)
    pub data: String,
}

impl ImageInput {
    /// Approximate decoded size in bytes (base64 → raw).
    pub fn approx_bytes(&self) -> usize {
        self.data.len() * 3 / 4
    }
}

#[derive(Debug, Clone)]
pub struct ExtractRequest<'a> {
    pub images: &'a [ImageInput],
    pub hint: &'a str,
    pub front_lang: &'a str,
    pub back_lang: &'a str,
}

/// Why one Gemini call failed. Every variant names the stage, carries the
/// latency, and (where there was an answer) the upstream status and the first
/// [`BODY_LOG_LIMIT`] bytes of the body – so one log line is enough to see what
/// Gemini actually said. The `Display` text is safe to show in the UI (it never
/// contains the key; the key travels in a header, not the URL).
#[derive(Debug, thiserror::Error)]
pub enum GeminiError {
    #[error("Gemini API key is not configured – set GEMINI_API_KEY on the server")]
    NoApiKey,
    /// The request never completed: DNS / connect / TLS / timeout / reset.
    #[error("{} after {} ms", if .source.is_timeout() { "no answer from Gemini" } else { "could not reach Gemini" }, .elapsed.as_millis())]
    Transport {
        /// "sending request" | "reading response"
        stage: &'static str,
        elapsed: Duration,
        #[source]
        source: reqwest::Error,
    },
    /// Gemini answered with a non-2xx.
    #[error("Gemini answered HTTP {status}{}: {message}", .api_status.as_deref().map(|s| format!(" {s}")).unwrap_or_default())]
    Status {
        status: u16,
        /// `error.status` from the body, e.g. "UNAVAILABLE", "INVALID_ARGUMENT".
        api_status: Option<String>,
        /// `error.message` from the body, or the raw (truncated) body.
        message: String,
        /// Raw body, truncated to [`BODY_LOG_LIMIT`].
        body: String,
        elapsed: Duration,
    },
    /// 2xx, but the body was not something we can turn into cards.
    #[error("could not understand Gemini's answer: {reason}")]
    BadResponse {
        reason: String,
        /// Raw body, truncated to [`BODY_LOG_LIMIT`].
        body: String,
        elapsed: Duration,
    },
}

impl GeminiError {
    /// Short stage tag for structured logs.
    pub fn stage(&self) -> &'static str {
        match self {
            GeminiError::NoApiKey => "config",
            GeminiError::Transport { stage, .. } => stage,
            GeminiError::Status { .. } => "upstream_status",
            GeminiError::BadResponse { .. } => "parse",
        }
    }

    pub fn upstream_status(&self) -> Option<u16> {
        match self {
            GeminiError::Status { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Truncated upstream body, when there was one.
    pub fn body(&self) -> Option<&str> {
        match self {
            GeminiError::Status { body, .. } | GeminiError::BadResponse { body, .. } => Some(body),
            _ => None,
        }
    }

    pub fn elapsed(&self) -> Option<Duration> {
        match self {
            GeminiError::NoApiKey => None,
            GeminiError::Transport { elapsed, .. }
            | GeminiError::Status { elapsed, .. }
            | GeminiError::BadResponse { elapsed, .. } => Some(*elapsed),
        }
    }
}

/// Keep the first `limit` bytes of `s` (on a char boundary), marking the cut.
pub fn truncate_body(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut end = limit;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… [{} bytes total]", &s[..end], s.len())
}

pub fn build_prompt(front_lang: &str, back_lang: &str, hint: &str) -> String {
    let hint = hint.trim();
    let mut p = format!(
        "You are helping a learner build vocabulary flashcards from photos of pages of a language textbook.\n\
         Each photo shows one or two pages. Extract the vocabulary items a learner would want to memorise.\n\n\
         Card format:\n\
         - \"front\": the word or short phrase in {front_lang}, exactly as printed (keep accents, ¿¡, and the article for nouns when it is printed).\n\
         - \"back\": its translation in {back_lang}. If the page prints translations, use them; otherwise translate it yourself, briefly (1–4 words, add a short disambiguation in parentheses only when needed).\n\
         - \"example\": a short example sentence in {front_lang} taken from the page if one is printed next to the item; otherwise omit the field.\n\
         - \"confidence\": a number from 0 to 1. Use values below 0.7 when the text is blurry, cut off, or when you had to guess the translation.\n\n\
         Rules:\n\
         - One item per vocabulary entry; do not merge items; do not invent items that are not on the page.\n\
         - Skip page numbers, headings, instructions for exercises, and grammar tables unless the learner asks for them.\n\
         - Do not repeat the same front twice.\n\
         - If nothing suitable is on the page, return an empty list.\n"
    );
    if !hint.is_empty() {
        p.push_str("\nThe learner's instructions for this photo (follow them, they take priority over the rules above):\n");
        p.push_str(hint);
        p.push('\n');
    }
    p.push_str("\nReturn only JSON matching the schema.");
    p
}

pub fn response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "front": { "type": "string" },
                        "back": { "type": "string" },
                        "example": { "type": "string" },
                        "confidence": { "type": "number" }
                    },
                    "required": ["front", "back", "confidence"]
                }
            }
        },
        "required": ["cards"]
    })
}

pub fn build_request_body(req: &ExtractRequest<'_>) -> Value {
    let mut parts = vec![json!({ "text": build_prompt(req.front_lang, req.back_lang, req.hint) })];
    for img in req.images {
        parts.push(json!({ "inline_data": { "mime_type": img.mime_type, "data": img.data } }));
    }
    json!({
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": {
            "temperature": 0.2,
            "response_mime_type": "application/json",
            "response_schema": response_schema()
        }
    })
}

/// Pull the card list out of a `generateContent` response. `Err` is the reason
/// (the caller attaches the raw body and latency).
pub fn parse_response(v: &Value) -> Result<Vec<ExtractedCard>, String> {
    if let Some(reason) = v
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return Err(format!("request was blocked by Gemini ({reason})"));
    }
    let candidate = v
        .pointer("/candidates/0")
        .ok_or_else(|| "no candidates in response".to_string())?;
    let text: String = candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        let finish = candidate
            .get("finishReason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(format!("empty answer (finishReason: {finish})"));
    }
    let parsed: Value = serde_json::from_str(strip_code_fence(&text))
        .map_err(|e| format!("answer was not valid JSON: {e}"))?;
    let cards = match parsed {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("cards") {
            Some(Value::Array(a)) => a,
            _ => return Err("answer has no \"cards\" array".into()),
        },
        _ => return Err("answer has unexpected shape".into()),
    };
    let mut out = Vec::new();
    for c in cards {
        let front = c
            .get("front")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let back = c
            .get("back")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if front.is_empty() && back.is_empty() {
            continue;
        }
        let example = c
            .get("example")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(String::from);
        let confidence = c
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .clamp(0.0, 1.0);
        out.push(ExtractedCard {
            front,
            back,
            example,
            confidence,
            existing_in: None,
            existing_card_id: None,
        });
    }
    Ok(out)
}

pub fn build_generate_prompt(front_lang: &str, back_lang: &str, prompt: &str) -> String {
    let prompt = prompt.trim();
    format!(
        "You are helping a learner create language flashcards.\n\
         The learner is studying {front_lang} (front) -> {back_lang} (back) and wants flashcards for:\n\
         {prompt}\n\n\
         Card format:\n\
         - \"front\": word, conjugated form (include subject pronoun like yo soy when conjugating verbs so cards are unambiguous, unless instructed otherwise), or short phrase in {front_lang} (keep accents, ¿¡, and articles for nouns when appropriate).\n\
         - \"back\": concise translation in {back_lang} (add brief disambiguation in parentheses when helpful).\n\
         - \"example\": optional short example sentence in {front_lang} if requested or particularly helpful; otherwise omit.\n\
         - \"confidence\": number from 0 to 1 (1.0 when certain).\n\n\
         Rules:\n\
         - Do not repeat identical front values.\n\
         - Keep the set focused and practical (typically 6-25 cards unless a specific count/list is requested).\n\
         - Return only JSON matching the schema."
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditCardInput {
    pub id: i64,
    pub front: String,
    pub back: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawCardEdit {
    pub id: i64,
    pub front: String,
    pub back: String,
    pub example: Option<String>,
}

pub fn build_batch_edit_prompt(
    front_lang: &str,
    back_lang: &str,
    prompt: &str,
    cards: &[EditCardInput],
) -> String {
    let prompt = prompt.trim();
    let cards_json = serde_json::to_string(cards).unwrap_or_else(|_| "[]".to_string());
    format!(
        "You are editing an existing list of language flashcards.\n\
         The cards have front in {front_lang}, back in {back_lang}, and an optional example in {front_lang}.\n\n\
         Instruction from the learner:\n\
         {prompt}\n\n\
         Rules:\n\
         - Return ONLY cards that actually need changes to satisfy the instruction; omit cards that do not need any modification.\n\
         - Every returned item MUST preserve its exact \"id\" from the input JSON array. Never invent new IDs.\n\
         - When adding context/disambiguation (e.g. differentiating ser vs estar), keep it concise (e.g. short note in parentheses on back or front as appropriate) while preserving accurate translations.\n\
         - Keep existing example if still valid (unless asked to change/remove it), or add/update example if helpful/requested.\n\
         - Return only JSON matching the schema.\n\n\
         Input cards:\n\
         {cards_json}"
    )
}

pub fn edit_response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "integer" },
                        "front": { "type": "string" },
                        "back": { "type": "string" },
                        "example": { "type": "string" }
                    },
                    "required": ["id", "front", "back"]
                }
            }
        },
        "required": ["edits"]
    })
}

pub fn parse_edit_response(v: &Value) -> Result<Vec<RawCardEdit>, String> {
    if let Some(reason) = v
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return Err(format!("request was blocked by Gemini ({reason})"));
    }
    let candidate = v
        .pointer("/candidates/0")
        .ok_or_else(|| "no candidates in response".to_string())?;
    let text: String = candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        let finish = candidate
            .get("finishReason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(format!("empty answer (finishReason: {finish})"));
    }
    let parsed: Value = serde_json::from_str(strip_code_fence(&text))
        .map_err(|e| format!("answer was not valid JSON: {e}"))?;
    let edits = match parsed {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("edits") {
            Some(Value::Array(a)) => a,
            _ => return Err("answer has no \"edits\" array".into()),
        },
        _ => return Err("answer has unexpected shape".into()),
    };
    let mut out = Vec::new();
    for e in edits {
        let id = match e.get("id").and_then(Value::as_i64) {
            Some(id) => id,
            None => continue,
        };
        let front = e
            .get("front")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let back = e
            .get("back")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if front.is_empty() || back.is_empty() {
            continue;
        }
        let example = e
            .get("example")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        out.push(RawCardEdit {
            id,
            front,
            back,
            example,
        });
    }
    Ok(out)
}

fn strip_code_fence(s: &str) -> &str {
    let t = s.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim()
}

/// `(error.status, error.message)` from a Gemini error body, if it is one.
fn parse_error_body(text: &str) -> (Option<String>, Option<String>) {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => (
            v.pointer("/error/status")
                .and_then(Value::as_str)
                .map(String::from),
            v.pointer("/error/message")
                .and_then(Value::as_str)
                .map(String::from),
        ),
        Err(_) => (None, None),
    }
}

#[derive(Clone)]
pub struct GeminiClient {
    http: reqwest::Client,
    base_url: String,
    timeout: Duration,
}

impl GeminiClient {
    pub fn new(base_url: Option<String>) -> Self {
        Self::with_timeout(base_url, DEFAULT_TIMEOUT)
    }

    /// `timeout` bounds one HTTP attempt (connect + send + first byte + body).
    pub fn with_timeout(base_url: Option<String>, timeout: Duration) -> Self {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(10).min(timeout))
            .build()
            .expect("reqwest client");
        GeminiClient {
            http,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            timeout,
        }
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// One extraction. Logs the attempt at `debug`, the outcome at `info`
    /// (success) or `warn` (failure, with upstream status and truncated body),
    /// and retries a *fast* `503` once – the usual "high demand" answer. The
    /// retry only gets what is left of the per-call budget, so the whole call
    /// stays within `timeout` (+ a short backoff).
    pub async fn extract(
        &self,
        api_key: &str,
        model: &str,
        req: &ExtractRequest<'_>,
    ) -> Result<Vec<ExtractedCard>, GeminiError> {
        if api_key.trim().is_empty() {
            return Err(GeminiError::NoApiKey);
        }
        let url = format!(
            "{}/models/{}:generateContent",
            self.base_url.trim_end_matches('/'),
            model
        );
        let body = build_request_body(req);
        let body_bytes = serde_json::to_vec(&body).map(|b| b.len()).unwrap_or(0);
        let image_bytes: Vec<usize> = req.images.iter().map(ImageInput::approx_bytes).collect();
        tracing::debug!(
            model,
            url = %url,
            images = req.images.len(),
            ?image_bytes,
            body_bytes,
            hint_chars = req.hint.chars().count(),
            timeout_ms = self.timeout.as_millis() as u64,
            "gemini: sending generateContent"
        );

        let started = Instant::now();
        let backoff = RETRY_BACKOFF.min(self.timeout / 10);
        let mut attempt = 1u32;
        let mut attempt_timeout = self.timeout;
        loop {
            let res = self.attempt(&url, api_key, &body, attempt_timeout).await;
            match res {
                Ok((cards, elapsed, finish)) => {
                    tracing::info!(model, attempt, cards = cards.len(), latency_ms = elapsed.as_millis() as u64, finish_reason = %finish, "gemini: ok");
                    return Ok(cards);
                }
                Err(e) => {
                    let remaining = self.timeout.saturating_sub(started.elapsed() + backoff);
                    let retry = attempt == 1
                        && e.upstream_status() == Some(503)
                        && e.elapsed()
                            .map(|d| d < RETRY_IF_FASTER_THAN)
                            .unwrap_or(false)
                        && remaining >= MIN_RETRY_BUDGET;
                    tracing::warn!(
                        model,
                        attempt,
                        stage = e.stage(),
                        upstream_status = e.upstream_status(),
                        latency_ms = e.elapsed().map(|d| d.as_millis() as u64),
                        images = req.images.len(),
                        ?image_bytes,
                        body = e.body(),
                        error = %crate::error::chain(&e),
                        will_retry = retry,
                        retry_budget_ms = remaining.as_millis() as u64,
                        "gemini: request failed"
                    );
                    if !retry {
                        return Err(e);
                    }
                    tokio::time::sleep(backoff).await;
                    attempt += 1;
                    attempt_timeout = remaining;
                }
            }
        }
    }

    pub async fn generate(
        &self,
        api_key: &str,
        model: &str,
        front_lang: &str,
        back_lang: &str,
        prompt: &str,
    ) -> Result<Vec<ExtractedCard>, GeminiError> {
        if api_key.trim().is_empty() {
            return Err(GeminiError::NoApiKey);
        }
        let url = format!(
            "{}/models/{}:generateContent",
            self.base_url.trim_end_matches('/'),
            model
        );
        let body = json!({
            "contents": [{ "role": "user", "parts": [{ "text": build_generate_prompt(front_lang, back_lang, prompt) }] }],
            "generationConfig": {
                "temperature": 0.3,
                "response_mime_type": "application/json",
                "response_schema": response_schema()
            }
        });
        let body_bytes = serde_json::to_vec(&body).map(|b| b.len()).unwrap_or(0);
        tracing::debug!(
            model,
            url = %url,
            body_bytes,
            prompt_chars = prompt.chars().count(),
            timeout_ms = self.timeout.as_millis() as u64,
            "gemini: sending generateContent (generate)"
        );

        let started = Instant::now();
        let backoff = RETRY_BACKOFF.min(self.timeout / 10);
        let mut attempt = 1u32;
        let mut attempt_timeout = self.timeout;
        loop {
            let res = self.attempt(&url, api_key, &body, attempt_timeout).await;
            match res {
                Ok((cards, elapsed, finish)) => {
                    tracing::info!(model, attempt, cards = cards.len(), latency_ms = elapsed.as_millis() as u64, finish_reason = %finish, "gemini: generate ok");
                    return Ok(cards);
                }
                Err(e) => {
                    let remaining = self.timeout.saturating_sub(started.elapsed() + backoff);
                    let retry = attempt == 1
                        && e.upstream_status() == Some(503)
                        && e.elapsed()
                            .map(|d| d < RETRY_IF_FASTER_THAN)
                            .unwrap_or(false)
                        && remaining >= MIN_RETRY_BUDGET;
                    tracing::warn!(
                        model,
                        attempt,
                        stage = e.stage(),
                        upstream_status = e.upstream_status(),
                        latency_ms = e.elapsed().map(|d| d.as_millis() as u64),
                        prompt_chars = prompt.chars().count(),
                        body = e.body(),
                        error = %crate::error::chain(&e),
                        will_retry = retry,
                        retry_budget_ms = remaining.as_millis() as u64,
                        "gemini: generate request failed"
                    );
                    if !retry {
                        return Err(e);
                    }
                    tokio::time::sleep(backoff).await;
                    attempt += 1;
                    attempt_timeout = remaining;
                }
            }
        }
    }

    pub async fn edit_cards(
        &self,
        api_key: &str,
        model: &str,
        front_lang: &str,
        back_lang: &str,
        prompt: &str,
        cards: &[EditCardInput],
    ) -> Result<Vec<RawCardEdit>, GeminiError> {
        if api_key.trim().is_empty() {
            return Err(GeminiError::NoApiKey);
        }
        let url = format!(
            "{}/models/{}:generateContent",
            self.base_url.trim_end_matches('/'),
            model
        );
        let body = json!({
            "contents": [{ "role": "user", "parts": [{ "text": build_batch_edit_prompt(front_lang, back_lang, prompt, cards) }] }],
            "generationConfig": {
                "temperature": 0.2,
                "response_mime_type": "application/json",
                "response_schema": edit_response_schema()
            }
        });
        let body_bytes = serde_json::to_vec(&body).map(|b| b.len()).unwrap_or(0);
        tracing::debug!(
            model,
            url = %url,
            cards = cards.len(),
            body_bytes,
            prompt_chars = prompt.chars().count(),
            timeout_ms = self.timeout.as_millis() as u64,
            "gemini: sending generateContent (edit_cards)"
        );

        let started = Instant::now();
        let backoff = RETRY_BACKOFF.min(self.timeout / 10);
        let mut attempt = 1u32;
        let mut attempt_timeout = self.timeout;
        loop {
            let res = self
                .attempt_edit(&url, api_key, &body, attempt_timeout)
                .await;
            match res {
                Ok((edits, elapsed, finish)) => {
                    tracing::info!(model, attempt, edits = edits.len(), latency_ms = elapsed.as_millis() as u64, finish_reason = %finish, "gemini: edit_cards ok");
                    return Ok(edits);
                }
                Err(e) => {
                    let remaining = self.timeout.saturating_sub(started.elapsed() + backoff);
                    let retry = attempt == 1
                        && e.upstream_status() == Some(503)
                        && e.elapsed()
                            .map(|d| d < RETRY_IF_FASTER_THAN)
                            .unwrap_or(false)
                        && remaining >= MIN_RETRY_BUDGET;
                    tracing::warn!(
                        model,
                        attempt,
                        stage = e.stage(),
                        upstream_status = e.upstream_status(),
                        latency_ms = e.elapsed().map(|d| d.as_millis() as u64),
                        cards = cards.len(),
                        prompt_chars = prompt.chars().count(),
                        body = e.body(),
                        error = %crate::error::chain(&e),
                        will_retry = retry,
                        retry_budget_ms = remaining.as_millis() as u64,
                        "gemini: edit_cards request failed"
                    );
                    if !retry {
                        return Err(e);
                    }
                    tokio::time::sleep(backoff).await;
                    attempt += 1;
                    attempt_timeout = remaining;
                }
            }
        }
    }

    async fn post_json(
        &self,
        url: &str,
        api_key: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<(Value, String, Duration, String), GeminiError> {
        let t0 = Instant::now();
        let resp = self
            .http
            .post(url)
            .timeout(timeout)
            .header("x-goog-api-key", api_key)
            .json(body)
            .send()
            .await
            .map_err(|source| GeminiError::Transport {
                stage: "sending request",
                elapsed: t0.elapsed(),
                source,
            })?;
        let status = resp.status();
        let text = resp.text().await.map_err(|source| GeminiError::Transport {
            stage: "reading response",
            elapsed: t0.elapsed(),
            source,
        })?;
        let elapsed = t0.elapsed();
        if !status.is_success() {
            let (api_status, message) = parse_error_body(&text);
            return Err(GeminiError::Status {
                status: status.as_u16(),
                api_status,
                message: message.unwrap_or_else(|| truncate_body(text.trim(), 300)),
                body: truncate_body(&text, BODY_LOG_LIMIT),
                elapsed,
            });
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| GeminiError::BadResponse {
            reason: format!("not JSON: {e}"),
            body: truncate_body(&text, BODY_LOG_LIMIT),
            elapsed,
        })?;
        let finish = v
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
            .unwrap_or("-")
            .to_string();
        Ok((v, text, elapsed, finish))
    }

    /// One HTTP round-trip bounded by `timeout`; `Ok` carries (cards, latency, finishReason).
    async fn attempt(
        &self,
        url: &str,
        api_key: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<(Vec<ExtractedCard>, Duration, String), GeminiError> {
        let (v, text, elapsed, finish) = self.post_json(url, api_key, body, timeout).await?;
        let cards = parse_response(&v).map_err(|reason| GeminiError::BadResponse {
            reason,
            body: truncate_body(&text, BODY_LOG_LIMIT),
            elapsed,
        })?;
        Ok((cards, elapsed, finish))
    }

    /// One HTTP round-trip for batch edits bounded by `timeout`; `Ok` carries (edits, latency, finishReason).
    async fn attempt_edit(
        &self,
        url: &str,
        api_key: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<(Vec<RawCardEdit>, Duration, String), GeminiError> {
        let (v, text, elapsed, finish) = self.post_json(url, api_key, body, timeout).await?;
        let edits = parse_edit_response(&v).map_err(|reason| GeminiError::BadResponse {
            reason,
            body: truncate_body(&text, BODY_LOG_LIMIT),
            elapsed,
        })?;
        Ok((edits, elapsed, finish))
    }
}

/// Input caps for one extraction. The browser downscales photos to ~1600 px
/// JPEG (a few hundred KB), so these are generous but keep one request from
/// burning a lot of upload / Gemini quota.
pub const MAX_IMAGES: usize = 4;
/// Per image, base64 length (≈ 6 MB of raw JPEG).
pub const MAX_IMAGE_B64_BYTES: usize = 8 * 1024 * 1024;
/// All images together, base64 length.
pub const MAX_TOTAL_B64_BYTES: usize = 20 * 1024 * 1024;
/// HTTP body limit for `/api/*` – total images plus JSON/hint overhead.
pub const MAX_REQUEST_BYTES: usize = MAX_TOTAL_B64_BYTES + 1024 * 1024;
pub const MAX_HINT_CHARS: usize = 2000;
pub const MAX_EDIT_CARDS: usize = 200;
const _: () =
    assert!(MAX_REQUEST_BYTES > MAX_TOTAL_B64_BYTES && MAX_TOTAL_B64_BYTES >= MAX_IMAGE_B64_BYTES);

/// Validate and normalise the images sent by the browser.
pub fn validate_images(images: &[ImageInput]) -> Result<()> {
    if images.is_empty() {
        return Err(anyhow!("at least one image is required"));
    }
    if images.len() > MAX_IMAGES {
        return Err(anyhow!("at most {MAX_IMAGES} images per extraction"));
    }
    let mut total = 0usize;
    for img in images {
        if !matches!(
            img.mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif"
        ) {
            return Err(anyhow!("unsupported image type {}", img.mime_type));
        }
        if img.data.is_empty() {
            return Err(anyhow!("empty image"));
        }
        if img.data.len() > MAX_IMAGE_B64_BYTES {
            return Err(anyhow!(
                "image is too large (max ~{} MB after encoding)",
                MAX_IMAGE_B64_BYTES * 3 / 4 / 1024 / 1024
            ));
        }
        total += img.data.len();
    }
    if total > MAX_TOTAL_B64_BYTES {
        return Err(anyhow!(
            "images are too large together (max ~{} MB after encoding)",
            MAX_TOTAL_B64_BYTES * 3 / 4 / 1024 / 1024
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_mentions_languages_and_hint() {
        let p = build_prompt("Español", "Polski", "Only the blue box.");
        assert!(p.contains("in Español"));
        assert!(p.contains("in Polski"));
        assert!(p.contains("Only the blue box."));
        let p2 = build_prompt("Español", "Polski", "   ");
        assert!(!p2.contains("learner's instructions"));
    }

    #[test]
    fn request_body_has_text_then_images_and_json_mode() {
        let imgs = vec![ImageInput {
            mime_type: "image/jpeg".into(),
            data: "AAAA".into(),
        }];
        let body = build_request_body(&ExtractRequest {
            images: &imgs,
            hint: "",
            front_lang: "A",
            back_lang: "B",
        });
        let parts = body
            .pointer("/contents/0/parts")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].get("text").is_some());
        assert_eq!(
            parts[1].pointer("/inline_data/mime_type").unwrap(),
            "image/jpeg"
        );
        assert_eq!(
            body.pointer("/generationConfig/response_mime_type")
                .unwrap(),
            "application/json"
        );
    }

    #[test]
    fn parses_object_with_cards() {
        let v = json!({"candidates":[{"content":{"parts":[{"text":"{\"cards\":[{\"front\":\" hace sol \",\"back\":\"jest słonecznie\",\"confidence\":0.95},{\"front\":\"llueve\",\"back\":\"pada\",\"example\":\"Hoy llueve.\",\"confidence\":1.7},{\"front\":\"\",\"back\":\"\"}]}"}]},"finishReason":"STOP"}]});
        let cards = parse_response(&v).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].front, "hace sol");
        assert_eq!(cards[0].example, None);
        assert_eq!(cards[1].example.as_deref(), Some("Hoy llueve."));
        assert_eq!(cards[1].confidence, 1.0, "clamped");
    }

    #[test]
    fn parses_bare_array_and_code_fences_and_multiple_parts() {
        let v = json!({"candidates":[{"content":{"parts":[{"text":"```json\n[{\"front\":\"a\",\"back\":\"b\"}"},{"text":",{\"front\":\"c\",\"back\":\"d\",\"confidence\":0.5}]\n```"}]}}]});
        let cards = parse_response(&v).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].confidence, 1.0, "missing confidence defaults to 1");
        assert_eq!(cards[1].confidence, 0.5);
    }

    #[test]
    fn reports_blocked_empty_and_malformed() {
        let blocked = json!({"promptFeedback":{"blockReason":"SAFETY"}});
        assert!(parse_response(&blocked)
            .unwrap_err()
            .contains("blocked by Gemini (SAFETY)"));
        let empty = json!({"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]});
        let e = parse_response(&empty).unwrap_err();
        assert!(e.contains("MAX_TOKENS"), "{e}");
        let bad = json!({"candidates":[{"content":{"parts":[{"text":"not json"}]}}]});
        assert!(parse_response(&bad).unwrap_err().contains("not valid JSON"));
        let no_cards = json!({"candidates":[{"content":{"parts":[{"text":"{\"foo\":1}"}]}}]});
        assert!(parse_response(&no_cards).unwrap_err().contains("cards"));
        assert!(parse_response(&json!({}))
            .unwrap_err()
            .contains("no candidates"));
    }

    #[test]
    fn model_name_is_validated() {
        assert_eq!(
            clean_model(" models/gemini-2.5-flash ").unwrap(),
            "gemini-2.5-flash",
            "prefix stripped, trimmed"
        );
        assert_eq!(
            clean_model("gemini-2.0-flash_exp.v1").unwrap(),
            "gemini-2.0-flash_exp.v1"
        );
        let e = clean_model("gemini flash; drop").unwrap_err().to_string();
        assert!(e.contains(DEFAULT_MODEL), "{e}");
        assert!(clean_model("x".repeat(81).as_str()).is_err());
        assert!(clean_model("models/").is_err());
        assert!(clean_model("").is_err());
        assert_eq!(GeminiConfig::default().model, DEFAULT_MODEL);
        assert!(GeminiConfig::default().api_key.is_none());
    }

    #[test]
    fn body_truncation_keeps_char_boundaries() {
        assert_eq!(truncate_body("short", 10), "short");
        let t = truncate_body("ąąąąą", 3); // each 'ą' is 2 bytes → cut at 2
        assert!(t.starts_with("ą…"), "{t}");
        assert!(t.contains("[10 bytes total]"), "{t}");
        let long = "x".repeat(BODY_LOG_LIMIT + 5);
        let t = truncate_body(&long, BODY_LOG_LIMIT);
        assert!(t.len() < long.len() + 30 && t.ends_with("bytes total]"));
    }

    #[test]
    fn error_display_names_stage_status_and_message() {
        let e = GeminiError::Status {
            status: 503,
            api_status: Some("UNAVAILABLE".into()),
            message: "This model is currently experiencing high demand.".into(),
            body: "{...}".into(),
            elapsed: Duration::from_millis(2200),
        };
        assert_eq!(e.to_string(), "Gemini answered HTTP 503 UNAVAILABLE: This model is currently experiencing high demand.");
        assert_eq!(e.stage(), "upstream_status");
        assert_eq!(e.upstream_status(), Some(503));
        assert_eq!(e.body(), Some("{...}"));
        assert_eq!(e.elapsed(), Some(Duration::from_millis(2200)));

        let e = GeminiError::Status {
            status: 500,
            api_status: None,
            message: "<html>".into(),
            body: String::new(),
            elapsed: Duration::ZERO,
        };
        assert_eq!(e.to_string(), "Gemini answered HTTP 500: <html>");

        let e = GeminiError::BadResponse {
            reason: "answer has no \"cards\" array".into(),
            body: "{}".into(),
            elapsed: Duration::ZERO,
        };
        assert_eq!(
            e.to_string(),
            "could not understand Gemini's answer: answer has no \"cards\" array"
        );
        assert_eq!(e.stage(), "parse");
        assert!(e.upstream_status().is_none());

        assert_eq!(GeminiError::NoApiKey.stage(), "config");
        assert!(GeminiError::NoApiKey.to_string().contains("GEMINI_API_KEY"));
        assert!(GeminiError::NoApiKey.elapsed().is_none());
    }

    #[test]
    fn upstream_error_body_is_parsed_for_status_and_message() {
        let (st, msg) =
            parse_error_body(r#"{"error":{"code":503,"message":"busy","status":"UNAVAILABLE"}}"#);
        assert_eq!(st.as_deref(), Some("UNAVAILABLE"));
        assert_eq!(msg.as_deref(), Some("busy"));
        assert_eq!(parse_error_body("<html>502</html>"), (None, None));
        assert_eq!(parse_error_body(r#"{"error":"flat"}"#), (None, None));
    }

    #[test]
    fn image_validation() {
        assert!(validate_images(&[]).is_err());
        assert!(validate_images(&[ImageInput {
            mime_type: "image/gif".into(),
            data: "x".into()
        }])
        .is_err());
        assert!(validate_images(&[ImageInput {
            mime_type: "image/jpeg".into(),
            data: "".into()
        }])
        .is_err());
        assert!(validate_images(&[ImageInput {
            mime_type: "image/jpeg".into(),
            data: "x".into()
        }])
        .is_ok());
        let five: Vec<_> = (0..5)
            .map(|_| ImageInput {
                mime_type: "image/jpeg".into(),
                data: "x".into(),
            })
            .collect();
        assert!(validate_images(&five).is_err());
        // Size caps: one image just over the per-image limit, and 3 under it but over the total.
        let big = ImageInput {
            mime_type: "image/jpeg".into(),
            data: "x".repeat(MAX_IMAGE_B64_BYTES + 1),
        };
        assert!(validate_images(std::slice::from_ref(&big))
            .unwrap_err()
            .to_string()
            .contains("too large"));
        let ok = ImageInput {
            mime_type: "image/jpeg".into(),
            data: "x".repeat(MAX_IMAGE_B64_BYTES),
        };
        assert!(validate_images(std::slice::from_ref(&ok)).is_ok());
        let three = vec![ok.clone(), ok.clone(), ok];
        assert!(validate_images(&three)
            .unwrap_err()
            .to_string()
            .contains("together"));
    }

    #[test]
    fn generate_prompt_mentions_languages_and_prompt() {
        let p = build_generate_prompt("Español", "Polski", "animals in the jungle");
        assert!(p.contains("in Español"));
        assert!(p.contains("in Polski"));
        assert!(p.contains("animals in the jungle"));
        assert!(p.contains("\"front\""));
        assert!(p.contains("\"back\""));
        assert!(p.contains("confidence"));
    }

    #[test]
    fn batch_edit_prompt_contains_cards_and_rules() {
        let cards = vec![
            EditCardInput {
                id: 42,
                front: "el perro".into(),
                back: "pies".into(),
                example: Some("El perro ladra.".into()),
            },
            EditCardInput {
                id: 43,
                front: "el gato".into(),
                back: "kot".into(),
                example: None,
            },
        ];
        let p = build_batch_edit_prompt("Español", "Polski", "Add plural forms", &cards);
        assert!(p.contains("in Español"));
        assert!(p.contains("in Polski"));
        assert!(p.contains("Add plural forms"));
        assert!(p.contains("\"id\":42"));
        assert!(p.contains("\"id\":43"));
        assert!(p.contains("preserve its exact \"id\""));
    }

    #[test]
    fn parses_edit_response_formats_and_strips_fences() {
        // Wrapped in {"edits": [...]}
        let v1 = json!({
            "candidates": [{
                "content": {
                    "parts": [{
                        "text": "```json\n{\"edits\": [{\"id\": 1, \"front\": \" ser \", \"back\": \" być (cecha stała) \", \"example\": \" Soy profesor. \"}, {\"id\": 2, \"front\": \"\", \"back\": \"\"}]}\n```"
                    }]
                },
                "finishReason": "STOP"
            }]
        });
        let edits1 = parse_edit_response(&v1).unwrap();
        assert_eq!(edits1.len(), 1);
        assert_eq!(
            edits1[0],
            RawCardEdit {
                id: 1,
                front: "ser".into(),
                back: "być (cecha stała)".into(),
                example: Some("Soy profesor.".into()),
            }
        );

        // Bare array format [...]
        let v2 = json!({
            "candidates": [{
                "content": {
                    "parts": [{
                        "text": "[{\"id\": 5, \"front\": \"estar\", \"back\": \"być (stan)\", \"example\": \"   \"}]"
                    }]
                }
            }]
        });
        let edits2 = parse_edit_response(&v2).unwrap();
        assert_eq!(edits2.len(), 1);
        assert_eq!(
            edits2[0],
            RawCardEdit {
                id: 5,
                front: "estar".into(),
                back: "być (stan)".into(),
                example: None,
            }
        );

        // Blocked & error cases
        let blocked = json!({"promptFeedback": {"blockReason": "SAFETY"}});
        assert!(parse_edit_response(&blocked)
            .unwrap_err()
            .contains("blocked by Gemini (SAFETY)"));

        let bad_json = json!({"candidates": [{"content": {"parts": [{"text": "not-json"}]}}]});
        assert!(parse_edit_response(&bad_json)
            .unwrap_err()
            .contains("not valid JSON"));

        let bad_shape =
            json!({"candidates": [{"content": {"parts": [{"text": "{\"other\": []}"}]}}]});
        assert!(parse_edit_response(&bad_shape)
            .unwrap_err()
            .contains("answer has no \"edits\" array"));
    }
}
