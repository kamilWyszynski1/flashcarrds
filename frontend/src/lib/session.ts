import type { Grade, StudyItem } from './types';

/**
 * In-session queue management. The server owns long-term scheduling; the
 * client only decides whether a card graded Again/Hard (due again in minutes)
 * should come back later in *this* session, like Anki's learning steps.
 */

/** Cards due again within this many seconds are re-queued in the same session. */
export const REQUEUE_WITHIN_SECS = 20 * 60;
/** How many other cards to show before a re-queued card returns. */
export const REQUEUE_GAP = 3;

export interface SessionResult {
  cardId: number;
  grade: Grade;
  front: string;
  back: string;
  firstGrade: boolean;
}

export interface SessionState {
  queue: StudyItem[];
  /** Number of distinct cards the session started with. */
  total: number;
  done: number;
  results: SessionResult[];
  startedAt: number;
}

export function createSession(items: StudyItem[], startedAt = Date.now()): SessionState {
  return { queue: items, total: items.length, done: 0, results: [], startedAt };
}

/**
 * Returns a new array with `items` in random order (Fisher–Yates). The input
 * is not mutated. The server already randomises its queue; the client shuffles
 * again so explicit-id sessions ("repeat the missed ones") are mixed too and
 * a cached/replayed response never yields the same order twice.
 */
export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function current(s: SessionState): StudyItem | undefined {
  return s.queue[0];
}

/**
 * Apply the grade of the current card. `dueInSecs` comes from the server
 * (`ReviewResult.due_in_secs`). When the card comes back later in this
 * session, `fresh` (the server's post-review card + previews) replaces the
 * stale snapshot so the status tag and grade intervals are correct.
 * Returns the next state (immutable).
 */
export function applyGrade(s: SessionState, grade: Grade, dueInSecs: number, fresh?: Partial<Pick<StudyItem, 'card' | 'preview' | 'preview_labels'>>): SessionState {
  const [item, ...rest] = s.queue;
  if (!item) return s;
  const firstGrade = !s.results.some((r) => r.cardId === item.card.id);
  const results = [...s.results, { cardId: item.card.id, grade, front: item.card.front, back: item.card.back, firstGrade }];
  const requeue = dueInSecs <= REQUEUE_WITHIN_SECS;
  let queue = rest;
  if (requeue) {
    const at = Math.min(rest.length, REQUEUE_GAP);
    const again: StudyItem = { ...item, ...fresh };
    queue = [...rest.slice(0, at), again, ...rest.slice(at)];
  }
  return { ...s, queue, results, done: requeue ? s.done : s.done + 1 };
}

export function isFinished(s: SessionState): boolean {
  return s.queue.length === 0;
}

/** 0..1 progress for the top bar. */
export function progress(s: SessionState): number {
  return s.total === 0 ? 1 : s.done / s.total;
}

export interface Summary {
  total: number;
  counts: Record<Grade, number>;
  /** Percentage of first answers that were Good/Easy. */
  accuracy: number;
  /** Cards whose *first* grade was Again (to revisit). */
  missed: { cardId: number; front: string; back: string }[];
  durationMs: number;
}

export function summarize(s: SessionState, now = Date.now()): Summary {
  const counts: Record<Grade, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const r of s.results) counts[r.grade]++;
  const first = s.results.filter((r) => r.firstGrade);
  const ok = first.filter((r) => r.grade === 'good' || r.grade === 'easy').length;
  const seen = new Set<number>();
  const missed = first
    .filter((r) => r.grade === 'again' && !seen.has(r.cardId) && seen.add(r.cardId))
    .map((r) => ({ cardId: r.cardId, front: r.front, back: r.back }));
  return {
    total: s.total,
    counts,
    accuracy: first.length === 0 ? 0 : Math.round((ok / first.length) * 100),
    missed,
    durationMs: Math.max(0, now - s.startedAt),
  };
}
