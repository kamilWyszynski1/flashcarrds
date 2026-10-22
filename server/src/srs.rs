//! Spaced-repetition scheduler.
//!
//! A small SM-2 style algorithm with Anki-like learning steps and four grades
//! (Again / Hard / Good / Easy). It is deliberately simple and deterministic
//! so it can be unit-tested and reasoned about; the card table stores the
//! complete state so the algorithm can be swapped later (e.g. for FSRS)
//! without a schema change.

use serde::{Deserialize, Serialize};

pub const STATE_NEW: i64 = 0;
pub const STATE_LEARNING: i64 = 1;
pub const STATE_REVIEW: i64 = 2;
pub const STATE_RELEARNING: i64 = 3;

const MIN: i64 = 60;
const DAY: i64 = 86_400;

const AGAIN_STEP_SECS: i64 = MIN;
const HARD_STEP_SECS: i64 = 6 * MIN;
const LAPSE_STEP_SECS: i64 = 10 * MIN;
const GRADUATE_DAYS: f64 = 1.0;
const EASY_DAYS: f64 = 4.0;
const MIN_EASE: f64 = 1.3;
const INITIAL_EASE: f64 = 2.5;
const EASY_BONUS: f64 = 1.3;
const HARD_FACTOR: f64 = 1.2;
const LAPSE_INTERVAL_FACTOR: f64 = 0.3;
const MAX_INTERVAL_DAYS: f64 = 365.0 * 5.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    pub const ALL: [Grade; 4] = [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy];

    pub fn as_i64(self) -> i64 {
        match self {
            Grade::Again => 1,
            Grade::Hard => 2,
            Grade::Good => 3,
            Grade::Easy => 4,
        }
    }

    pub fn parse(s: &str) -> Option<Grade> {
        match s.to_ascii_lowercase().as_str() {
            "again" | "1" => Some(Grade::Again),
            "hard" | "2" => Some(Grade::Hard),
            "good" | "3" => Some(Grade::Good),
            "easy" | "4" => Some(Grade::Easy),
            _ => None,
        }
    }
}

/// The scheduling columns stored on a card.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SrsState {
    pub state: i64,
    /// Unix seconds when the card becomes due.
    pub due: i64,
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
    pub last_review: Option<i64>,
}

impl SrsState {
    pub fn new_card(now: i64) -> Self {
        SrsState {
            state: STATE_NEW,
            due: now,
            interval_days: 0.0,
            ease: INITIAL_EASE,
            reps: 0,
            lapses: 0,
            last_review: None,
        }
    }

    pub fn is_new(&self) -> bool {
        self.state == STATE_NEW
    }

    pub fn is_due(&self, now: i64) -> bool {
        self.due <= now
    }

    /// Human-facing status used by the UI: new / due / learning / learned.
    pub fn status(&self, now: i64) -> &'static str {
        status_for(self.state, self.due, now)
    }
}

pub fn status_for(state: i64, due: i64, now: i64) -> &'static str {
    if state == STATE_NEW {
        "new"
    } else if due <= now {
        "due"
    } else if state == STATE_LEARNING || state == STATE_RELEARNING {
        "learning"
    } else {
        "learned"
    }
}

