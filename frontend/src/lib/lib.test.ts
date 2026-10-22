import { describe, expect, it } from 'vitest';
import { applyGrade, createSession, current, isFinished, progress, summarize, REQUEUE_GAP } from './session';
import { parsePairs } from './paste';
import { fmtInterval, lessonMeta } from './format';
import type { Card, StudyItem } from './types';

const item = (id: number): StudyItem => ({
  card: {
    id,
    lesson_id: 1,
    lesson_name: 'L',
    unit_id: 1,
    unit_name: 'U',
    front: `f${id}`,
    back: `b${id}`,
    example: null,
    state: 0,
    status: 'new',
    due: 0,
    interval_days: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    last_review: null,
    created_at: 0,
    updated_at: 0,
  },
  direction: 'forward',
  preview: { again: 60, hard: 360, good: 86400, easy: 345600 },
  preview_labels: { again: '<1 min', hard: '6 min', good: '1 day', easy: '4 days' },
});

describe('session queue', () => {
  it('removes a card graded Good and advances progress', () => {
    let s = createSession([item(1), item(2), item(3)], 0);
    expect(current(s)?.card.id).toBe(1);
    s = applyGrade(s, 'good', 86400);
    expect(s.queue.map((i) => i.card.id)).toEqual([2, 3]);
    expect(s.done).toBe(1);
    expect(progress(s)).toBeCloseTo(1 / 3);
  });

  it('re-queues a card graded Again a few cards later, without counting it as done', () => {
    let s = createSession([item(1), item(2), item(3), item(4), item(5)], 0);
    s = applyGrade(s, 'again', 60);
    expect(s.queue.map((i) => i.card.id)).toEqual([2, 3, 4, 1, 5]);
    expect(s.done).toBe(0);
    expect(s.queue[REQUEUE_GAP].card.id).toBe(1);
  });

  it('re-queues at the end when fewer cards remain than the gap', () => {
    let s = createSession([item(1), item(2)], 0);
    s = applyGrade(s, 'hard', 360);
    expect(s.queue.map((i) => i.card.id)).toEqual([2, 1]);
    s = applyGrade(s, 'good', 86400);
    s = applyGrade(s, 'good', 86400);
    expect(isFinished(s)).toBe(true);
    expect(s.done).toBe(2);
  });

  it('a single Again card loops until graded Good', () => {
    let s = createSession([item(7)], 0);
    s = applyGrade(s, 'again', 60);
    expect(isFinished(s)).toBe(false);
    expect(current(s)?.card.id).toBe(7);
    s = applyGrade(s, 'good', 86400);
    expect(isFinished(s)).toBe(true);
  });

  it('a re-queued card carries the fresh card state and previews from the server', () => {
    let s = createSession([item(1), item(2)], 0);
    const freshCard: Card = { ...item(1).card, state: 3, status: 'learning', lapses: 1 };
    const labels = { again: '1 min', hard: '6 min', good: '1 day', easy: '4 days' };
    s = applyGrade(s, 'again', 600, { card: freshCard, preview: { again: 60, hard: 360, good: 86400, easy: 345600 }, preview_labels: labels });
    const back = s.queue.find((q) => q.card.id === 1)!;
    expect(back.card.status).toBe('learning');
    expect(back.card.lapses).toBe(1);
    expect(back.preview_labels.good).toBe('1 day');
    expect(back.direction).toBe('forward');
  });

  it('is a no-op on an empty queue', () => {
    const s = createSession([], 0);
    expect(applyGrade(s, 'good', 1)).toBe(s);
    expect(isFinished(s)).toBe(true);
    expect(progress(s)).toBe(1);
  });

  it('summarizes first answers only for accuracy and missed list', () => {
    let s = createSession([item(1), item(2), item(3)], 1000);
    s = applyGrade(s, 'again', 60); // 1 missed → queue 2,3,1
    s = applyGrade(s, 'easy', 345600); // 2
    s = applyGrade(s, 'good', 86400); // 3
    s = applyGrade(s, 'good', 86400); // 1 again, second time
    const sum = summarize(s, 61000);
    expect(sum.total).toBe(3);
    expect(sum.counts).toEqual({ again: 1, hard: 0, good: 2, easy: 1 });
    expect(sum.accuracy).toBe(67);
    expect(sum.missed).toEqual([{ cardId: 1, front: 'f1', back: 'b1' }]);
    expect(sum.durationMs).toBe(60000);
  });
});

describe('parsePairs', () => {
  it('handles the common separators and a third example column', () => {
    const cards = parsePairs('la ventana – okno\nla puerta\tdrzwi\tAbre la puerta.\n\n  la mesa ; stół\nel libro - książka\nsolo una palabra');
    expect(cards.map((c) => [c.front, c.back])).toEqual([
      ['la ventana', 'okno'],
      ['la puerta', 'drzwi'],
      ['la mesa', 'stół'],
      ['el libro', 'książka'],
      ['solo una palabra', ''],
    ]);
    expect(cards[1].example).toBe('Abre la puerta.');
    expect(cards[4].confidence).toBeLessThan(0.7);
  });

  it('does not split hyphenated words', () => {
    const [c] = parsePairs('bien-estar: dobrostan');
    expect(c.front).toBe('bien-estar');
    expect(c.back).toBe('dobrostan');
  });
});

describe('format', () => {
  it('fmtInterval matches the backend labels', () => {
    expect(fmtInterval(30)).toBe('<1 min');
    expect(fmtInterval(360)).toBe('6 min');
    expect(fmtInterval(86400)).toBe('1 day');
    expect(fmtInterval(4 * 86400)).toBe('4 days');
    expect(fmtInterval(60 * 86400)).toBe('2 mo');
  });
  it('lessonMeta', () => {
    expect(lessonMeta({ total: 0, new: 0, due: 0, learned: 0 })).toMatch(/Empty/);
    expect(lessonMeta({ total: 41, new: 0, due: 7, learned: 10 })).toBe('41 cards · 7 due');
    expect(lessonMeta({ total: 32, new: 0, due: 0, learned: 32 })).toBe('32 cards · all learned');
    expect(lessonMeta({ total: 1, new: 1, due: 0, learned: 0 })).toBe('1 card · 1 new');
  });
});
