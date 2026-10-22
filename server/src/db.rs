//! SQLite connection management and schema migrations.

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::Connection;

pub type Db = Arc<Mutex<Connection>>;

/// Open (or create) the database file. `None` opens an in-memory database
/// (used by tests).
pub fn open(path: Option<&Path>) -> Result<Connection> {
    let conn = match path {
        Some(p) => {
            if let Some(dir) = p.parent() {
                if !dir.as_os_str().is_empty() {
                    std::fs::create_dir_all(dir)
                        .with_context(|| format!("creating {}", dir.display()))?;
                }
            }
            Connection::open(p).with_context(|| format!("opening {}", p.display()))?
        }
        None => Connection::open_in_memory()?,
    };
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn shared(conn: Connection) -> Db {
    Arc::new(Mutex::new(conn))
}

pub(crate) const MIGRATIONS: &[&str] = &[
    // v1 – initial schema
    "
    CREATE TABLE units (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
    );
    CREATE TABLE lessons (
        id          INTEGER PRIMARY KEY,
        unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX lessons_unit ON lessons(unit_id, position);
    CREATE TABLE cards (
        id            INTEGER PRIMARY KEY,
        lesson_id     INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        front         TEXT NOT NULL,
        back          TEXT NOT NULL,
        example       TEXT,
        state         INTEGER NOT NULL DEFAULT 0,
        due           INTEGER NOT NULL,
        interval_days REAL NOT NULL DEFAULT 0,
        ease          REAL NOT NULL DEFAULT 2.5,
        reps          INTEGER NOT NULL DEFAULT 0,
        lapses        INTEGER NOT NULL DEFAULT 0,
        last_review   INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE INDEX cards_lesson ON cards(lesson_id);
    CREATE INDEX cards_due ON cards(state, due);
    CREATE TABLE reviews (
        id              INTEGER PRIMARY KEY,
        card_id         INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        grade           INTEGER NOT NULL,
        reviewed_at     INTEGER NOT NULL,
        was_new         INTEGER NOT NULL DEFAULT 0,
        interval_before REAL NOT NULL DEFAULT 0,
        interval_after  REAL NOT NULL DEFAULT 0,
        direction       TEXT
    );
    CREATE INDEX reviews_time ON reviews(reviewed_at);
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    ",
    // v2 – the Gemini key and model are server environment only
    // (GEMINI_API_KEY / FISZKI_GEMINI_MODEL); drop anything an older build saved.
    "
    DELETE FROM settings WHERE key IN ('gemini_api_key', 'gemini_model');
    ",
];

pub fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if version < target {
            if target == 2 {
                let stored: i64 = conn
                    .query_row("SELECT count(*) FROM settings WHERE key = 'gemini_api_key'", [], |r| r.get(0))
                    .context("checking for a stored Gemini key before migration 2")?;
                if stored > 0 {
                    tracing::warn!("removing the Gemini API key stored in the database – keys now live only in GEMINI_API_KEY (env / .env)");
                }
            }
            conn.execute_batch("BEGIN;")?;
            conn.execute_batch(sql)
                .with_context(|| format!("applying migration {target}"))?;
            conn.execute_batch(&format!("PRAGMA user_version = {target}; COMMIT;"))?;
            tracing::info!(version = target, "applied migration");
        }
    }
    Ok(())
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Unix timestamp of local midnight for the day containing `now`.
pub fn start_of_local_day(now: i64) -> i64 {
    use chrono::{Local, TimeZone};
    match Local.timestamp_opt(now, 0).single() {
        Some(dt) => {
            let midnight = dt.date_naive().and_hms_opt(0, 0, 0).unwrap();
            match Local.from_local_datetime(&midnight).earliest() {
                Some(m) => m.timestamp(),
                None => now - now.rem_euclid(86_400),
            }
        }
        None => now - now.rem_euclid(86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent() {
        let conn = open(None).unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for t in ["units", "lessons", "cards", "reviews", "settings"] {
            assert!(tables.iter().any(|x| x == t), "missing table {t}");
        }
    }

    #[test]
    fn start_of_day_is_at_or_before_now_and_within_a_day() {
        let now = 1_700_000_000;
        let s = start_of_local_day(now);
        assert!(s <= now);
        assert!(now - s < 86_400 + 3600);
    }
}