/// Apply a grade at time `now` and return the next state.
pub fn schedule(s: &SrsState, grade: Grade, now: i64) -> SrsState {
    let mut n = *s;
    n.reps += 1;
    n.last_review = Some(now);

    match s.state {
        STATE_NEW | STATE_LEARNING | STATE_RELEARNING => {
            let relearning = s.state == STATE_RELEARNING;
            match grade {
                Grade::Again => {
                    n.state = if relearning { STATE_RELEARNING } else { STATE_LEARNING };
                    n.due = now + AGAIN_STEP_SECS;
                }
                Grade::Hard => {
                    n.state = if relearning { STATE_RELEARNING } else { STATE_LEARNING };
                    n.due = now + HARD_STEP_SECS;
                }
                Grade::Good => {
                    n.state = STATE_REVIEW;
                    // After a lapse, graduate back to the shrunk interval stored at
                    // lapse time; otherwise the standard graduating interval.
                    n.interval_days = if relearning {
                        s.interval_days.max(GRADUATE_DAYS)
                    } else {
                        GRADUATE_DAYS
                    };
                    n.due = now + days_to_secs(n.interval_days);
                }
                Grade::Easy => {
                    n.state = STATE_REVIEW;
                    n.interval_days = if relearning {
                        (s.interval_days * EASY_BONUS).max(EASY_DAYS)
                    } else {
                        EASY_DAYS
                    };
                    n.ease = s.ease + 0.15;
                    n.due = now + days_to_secs(n.interval_days);
                }
            }
        }
        _ => {
            // STATE_REVIEW
            let ivl = s.interval_days.max(GRADUATE_DAYS);
            match grade {
                Grade::Again => {
                    n.state = STATE_RELEARNING;
                    n.lapses += 1;
                    n.ease = (s.ease - 0.2).max(MIN_EASE);
                    n.interval_days = (ivl * LAPSE_INTERVAL_FACTOR).max(GRADUATE_DAYS);
                    n.due = now + LAPSE_STEP_SECS;
                }
                Grade::Hard => {
                    n.ease = (s.ease - 0.15).max(MIN_EASE);
                    n.interval_days = (ivl * HARD_FACTOR).max(ivl + 1.0);
                    n.due = now + days_to_secs(n.interval_days);
                }
                Grade::Good => {
                    n.interval_days = (ivl * s.ease).max(ivl + 1.0);
                    n.due = now + days_to_secs(n.interval_days);
                }
                Grade::Easy => {
                    n.ease = s.ease + 0.15;
                    n.interval_days = (ivl * s.ease * EASY_BONUS).max(ivl + 2.0);
                    n.due = now + days_to_secs(n.interval_days);
                }
            }
        }
    }

    n.interval_days = n.interval_days.min(MAX_INTERVAL_DAYS);
    n.ease = n.ease.max(MIN_EASE);
    n
}

fn days_to_secs(days: f64) -> i64 {
    (days * DAY as f64).round() as i64
}

/// Seconds until due for each of the four grades, in Again/Hard/Good/Easy order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preview {
    pub again: i64,
    pub hard: i64,
    pub good: i64,
    pub easy: i64,
}

pub fn preview(s: &SrsState, now: i64) -> Preview {
    let secs = |g| schedule(s, g, now).due - now;
    Preview {
        again: secs(Grade::Again),
        hard: secs(Grade::Hard),
        good: secs(Grade::Good),
        easy: secs(Grade::Easy),
    }
}

