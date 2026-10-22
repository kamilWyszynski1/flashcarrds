import { describe, expect, it } from 'vitest';
import {
  DAY,
  fmtDays,
  fmtIntervalSecs,
  GRADUATE_DAYS,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  newCard,
  preview,
  previewLabels,
  schedule,
  statusFor,
} from './srs';

const NOW = 1_700_000_000;

describe('srs', () => {
  it('new_card_again_and_hard_stay_in_learning', () => {
    const c = newCard(NOW);
    const a = schedule(c, 'again', NOW);
    expect(a.state).toBe('learning');
    expect(a.due).toBe(NOW + 60);
    expect(a.reps).toBe(1);

    const h = schedule(c, 'hard', NOW);
    expect(h.state).toBe('learning');
    expect(h.due).toBe(NOW + 6 * 60);
  });

  it('new_card_good_graduates_to_one_day_and_easy_to_four', () => {
    const c = newCard(NOW);
    const g = schedule(c, 'good', NOW);
    expect(g.state).toBe('review');
    expect(g.due).toBe(NOW + DAY);
    expect(g.interval_days).toBe(GRADUATE_DAYS);

    const e = schedule(c, 'easy', NOW);
    expect(e.state).toBe('review');
    expect(e.due).toBe(NOW + 4 * DAY);
    expect(e.ease).toBeGreaterThan(c.ease);
  });

  it('review_good_multiplies_by_ease', () => {
    const c = { ...newCard(NOW), state: 'review' as const, interval_days: 10.0, ease: 2.5 };
    const g = schedule(c, 'good', NOW);
    expect(g.interval_days).toBe(25.0);
    expect(g.due).toBe(NOW + 25 * DAY);
    expect(g.ease).toBe(2.5);
  });

  it('review_hard_grows_a_little_and_lowers_ease', () => {
    const c = { ...newCard(NOW), state: 'review' as const, interval_days: 10.0, ease: 2.5 };
    const h = schedule(c, 'hard', NOW);
    expect(h.interval_days).toBe(12.0);
    expect(Math.abs(h.ease - 2.35)).toBeLessThan(1e-9);
  });

  it('review_again_lapses_into_relearning_and_shrinks_interval', () => {
    const c = { ...newCard(NOW), state: 'review' as const, interval_days: 20.0, ease: 2.5 };
    const a = schedule(c, 'again', NOW);
    expect(a.state).toBe('relearning');
    expect(a.lapses).toBe(1);
    expect(a.due).toBe(NOW + 10 * 60);
    expect(a.interval_days).toBe(6.0);

    // Graduating from relearning returns to the shrunk interval.
    const g = schedule(a, 'good', NOW + 600);
    expect(g.state).toBe('review');
    expect(g.interval_days).toBe(6.0);
    expect(g.due).toBe(NOW + 600 + 6 * DAY);
  });

  it('ease_never_drops_below_minimum', () => {
    const c = { ...newCard(NOW), state: 'review' as const, interval_days: 5.0, ease: 1.3 };
    const a = schedule(c, 'again', NOW);
    expect(a.ease).toBe(MIN_EASE);
    const h = schedule(c, 'hard', NOW);
    expect(h.ease).toBe(MIN_EASE);
  });

  it('intervals_are_monotonic_in_grade', () => {
    for (const state of ['new', 'learning', 'review', 'relearning'] as const) {
      const c = { ...newCard(NOW), state, interval_days: state === 'review' ? 7.0 : 2.0 };
      const p = preview(c, NOW);
      expect(p.again).toBeLessThan(p.hard);
      expect(p.hard).toBeLessThan(p.good);
      expect(p.good).toBeLessThan(p.easy);
    }
  });

  it('interval_is_capped', () => {
    const c = { ...newCard(NOW), state: 'review' as const, interval_days: 2000.0, ease: 3.0 };
    const e = schedule(c, 'easy', NOW);
    expect(e.interval_days).toBe(MAX_INTERVAL_DAYS);
  });

  it('status_labels', () => {
    expect(statusFor('new', NOW, NOW)).toBe('new');
    expect(statusFor('review', NOW - 1, NOW)).toBe('due');
    expect(statusFor('review', NOW + 1, NOW)).toBe('learned');
    expect(statusFor('learning', NOW + 1, NOW)).toBe('learning');
    expect(statusFor('relearning', NOW + 1, NOW)).toBe('learning');
    expect(statusFor('learning', NOW, NOW)).toBe('due');
  });

  it('human_labels', () => {
    expect(fmtIntervalSecs(30)).toBe('<1 min');
    expect(fmtIntervalSecs(6 * 60)).toBe('6 min');
    expect(fmtIntervalSecs(3 * 3600)).toBe('3 h');
    expect(fmtIntervalSecs(DAY)).toBe('1 day');
    expect(fmtIntervalSecs(4 * DAY)).toBe('4 days');
    expect(fmtIntervalSecs(60 * DAY)).toBe('2 mo');
    expect(fmtIntervalSecs(730 * DAY)).toBe('2.0 y');
    expect(fmtDays(1)).toBe('1 day');
    expect(fmtDays(4)).toBe('4 days');
  });

  it('previewLabels', () => {
    const c = newCard(NOW);
    const labels = previewLabels(c, NOW);
    expect(labels.again).toBe('1 min');
    expect(labels.hard).toBe('6 min');
    expect(labels.good).toBe('1 day');
    expect(labels.easy).toBe('4 days');
  });
});
