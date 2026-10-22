import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeExtractError } from './extractError';
import { applyGrade, createSession, current, isFinished, progress, shuffle, summarize, REQUEUE_GAP } from './session';
import { parsePairs } from './paste';
import { fmtInterval, lessonMeta } from './format';
import { DEFAULT_THEME, THEMES, THEME_COLOR, THEME_KEY, applyTheme, isTheme, resolveTheme } from './theme';
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

  describe('shuffle', () => {
    const ids = (xs: StudyItem[]) => xs.map((i) => i.card.id);
    const deck = (n: number) => Array.from({ length: n }, (_, k) => item(k + 1));

    it('keeps every card exactly once and does not mutate the input', () => {
      const input = deck(20);
      const before = ids(input);
      const out = shuffle(input);
      expect(ids(input)).toEqual(before);
      expect(out).not.toBe(input);
      expect([...ids(out)].sort((a, b) => a - b)).toEqual(before);
    });

    it('handles empty and single-card queues', () => {
      expect(shuffle([])).toEqual([]);
      expect(ids(shuffle([item(9)]))).toEqual([9]);
    });

    it('is deterministic for a given rng and different for different rngs', () => {
      const lcg = (seed: number) => () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const a = ids(shuffle(deck(12), lcg(1)));
      const b = ids(shuffle(deck(12), lcg(1)));
      const c = ids(shuffle(deck(12), lcg(2)));
      expect(a).toEqual(b);
      expect(a).not.toEqual(c);
      // rng returning 0 always swaps with index 0 → a specific, in-range permutation (no NaN/undefined holes).
      expect(ids(shuffle(deck(4), () => 0))).toEqual([2, 3, 4, 1]);
      // rng just below 1 picks j = i → identity (never out of bounds).
      expect(ids(shuffle(deck(4), () => 0.999999))).toEqual([1, 2, 3, 4]);
    });

    it('two sessions over the same cards come in a different order', () => {
      const cards = deck(10);
      const first = ids(shuffle(cards));
      // P(6 independent draws all equal `first`) ≈ (1/10!)^5 — not a flake source.
      const differs = Array.from({ length: 6 }, () => ids(shuffle(cards))).some((o) => o.join() !== first.join());
      expect(differs).toBe(true);
      // And it is still a permutation of the same cards.
      expect([...first].sort((a, b) => a - b)).toEqual(ids(cards));
    });

    it('an Again card on a shuffled queue still returns later, not immediately next', () => {
      let s = createSession(shuffle(deck(8)), 0);
      const firstId = current(s)!.card.id;
      const rest = s.queue.slice(1).map((i) => i.card.id);
      s = applyGrade(s, 'again', 60);
      expect(current(s)?.card.id).not.toBe(firstId);
      expect(s.queue.map((i) => i.card.id)).toEqual([...rest.slice(0, REQUEUE_GAP), firstId, ...rest.slice(REQUEUE_GAP)]);
      expect(s.total).toBe(8);
      expect(s.done).toBe(0);
    });
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

describe('theme', () => {
  it('defaults to light and only system follows the OS', () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
  it('isTheme rejects anything the server would not store', () => {
    for (const t of THEMES) expect(isTheme(t)).toBe(true);
    expect(isTheme('auto')).toBe(false);
    expect(isTheme('')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
    expect(isTheme(1)).toBe(false);
  });
  it('applyTheme toggles html.dark, theme-color and caches the preference', () => {
    const cls = new Set<string>();
    const meta = { content: '' };
    const store = new Map<string, string>();
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, window: g.window, localStorage: g.localStorage };
    g.document = {
      documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)) } },
      querySelectorAll: () => [meta],
    };
    g.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) };
    g.localStorage = { setItem: (k: string, v: string) => store.set(k, v), getItem: (k: string) => store.get(k) ?? null };
    try {
      expect(applyTheme('light')).toBe('light');
      expect(cls.has('dark')).toBe(false);
      expect(meta.content).toBe(THEME_COLOR.light);
      expect(store.get(THEME_KEY)).toBe('light');
      // OS prefers dark (matchMedia above) but an explicit Light must win.
      expect(applyTheme('system')).toBe('dark');
      expect(cls.has('dark')).toBe(true);
      expect(meta.content).toBe(THEME_COLOR.dark);
      expect(applyTheme('light')).toBe('light');
      expect(cls.has('dark')).toBe(false);
    } finally {
      g.document = saved.document;
      g.window = saved.window;
      g.localStorage = saved.localStorage;
    }
  });
});

describe('describeExtractError', () => {
  const upstream = (msg: string) => new ApiError(502, 'upstream', msg);
  it('shows the server chain verbatim and adds a retry hint only for transient upstream failures', () => {
    const busy = "Gemini extraction failed at stage 'upstream_status' (model gemini-flash-latest, 1 image [312 KB], hint 0 chars, 2210 ms): Gemini answered HTTP 503 UNAVAILABLE: This model is currently experiencing high demand.";
    expect(describeExtractError(upstream(busy))).toBe(`${busy} — Gemini is busy or unreachable; try again in a minute.`);
    const timeout = "Gemini extraction failed at stage 'sending request' (model gemini-flash-latest, 1 image [312 KB], hint 0 chars, 30001 ms): no answer from Gemini after 30001 ms: error sending request: operation timed out";
    expect(describeExtractError(upstream(timeout))).toContain('try again in a minute');
    const bad = "Gemini extraction failed at stage 'upstream_status' (model gemini-flash-latest, 1 image [3 KB], hint 0 chars, 164 ms): Gemini answered HTTP 400 INVALID_ARGUMENT: Unable to process input image.";
    expect(describeExtractError(upstream(bad))).toBe(bad);
    const parse = "Gemini extraction failed at stage 'parse' (…): could not understand Gemini's answer: answer was not valid JSON";
    expect(describeExtractError(upstream(parse))).toBe(parse);
  });
  it('passes through non-upstream API errors and plain errors', () => {
    expect(describeExtractError(new ApiError(409, 'paused', 'Extraction is paused – switch it back on in Settings'))).toBe('Extraction is paused – switch it back on in Settings');
    expect(describeExtractError(new ApiError(400, 'bad_request', 'Gemini API key is not configured – set GEMINI_API_KEY on the server'))).toContain('GEMINI_API_KEY');
    expect(describeExtractError(new Error('boom'))).toBe('boom');
    expect(describeExtractError(undefined)).toBe('Extraction failed.');
  });
});
