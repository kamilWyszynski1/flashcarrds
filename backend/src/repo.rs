//! All database access lives here. Functions take a `&Connection` so they can
//! be used from HTTP handlers (behind the shared mutex) and from tests.

use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Serialize};

use crate::db::{now, start_of_local_day};
use crate::models::*;
use crate::srs::{self, Grade, SrsState, STATE_NEW};

// ---------------------------------------------------------------------------
// Units & lessons
// ---------------------------------------------------------------------------

pub fn list_units(conn: &Connection) -> Result<Vec<Unit>> {
    let mut st = conn.prepare("SELECT id, name, position FROM units ORDER BY position, id")?;
    let rows = st.query_map([], |r| {
        Ok(Unit { id: r.get(0)?, name: r.get(1)?, position: r.get(2)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_unit(conn: &Connection, id: i64) -> Result<Option<Unit>> {
    Ok(conn
        .query_row("SELECT id, name, position FROM units WHERE id=?1", [id], |r| {
            Ok(Unit { id: r.get(0)?, name: r.get(1)?, position: r.get(2)? })
        })
        .optional()?)
}

pub fn create_unit(conn: &Connection, name: &str) -> Result<Unit> {
    let name = clean_name(name)?;
    let pos: i64 = conn.query_row("SELECT COALESCE(MAX(position),0)+1 FROM units", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO units(name, position, created_at) VALUES (?1, ?2, ?3)",
        params![name, pos, now()],
    )?;
    Ok(Unit { id: conn.last_insert_rowid(), name, position: pos })
}

pub fn rename_unit(conn: &Connection, id: i64, name: &str) -> Result<Option<Unit>> {
    let name = clean_name(name)?;
    let n = conn.execute("UPDATE units SET name=?1 WHERE id=?2", params![name, id])?;
    if n == 0 {
        return Ok(None);
    }
    get_unit(conn, id)
}

pub fn delete_unit(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute("DELETE FROM units WHERE id=?1", [id])? > 0)
}

pub fn list_lessons(conn: &Connection) -> Result<Vec<Lesson>> {
    let mut st = conn.prepare(
        "SELECT l.id, l.unit_id, l.name, l.position FROM lessons l
         JOIN units u ON u.id = l.unit_id
         ORDER BY u.position, u.id, l.position, l.id",
    )?;
    let rows = st.query_map([], |r| {
        Ok(Lesson { id: r.get(0)?, unit_id: r.get(1)?, name: r.get(2)?, position: r.get(3)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_lesson(conn: &Connection, id: i64) -> Result<Option<Lesson>> {
    Ok(conn
        .query_row("SELECT id, unit_id, name, position FROM lessons WHERE id=?1", [id], |r| {
            Ok(Lesson { id: r.get(0)?, unit_id: r.get(1)?, name: r.get(2)?, position: r.get(3)? })
        })
        .optional()?)
}

pub fn create_lesson(conn: &Connection, unit_id: i64, name: &str) -> Result<Lesson> {
    let name = clean_name(name)?;
    if get_unit(conn, unit_id)?.is_none() {
        return Err(anyhow!("unit {unit_id} does not exist"));
    }
    let pos: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position),0)+1 FROM lessons WHERE unit_id=?1",
        [unit_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO lessons(unit_id, name, position, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![unit_id, name, pos, now()],
    )?;
    Ok(Lesson { id: conn.last_insert_rowid(), unit_id, name, position: pos })
}

pub fn update_lesson(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    unit_id: Option<i64>,
) -> Result<Option<Lesson>> {
    let Some(mut lesson) = get_lesson(conn, id)? else { return Ok(None) };
    if let Some(n) = name {
        lesson.name = clean_name(n)?;
    }
    if let Some(u) = unit_id {
        if get_unit(conn, u)?.is_none() {
            return Err(anyhow!("unit {u} does not exist"));
        }
        if u != lesson.unit_id {
            lesson.unit_id = u;
            lesson.position = conn.query_row(
                "SELECT COALESCE(MAX(position),0)+1 FROM lessons WHERE unit_id=?1",
                [u],
                |r| r.get(0),
            )?;
        }
    }
    conn.execute(
        "UPDATE lessons SET name=?1, unit_id=?2, position=?3 WHERE id=?4",
        params![lesson.name, lesson.unit_id, lesson.position, id],
    )?;
    Ok(Some(lesson))
}

pub fn delete_lesson(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute("DELETE FROM lessons WHERE id=?1", [id])? > 0)
}

fn clean_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(anyhow!("name must not be empty"));
    }
    if n.chars().count() > 120 {
        return Err(anyhow!("name is too long (max 120 characters)"));
    }
    Ok(n.to_string())
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

pub fn overview(conn: &Connection) -> Result<Overview> {
    let now_ts = now();
    let settings = get_settings(conn)?;
    let units = list_units(conn)?;

    let mut st = conn.prepare(
        "SELECT l.id, l.unit_id, l.name, l.position,
                COUNT(c.id),
                COALESCE(SUM(c.state = 0), 0),
                COALESCE(SUM(c.state <> 0 AND c.due <= ?1), 0),
                COALESCE(SUM(c.state IN (1,3) AND c.due > ?1), 0),
                COALESCE(SUM(c.state = 2 AND c.due > ?1), 0)
         FROM lessons l LEFT JOIN cards c ON c.lesson_id = l.id
         GROUP BY l.id ORDER BY l.position, l.id",
    )?;
    let lessons: Vec<LessonOverview> = st
        .query_map([now_ts], |r| {
            Ok(LessonOverview {
                id: r.get(0)?,
                unit_id: r.get(1)?,
                name: r.get(2)?,
                position: r.get(3)?,
                counts: Counts {
                    total: r.get(4)?,
                    new: r.get(5)?,
                    due: r.get(6)?,
                    learning: r.get(7)?,
                    learned: r.get(8)?,
                },
            })
        })?
        .collect::<Result<_, _>>()?;

    let mut total = Counts::default();
    let mut unit_views: Vec<UnitOverview> = units
        .into_iter()
        .map(|u| UnitOverview { id: u.id, name: u.name, position: u.position, counts: Counts::default(), lessons: vec![] })
        .collect();
    for l in lessons {
        add_counts(&mut total, &l.counts);
        if let Some(u) = unit_views.iter_mut().find(|u| u.id == l.unit_id) {
            add_counts(&mut u.counts, &l.counts);
            u.lessons.push(l);
        }
    }

    let (new_studied_today, reviews_today) = today_stats(conn, now_ts)?;
    let new_available = (settings.new_per_day - new_studied_today).max(0).min(total.new);

    Ok(Overview {
        now: now_ts,
        counts: total,
        new_available,
        new_studied_today,
        reviews_today,
        units: unit_views,
    })
}

fn add_counts(acc: &mut Counts, c: &Counts) {
    acc.total += c.total;
    acc.new += c.new;
    acc.due += c.due;
    acc.learning += c.learning;
    acc.learned += c.learned;
}

fn today_stats(conn: &Connection, now_ts: i64) -> Result<(i64, i64)> {
    let start = start_of_local_day(now_ts);
    let r = conn.query_row(
        "SELECT COALESCE(SUM(was_new),0), COUNT(*) FROM reviews WHERE reviewed_at >= ?1",
        [start],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;
    Ok(r)
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const CARD_SELECT: &str = "SELECT c.id, c.lesson_id, l.name, u.id, u.name, c.front, c.back, c.example,
       c.state, c.due, c.interval_days, c.ease, c.reps, c.lapses, c.last_review, c.created_at, c.updated_at
  FROM cards c JOIN lessons l ON l.id = c.lesson_id JOIN units u ON u.id = l.unit_id";

fn row_to_card(r: &Row<'_>, now_ts: i64) -> rusqlite::Result<Card> {
    let state: i64 = r.get(8)?;
    let due: i64 = r.get(9)?;
    Ok(Card {
        id: r.get(0)?,
        lesson_id: r.get(1)?,
        lesson_name: r.get(2)?,
        unit_id: r.get(3)?,
        unit_name: r.get(4)?,
        front: r.get(5)?,
        back: r.get(6)?,
        example: r.get(7)?,
        state,
        status: srs::status_for(state, due, now_ts).to_string(),
        due,
        interval_days: r.get(10)?,
        ease: r.get(11)?,
        reps: r.get(12)?,
        lapses: r.get(13)?,
        last_review: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CardFilter {
    pub lesson_id: Option<i64>,
    pub unit_id: Option<i64>,
    /// Case-insensitive substring match on front/back/example.
    pub q: Option<String>,
    /// "new" | "due" | "learning" | "learned" | "hard" (lapses>0 or ease low)
    pub status: Option<String>,
    /// "created" (default, newest first) | "alpha" | "due"
    pub sort: Option<String>,
    pub limit: Option<i64>,
}

pub fn list_cards(conn: &Connection, f: &CardFilter) -> Result<Vec<Card>> {
    let now_ts = now();
    let mut sql = String::from(CARD_SELECT);
    let mut wh: Vec<String> = vec![];
    let mut args: Vec<Box<dyn ToSql>> = vec![];

    if let Some(l) = f.lesson_id {
        args.push(Box::new(l));
        wh.push(format!("c.lesson_id = ?{}", args.len()));
    }
    if let Some(u) = f.unit_id {
        args.push(Box::new(u));
        wh.push(format!("u.id = ?{}", args.len()));
    }
    // Free-text search is done in Rust: SQLite's lower() is ASCII-only, so
    // "ESTÁ" would not match "está" in SQL. Card counts are small (hundreds).
    let needle = f.q.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(|q| q.to_lowercase());
    if let Some(s) = f.status.as_deref() {
        let mut with_now = |tmpl: &str| {
            args.push(Box::new(now_ts));
            wh.push(tmpl.replace("?N", &format!("?{}", args.len())));
        };
        match s {
            "new" => wh.push("c.state = 0".into()),
            "due" => with_now("c.state <> 0 AND c.due <= ?N"),
            "learning" => with_now("c.state IN (1,3) AND c.due > ?N"),
            "learned" => with_now("c.state = 2 AND c.due > ?N"),
            "hard" => wh.push("(c.lapses > 0 OR (c.reps > 0 AND c.ease < 2.0))".into()),
            "" | "all" => {}
            other => return Err(anyhow!("unknown status filter '{other}'")),
        }
    }
    if !wh.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wh.join(" AND "));
    }
    sql.push_str(match f.sort.as_deref() {
        Some("alpha") => " ORDER BY lower(c.front), c.id",
        Some("due") => " ORDER BY c.state = 0, c.due, c.id",
        _ => " ORDER BY c.created_at DESC, c.id DESC",
    });
    let limit = f.limit.unwrap_or(2000).clamp(1, 10_000) as usize;

    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(args.iter().map(|a| a.as_ref())), |r| row_to_card(r, now_ts))?;
    let mut out = Vec::new();
    for row in rows {
        let c = row?;
        if let Some(n) = &needle {
            let hit = c.front.to_lowercase().contains(n.as_str())
                || c.back.to_lowercase().contains(n.as_str())
                || c.example.as_deref().map(|e| e.to_lowercase().contains(n.as_str())).unwrap_or(false);
            if !hit {
                continue;
            }
        }
        out.push(c);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

pub fn get_card(conn: &Connection, id: i64) -> Result<Option<Card>> {
    let now_ts = now();
    let sql = format!("{CARD_SELECT} WHERE c.id = ?1");
    Ok(conn.query_row(&sql, [id], |r| row_to_card(r, now_ts)).optional()?)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NewCard {
    pub front: String,
    pub back: String,
    #[serde(default)]
    pub example: Option<String>,
}

fn clean_card(c: &NewCard) -> Result<(String, String, Option<String>)> {
    let front = c.front.trim();
    let back = c.back.trim();
    if front.is_empty() || back.is_empty() {
        return Err(anyhow!("both sides of a card are required"));
    }
    if front.chars().count() > 500 || back.chars().count() > 500 {
        return Err(anyhow!("card text is too long (max 500 characters per side)"));
    }
    let example = c.example.as_deref().map(str::trim).filter(|e| !e.is_empty()).map(|e| e.chars().take(1000).collect());
    Ok((front.to_string(), back.to_string(), example))
}

pub fn create_card(conn: &Connection, lesson_id: i64, c: &NewCard) -> Result<Card> {
    let ids = create_cards(conn, lesson_id, std::slice::from_ref(c))?;
    get_card(conn, ids[0])?.ok_or_else(|| anyhow!("card vanished"))
}

/// Insert many cards in one transaction; returns the new ids in input order.
pub fn create_cards(conn: &Connection, lesson_id: i64, cards: &[NewCard]) -> Result<Vec<i64>> {
    if get_lesson(conn, lesson_id)?.is_none() {
        return Err(anyhow!("lesson {lesson_id} does not exist"));
    }
    let cleaned: Vec<_> = cards.iter().map(clean_card).collect::<Result<_>>()?;
    let ts = now();
    let srs = SrsState::new_card(ts);
    let tx = conn.unchecked_transaction()?;
    let mut ids = Vec::with_capacity(cleaned.len());
    {
        let mut st = tx.prepare(
            "INSERT INTO cards(lesson_id, front, back, example, state, due, interval_days, ease, reps, lapses, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, ?9, ?9)",
        )?;
        // Rowids are monotonic, so (created_at, id) ordering preserves input order.
        for (front, back, example) in &cleaned {
            st.execute(params![lesson_id, front, back, example, srs.state, srs.due, srs.interval_days, srs.ease, ts])?;
            ids.push(tx.last_insert_rowid());
        }
    }
    tx.commit()?;
    set_setting(conn, "last_lesson_id", &lesson_id.to_string())?;
    Ok(ids)
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CardPatch {
    pub front: Option<String>,
    pub back: Option<String>,
    /// `Some(None)` is not expressible in JSON; send "" to clear the example.
    pub example: Option<String>,
    pub lesson_id: Option<i64>,
    /// Reset scheduling (back to "new").
    #[serde(default)]
    pub reset_progress: bool,
}

pub fn update_card(conn: &Connection, id: i64, p: &CardPatch) -> Result<Option<Card>> {
    let Some(cur) = get_card(conn, id)? else { return Ok(None) };
    let nc = NewCard {
        front: p.front.clone().unwrap_or(cur.front),
        back: p.back.clone().unwrap_or(cur.back),
        example: match &p.example {
            Some(e) => Some(e.clone()),
            None => cur.example,
        },
    };
    let (front, back, example) = clean_card(&nc)?;
    let lesson_id = p.lesson_id.unwrap_or(cur.lesson_id);
    if get_lesson(conn, lesson_id)?.is_none() {
        return Err(anyhow!("lesson {lesson_id} does not exist"));
    }
    let ts = now();
    conn.execute(
        "UPDATE cards SET front=?1, back=?2, example=?3, lesson_id=?4, updated_at=?5 WHERE id=?6",
        params![front, back, example, lesson_id, ts, id],
    )?;
    if p.reset_progress {
        let s = SrsState::new_card(ts);
        conn.execute(
            "UPDATE cards SET state=?1, due=?2, interval_days=?3, ease=?4, reps=0, lapses=0, last_review=NULL WHERE id=?5",
            params![s.state, s.due, s.interval_days, s.ease, id],
        )?;
    }
    get_card(conn, id)
}

pub fn delete_card(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute("DELETE FROM cards WHERE id=?1", [id])? > 0)
}

/// Normalised front text used for duplicate detection.
pub fn normalize_front(s: &str) -> String {
    s.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Map from normalised front → (card id, "lesson name") for duplicate hints.
pub fn existing_fronts(conn: &Connection) -> Result<HashMap<String, (i64, String)>> {
    let mut st = conn.prepare("SELECT c.id, c.front, l.name FROM cards c JOIN lessons l ON l.id=c.lesson_id ORDER BY c.id")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, front, lesson) = row?;
        map.entry(normalize_front(&front)).or_insert((id, lesson));
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// `gemini-flash-latest` is an alias Google keeps pointing at the current
/// Flash model, so a fresh install works without knowing today's version.
pub const DEFAULT_MODEL: &str = "gemini-flash-latest";

/// Accept `gemini-2.5-flash`, `models/gemini-flash-latest`, etc.; reject
/// anything that cannot be a model id so a typo fails here with a clear
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
    if !m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')) {
        return Err(anyhow!("model name may only contain letters, digits, '-', '.' and '_' (e.g. {DEFAULT_MODEL})"));
    }
    Ok(m.to_string())
}

/// The Stitch design only exists in light; dark is an opt-in derived palette,
/// so a fresh install must never auto-switch on `prefers-color-scheme`.
pub const DEFAULT_THEME: &str = "light";
pub const THEMES: [&str; 3] = ["light", "dark", "system"];

pub fn clean_theme(t: &str) -> Result<String> {
    let t = t.trim().to_ascii_lowercase();
    if !THEMES.contains(&t.as_str()) {
        return Err(anyhow!("theme must be one of {}", THEMES.join(", ")));
    }
    Ok(t)
}

fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()?)
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn del_setting(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM settings WHERE key=?1", [key])?;
    Ok(())
}

pub fn get_api_key(conn: &Connection) -> Result<Option<String>> {
    get_setting(conn, "gemini_api_key")
}

pub fn get_settings(conn: &Connection) -> Result<Settings> {
    let key = get_api_key(conn)?.filter(|k| !k.is_empty());
    let usage = extraction_usage(conn, now())?;
    Ok(Settings {
        front_lang: get_setting(conn, "front_lang")?.unwrap_or_else(|| "Español".into()),
        back_lang: get_setting(conn, "back_lang")?.unwrap_or_else(|| "Polski".into()),
        study_direction: get_setting(conn, "study_direction")?.unwrap_or_else(|| "front_to_back".into()),
        new_per_day: get_setting(conn, "new_per_day")?.and_then(|v| v.parse().ok()).unwrap_or(15),
        haptics: get_setting(conn, "haptics")?.map(|v| v == "true").unwrap_or(true),
        gemini_model: get_setting(conn, "gemini_model")?.filter(|m| !m.is_empty()).unwrap_or_else(|| DEFAULT_MODEL.into()),
        gemini_api_key_set: key.is_some(),
        gemini_api_key_hint: key.map(|k| {
            let tail: String = k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            format!("…{tail}")
        }),
        last_lesson_id: get_setting(conn, "last_lesson_id")?.and_then(|v| v.parse().ok()),
        extraction_paused: extraction_paused(conn)?,
        extractions_today: usage.today,
        extractions_total: usage.total,
        extract_daily_cap: 0,
        theme: get_setting(conn, "theme")?.and_then(|t| clean_theme(&t).ok()).unwrap_or_else(|| DEFAULT_THEME.into()),
    })
}

pub fn patch_settings(conn: &Connection, p: &SettingsPatch) -> Result<Settings> {
    if let Some(v) = &p.front_lang {
        set_setting(conn, "front_lang", &clean_name(v)?)?;
    }
    if let Some(v) = &p.back_lang {
        set_setting(conn, "back_lang", &clean_name(v)?)?;
    }
    if let Some(v) = &p.study_direction {
        if !matches!(v.as_str(), "front_to_back" | "back_to_front" | "mixed") {
            return Err(anyhow!("study_direction must be front_to_back, back_to_front or mixed"));
        }
        set_setting(conn, "study_direction", v)?;
    }
    if let Some(v) = p.new_per_day {
        if !(0..=500).contains(&v) {
            return Err(anyhow!("new_per_day must be between 0 and 500"));
        }
        set_setting(conn, "new_per_day", &v.to_string())?;
    }
    if let Some(v) = p.haptics {
        set_setting(conn, "haptics", if v { "true" } else { "false" })?;
    }
    if let Some(v) = &p.gemini_model {
        if v.trim().is_empty() {
            // Empty = back to the default.
            del_setting(conn, "gemini_model")?;
        } else {
            set_setting(conn, "gemini_model", &clean_model(v)?)?;
        }
    }
    if let Some(v) = &p.gemini_api_key {
        let k = v.trim();
        if k.is_empty() {
            del_setting(conn, "gemini_api_key")?;
        } else {
            set_setting(conn, "gemini_api_key", k)?;
        }
    }
    if let Some(v) = p.last_lesson_id {
        set_setting(conn, "last_lesson_id", &v.to_string())?;
    }
    if let Some(v) = p.extraction_paused {
        set_setting(conn, "extraction_paused", if v { "true" } else { "false" })?;
    }
    if let Some(v) = &p.theme {
        set_setting(conn, "theme", &clean_theme(v)?)?;
    }
    get_settings(conn)
}

// ---------------------------------------------------------------------------
// Extraction safeguards (persisted in `settings`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ExtractionUsage {
    pub today: i64,
    pub total: i64,
}

pub fn extraction_paused(conn: &Connection) -> Result<bool> {
    Ok(get_setting(conn, "extraction_paused")?.map(|v| v == "true").unwrap_or(false))
}

/// Attempts started today (local day containing `now_ts`) and overall.
pub fn extraction_usage(conn: &Connection, now_ts: i64) -> Result<ExtractionUsage> {
    let total = get_setting(conn, "extract_total")?.and_then(|v| v.parse().ok()).unwrap_or(0);
    let day = get_setting(conn, "extract_day")?.and_then(|v| v.parse::<i64>().ok());
    let today = if day == Some(start_of_local_day(now_ts)) {
        get_setting(conn, "extract_today")?.and_then(|v| v.parse().ok()).unwrap_or(0)
    } else {
        0
    };
    Ok(ExtractionUsage { today, total })
}

/// Count one attempt (called before the Gemini request so failures count too).
pub fn record_extraction(conn: &Connection, now_ts: i64) -> Result<ExtractionUsage> {
    let cur = extraction_usage(conn, now_ts)?;
    let next = ExtractionUsage { today: cur.today + 1, total: cur.total + 1 };
    let tx = conn.unchecked_transaction()?;
    set_setting(&tx, "extract_day", &start_of_local_day(now_ts).to_string())?;
    set_setting(&tx, "extract_today", &next.today.to_string())?;
    set_setting(&tx, "extract_total", &next.total.to_string())?;
    tx.commit()?;
    Ok(next)
}

// ---------------------------------------------------------------------------
// Study
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueueRequest {
    /// "all" (default) | "lesson:ID" | "unit:ID"
    pub scope: Option<String>,
    /// "due" (default: due + new within the daily limit) | "all" (every card in scope)
    pub mode: Option<String>,
    /// Explicit comma-separated card ids (e.g. "repeat the missed ones").
    pub ids: Option<String>,
    pub limit: Option<i64>,
    /// Overrides the study-direction setting for this session.
    pub direction: Option<String>,
}

pub fn study_queue(conn: &Connection, req: &QueueRequest) -> Result<Vec<StudyItem>> {
    let now_ts = now();
    let settings = get_settings(conn)?;
    let limit = req.limit.unwrap_or(200).clamp(1, 1000) as usize;

    let mut cards: Vec<Card> = Vec::new();
    if let Some(ids) = req.ids.as_deref().filter(|s| !s.trim().is_empty()) {
        for id in ids.split(',') {
            let id: i64 = id.trim().parse().map_err(|_| anyhow!("bad card id '{id}'"))?;
            if let Some(c) = get_card(conn, id)? {
                cards.push(c);
            }
        }
    } else {
        let mut filter = CardFilter { sort: Some("due".into()), limit: Some(10_000), ..Default::default() };
        match req.scope.as_deref().unwrap_or("all") {
            "all" | "" => {}
            s if s.starts_with("lesson:") => filter.lesson_id = Some(parse_scope_id(s)?),
            s if s.starts_with("unit:") => filter.unit_id = Some(parse_scope_id(s)?),
            other => return Err(anyhow!("unknown scope '{other}'")),
        }
        let all = list_cards(conn, &filter)?;
        let mode = req.mode.as_deref().unwrap_or("due");
        let (new_studied_today, _) = today_stats(conn, now_ts)?;
        let mut new_budget = if mode == "all" { usize::MAX } else { (settings.new_per_day - new_studied_today).max(0) as usize };

        let (due, rest): (Vec<Card>, Vec<Card>) = all.into_iter().partition(|c| c.state != STATE_NEW && c.due <= now_ts);
        cards.extend(due);
        let (new, later): (Vec<Card>, Vec<Card>) = rest.into_iter().partition(|c| c.state == STATE_NEW);
        let mut new = new;
        new.sort_by_key(|c| (c.created_at, c.id));
        for c in new {
            if new_budget == 0 {
                break;
            }
            new_budget -= 1;
            cards.push(c);
        }
        if mode == "all" {
            cards.extend(later);
        }
    }
    cards.truncate(limit);

    let direction_setting = req.direction.clone().unwrap_or(settings.study_direction);
    let items = cards
        .into_iter()
        .enumerate()
        .map(|(i, card)| {
            let s = card_srs(&card);
            let preview = srs::preview(&s, now_ts);
            // "mixed": cheap deterministic-per-session pseudo randomness.
            let mixed_reverse = (card.id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(now_ts as u64 ^ i as u64) >> 63 == 1;
            let direction = match direction_setting.as_str() {
                "back_to_front" => "reverse",
                "mixed" if mixed_reverse => "reverse",
                _ => "forward",
            }
            .to_string();
            StudyItem {
                card,
                direction,
                preview,
                preview_labels: PreviewLabels {
                    again: srs::human_interval(preview.again),
                    hard: srs::human_interval(preview.hard),
                    good: srs::human_interval(preview.good),
                    easy: srs::human_interval(preview.easy),
                },
            }
        })
        .collect();
    Ok(items)
}

fn parse_scope_id(s: &str) -> Result<i64> {
    s.split_once(':')
        .and_then(|(_, id)| id.parse().ok())
        .ok_or_else(|| anyhow!("bad scope '{s}'"))
}

fn card_srs(c: &Card) -> SrsState {
    SrsState {
        state: c.state,
        due: c.due,
        interval_days: c.interval_days,
        ease: c.ease,
        reps: c.reps,
        lapses: c.lapses,
        last_review: c.last_review,
    }
}

pub fn apply_review(conn: &Connection, card_id: i64, grade: Grade, direction: Option<&str>) -> Result<Option<ReviewResult>> {
    let Some(card) = get_card(conn, card_id)? else { return Ok(None) };
    let now_ts = now();
    let before = card_srs(&card);
    let after = srs::schedule(&before, grade, now_ts);
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE cards SET state=?1, due=?2, interval_days=?3, ease=?4, reps=?5, lapses=?6, last_review=?7, updated_at=?7 WHERE id=?8",
        params![after.state, after.due, after.interval_days, after.ease, after.reps, after.lapses, now_ts, card_id],
    )?;
    tx.execute(
        "INSERT INTO reviews(card_id, grade, reviewed_at, was_new, interval_before, interval_after, direction)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![card_id, grade.as_i64(), now_ts, before.is_new() as i64, before.interval_days, after.interval_days, direction],
    )?;
    tx.commit()?;
    let card = get_card(conn, card_id)?.context("card vanished")?;
    let due_in_secs = after.due - now_ts;
    // Previews for the *next* answer, so the client can refresh a card it re-queues in-session.
    let preview = srs::preview(&after, now_ts);
    let preview_labels = PreviewLabels {
        again: srs::human_interval(preview.again),
        hard: srs::human_interval(preview.hard),
        good: srs::human_interval(preview.good),
        easy: srs::human_interval(preview.easy),
    };
    Ok(Some(ReviewResult { card, due_in_secs, due_label: srs::human_interval(due_in_secs), preview, preview_labels }))
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backup {
    pub version: u32,
    pub exported_at: i64,
    pub units: Vec<BackupUnit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupUnit {
    pub name: String,
    pub lessons: Vec<BackupLesson>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupLesson {
    pub name: String,
    pub cards: Vec<BackupCard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupCard {
    pub front: String,
    pub back: String,
    #[serde(default)]
    pub example: Option<String>,
    #[serde(default)]
    pub state: i64,
    #[serde(default)]
    pub due: i64,
    #[serde(default)]
    pub interval_days: f64,
    #[serde(default = "default_ease")]
    pub ease: f64,
    #[serde(default)]
    pub reps: i64,
    #[serde(default)]
    pub lapses: i64,
    #[serde(default)]
    pub last_review: Option<i64>,
}

fn default_ease() -> f64 {
    2.5
}

pub fn export(conn: &Connection) -> Result<Backup> {
    let units = list_units(conn)?;
    let lessons = list_lessons(conn)?;
    let cards = list_cards(conn, &CardFilter { sort: Some("alpha".into()), limit: Some(10_000), ..Default::default() })?;
    let out = units
        .into_iter()
        .map(|u| BackupUnit {
            lessons: lessons
                .iter()
                .filter(|l| l.unit_id == u.id)
                .map(|l| BackupLesson {
                    cards: cards
                        .iter()
                        .filter(|c| c.lesson_id == l.id)
                        .map(|c| BackupCard {
                            front: c.front.clone(),
                            back: c.back.clone(),
                            example: c.example.clone(),
                            state: c.state,
                            due: c.due,
                            interval_days: c.interval_days,
                            ease: c.ease,
                            reps: c.reps,
                            lapses: c.lapses,
                            last_review: c.last_review,
                        })
                        .collect(),
                    name: l.name.clone(),
                })
                .collect(),
            name: u.name,
        })
        .collect();
    Ok(Backup { version: 1, exported_at: now(), units: out })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportReport {
    pub units_created: usize,
    pub lessons_created: usize,
    pub cards_created: usize,
    pub cards_skipped: usize,
}

/// Merge a backup into the database: units/lessons are matched by name,
/// cards are skipped when the same front+back already exists in that lesson.
pub fn import(conn: &Connection, b: &Backup) -> Result<ImportReport> {
    let mut rep = ImportReport::default();
    let tx = conn.unchecked_transaction()?;
    let ts = now();
    for bu in &b.units {
        let unit_id = match tx
            .query_row("SELECT id FROM units WHERE name=?1", [&bu.name], |r| r.get::<_, i64>(0))
            .optional()?
        {
            Some(id) => id,
            None => {
                rep.units_created += 1;
                create_unit(&tx, &bu.name)?.id
            }
        };
        for bl in &bu.lessons {
            let lesson_id = match tx
                .query_row("SELECT id FROM lessons WHERE unit_id=?1 AND name=?2", params![unit_id, &bl.name], |r| r.get::<_, i64>(0))
                .optional()?
            {
                Some(id) => id,
                None => {
                    rep.lessons_created += 1;
                    create_lesson(&tx, unit_id, &bl.name)?.id
                }
            };
            for bc in &bl.cards {
                let nc = NewCard { front: bc.front.clone(), back: bc.back.clone(), example: bc.example.clone() };
                let Ok((front, back, example)) = clean_card(&nc) else {
                    rep.cards_skipped += 1;
                    continue;
                };
                let exists: Option<i64> = tx
                    .query_row(
                        "SELECT id FROM cards WHERE lesson_id=?1 AND lower(front)=lower(?2) AND lower(back)=lower(?3)",
                        params![lesson_id, &front, &back],
                        |r| r.get(0),
                    )
                    .optional()?;
                if exists.is_some() {
                    rep.cards_skipped += 1;
                    continue;
                }
                let due = if bc.state == STATE_NEW || bc.due == 0 { ts } else { bc.due };
                tx.execute(
                    "INSERT INTO cards(lesson_id, front, back, example, state, due, interval_days, ease, reps, lapses, last_review, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)",
                    params![lesson_id, front, back, example, bc.state.clamp(0, 3), due, bc.interval_days.max(0.0), bc.ease.max(1.3), bc.reps.max(0), bc.lapses.max(0), bc.last_review, ts],
                )?;
                rep.cards_created += 1;
            }
        }
    }
    tx.commit()?;
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> Connection {
        db::open(None).unwrap()
    }

    fn seed(c: &Connection) -> (Unit, Lesson, Lesson) {
        let u = create_unit(c, "Unidad 1 · Nosotros").unwrap();
        let l1 = create_lesson(c, u.id, "1.1 Saludos").unwrap();
        let l2 = create_lesson(c, u.id, "1.2 Números").unwrap();
        (u, l1, l2)
    }

    #[test]
    fn groups_crud_and_cascade() {
        let c = conn();
        let (u, l1, _l2) = seed(&c);
        assert_eq!(list_units(&c).unwrap().len(), 1);
        assert_eq!(list_lessons(&c).unwrap().len(), 2);
        create_card(&c, l1.id, &NewCard { front: "hola".into(), back: "cześć".into(), example: None }).unwrap();
        assert!(rename_unit(&c, u.id, "  Unidad 1  ").unwrap().unwrap().name == "Unidad 1");
        assert!(create_unit(&c, "   ").is_err());
        assert!(create_lesson(&c, 999, "x").is_err());
        assert!(delete_unit(&c, u.id).unwrap());
        assert_eq!(list_lessons(&c).unwrap().len(), 0);
        assert_eq!(list_cards(&c, &CardFilter::default()).unwrap().len(), 0, "cards cascade with the unit");
        assert!(!delete_unit(&c, u.id).unwrap());
    }

    #[test]
    fn cards_crud_search_and_filters() {
        let c = conn();
        let (_u, l1, l2) = seed(&c);
        let ids = create_cards(
            &c,
            l1.id,
            &[
                NewCard { front: "la plaza".into(), back: "plac".into(), example: Some("La plaza está en el centro.".into()) },
                NewCard { front: " el barrio ".into(), back: "dzielnica".into(), example: Some("  ".into()) },
            ],
        )
        .unwrap();
        assert_eq!(ids.len(), 2);
        let all = list_cards(&c, &CardFilter { sort: Some("alpha".into()), ..Default::default() }).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].front, "el barrio", "trimmed");
        assert_eq!(all[0].example, None, "blank example becomes NULL");
        assert_eq!(all[0].status, "new");
        assert_eq!(all[0].lesson_name, "1.1 Saludos");

        // Search is case-insensitive and crosses both sides.
        assert_eq!(list_cards(&c, &CardFilter { q: Some("PLAC".into()), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(list_cards(&c, &CardFilter { q: Some("centro".into()), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(list_cards(&c, &CardFilter { q: Some("ESTÁ".into()), ..Default::default() }).unwrap().len(), 1, "unicode case-insensitive");
        assert_eq!(list_cards(&c, &CardFilter { q: Some("zzz".into()), ..Default::default() }).unwrap().len(), 0);
        assert_eq!(list_cards(&c, &CardFilter { lesson_id: Some(l2.id), ..Default::default() }).unwrap().len(), 0);
        assert_eq!(list_cards(&c, &CardFilter { status: Some("new".into()), ..Default::default() }).unwrap().len(), 2);
        assert_eq!(list_cards(&c, &CardFilter { status: Some("due".into()), ..Default::default() }).unwrap().len(), 0);
        assert!(list_cards(&c, &CardFilter { status: Some("bogus".into()), ..Default::default() }).is_err());

        // Validation.
        assert!(create_card(&c, l1.id, &NewCard { front: "".into(), back: "x".into(), example: None }).is_err());
        assert!(create_card(&c, 999, &NewCard { front: "a".into(), back: "b".into(), example: None }).is_err());

        // Update + move + clear example.
        let upd = update_card(&c, ids[0], &CardPatch { back: Some("plac (miejski)".into()), lesson_id: Some(l2.id), example: Some("".into()), ..Default::default() })
            .unwrap()
            .unwrap();
        assert_eq!(upd.back, "plac (miejski)");
        assert_eq!(upd.lesson_id, l2.id);
        assert_eq!(upd.example, None);
        assert!(update_card(&c, 12345, &CardPatch::default()).unwrap().is_none());

        assert!(delete_card(&c, ids[1]).unwrap());
        assert!(!delete_card(&c, ids[1]).unwrap());
        assert_eq!(list_cards(&c, &CardFilter::default()).unwrap().len(), 1);

        // last_lesson_id remembers where we saved last.
        assert_eq!(get_settings(&c).unwrap().last_lesson_id, Some(l1.id));
    }

    #[test]
    fn overview_counts_and_new_budget() {
        let c = conn();
        let (u, l1, l2) = seed(&c);
        create_cards(&c, l1.id, &(0..5).map(|i| NewCard { front: format!("w{i}"), back: "x".into(), example: None }).collect::<Vec<_>>()).unwrap();
        create_cards(&c, l2.id, &[NewCard { front: "uno".into(), back: "jeden".into(), example: None }]).unwrap();
        patch_settings(&c, &SettingsPatch { new_per_day: Some(3), ..Default::default() }).unwrap();

        let o = overview(&c).unwrap();
        assert_eq!(o.counts.total, 6);
        assert_eq!(o.counts.new, 6);
        assert_eq!(o.new_available, 3);
        assert_eq!(o.units.len(), 1);
        assert_eq!(o.units[0].id, u.id);
        assert_eq!(o.units[0].counts.total, 6);
        assert_eq!(o.units[0].lessons.len(), 2);
        assert_eq!(o.units[0].lessons[0].counts.total, 5);

        // Review one new card: it leaves "new", new_available shrinks.
        let first = list_cards(&c, &CardFilter { lesson_id: Some(l1.id), sort: Some("alpha".into()), ..Default::default() }).unwrap()[0].id;
        let r = apply_review(&c, first, Grade::Good, Some("forward")).unwrap().unwrap();
        assert_eq!(r.card.status, "learned");
        assert_eq!(r.due_label, "1 day");
        let o = overview(&c).unwrap();
        assert_eq!(o.counts.new, 5);
        assert_eq!(o.counts.learned, 1);
        assert_eq!(o.new_studied_today, 1);
        assert_eq!(o.reviews_today, 1);
        assert_eq!(o.new_available, 2);

        // Again keeps it in learning and due within a minute.
        let r = apply_review(&c, first, Grade::Again, None).unwrap().unwrap();
        assert_eq!(r.card.status, "learning");
        assert!(r.due_in_secs <= 600);
        assert!(apply_review(&c, 999, Grade::Good, None).unwrap().is_none());
    }

    #[test]
    fn study_queue_respects_scope_budget_and_ids() {
        let c = conn();
        let (u, l1, l2) = seed(&c);
        create_cards(&c, l1.id, &(0..4).map(|i| NewCard { front: format!("a{i}"), back: "x".into(), example: None }).collect::<Vec<_>>()).unwrap();
        create_cards(&c, l2.id, &(0..4).map(|i| NewCard { front: format!("b{i}"), back: "x".into(), example: None }).collect::<Vec<_>>()).unwrap();
        patch_settings(&c, &SettingsPatch { new_per_day: Some(5), ..Default::default() }).unwrap();

        let q = study_queue(&c, &QueueRequest::default()).unwrap();
        assert_eq!(q.len(), 5, "new cards capped by daily budget");
        assert!(q.iter().all(|i| i.direction == "forward"));
        assert_eq!(q[0].preview_labels.good, "1 day");
        assert_eq!(q[0].preview_labels.easy, "4 days");

        let q = study_queue(&c, &QueueRequest { scope: Some(format!("lesson:{}", l2.id)), ..Default::default() }).unwrap();
        assert_eq!(q.len(), 4);
        assert!(q.iter().all(|i| i.card.lesson_id == l2.id));

        let q = study_queue(&c, &QueueRequest { scope: Some(format!("unit:{}", u.id)), mode: Some("all".into()), ..Default::default() }).unwrap();
        assert_eq!(q.len(), 8, "mode=all ignores the budget");

        // Make one card due in the past: it must come first.
        let target = q[7].card.id;
        c.execute("UPDATE cards SET state=2, due=0, interval_days=3 WHERE id=?1", [target]).unwrap();
        let q = study_queue(&c, &QueueRequest::default()).unwrap();
        assert_eq!(q[0].card.id, target);
        assert_eq!(q[0].card.status, "due");
        assert_eq!(q.len(), 6, "1 due + 5 new");

        // Explicit ids keep the given order.
        let ids = format!("{},{},{}", q[2].card.id, q[1].card.id, 99999);
        let q2 = study_queue(&c, &QueueRequest { ids: Some(ids), ..Default::default() }).unwrap();
        assert_eq!(q2.iter().map(|i| i.card.id).collect::<Vec<_>>(), vec![q[2].card.id, q[1].card.id]);

        // Direction override.
        let q3 = study_queue(&c, &QueueRequest { direction: Some("back_to_front".into()), ..Default::default() }).unwrap();
        assert!(q3.iter().all(|i| i.direction == "reverse"));
        assert!(study_queue(&c, &QueueRequest { scope: Some("galaxy:1".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn settings_roundtrip_and_key_masking() {
        let c = conn();
        let s = get_settings(&c).unwrap();
        assert_eq!(s.front_lang, "Español");
        assert_eq!(s.new_per_day, 15);
        assert!(!s.gemini_api_key_set);
        let s = patch_settings(
            &c,
            &SettingsPatch { front_lang: Some("Polski".into()), back_lang: Some("English".into()), gemini_api_key: Some("AIzaSyEXAMPLE1234".into()), study_direction: Some("mixed".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(s.front_lang, "Polski");
        assert_eq!(s.back_lang, "English");
        assert!(s.gemini_api_key_set);
        assert_eq!(s.gemini_api_key_hint.as_deref(), Some("…1234"));
        assert_eq!(s.study_direction, "mixed");
        assert_eq!(get_api_key(&c).unwrap().as_deref(), Some("AIzaSyEXAMPLE1234"));
        let s = patch_settings(&c, &SettingsPatch { gemini_api_key: Some("".into()), ..Default::default() }).unwrap();
        assert!(!s.gemini_api_key_set);
        assert!(patch_settings(&c, &SettingsPatch { study_direction: Some("sideways".into()), ..Default::default() }).is_err());
        assert!(patch_settings(&c, &SettingsPatch { new_per_day: Some(-1), ..Default::default() }).is_err());
    }

    #[test]
    fn model_name_is_validated_and_defaults() {
        let c = conn();
        assert_eq!(get_settings(&c).unwrap().gemini_model, DEFAULT_MODEL);
        let s = patch_settings(&c, &SettingsPatch { gemini_model: Some(" models/gemini-2.5-flash ".into()), ..Default::default() }).unwrap();
        assert_eq!(s.gemini_model, "gemini-2.5-flash", "prefix stripped, trimmed");
        let e = patch_settings(&c, &SettingsPatch { gemini_model: Some("gemini flash; drop".into()), ..Default::default() }).unwrap_err().to_string();
        assert!(e.contains(DEFAULT_MODEL), "{e}");
        assert!(patch_settings(&c, &SettingsPatch { gemini_model: Some("x".repeat(81)), ..Default::default() }).is_err());
        assert_eq!(get_settings(&c).unwrap().gemini_model, "gemini-2.5-flash", "rejected value did not overwrite");
        let s = patch_settings(&c, &SettingsPatch { gemini_model: Some("".into()), ..Default::default() }).unwrap();
        assert_eq!(s.gemini_model, DEFAULT_MODEL, "empty resets to default");
        assert!(clean_model("models/").is_err());
        assert_eq!(clean_model("gemini-2.0-flash_exp.v1").unwrap(), "gemini-2.0-flash_exp.v1");
    }

    #[test]
    fn theme_defaults_to_light_and_is_validated() {
        let c = conn();
        assert_eq!(get_settings(&c).unwrap().theme, "light", "fresh install must show the Stitch light design");
        for t in THEMES {
            let s = patch_settings(&c, &SettingsPatch { theme: Some(t.into()), ..Default::default() }).unwrap();
            assert_eq!(s.theme, t);
        }
        let s = patch_settings(&c, &SettingsPatch { theme: Some("  Dark ".into()), ..Default::default() }).unwrap();
        assert_eq!(s.theme, "dark", "trimmed and lower-cased");
        let e = patch_settings(&c, &SettingsPatch { theme: Some("sepia".into()), ..Default::default() }).unwrap_err().to_string();
        assert!(e.contains("light, dark, system"), "{e}");
        assert!(patch_settings(&c, &SettingsPatch { theme: Some("".into()), ..Default::default() }).is_err());
        assert_eq!(get_settings(&c).unwrap().theme, "dark", "rejected value did not overwrite");
        // Garbage written directly to the table (e.g. older build) falls back to the default.
        set_setting(&c, "theme", "neon").unwrap();
        assert_eq!(get_settings(&c).unwrap().theme, DEFAULT_THEME);
    }

    #[test]
    fn extraction_usage_counts_and_rolls_over_at_midnight() {
        let c = conn();
        let s = get_settings(&c).unwrap();
        assert!(!s.extraction_paused);
        assert_eq!((s.extractions_today, s.extractions_total), (0, 0));

        let t = 1_700_000_000;
        assert_eq!(record_extraction(&c, t).unwrap(), ExtractionUsage { today: 1, total: 1 });
        assert_eq!(record_extraction(&c, t + 60).unwrap(), ExtractionUsage { today: 2, total: 2 });
        assert_eq!(extraction_usage(&c, t + 61).unwrap(), ExtractionUsage { today: 2, total: 2 });
        // Next day: today's counter resets, the total keeps growing.
        let tomorrow = t + 86_400;
        assert_eq!(extraction_usage(&c, tomorrow).unwrap(), ExtractionUsage { today: 0, total: 2 });
        assert_eq!(record_extraction(&c, tomorrow).unwrap(), ExtractionUsage { today: 1, total: 3 });

        let s = patch_settings(&c, &SettingsPatch { extraction_paused: Some(true), ..Default::default() }).unwrap();
        assert!(s.extraction_paused);
        assert!(extraction_paused(&c).unwrap());
        let s = patch_settings(&c, &SettingsPatch { extraction_paused: Some(false), ..Default::default() }).unwrap();
        assert!(!s.extraction_paused);
    }

    #[test]
    fn duplicate_detection_normalises_fronts() {
        let c = conn();
        let (_u, l1, _) = seed(&c);
        create_card(&c, l1.id, &NewCard { front: "El  Paraguas".into(), back: "parasol".into(), example: None }).unwrap();
        let m = existing_fronts(&c).unwrap();
        assert!(m.contains_key("el paraguas"));
        assert_eq!(normalize_front("  el   paraguas "), "el paraguas");
    }

    #[test]
    fn export_import_roundtrip_is_idempotent() {
        let c = conn();
        let (_u, l1, _) = seed(&c);
        create_cards(&c, l1.id, &[NewCard { front: "hola".into(), back: "cześć".into(), example: None }, NewCard { front: "adiós".into(), back: "pa".into(), example: None }]).unwrap();
        let b = export(&c).unwrap();
        assert_eq!(b.units.len(), 1);
        assert_eq!(b.units[0].lessons[0].cards.len(), 2);

        let c2 = conn();
        let rep = import(&c2, &b).unwrap();
        assert_eq!((rep.units_created, rep.lessons_created, rep.cards_created, rep.cards_skipped), (1, 2, 2, 0));
        let rep = import(&c2, &b).unwrap();
        assert_eq!((rep.units_created, rep.lessons_created, rep.cards_created, rep.cards_skipped), (0, 0, 0, 2));
        assert_eq!(list_cards(&c2, &CardFilter::default()).unwrap().len(), 2);
    }
}
