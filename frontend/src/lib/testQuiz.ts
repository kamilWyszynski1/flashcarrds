import { cardExampleSide } from './format';
import { shuffle } from './session';
import type { Card, Direction, TestDirection, TestMode, TestResult, TestSummary } from './types';

export type GradeLetter = 'A' | 'B' | 'C' | 'D' | 'F';
export type GradeTone = 'ok' | 'new' | 'due' | 'fail';

export interface TestGradeInfo {
  letter: GradeLetter;
  tone: GradeTone;
}

export function scorePercent(correct: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((correct / total) * 100);
}

export function gradeForScore(score: number): TestGradeInfo {
  if (score >= 90) return { letter: 'A', tone: 'ok' };
  if (score >= 80) return { letter: 'B', tone: 'new' };
  if (score >= 70) return { letter: 'C', tone: 'due' };
  if (score >= 60) return { letter: 'D', tone: 'due' };
  return { letter: 'F', tone: 'fail' };
}

export function summarizeTestResults(results: readonly TestResult[]): TestSummary | null {
  if (results.length === 0) return null;
  let last = results[0];
  let best = results[0];
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    if (r.created_at > last.created_at || (r.created_at === last.created_at && r.id > last.id)) {
      last = r;
    }
    if (
      r.score > best.score ||
      (r.score === best.score && r.total > best.total) ||
      (r.score === best.score && r.total === best.total && r.created_at > best.created_at) ||
      (r.score === best.score && r.total === best.total && r.created_at === best.created_at && r.id > best.id)
    ) {
      best = r;
    }
  }
  return {
    best_score: best.score,
    best_correct: best.correct,
    best_total: best.total,
    best_mode: best.mode,
    last_score: last.score,
    last_correct: last.correct,
    last_total: last.total,
    last_mode: last.mode,
    last_at: last.created_at,
    attempts: results.length,
  };
}

/** Normalize whitespace, casing, and outer/Spanish punctuation for answer comparison. */
export function normalizeAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[¿¡?!.,;:"'«»„”‚’()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fold diacritics (including Polish ł/Ł which NFD does not decompose). */
export function foldDiacritics(text: string): string {
  return text
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const MAX_EXPANDED_VARIANTS = 16;

function expandSlashToken(token: string): string[] {
  if (!token.includes('/')) return [token];
  const parts = token.split('/').filter(Boolean);
  if (parts.length < 2) return [token];

  if (parts.length === 2) {
    const [base, suffix] = parts;
    const baseLow = base.toLowerCase();
    const sufLow = suffix.toLowerCase();
    // Handle Spanish/Romance gender endings like amigo/a, amigos/as, profesor/a, profesores/as
    if (base.length >= 2) {
      if (sufLow === 'a') {
        if (baseLow.endsWith('o')) return [base, base.slice(0, -1) + suffix];
        if (!/[aeiouáéíóúü]$/.test(baseLow)) return [base, base + suffix];
      }
      if (sufLow === 'o') {
        if (baseLow.endsWith('a')) return [base, base.slice(0, -1) + suffix];
      }
      if (sufLow === 'as') {
        if (baseLow.endsWith('os') || baseLow.endsWith('es')) {
          return [base, base.slice(0, -2) + suffix];
        }
      }
      if (sufLow === 'os') {
        if (baseLow.endsWith('as')) return [base, base.slice(0, -2) + suffix];
      }
    }
  }
  return parts;
}

function expandInlineSlashes(phrase: string): string[] {
  const tokens = phrase.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.some((t) => t.includes('/'))) return [];
  let combos: string[] = [''];
  for (const tok of tokens) {
    const alts = expandSlashToken(tok);
    const next: string[] = [];
    for (const prefix of combos) {
      for (const alt of alts) {
        next.push(prefix ? `${prefix} ${alt}` : alt);
        if (next.length >= MAX_EXPANDED_VARIANTS) break;
      }
      if (next.length >= MAX_EXPANDED_VARIANTS) break;
    }
    combos = next;
  }
  return combos;
}

/**
 * Expand an expected answer string into acceptable normalized variants:
 * - the full expected string
 * - the string with parenthetical disambiguations removed (e.g. "zamek (drzwi)" → "zamek")
 *   or unwrapped when attached to a word (e.g. "profesor(a)" → "profesora")
 * - individual `;`- or ` / `-separated synonyms (e.g. "cześć / dzień dobry" → ["cześć", "dzień dobry"])
 * - inline token slashes and Spanish gender forms (e.g. "el/la estudiante" → ["el estudiante", "la estudiante"],
 *   "amigo/a" → ["amigo", "amiga"], "cześć/hej" → ["cześć", "hej"])
 */
export function acceptableAnswers(expected: string): string[] {
  const out = new Set<string>();
  const addPhrase = (raw: string) => {
    const n = normalizeAnswer(raw);
    if (n) out.add(n);

    const strippedParens = raw.replace(/\([^)]*\)/g, ' ');
    const nStripped = normalizeAnswer(strippedParens);
    if (nStripped) out.add(nStripped);

    if (/\([^)]*\)/.test(raw)) {
      const unwrapped = normalizeAnswer(raw.replace(/[()]/g, ''));
      if (unwrapped) out.add(unwrapped);
    }

    for (const expanded of expandInlineSlashes(raw)) {
      const ne = normalizeAnswer(expanded);
      if (ne) out.add(ne);
    }
    if (strippedParens !== raw) {
      for (const expanded of expandInlineSlashes(strippedParens)) {
        const ne = normalizeAnswer(expanded);
        if (ne) out.add(ne);
      }
    }
  };

  addPhrase(expected);
  // Split top-level synonym lists on `;` or spaced ` / `
  for (const part of expected.split(/\s*;\s*|\s+\/\s+/)) {
    addPhrase(part);
  }
  return Array.from(out);
}