/// Short human label for an interval in seconds ("<1 min", "6 min", "1 day", "4 days", "2 mo").
pub fn human_interval(secs: i64) -> String {
    if secs < MIN {
        return "<1 min".into();
    }
    if secs < 60 * MIN {
        return format!("{} min", secs / MIN);
    }
    if secs < DAY {
        return format!("{} h", (secs as f64 / 3600.0).round() as i64);
    }
    let days = secs as f64 / DAY as f64;
    if days < 30.0 {
        let d = days.round() as i64;
        return if d == 1 { "1 day".into() } else { format!("{} days", d) };
    }
    if days < 365.0 {
        return format!("{} mo", (days / 30.0).round() as i64);
    }
    format!("{:.1} y", days / 365.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000;

    #[test]
    fn new_card_again_and_hard_stay_in_learning() {
        let c = SrsState::new_card(NOW);
        let a = schedule(&c, Grade::Again, NOW);
        assert_eq!(a.state, STATE_LEARNING);
        assert_eq!(a.due, NOW + 60);
        assert_eq!(a.reps, 1);
        let h = schedule(&c, Grade::Hard, NOW);
        assert_eq!(h.state, STATE_LEARNING);
        assert_eq!(h.due, NOW + 6 * 60);
    }

    #[test]
    fn new_card_good_graduates_to_one_day_and_easy_to_four() {
        let c = SrsState::new_card(NOW);
        let g = schedule(&c, Grade::Good, NOW);
        assert_eq!(g.state, STATE_REVIEW);
        assert_eq!(g.due, NOW + DAY);
        assert_eq!(g.interval_days, 1.0);
        let e = schedule(&c, Grade::Easy, NOW);
        assert_eq!(e.state, STATE_REVIEW);
        assert_eq!(e.due, NOW + 4 * DAY);
        assert!(e.ease > c.ease);
    }

    #[test]
    fn review_good_multiplies_by_ease() {
        let mut c = SrsState::new_card(NOW);
        c.state = STATE_REVIEW;
        c.interval_days = 10.0;
        c.ease = 2.5;
        let g = schedule(&c, Grade::Good, NOW);
        assert_eq!(g.interval_days, 25.0);
        assert_eq!(g.due, NOW + 25 * DAY);
        assert_eq!(g.ease, 2.5);
    }

    #[test]
    fn review_hard_grows_a_little_and_lowers_ease() {
        let mut c = SrsState::new_card(NOW);
        c.state = STATE_REVIEW;
        c.interval_days = 10.0;
        let h = schedule(&c, Grade::Hard, NOW);
        assert_eq!(h.interval_days, 12.0);
        assert!((h.ease - 2.35).abs() < 1e-9);
    }

    #[test]
    fn review_again_lapses_into_relearning_and_shrinks_interval() {
        let mut c = SrsState::new_card(NOW);
        c.state = STATE_REVIEW;
        c.interval_days = 20.0;
        let a = schedule(&c, Grade::Again, NOW);
        assert_eq!(a.state, STATE_RELEARNING);
        assert_eq!(a.lapses, 1);
        assert_eq!(a.due, NOW + 10 * 60);
        assert_eq!(a.interval_days, 6.0);
        // Graduating from relearning returns to the shrunk interval.
        let g = schedule(&a, Grade::Good, NOW + 600);
        assert_eq!(g.state, STATE_REVIEW);
        assert_eq!(g.interval_days, 6.0);
        assert_eq!(g.due, NOW + 600 + 6 * DAY);
    }

    #[test]
    fn ease_never_drops_below_minimum() {
        let mut c = SrsState::new_card(NOW);
        c.state = STATE_REVIEW;
        c.interval_days = 5.0;
        c.ease = 1.3;
        let a = schedule(&c, Grade::Again, NOW);
        assert_eq!(a.ease, MIN_EASE);
        let h = schedule(&c, Grade::Hard, NOW);
        assert_eq!(h.ease, MIN_EASE);
    }

    #[test]
    fn intervals_are_monotonic_in_grade() {
        for state in [STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING] {
            let mut c = SrsState::new_card(NOW);
            c.state = state;
            c.interval_days = if state == STATE_REVIEW { 7.0 } else { 2.0 };
            let p = preview(&c, NOW);
            assert!(p.again < p.hard, "state {state}: {p:?}");
            assert!(p.hard < p.good, "state {state}: {p:?}");
            assert!(p.good < p.easy, "state {state}: {p:?}");
        }
    }

    #[test]
    fn interval_is_capped() {
        let mut c = SrsState::new_card(NOW);
        c.state = STATE_REVIEW;
        c.interval_days = 2000.0;
        c.ease = 3.0;
        let e = schedule(&c, Grade::Easy, NOW);
        assert_eq!(e.interval_days, MAX_INTERVAL_DAYS);
    }

    #[test]
    fn status_labels() {
        assert_eq!(status_for(STATE_NEW, NOW, NOW), "new");
        assert_eq!(status_for(STATE_REVIEW, NOW - 1, NOW), "due");
        assert_eq!(status_for(STATE_REVIEW, NOW + 1, NOW), "learned");
        assert_eq!(status_for(STATE_LEARNING, NOW + 1, NOW), "learning");
        assert_eq!(status_for(STATE_RELEARNING, NOW + 1, NOW), "learning");
        assert_eq!(status_for(STATE_LEARNING, NOW, NOW), "due");
    }

    #[test]
    fn human_labels() {
        assert_eq!(human_interval(30), "<1 min");
        assert_eq!(human_interval(6 * 60), "6 min");
        assert_eq!(human_interval(3 * 3600), "3 h");
        assert_eq!(human_interval(DAY), "1 day");
        assert_eq!(human_interval(4 * DAY), "4 days");
        assert_eq!(human_interval(60 * DAY), "2 mo");
        assert_eq!(human_interval(730 * DAY), "2.0 y");
    }

    #[test]
    fn grade_parsing() {
        assert_eq!(Grade::parse("again"), Some(Grade::Again));
        assert_eq!(Grade::parse("EASY"), Some(Grade::Easy));
        assert_eq!(Grade::parse("3"), Some(Grade::Good));
        assert_eq!(Grade::parse("meh"), None);
    }
}
