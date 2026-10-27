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
        Ok(Unit {
            id: r.get(0)?,
            name: r.get(1)?,
            position: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_unit(conn: &Connection, id: i64) -> Result<Option<Unit>> {
    Ok(conn
        .query_row(
            "SELECT id, name, position FROM units WHERE id=?1",
            [id],
            |r| {
                Ok(Unit {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    position: r.get(2)?,
                })
            },
        )
        .optional()?)
}

pub fn create_unit(conn: &Connection, name: &str) -> Result<Unit> {
    let name = clean_name(name)?;
    let pos: i64 = conn.query_row("SELECT COALESCE(MAX(position),0)+1 FROM units", [], |r| {
        r.get(0)
    })?;
    conn.execute(
        "INSERT INTO units(name, position, created_at) VALUES (?1, ?2, ?3)",
        params![name, pos, now()],
    )?;
    Ok(Unit {
        id: conn.last_insert_rowid(),
        name,
        position: pos,
    })
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
        Ok(Lesson {
            id: r.get(0)?,
            unit_id: r.get(1)?,
            name: r.get(2)?,
            position: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_lesson(conn: &Connection, id: i64) -> Result<Option<Lesson>> {
    Ok(conn
        .query_row(
            "SELECT id, unit_id, name, position FROM lessons WHERE id=?1",
            [id],
            |r| {
                Ok(Lesson {
                    id: r.get(0)?,
                    unit_id: r.get(1)?,
                    name: r.get(2)?,
                    position: r.get(3)?,
                })
            },
        )
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
    Ok(Lesson {
        id: conn.last_insert_rowid(),
        unit_id,
        name,
        position: pos,
    })
}

pub fn update_lesson(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    unit_id: Option<i64>,
) -> Result<Option<Lesson>> {
    let Some(mut lesson) = get_lesson(conn, id)? else {
        return Ok(None);
    };
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
        .map(|u| UnitOverview {
            id: u.id,
            name: u.name,
            position: u.position,
            counts: Counts::default(),
            lessons: vec![],
        })
        .collect();
    for l in lessons {
        add_counts(&mut total, &l.counts);
        if let Some(u) = unit_views.iter_mut().find(|u| u.id == l.unit_id) {
            add_counts(&mut u.counts, &l.counts);
            u.lessons.push(l);
        }
    }

    let (new_studied_today, reviews_today) = today_stats(conn, now_ts)?;
    let new_available = (settings.new_per_day - new_studied_today)
        .max(0)
        .min(total.new);

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
    let needle =
        f.q.as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(|q| q.to_lowercase());
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
    let rows = st.query_map(params_from_iter(args.iter().map(|a| a.as_ref())), |r| {
        row_to_card(r, now_ts)
    })?;
    let mut out = Vec::new();
    for row in rows {
        let c = row?;
        if let Some(n) = &needle {
            let hit = c.front.to_lowercase().contains(n.as_str())
                || c.back.to_lowercase().contains(n.as_str())
                || c.example
                    .as_deref()
                    .map(|e| e.to_lowercase().contains(n.as_str()))
                    .unwrap_or(false);
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
    Ok(conn
        .query_row(&sql, [id], |r| row_to_card(r, now_ts))
        .optional()?)
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
        return Err(anyhow!(
            "card text is too long (max 500 characters per side)"
        ));
    }
    let example = c
        .example
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| e.chars().take(1000).collect());
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
            st.execute(params![
                lesson_id,
                front,
                back,
                example,
                srs.state,
                srs.due,
                srs.interval_days,
                srs.ease,
                ts
            ])?;
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
    let Some(cur) = get_card(conn, id)? else {
        return Ok(None);
    };
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

pub fn update_cards_bulk(conn: &Connection, updates: &[BulkCardUpdate]) -> Result<usize> {
    if updates.is_empty() {
        return Ok(0);
    }
    if updates.len() > 500 {
        return Err(anyhow!("too many updates in one request (max 500)"));
    }
    let cleaned: Vec<(i64, String, String, Option<String>)> = updates
        .iter()
        .map(|u| {
            let (front, back, example) = clean_card(&NewCard {
                front: u.front.clone(),
                back: u.back.clone(),
                example: u.example.clone(),
            })?;
            Ok((u.id, front, back, example))
        })
        .collect::<Result<_>>()?;

    let ts = now();
    let tx = conn.unchecked_transaction()?;
    let mut rows_affected = 0usize;
    {
        let mut st = tx
            .prepare("UPDATE cards SET front=?1, back=?2, example=?3, updated_at=?4 WHERE id=?5")?;
        for (id, front, back, example) in cleaned {
            rows_affected += st.execute(params![front, back, example, ts, id])?;
        }
    }
    tx.commit()?;
    Ok(rows_affected)
}

/// Normalised front text used for duplicate detection.
pub fn normalize_front(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Map from normalised front → (card id, "lesson name") for duplicate hints.
pub fn existing_fronts(conn: &Connection) -> Result<HashMap<String, (i64, String)>> {
    let mut st = conn.prepare("SELECT c.id, c.front, l.name FROM cards c JOIN lessons l ON l.id=c.lesson_id ORDER BY c.id")?;
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
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
//
// The Gemini key and model are *not* settings: they come from the server
// environment only (see `gemini::GeminiConfig`). Migration v2 purges any
// values an older build stored here.

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
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Persisted settings. `gemini_model` / `gemini_api_key_set` are placeholders
/// here – the route fills them from the server environment.
pub fn get_settings(conn: &Connection) -> Result<Settings> {
    let usage = extraction_usage(conn, now())?;
    Ok(Settings {
        front_lang: get_setting(conn, "front_lang")?.unwrap_or_else(|| "Español".into()),
        back_lang: get_setting(conn, "back_lang")?.unwrap_or_else(|| "Polski".into()),
        study_direction: get_setting(conn, "study_direction")?
            .unwrap_or_else(|| "front_to_back".into()),
        new_per_day: get_setting(conn, "new_per_day")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(15),
        haptics: get_setting(conn, "haptics")?
            .map(|v| v == "true")
            .unwrap_or(true),
        gemini_model: String::new(),
        gemini_api_key_set: false,
        last_lesson_id: get_setting(conn, "last_lesson_id")?.and_then(|v| v.parse().ok()),
        extraction_paused: extraction_paused(conn)?,
        extractions_today: usage.today,
        extractions_total: usage.total,
        extract_daily_cap: 0,
        theme: get_setting(conn, "theme")?
            .and_then(|t| clean_theme(&t).ok())
            .unwrap_or_else(|| DEFAULT_THEME.into()),
    })
}

pub const SERVER_ONLY_SETTING_MSG: &str =
    "the Gemini API key and model are configured on the server (GEMINI_API_KEY / FISZKI_GEMINI_MODEL) and cannot be changed from the app";

pub fn patch_settings(conn: &Connection, p: &SettingsPatch) -> Result<Settings> {
    // Rejected first, so a request that tries it changes nothing at all.
    if p.gemini_api_key.is_some() || p.gemini_model.is_some() {
        return Err(anyhow!(SERVER_ONLY_SETTING_MSG));
    }
    if let Some(v) = &p.front_lang {
        set_setting(conn, "front_lang", &clean_name(v)?)?;
    }
    if let Some(v) = &p.back_lang {
        set_setting(conn, "back_lang", &clean_name(v)?)?;
    }
    if let Some(v) = &p.study_direction {
        if !matches!(v.as_str(), "front_to_back" | "back_to_front" | "mixed") {
            return Err(anyhow!(
                "study_direction must be front_to_back, back_to_front or mixed"
            ));
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
    Ok(get_setting(conn, "extraction_paused")?
        .map(|v| v == "true")
        .unwrap_or(false))
}

/// Attempts started today (local day containing `now_ts`) and overall.
pub fn extraction_usage(conn: &Connection, now_ts: i64) -> Result<ExtractionUsage> {
    let total = get_setting(conn, "extract_total")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let day = get_setting(conn, "extract_day")?.and_then(|v| v.parse::<i64>().ok());
    let today = if day == Some(start_of_local_day(now_ts)) {
        get_setting(conn, "extract_today")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    } else {
        0
    };
    Ok(ExtractionUsage { today, total })
}

/// Count one attempt (called before the Gemini request so failures count too).
pub fn record_extraction(conn: &Connection, now_ts: i64) -> Result<ExtractionUsage> {
    let cur = extraction_usage(conn, now_ts)?;
    let next = ExtractionUsage {
        today: cur.today + 1,
        total: cur.total + 1,
    };
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
            let id: i64 = id
                .trim()
                .parse()
                .map_err(|_| anyhow!("bad card id '{id}'"))?;
            if let Some(c) = get_card(conn, id)? {
                cards.push(c);
            }
        }
    } else {
        let mut filter = CardFilter {
            sort: Some("due".into()),
            limit: Some(10_000),
            ..Default::default()
        };
        match req.scope.as_deref().unwrap_or("all") {
            "all" | "" => {}
            s if s.starts_with("lesson:") => filter.lesson_id = Some(parse_scope_id(s)?),
            s if s.starts_with("unit:") => filter.unit_id = Some(parse_scope_id(s)?),
            other => return Err(anyhow!("unknown scope '{other}'")),
        }
        let all = list_cards(conn, &filter)?;
        let mode = req.mode.as_deref().unwrap_or("due");
        let (new_studied_today, _) = today_stats(conn, now_ts)?;
        let mut new_budget = if mode == "all" {
            usize::MAX
        } else {
            (settings.new_per_day - new_studied_today).max(0) as usize
        };

        let (due, rest): (Vec<Card>, Vec<Card>) = all
            .into_iter()
            .partition(|c| c.state != STATE_NEW && c.due <= now_ts);
        cards.extend(due);
        let (new, later): (Vec<Card>, Vec<Card>) =
            rest.into_iter().partition(|c| c.state == STATE_NEW);
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
        // Truncate first (so `limit` still prefers due cards over new ones),
        // then randomise the order so every session feels different.
        // Explicit `ids` keep the caller's order; the client shuffles those.
        cards.truncate(limit);
        shuffle(&mut cards, &mut SessionRng::new());
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
            let mixed_reverse = (card.id as u64)
                .wrapping_mul(0x9E37_79B9_7F4A_7C15)
                .wrapping_add(now_ts as u64 ^ i as u64)
                >> 63
                == 1;
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

/// Small, dependency-free PRNG (splitmix64) for shuffling study queues.
/// Not cryptographic; it only has to make sessions feel different.
pub struct SessionRng(u64);

impl SessionRng {
    /// Seeded from std's per-process random hasher state mixed with the
    /// clock, so two queues requested back to back still differ.
    pub fn new() -> Self {
        use std::hash::{BuildHasher, Hasher};
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        Self::seeded(h.finish())
    }

    pub fn seeded(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (n > 0). Rejection sampling avoids modulo bias.
    fn below(&mut self, n: usize) -> usize {
        let n = n as u64;
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let v = self.next_u64();
            if v < zone {
                return (v % n) as usize;
            }
        }
    }
}

impl Default for SessionRng {
    fn default() -> Self {
        Self::new()
    }
}

/// In-place Fisher–Yates shuffle.
pub fn shuffle<T>(items: &mut [T], rng: &mut SessionRng) {
    for i in (1..items.len()).rev() {
        let j = rng.below(i + 1);
        items.swap(i, j);
    }
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

pub fn apply_review(
    conn: &Connection,
    card_id: i64,
    grade: Grade,
    direction: Option<&str>,
) -> Result<Option<ReviewResult>> {
    let Some(card) = get_card(conn, card_id)? else {
        return Ok(None);
    };
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
    Ok(Some(ReviewResult {
        card,
        due_in_secs,
        due_label: srs::human_interval(due_in_secs),
        preview,
        preview_labels,
    }))
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
    let cards = list_cards(
        conn,
        &CardFilter {
            sort: Some("alpha".into()),
            limit: Some(10_000),
            ..Default::default()
        },
    )?;
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
    Ok(Backup {
        version: 1,
        exported_at: now(),
        units: out,
    })
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
            .query_row("SELECT id FROM units WHERE name=?1", [&bu.name], |r| {
                r.get::<_, i64>(0)
            })
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
                .query_row(
                    "SELECT id FROM lessons WHERE unit_id=?1 AND name=?2",
                    params![unit_id, &bl.name],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
            {
                Some(id) => id,
                None => {
                    rep.lessons_created += 1;
                    create_lesson(&tx, unit_id, &bl.name)?.id
                }
            };
            for bc in &bl.cards {
                let nc = NewCard {
                    front: bc.front.clone(),
                    back: bc.back.clone(),
                    example: bc.example.clone(),
                };
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
                let due = if bc.state == STATE_NEW || bc.due == 0 {
                    ts
                } else {
                    bc.due
                };
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
        create_card(
            &c,
            l1.id,
            &NewCard {
                front: "hola".into(),
                back: "cześć".into(),
                example: None,
            },
        )
        .unwrap();
        assert!(rename_unit(&c, u.id, "  Unidad 1  ").unwrap().unwrap().name == "Unidad 1");
        assert!(create_unit(&c, "   ").is_err());
        assert!(create_lesson(&c, 999, "x").is_err());
        assert!(delete_unit(&c, u.id).unwrap());
        assert_eq!(list_lessons(&c).unwrap().len(), 0);
        assert_eq!(
            list_cards(&c, &CardFilter::default()).unwrap().len(),
            0,
            "cards cascade with the unit"
        );
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
                NewCard {
                    front: "la plaza".into(),
                    back: "plac".into(),
                    example: Some("La plaza está en el centro.".into()),
                },
                NewCard {
                    front: " el barrio ".into(),
                    back: "dzielnica".into(),
                    example: Some("  ".into()),
                },
            ],
        )
        .unwrap();
        assert_eq!(ids.len(), 2);
        let all = list_cards(
            &c,
            &CardFilter {
                sort: Some("alpha".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].front, "el barrio", "trimmed");
        assert_eq!(all[0].example, None, "blank example becomes NULL");
        assert_eq!(all[0].status, "new");
        assert_eq!(all[0].lesson_name, "1.1 Saludos");

        // Search is case-insensitive and crosses both sides.
        assert_eq!(
            list_cards(
                &c,
                &CardFilter {
                    q: Some("PLAC".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            list_cards(
                &c,
                &CardFilter {
                    q: Some("centro".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            list_cards(
                &c,
                &CardFilter {
                    q: Some("ESTÁ".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            1,
            "unicode case-insensitive"
        );
        assert_eq!(
            list_cards(
                &c,
                &CardFilter {
                    q: Some("zzz".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            0
        );
        assert_eq!(
            list_cards(
                &c,
                &CardFilter {
                    lesson_id: Some(l2.id),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            0
        );
        assert_eq!(
            list_cards(
                &c,
                &CardFilter {
                    status: Some("new".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            2
        );
        assert_eq!(
            list_cards(
                &c,
                &CardFilter {
                    status: Some("due".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            0
        );
        assert!(list_cards(
            &c,
            &CardFilter {
                status: Some("bogus".into()),
                ..Default::default()
            }
        )
        .is_err());

        // Validation.
        assert!(create_card(
            &c,
            l1.id,
            &NewCard {
                front: "".into(),
                back: "x".into(),
                example: None
            }
        )
        .is_err());
        assert!(create_card(
            &c,
            999,
            &NewCard {
                front: "a".into(),
                back: "b".into(),
                example: None
            }
        )
        .is_err());

        // Update + move + clear example.
        let upd = update_card(
            &c,
            ids[0],
            &CardPatch {
                back: Some("plac (miejski)".into()),
                lesson_id: Some(l2.id),
                example: Some("".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(upd.back, "plac (miejski)");
        assert_eq!(upd.lesson_id, l2.id);
        assert_eq!(upd.example, None);
        assert!(update_card(&c, 12345, &CardPatch::default())
            .unwrap()
            .is_none());

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
        create_cards(
            &c,
            l1.id,
            &(0..5)
                .map(|i| NewCard {
                    front: format!("w{i}"),
                    back: "x".into(),
                    example: None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        create_cards(
            &c,
            l2.id,
            &[NewCard {
                front: "uno".into(),
                back: "jeden".into(),
                example: None,
            }],
        )
        .unwrap();
        patch_settings(
            &c,
            &SettingsPatch {
                new_per_day: Some(3),
                ..Default::default()
            },
        )
        .unwrap();

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
        let first = list_cards(
            &c,
            &CardFilter {
                lesson_id: Some(l1.id),
                sort: Some("alpha".into()),
                ..Default::default()
            },
        )
        .unwrap()[0]
            .id;
        let r = apply_review(&c, first, Grade::Good, Some("forward"))
            .unwrap()
            .unwrap();
        assert_eq!(r.card.status, "learned");
        assert_eq!(r.due_label, "1 day");
        let o = overview(&c).unwrap();
        assert_eq!(o.counts.new, 5);
        assert_eq!(o.counts.learned, 1);
        assert_eq!(o.new_studied_today, 1);
        assert_eq!(o.reviews_today, 1);
        assert_eq!(o.new_available, 2);

        // Again keeps it in learning and due within a minute.
        let r = apply_review(&c, first, Grade::Again, None)
            .unwrap()
            .unwrap();
        assert_eq!(r.card.status, "learning");
        assert!(r.due_in_secs <= 600);
        assert!(apply_review(&c, 999, Grade::Good, None).unwrap().is_none());
    }

    #[test]
    fn study_queue_respects_scope_budget_and_ids() {
        let c = conn();
        let (u, l1, l2) = seed(&c);
        create_cards(
            &c,
            l1.id,
            &(0..4)
                .map(|i| NewCard {
                    front: format!("a{i}"),
                    back: "x".into(),
                    example: None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        create_cards(
            &c,
            l2.id,
            &(0..4)
                .map(|i| NewCard {
                    front: format!("b{i}"),
                    back: "x".into(),
                    example: None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        patch_settings(
            &c,
            &SettingsPatch {
                new_per_day: Some(5),
                ..Default::default()
            },
        )
        .unwrap();

        let q = study_queue(&c, &QueueRequest::default()).unwrap();
        assert_eq!(q.len(), 5, "new cards capped by daily budget");
        assert!(q.iter().all(|i| i.direction == "forward"));
        assert_eq!(q[0].preview_labels.good, "1 day");
        assert_eq!(q[0].preview_labels.easy, "4 days");

        let q = study_queue(
            &c,
            &QueueRequest {
                scope: Some(format!("lesson:{}", l2.id)),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(q.len(), 4);
        assert!(q.iter().all(|i| i.card.lesson_id == l2.id));

        let q = study_queue(
            &c,
            &QueueRequest {
                scope: Some(format!("unit:{}", u.id)),
                mode: Some("all".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(q.len(), 8, "mode=all ignores the budget");

        // Make one card due in the past: it is always part of the queue (position is random).
        let target = q[7].card.id;
        c.execute(
            "UPDATE cards SET state=2, due=0, interval_days=3 WHERE id=?1",
            [target],
        )
        .unwrap();
        let q = study_queue(&c, &QueueRequest::default()).unwrap();
        let due_item = q
            .iter()
            .find(|i| i.card.id == target)
            .expect("due card is in the queue");
        assert_eq!(due_item.card.status, "due");
        assert_eq!(q.len(), 6, "1 due + 5 new");

        // Explicit ids keep the given order.
        let ids = format!("{},{},{}", q[2].card.id, q[1].card.id, 99999);
        let q2 = study_queue(
            &c,
            &QueueRequest {
                ids: Some(ids),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            q2.iter().map(|i| i.card.id).collect::<Vec<_>>(),
            vec![q[2].card.id, q[1].card.id]
        );

        // Direction override.
        let q3 = study_queue(
            &c,
            &QueueRequest {
                direction: Some("back_to_front".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(q3.iter().all(|i| i.direction == "reverse"));
        assert!(study_queue(
            &c,
            &QueueRequest {
                scope: Some("galaxy:1".into()),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn shuffle_is_a_permutation_and_seed_deterministic() {
        // Empty and single-element slices are fine.
        let mut empty: Vec<i32> = vec![];
        shuffle(&mut empty, &mut SessionRng::seeded(1));
        assert!(empty.is_empty());
        let mut one = vec![42];
        shuffle(&mut one, &mut SessionRng::seeded(1));
        assert_eq!(one, vec![42]);

        let base: Vec<u32> = (0..50).collect();
        let mut a = base.clone();
        shuffle(&mut a, &mut SessionRng::seeded(7));
        let mut sorted = a.clone();
        sorted.sort();
        assert_eq!(sorted, base, "shuffle keeps every element exactly once");
        assert_ne!(
            a, base,
            "50 elements practically never come back in identity order"
        );

        let mut b = base.clone();
        shuffle(&mut b, &mut SessionRng::seeded(7));
        assert_eq!(a, b, "same seed, same order");
        let mut c = base.clone();
        shuffle(&mut c, &mut SessionRng::seeded(8));
        assert_ne!(a, c, "different seed, different order");

        // `below` stays in range and hits every bucket for a small n.
        let mut rng = SessionRng::seeded(3);
        let mut seen = [false; 5];
        for _ in 0..500 {
            let v = rng.below(5);
            assert!(v < 5);
            seen[v] = true;
        }
        assert!(seen.iter().all(|&s| s), "every bucket reachable");

        // Fresh seeds differ between consecutive sessions.
        let (x, y) = (SessionRng::new().next_u64(), SessionRng::new().next_u64());
        assert_ne!(x, y);
    }

    #[test]
    fn study_queue_order_varies_between_sessions() {
        let c = conn();
        let (_u, l1, _) = seed(&c);
        // 12 cards; mark 4 of them due so the queue mixes due + new.
        let ids = create_cards(
            &c,
            l1.id,
            &(0..12)
                .map(|i| NewCard {
                    front: format!("w{i}"),
                    back: "x".into(),
                    example: None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        for id in &ids[..4] {
            c.execute(
                "UPDATE cards SET state=2, due=0, interval_days=3 WHERE id=?1",
                [id],
            )
            .unwrap();
        }
        patch_settings(
            &c,
            &SettingsPatch {
                new_per_day: Some(8),
                ..Default::default()
            },
        )
        .unwrap();

        let order = |req: &QueueRequest| {
            study_queue(&c, req)
                .unwrap()
                .iter()
                .map(|i| i.card.id)
                .collect::<Vec<_>>()
        };
        let mut expected: Vec<i64> = ids.clone();
        expected.sort();

        let first = order(&QueueRequest::default());
        assert_eq!(first.len(), 12, "4 due + 8 new (budget)");
        let mut got = first.clone();
        got.sort();
        assert_eq!(got, expected, "shuffling never drops or duplicates a card");

        // Probability that 6 fresh draws all reproduce `first` is ~(1/12!)^6.
        let differs = (0..6).any(|_| order(&QueueRequest::default()) != first);
        assert!(
            differs,
            "the same cards should come in a different order in another session"
        );

        // Limit still prefers due cards: with limit=4 only the due ones are served, in some order.
        let mut limited = order(&QueueRequest {
            limit: Some(4),
            ..Default::default()
        });
        limited.sort();
        let mut due_ids: Vec<i64> = ids[..4].to_vec();
        due_ids.sort();
        assert_eq!(limited, due_ids);

        // New-card budget: 8 of 8 new cards fit, but with a budget of 3 only the 3 oldest new cards are served.
        patch_settings(
            &c,
            &SettingsPatch {
                new_per_day: Some(3),
                ..Default::default()
            },
        )
        .unwrap();
        let mut q = order(&QueueRequest::default());
        q.sort();
        let mut want: Vec<i64> = ids[..7].to_vec(); // 4 due + 3 oldest new (ids are monotonic)
        want.sort();
        assert_eq!(
            q, want,
            "budget still picks the oldest new cards, only the order is random"
        );

        // Explicit ids are untouched by the server shuffle.
        let explicit = format!("{},{},{}", ids[5], ids[1], ids[9]);
        assert_eq!(
            order(&QueueRequest {
                ids: Some(explicit),
                ..Default::default()
            }),
            vec![ids[5], ids[1], ids[9]]
        );

        // mode=all: the served *set* is still carved as due → new → not-yet-due before the shuffle,
        // so a limit never drops a due card in favour of one scheduled far in the future.
        let later = ids[11];
        c.execute(
            "UPDATE cards SET state=2, due=?1, interval_days=30 WHERE id=?2",
            [now() + 30 * 86_400, later],
        )
        .unwrap();
        let all_req = |limit: Option<i64>| QueueRequest {
            mode: Some("all".into()),
            limit,
            ..Default::default()
        };
        let mut everything = order(&all_req(None));
        everything.sort();
        assert_eq!(
            everything, expected,
            "mode=all ignores the budget and includes the not-yet-due card"
        );
        let capped = order(&all_req(Some(11)));
        assert_eq!(capped.len(), 11);
        assert!(
            !capped.contains(&later),
            "the not-yet-due card is the first to be cut by the limit"
        );
        let mut capped = order(&all_req(Some(6)));
        capped.sort();
        let mut want: Vec<i64> = ids[..6].to_vec(); // 4 due + 2 oldest new
        want.sort();
        assert_eq!(
            capped, want,
            "limit under mode=all still prefers due, then oldest new"
        );
    }

    #[test]
    fn settings_roundtrip() {
        let c = conn();
        let s = get_settings(&c).unwrap();
        assert_eq!(s.front_lang, "Español");
        assert_eq!(s.new_per_day, 15);
        let s = patch_settings(
            &c,
            &SettingsPatch {
                front_lang: Some("Polski".into()),
                back_lang: Some("English".into()),
                study_direction: Some("mixed".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.front_lang, "Polski");
        assert_eq!(s.back_lang, "English");
        assert_eq!(s.study_direction, "mixed");
        assert!(patch_settings(
            &c,
            &SettingsPatch {
                study_direction: Some("sideways".into()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(patch_settings(
            &c,
            &SettingsPatch {
                new_per_day: Some(-1),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn key_and_model_are_not_settings() {
        let c = conn();
        // Rejected with a clear message, and the other fields in the same patch are not applied either.
        for p in [
            SettingsPatch {
                gemini_api_key: Some("AIzaSyEXAMPLE1234".into()),
                front_lang: Some("Deutsch".into()),
                ..Default::default()
            },
            SettingsPatch {
                gemini_api_key: Some(String::new()),
                ..Default::default()
            },
            SettingsPatch {
                gemini_model: Some("gemini-2.5-pro".into()),
                ..Default::default()
            },
            SettingsPatch {
                gemini_model: Some(String::new()),
                ..Default::default()
            },
        ] {
            let e = patch_settings(&c, &p).unwrap_err().to_string();
            assert_eq!(e, SERVER_ONLY_SETTING_MSG);
        }
        assert_eq!(
            get_settings(&c).unwrap().front_lang,
            "Español",
            "rejected patch changed nothing"
        );
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM settings WHERE key IN ('gemini_api_key','gemini_model')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "nothing key/model-related is ever written");
    }

    #[test]
    fn migration_v2_purges_key_and_model_rows() {
        // Simulate a v1 database that still holds the key, then migrate.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::MIGRATIONS[0]).unwrap();
        c.execute_batch("PRAGMA user_version = 1;").unwrap();
        set_setting(&c, "gemini_api_key", "AIzaOld").unwrap();
        set_setting(&c, "gemini_model", "gemini-old").unwrap();
        set_setting(&c, "theme", "dark").unwrap();
        crate::db::migrate(&c).unwrap();
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM settings WHERE key IN ('gemini_api_key','gemini_model')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
        assert_eq!(
            get_settings(&c).unwrap().theme,
            "dark",
            "other settings survive"
        );
    }

    #[test]
    fn theme_defaults_to_light_and_is_validated() {
        let c = conn();
        assert_eq!(
            get_settings(&c).unwrap().theme,
            "light",
            "fresh install must show the Stitch light design"
        );
        for t in THEMES {
            let s = patch_settings(
                &c,
                &SettingsPatch {
                    theme: Some(t.into()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(s.theme, t);
        }
        let s = patch_settings(
            &c,
            &SettingsPatch {
                theme: Some("  Dark ".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.theme, "dark", "trimmed and lower-cased");
        let e = patch_settings(
            &c,
            &SettingsPatch {
                theme: Some("sepia".into()),
                ..Default::default()
            },
        )
        .unwrap_err()
        .to_string();
        assert!(e.contains("light, dark, system"), "{e}");
        assert!(patch_settings(
            &c,
            &SettingsPatch {
                theme: Some("".into()),
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(
            get_settings(&c).unwrap().theme,
            "dark",
            "rejected value did not overwrite"
        );
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
        assert_eq!(
            record_extraction(&c, t).unwrap(),
            ExtractionUsage { today: 1, total: 1 }
        );
        assert_eq!(
            record_extraction(&c, t + 60).unwrap(),
            ExtractionUsage { today: 2, total: 2 }
        );
        assert_eq!(
            extraction_usage(&c, t + 61).unwrap(),
            ExtractionUsage { today: 2, total: 2 }
        );
        // Next day: today's counter resets, the total keeps growing.
        let tomorrow = t + 86_400;
        assert_eq!(
            extraction_usage(&c, tomorrow).unwrap(),
            ExtractionUsage { today: 0, total: 2 }
        );
        assert_eq!(
            record_extraction(&c, tomorrow).unwrap(),
            ExtractionUsage { today: 1, total: 3 }
        );

        let s = patch_settings(
            &c,
            &SettingsPatch {
                extraction_paused: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s.extraction_paused);
        assert!(extraction_paused(&c).unwrap());
        let s = patch_settings(
            &c,
            &SettingsPatch {
                extraction_paused: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!s.extraction_paused);
    }

    #[test]
    fn duplicate_detection_normalises_fronts() {
        let c = conn();
        let (_u, l1, _) = seed(&c);
        create_card(
            &c,
            l1.id,
            &NewCard {
                front: "El  Paraguas".into(),
                back: "parasol".into(),
                example: None,
            },
        )
        .unwrap();
        let m = existing_fronts(&c).unwrap();
        assert!(m.contains_key("el paraguas"));
        assert_eq!(normalize_front("  el   paraguas "), "el paraguas");
    }

    #[test]
    fn export_import_roundtrip_is_idempotent() {
        let c = conn();
        let (_u, l1, _) = seed(&c);
        create_cards(
            &c,
            l1.id,
            &[
                NewCard {
                    front: "hola".into(),
                    back: "cześć".into(),
                    example: None,
                },
                NewCard {
                    front: "adiós".into(),
                    back: "pa".into(),
                    example: None,
                },
            ],
        )
        .unwrap();
        let b = export(&c).unwrap();
        assert_eq!(b.units.len(), 1);
        assert_eq!(b.units[0].lessons[0].cards.len(), 2);

        let c2 = conn();
        let rep = import(&c2, &b).unwrap();
        assert_eq!(
            (
                rep.units_created,
                rep.lessons_created,
                rep.cards_created,
                rep.cards_skipped
            ),
            (1, 2, 2, 0)
        );
        let rep = import(&c2, &b).unwrap();
        assert_eq!(
            (
                rep.units_created,
                rep.lessons_created,
                rep.cards_created,
                rep.cards_skipped
            ),
            (0, 0, 0, 2)
        );
        assert_eq!(list_cards(&c2, &CardFilter::default()).unwrap().len(), 2);
    }

    #[test]
    fn update_cards_bulk_updates_content_and_preserves_srs() {
        let c = conn();
        let (_u, l1, _) = seed(&c);
        let ids = create_cards(
            &c,
            l1.id,
            &[
                NewCard {
                    front: "uno".into(),
                    back: "one".into(),
                    example: Some("uno por uno".into()),
                },
                NewCard {
                    front: "dos".into(),
                    back: "two".into(),
                    example: None,
                },
            ],
        )
        .unwrap();

        // Advance card 0 through SRS review so it has non-default SRS fields.
        let rev = apply_review(&c, ids[0], Grade::Good, Some("forward"))
            .unwrap()
            .unwrap();
        assert_eq!(rev.card.reps, 1);
        assert_eq!(rev.card.status, "learned");
        let orig_card = get_card(&c, ids[0]).unwrap().unwrap();

        // Run bulk update on both cards.
        let updates = vec![
            BulkCardUpdate {
                id: ids[0],
                front: "el uno".into(),
                back: "jeden".into(),
                example: Some("el uno es primero".into()),
            },
            BulkCardUpdate {
                id: ids[1],
                front: "el dos".into(),
                back: "dwa".into(),
                example: Some("los dos".into()),
            },
            // Non-existent card: should not update anything or error
            BulkCardUpdate {
                id: 99999,
                front: "tres".into(),
                back: "three".into(),
                example: None,
            },
        ];
        let count = update_cards_bulk(&c, &updates).unwrap();
        assert_eq!(count, 2);

        let card0 = get_card(&c, ids[0]).unwrap().unwrap();
        assert_eq!(card0.front, "el uno");
        assert_eq!(card0.back, "jeden");
        assert_eq!(card0.example.as_deref(), Some("el uno es primero"));
        // SRS fields must be preserved exactly:
        assert_eq!(card0.reps, orig_card.reps);
        assert_eq!(card0.interval_days, orig_card.interval_days);
        assert_eq!(card0.ease, orig_card.ease);
        assert_eq!(card0.state, orig_card.state);
        assert_eq!(card0.due, orig_card.due);
        assert_eq!(card0.lapses, orig_card.lapses);
        assert_eq!(card0.last_review, orig_card.last_review);

        let card1 = get_card(&c, ids[1]).unwrap().unwrap();
        assert_eq!(card1.front, "el dos");
        assert_eq!(card1.back, "dwa");
        assert_eq!(card1.example.as_deref(), Some("los dos"));
        assert_eq!(card1.reps, 0);
        assert_eq!(card1.status, "new");

        // Validations
        assert_eq!(update_cards_bulk(&c, &[]).unwrap(), 0);
        let empty_front = vec![BulkCardUpdate {
            id: ids[0],
            front: "".into(),
            back: "x".into(),
            example: None,
        }];
        assert!(update_cards_bulk(&c, &empty_front).is_err());
    }
}
