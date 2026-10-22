import type { Grade, Status } from './types';

export type State = 'new' | 'learning' | 'review' | 'relearning';
export type { Grade };

export const STATE_NEW = 0;
export const STATE_LEARNING = 1;
export const STATE_REVIEW = 2;
export const STATE_RELEARNING = 3;

export const MINUTE = 60;
export const DAY = 86_400;

export const AGAIN_STEP_SECS = MINUTE;
export const HARD_STEP_SECS = 6 * MINUTE;
export const LAPSE_STEP_SECS = 10 * MINUTE;
export const GRADUATE_DAYS = 1.0;
export const EASY_DAYS = 4.0;
export const MIN_EASE = 1.3;
export const INITIAL_EASE = 2.5;
export const EASY_BONUS = 1.3;
export const HARD_FACTOR = 1.2;
export const LAPSE_INTERVAL_FACTOR = 0.3;
export const MAX_INTERVAL_DAYS = 365.0 * 5.0;

export interface SrsState {
  state: State | number;
  due: number;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_review: number | null;
}

export interface ScheduleOut {
  state: State;
  due: number;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_review: number | null;
}

export function stateToNumber(s: State | number): number {
  if (typeof s === 'number') return s;
  switch (s) {
    case 'new': return STATE_NEW;
    case 'learning': return STATE_LEARNING;
    case 'review': return STATE_REVIEW;
    case 'relearning': return STATE_RELEARNING;
    default: return STATE_NEW;
  }
}

export function numberToState(n: State | number): State {
  if (typeof n === 'string') return n;
  switch (n) {
    case STATE_NEW: return 'new';
    case STATE_LEARNING: return 'learning';
    case STATE_REVIEW: return 'review';
    case STATE_RELEARNING: return 'relearning';
    default: return 'new';
  }
}

export function newCard(now: number): SrsState {
  return {
    state: 'new',
    due: now,
    interval_days: 0.0,
    ease: INITIAL_EASE,
    reps: 0,
    lapses: 0,
    last_review: null,
  };
}

export function statusFor(state: State | number, due: number, now: number): Status {
  const s = numberToState(state);
  if (s === 'new') return 'new';
  if (due <= now) return 'due';
  if (s === 'learning' || s === 'relearning') return 'learning';
  return 'learned';
}

function daysToSecs(days: number): number {
  return Math.round(days * DAY);
}

export function schedule(s: SrsState, grade: Grade, now: number): ScheduleOut {
  const curState = numberToState(s.state);
  const reps = (s.reps ?? 0) + 1;
  const last_review = now;
  let state: State = curState;
  let due = s.due;
  let interval_days = s.interval_days ?? 0.0;
  let ease = s.ease ?? INITIAL_EASE;
  let lapses = s.lapses ?? 0;

  if (curState === 'new' || curState === 'learning' || curState === 'relearning') {
    const relearning = curState === 'relearning';
    switch (grade) {
      case 'again':
        state = relearning ? 'relearning' : 'learning';
        due = now + AGAIN_STEP_SECS;
        break;
      case 'hard':
        state = relearning ? 'relearning' : 'learning';
        due = now + HARD_STEP_SECS;
        break;
      case 'good':
        state = 'review';
        interval_days = relearning ? Math.max(interval_days, GRADUATE_DAYS) : GRADUATE_DAYS;
        due = now + daysToSecs(interval_days);
        break;
      case 'easy':
        state = 'review';
        interval_days = relearning ? Math.max(interval_days * EASY_BONUS, EASY_DAYS) : EASY_DAYS;
        ease = ease + 0.15;
        due = now + daysToSecs(interval_days);
        break;
    }
  } else {
    // review
    const ivl = Math.max(interval_days, GRADUATE_DAYS);
    switch (grade) {
      case 'again':
        state = 'relearning';
        lapses += 1;
        ease = Math.max(ease - 0.2, MIN_EASE);
        interval_days = Math.max(ivl * LAPSE_INTERVAL_FACTOR, GRADUATE_DAYS);
        due = now + LAPSE_STEP_SECS;
        break;
      case 'hard':
        ease = Math.max(ease - 0.15, MIN_EASE);
        interval_days = Math.max(ivl * HARD_FACTOR, ivl + 1.0);
        due = now + daysToSecs(interval_days);
        break;
      case 'good':
        interval_days = Math.max(ivl * ease, ivl + 1.0);
        due = now + daysToSecs(interval_days);
        break;
      case 'easy':
        ease = ease + 0.15;
        interval_days = Math.max(ivl * ease * EASY_BONUS, ivl + 2.0);
        due = now + daysToSecs(interval_days);
        break;
    }
  }

  interval_days = Math.min(interval_days, MAX_INTERVAL_DAYS);
  ease = Math.max(ease, MIN_EASE);

  return {
    state,
    due,
    interval_days,
    ease,
    reps,
    lapses,
    last_review,
  };
}

export function preview(s: SrsState, now: number): { again: number; hard: number; good: number; easy: number } {
  return {
    again: schedule(s, 'again', now).due - now,
    hard: schedule(s, 'hard', now).due - now,
    good: schedule(s, 'good', now).due - now,
    easy: schedule(s, 'easy', now).due - now,
  };
}

export function fmtIntervalSecs(secs: number): string {
  if (secs < MINUTE) {
    return '<1 min';
  }
  if (secs < 60 * MINUTE) {
    return `${Math.floor(secs / MINUTE)} min`;
  }
  if (secs < DAY) {
    return `${Math.round(secs / 3600)} h`;
  }
  const days = secs / DAY;
  return fmtDays(days);
}

export function fmtDays(days: number): string {
  if (days < 30.0) {
    const d = Math.round(days);
    return d === 1 ? '1 day' : `${d} days`;
  }
  if (days < 365.0) {
    return `${Math.round(days / 30.0)} mo`;
  }
  return `${(days / 365.0).toFixed(1)} y`;
}

export function previewLabels(s: SrsState, now: number): { again: string; hard: string; good: string; easy: string } {
  const p = preview(s, now);
  return {
    again: fmtIntervalSecs(p.again),
    hard: fmtIntervalSecs(p.hard),
    good: fmtIntervalSecs(p.good),
    easy: fmtIntervalSecs(p.easy),
  };
}