export type WrittenMatch = 'exact' | 'accent' | 'wrong';

export interface WrittenEvaluation {
  correct: boolean;
  match: WrittenMatch;
}

export function evaluateWrittenAnswer(input: string, expected: string): WrittenEvaluation {
  const normInput = normalizeAnswer(input);
  if (!normInput) return { correct: false, match: 'wrong' };

  const candidates = acceptableAnswers(expected);
  if (candidates.length === 0) return { correct: false, match: 'wrong' };

  if (candidates.includes(normInput)) {
    return { correct: true, match: 'exact' };
  }

  const foldedInput = foldDiacritics(normInput);
  if (candidates.some((c) => foldDiacritics(c) === foldedInput)) {
    return { correct: true, match: 'accent' };
  }

  return { correct: false, match: 'wrong' };
}

export interface TestQuestion {
  card: Card;
  direction: Direction;
  prompt: string;
  answer: string;
  promptLang?: string;
  answerLang?: string;
  /** Example sentence shown alongside the prompt (only when prompt is the `es` side). */
  promptExample: string | null;
  /** Example sentence revealed after answering (when answer is the `es` side). */
  answerExample: string | null;
  /** Multiple-choice options (2..4 items when mode === 'abcd', empty for written). */
  options: string[];
}

export interface BuildQuestionsParams {
  cards: readonly Card[];
  distractorPool?: readonly Card[];
  mode: TestMode;
  direction: TestDirection;
  frontLang?: string;
  backLang?: string;
  rng?: () => number;
}

/** Count how many unique answers exist across the scope + deck pool for a given test direction. */
export function uniqueAnswerCount(cards: readonly Card[], distractorPool: readonly Card[], direction: TestDirection): number {
  const fronts = new Set<string>();
  const backs = new Set<string>();
  const scan = (source: readonly Card[]) => {
    for (const c of source) {
      const f = normalizeAnswer(c.front);
      const b = normalizeAnswer(c.back);
      if (f) fronts.add(f);
      if (b) backs.add(b);
    }
  };
  scan(cards);
  scan(distractorPool);
  if (direction === 'front_to_back') return backs.size;
  if (direction === 'back_to_front') return fronts.size;
  return Math.min(fronts.size, backs.size);
}

/**
 * Whether every card in `cards` can form a valid, non-ambiguous ABCD question
 * (at least 1 distractor with a different normalized prompt and different normalized answer).
 */
export function canRunAbcd(cards: readonly Card[], distractorPool: readonly Card[], direction: TestDirection): boolean {
  if (cards.length === 0) return false;
  const combined: Card[] = [...cards, ...distractorPool];
  const hasDistractor = (card: Card, forward: boolean): boolean => {
    const promptKey = normalizeAnswer(forward ? card.front : card.back);
    const answerKey = normalizeAnswer(forward ? card.back : card.front);
    for (const candidate of combined) {
      if (candidate.id === card.id) continue;
      const candPrompt = normalizeAnswer(forward ? candidate.front : candidate.back);
      const candAnswer = normalizeAnswer(forward ? candidate.back : candidate.front);
      if (!candAnswer || candAnswer === answerKey) continue;
      if (promptKey && candPrompt === promptKey) continue;
      return true;
    }
    return false;
  };
  for (const card of cards) {
    if (direction !== 'back_to_front' && !hasDistractor(card, true)) return false;
    if (direction !== 'front_to_back' && !hasDistractor(card, false)) return false;
  }
  return true;
}

export function buildTestQuestions({
  cards,
  distractorPool = [],
  mode,
  direction,
  frontLang,
  backLang,
  rng = Math.random,
}: BuildQuestionsParams): TestQuestion[] {
  const ordered = shuffle(cards, rng);
  const exSide = cardExampleSide(frontLang, backLang);

  return ordered.map((card) => {
    const itemDir: Direction =
      direction === 'front_to_back'
        ? 'forward'
        : direction === 'back_to_front'
          ? 'reverse'
          : rng() < 0.5
            ? 'forward'
            : 'reverse';

    const forward = itemDir === 'forward';
    const prompt = forward ? card.front : card.back;
    const answer = forward ? card.back : card.front;
    const promptLang = forward ? frontLang : backLang;
    const answerLang = forward ? backLang : frontLang;
    const showExampleOnPrompt = (forward && exSide === 'front') || (!forward && exSide === 'back');

    let options: string[] = [];
    if (mode === 'abcd') {
      const promptKey = normalizeAnswer(prompt);
      const seen = new Set<string>([normalizeAnswer(answer)]);
      const distractors: string[] = [];

      const collectFrom = (source: readonly Card[]) => {
        for (const candidate of shuffle(source, rng)) {
          if (distractors.length >= 3) break;
          if (candidate.id === card.id) continue;
          const candPrompt = normalizeAnswer(forward ? candidate.front : candidate.back);
          if (promptKey && candPrompt === promptKey) continue;
          const text = forward ? candidate.back : candidate.front;
          const key = normalizeAnswer(text);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          distractors.push(text);
        }
      };

      // Prefer distractors from the same unit/lesson first, then widen to the full deck.
      collectFrom(cards);
      if (distractors.length < 3 && distractorPool.length > 0) {
        collectFrom(distractorPool);
      }

      options = shuffle([answer, ...distractors], rng);
    }

    return {
      card,
      direction: itemDir,
      prompt,
      answer,
      promptLang,
      answerLang,
      promptExample: showExampleOnPrompt ? card.example : null,
      answerExample: !showExampleOnPrompt ? card.example : null,
      options,
    };
  });
}
