//! Gemini client used to turn a photo of a textbook page into card pairs.
//!
//! The API key never leaves the server: the browser uploads the (downscaled)
//! image here, and this module calls the Generative Language REST API with
//! structured (JSON-schema) output so the result is machine-parseable.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::models::ExtractedCard;

pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInput {
    /// e.g. "image/jpeg"
    pub mime_type: String,
    /// base64 (no data: prefix)
    pub data: String,
}

#[derive(Debug, Clone)]
pub struct ExtractRequest<'a> {
    pub images: &'a [ImageInput],
    pub hint: &'a str,
    pub front_lang: &'a str,
    pub back_lang: &'a str,
}

/// Errors that the UI should show verbatim (configuration / upstream problems).
#[derive(Debug, thiserror::Error)]
pub enum GeminiError {
    #[error("Gemini API key is not configured – add it in Settings")]
    NoApiKey,
    #[error("Gemini request failed: {0}")]
    Upstream(String),
    #[error("Could not understand Gemini's answer: {0}")]
    BadResponse(String),
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

/// Pull the card list out of a `generateContent` response.
pub fn parse_response(v: &Value) -> Result<Vec<ExtractedCard>, GeminiError> {
    if let Some(reason) = v.pointer("/promptFeedback/blockReason").and_then(Value::as_str) {
        return Err(GeminiError::Upstream(format!("request was blocked ({reason})")));
    }
    let candidate = v
        .pointer("/candidates/0")
        .ok_or_else(|| GeminiError::BadResponse("no candidates in response".into()))?;
    let text: String = candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
        .unwrap_or_default();
    if text.trim().is_empty() {
        let finish = candidate.get("finishReason").and_then(Value::as_str).unwrap_or("unknown");
        return Err(GeminiError::BadResponse(format!("empty answer (finishReason: {finish})")));
    }
    let parsed: Value = serde_json::from_str(strip_code_fence(&text))
        .map_err(|e| GeminiError::BadResponse(format!("answer was not valid JSON: {e}")))?;
    let cards = match parsed {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("cards") {
            Some(Value::Array(a)) => a,
            _ => return Err(GeminiError::BadResponse("answer has no \"cards\" array".into())),
        },
        _ => return Err(GeminiError::BadResponse("answer has unexpected shape".into())),
    };
    let mut out = Vec::new();
    for c in cards {
        let front = c.get("front").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let back = c.get("back").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if front.is_empty() && back.is_empty() {
            continue;
        }
        let example = c.get("example").and_then(Value::as_str).map(str::trim).filter(|e| !e.is_empty()).map(String::from);
        let confidence = c.get("confidence").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.0, 1.0);
        out.push(ExtractedCard { front, back, example, confidence, existing_in: None, existing_card_id: None });
    }
    Ok(out)
}

fn strip_code_fence(s: &str) -> &str {
    let t = s.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim()
}

#[derive(Clone)]
pub struct GeminiClient {
    http: reqwest::Client,
    base_url: String,
}

impl GeminiClient {
    pub fn new(base_url: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .build()
            .expect("reqwest client");
        GeminiClient { http, base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()) }
    }

    pub async fn extract(&self, api_key: &str, model: &str, req: &ExtractRequest<'_>) -> Result<Vec<ExtractedCard>, GeminiError> {
        if api_key.trim().is_empty() {
            return Err(GeminiError::NoApiKey);
        }
        let url = format!("{}/models/{}:generateContent", self.base_url.trim_end_matches('/'), model);
        let body = build_request_body(req);
        let resp = self
            .http
            .post(&url)
            .header("x-goog-api-key", api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| GeminiError::Upstream(format!("network error: {e}")))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| GeminiError::Upstream(format!("reading response: {e}")))?;
        if !status.is_success() {
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(String::from))
                .unwrap_or_else(|| text.chars().take(300).collect());
            return Err(GeminiError::Upstream(format!("HTTP {}: {}", status.as_u16(), msg)));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| GeminiError::BadResponse(format!("not JSON: {e}")))?;
        parse_response(&v)
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
const _: () = assert!(MAX_REQUEST_BYTES > MAX_TOTAL_B64_BYTES && MAX_TOTAL_B64_BYTES >= MAX_IMAGE_B64_BYTES);

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
        if !matches!(img.mime_type.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif") {
            return Err(anyhow!("unsupported image type {}", img.mime_type));
        }
        if img.data.is_empty() {
            return Err(anyhow!("empty image"));
        }
        if img.data.len() > MAX_IMAGE_B64_BYTES {
            return Err(anyhow!("image is too large (max ~{} MB after encoding)", MAX_IMAGE_B64_BYTES * 3 / 4 / 1024 / 1024));
        }
        total += img.data.len();
    }
    if total > MAX_TOTAL_B64_BYTES {
        return Err(anyhow!("images are too large together (max ~{} MB after encoding)", MAX_TOTAL_B64_BYTES * 3 / 4 / 1024 / 1024));
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
        let imgs = vec![ImageInput { mime_type: "image/jpeg".into(), data: "AAAA".into() }];
        let body = build_request_body(&ExtractRequest { images: &imgs, hint: "", front_lang: "A", back_lang: "B" });
        let parts = body.pointer("/contents/0/parts").unwrap().as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].get("text").is_some());
        assert_eq!(parts[1].pointer("/inline_data/mime_type").unwrap(), "image/jpeg");
        assert_eq!(body.pointer("/generationConfig/response_mime_type").unwrap(), "application/json");
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
        assert!(matches!(parse_response(&blocked), Err(GeminiError::Upstream(_))));
        let empty = json!({"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]});
        let e = parse_response(&empty).unwrap_err().to_string();
        assert!(e.contains("MAX_TOKENS"), "{e}");
        let bad = json!({"candidates":[{"content":{"parts":[{"text":"not json"}]}}]});
        assert!(matches!(parse_response(&bad), Err(GeminiError::BadResponse(_))));
        let no_cards = json!({"candidates":[{"content":{"parts":[{"text":"{\"foo\":1}"}]}}]});
        assert!(matches!(parse_response(&no_cards), Err(GeminiError::BadResponse(_))));
        assert!(matches!(parse_response(&json!({})), Err(GeminiError::BadResponse(_))));
    }

    #[test]
    fn image_validation() {
        assert!(validate_images(&[]).is_err());
        assert!(validate_images(&[ImageInput { mime_type: "image/gif".into(), data: "x".into() }]).is_err());
        assert!(validate_images(&[ImageInput { mime_type: "image/jpeg".into(), data: "".into() }]).is_err());
        assert!(validate_images(&[ImageInput { mime_type: "image/jpeg".into(), data: "x".into() }]).is_ok());
        let five: Vec<_> = (0..5).map(|_| ImageInput { mime_type: "image/jpeg".into(), data: "x".into() }).collect();
        assert!(validate_images(&five).is_err());
        // Size caps: one image just over the per-image limit, and 3 under it but over the total.
        let big = ImageInput { mime_type: "image/jpeg".into(), data: "x".repeat(MAX_IMAGE_B64_BYTES + 1) };
        assert!(validate_images(std::slice::from_ref(&big)).unwrap_err().to_string().contains("too large"));
        let ok = ImageInput { mime_type: "image/jpeg".into(), data: "x".repeat(MAX_IMAGE_B64_BYTES) };
        assert!(validate_images(std::slice::from_ref(&ok)).is_ok());
        let three = vec![ok.clone(), ok.clone(), ok];
        assert!(validate_images(&three).unwrap_err().to_string().contains("together"));
    }
}
