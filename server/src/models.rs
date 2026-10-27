//! Serialisable data types shared by the repository and the HTTP API.

use serde::{Deserialize, Serialize};

use crate::srs::Preview;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Unit {
    pub id: i64,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Lesson {
    pub id: i64,
    pub unit_id: i64,
    pub name: String,
    pub position: i64,
}

/// A card together with its group names and a derived status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Card {
    pub id: i64,
    pub lesson_id: i64,
    pub lesson_name: String,
    pub unit_id: i64,
    pub unit_name: String,
    pub front: String,
    pub back: String,
    pub example: Option<String>,
    pub state: i64,
    /// "new" | "due" | "learning" | "learned"
    pub status: String,
    pub due: i64,
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
    pub last_review: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Counts {
    pub total: i64,
    pub new: i64,
    pub due: i64,
    pub learning: i64,
    pub learned: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LessonOverview {
    pub id: i64,
    pub unit_id: i64,
    pub name: String,
    pub position: i64,
    #[serde(flatten)]
    pub counts: Counts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnitOverview {
    pub id: i64,
    pub name: String,
    pub position: i64,
    #[serde(flatten)]
    pub counts: Counts,
    pub lessons: Vec<LessonOverview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Overview {
    pub now: i64,
    #[serde(flatten)]
    pub counts: Counts,
    /// New cards still allowed today (daily limit minus already introduced).
    pub new_available: i64,
    pub new_studied_today: i64,
    pub reviews_today: i64,
    pub units: Vec<UnitOverview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub front_lang: String,
    pub back_lang: String,
    /// "front_to_back" | "back_to_front" | "mixed"
    pub study_direction: String,
    pub new_per_day: i64,
    pub haptics: bool,
    /// Read-only: `FISZKI_GEMINI_MODEL` on the server (default `gemini-flash-latest`).
    pub gemini_model: String,
    /// Read-only: whether `GEMINI_API_KEY` is set on the server.
    pub gemini_api_key_set: bool,
    pub last_lesson_id: Option<i64>,
    /// Kill switch for `/api/extract` (persisted).
    pub extraction_paused: bool,
    /// Extraction attempts started today (local day) / ever.
    pub extractions_today: i64,
    pub extractions_total: i64,
    /// Max extraction attempts per local day (from `FISZKI_EXTRACT_DAILY_CAP`; 0 = unlimited).
    #[serde(default)]
    pub extract_daily_cap: i64,
    /// UI colour theme: "light" (default – the Stitch design) | "dark" | "system".
    #[serde(default = "default_theme")]
    pub theme: String,
}

pub fn default_theme() -> String {
    crate::repo::DEFAULT_THEME.to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SettingsPatch {
    pub front_lang: Option<String>,
    pub back_lang: Option<String>,
    pub study_direction: Option<String>,
    pub new_per_day: Option<i64>,
    pub haptics: Option<bool>,
    pub last_lesson_id: Option<i64>,
    pub extraction_paused: Option<bool>,
    pub theme: Option<String>,
    /// Not settable from the app (server env only). Kept so that an old client
    /// or a stolen Basic-auth session gets an explicit 400 instead of a silent no-op.
    pub gemini_model: Option<String>,
    pub gemini_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StudyItem {
    pub card: Card,
    /// "forward" (front → back) or "reverse" (back → front)
    pub direction: String,
    pub preview: Preview,
    pub preview_labels: PreviewLabels,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreviewLabels {
    pub again: String,
    pub hard: String,
    pub good: String,
    pub easy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewResult {
    pub card: Card,
    pub due_in_secs: i64,
    pub due_label: String,
    /// Intervals the four grades would give on the card's *next* review.
    pub preview: Preview,
    pub preview_labels: PreviewLabels,
}

/// A card proposed by the extractor, before the user confirms it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtractedCard {
    pub front: String,
    pub back: String,
    #[serde(default)]
    pub example: Option<String>,
    /// 0..1 – lower means the model was unsure (blurry text, guessed translation).
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    /// Set when a card with the same front already exists.
    #[serde(default)]
    pub existing_in: Option<String>,
    #[serde(default)]
    pub existing_card_id: Option<i64>,
}

fn default_confidence() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AiCardEdit {
    pub card_id: i64,
    pub front: String,
    pub back: String,
    #[serde(default)]
    pub example: Option<String>,
    pub orig_front: String,
    pub orig_back: String,
    #[serde(default)]
    pub orig_example: Option<String>,
    pub lesson_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BulkCardUpdate {
    pub id: i64,
    pub front: String,
    pub back: String,
    #[serde(default)]
    pub example: Option<String>,
}
