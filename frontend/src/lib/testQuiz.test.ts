import { describe, expect, it } from 'vitest';
import {
  buildTestQuestions,
  canRunAbcd,
  evaluateWrittenAnswer,
  gradeForScore,
  scorePercent,
  summarizeTestResults,
  uniqueAnswerCount,
} from './testQuiz';
import type { Card, TestResult } from './types';

function makeCard(id: number, front: string, back: string, example: string | null = null): Card {
  return {
    id,
    lesson_id: 1,
    lesson_name: '1.1',
    unit_id: 1,
    unit_name: 'Unidad 1',
    front,
    back,
    example,
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
  };
}

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('testQuiz scoring & grading', () => {
  it('computes rounded percentages and handles zero total safely', () => {
    expect(scorePercent(0, 0)).toBe(0);
    expect(scorePercent(0, 5)).toBe(0);
    expect(scorePercent(2, 3)).toBe(67);
    expect(scorePercent(5, 5)).toBe(100);
  });

  it('maps boundary scores to grades A-F with expected tones', () => {
    expect(gradeForScore(100)).toEqual({ letter: 'A', tone: 'ok' });
    expect(gradeForScore(90)).toEqual({ letter: 'A', tone: 'ok' });
    expect(gradeForScore(89)).toEqual({ letter: 'B', tone: 'new' });
    expect(gradeForScore(80)).toEqual({ letter: 'B', tone: 'new' });
    expect(gradeForScore(79)).toEqual({ letter: 'C', tone: 'due' });
    expect(gradeForScore(70)).toEqual({ letter: 'C', tone: 'due' });
    expect(gradeForScore(69)).toEqual({ letter: 'D', tone: 'due' });
    expect(gradeForScore(60)).toEqual({ letter: 'D', tone: 'due' });
    expect(gradeForScore(59)).toEqual({ letter: 'F', tone: 'fail' });
    expect(gradeForScore(0)).toEqual({ letter: 'F', tone: 'fail' });
  });

  it('summarizes results tracking best and latest attempts independently', () => {
    expect(summarizeTestResults([])).toBeNull();

    const r1: TestResult = {
      id: 1,
      scope_type: 'lesson',
      scope_id: 1,
      mode: 'abcd',
      direction: 'front_to_back',
      correct: 6,
      total: 10,
      score: 60,
      duration_ms: 12000,
      created_at: 100,
    };
    const r2: TestResult = {
      ...r1,
      id: 2,
      mode: 'written',
      correct: 9,
      total: 10,
      score: 90,
      created_at: 200,
    };
    const r3: TestResult = {
      ...r1,
      id: 3,
      mode: 'abcd',
      correct: 7,
      total: 10,
      score: 70,
      created_at: 300,
    };

    const sum = summarizeTestResults([r1, r2, r3])!;
    expect(sum.best_score).toBe(90);
    expect(sum.best_correct).toBe(9);
    expect(sum.best_mode).toBe('written');
    expect(sum.last_score).toBe(70);
    expect(sum.last_correct).toBe(7);
    expect(sum.last_mode).toBe('abcd');
    expect(sum.last_at).toBe(300);
    expect(sum.attempts).toBe(3);
  });
});

describe('evaluateWrittenAnswer', () => {
  it('accepts exact matches ignoring case, extra spaces, and punctuation', () => {
    expect(evaluateWrittenAnswer('Hola', 'hola')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('  la   ventana  ', 'la ventana')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('cómo estás', '¿Cómo estás?')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('hola', '¡Hola!')).toEqual({ correct: true, match: 'exact' });
  });

  it('accepts diacritic-only omissions with accent hint including Polish ł', () => {
    expect(evaluateWrittenAnswer('como estas', '¿Cómo estás?')).toEqual({ correct: true, match: 'accent' });
    expect(evaluateWrittenAnswer('espanol', 'español')).toEqual({ correct: true, match: 'accent' });
    expect(evaluateWrittenAnswer('czesc', 'cześć')).toEqual({ correct: true, match: 'accent' });
    expect(evaluateWrittenAnswer('lodz', 'łódź')).toEqual({ correct: true, match: 'accent' });
  });

  it('supports slash/semicolon synonyms and parenthetical notes', () => {
    expect(evaluateWrittenAnswer('cześć', 'cześć / dzień dobry')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('dzień dobry', 'cześć / dzień dobry')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('cześć', 'cześć/hej')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('hej', 'cześć/hej')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('mieszkanie', 'dom; mieszkanie')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('zamek', 'zamek (drzwi)')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('libro', '(el) libro')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('el libro', '(el) libro')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('profesor', 'profesor(a)')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('profesora', 'profesor(a)')).toEqual({ correct: true, match: 'exact' });
  });

  it('expands Spanish inline gender slashes without accepting bare articles or suffixes', () => {
    expect(evaluateWrittenAnswer('el estudiante', 'el/la estudiante')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('la estudiante', 'el/la estudiante')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('el', 'el/la estudiante')).toEqual({ correct: false, match: 'wrong' });
    expect(evaluateWrittenAnswer('la', 'el/la estudiante')).toEqual({ correct: false, match: 'wrong' });

    expect(evaluateWrittenAnswer('amigo', 'amigo/a')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('amiga', 'amigo/a')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('a', 'amigo/a')).toEqual({ correct: false, match: 'wrong' });

    expect(evaluateWrittenAnswer('profesor', 'el/la profesor/a')).toEqual({ correct: false, match: 'wrong' });
    expect(evaluateWrittenAnswer('el profesor', 'el/la profesor/a')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('la profesora', 'el/la profesor/a')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('a', 'el/la profesor/a')).toEqual({ correct: false, match: 'wrong' });

    expect(evaluateWrittenAnswer('amigos', 'amigos/as')).toEqual({ correct: true, match: 'exact' });
    expect(evaluateWrittenAnswer('amigas', 'amigos/as')).toEqual({ correct: true, match: 'exact' });
  });

  it('rejects empty inputs, substrings, and wrong answers', () => {
    expect(evaluateWrittenAnswer('', 'hola')).toEqual({ correct: false, match: 'wrong' });
    expect(evaluateWrittenAnswer('   ', 'hola')).toEqual({ correct: false, match: 'wrong' });
    expect(evaluateWrittenAnswer('', '(nota)')).toEqual({ correct: false, match: 'wrong' });
    expect(evaluateWrittenAnswer('a', 'la ventana')).toEqual({ correct: false, match: 'wrong' });
    expect(evaluateWrittenAnswer('gato', 'perro')).toEqual({ correct: false, match: 'wrong' });
  });
});

describe('buildTestQuestions', () => {
  const deck = [
    makeCard(1, 'la ventana', 'okno', 'Abre la ventana.'),
    makeCard(2, 'la puerta', 'drzwi', 'Cierra la puerta.'),
    makeCard(3, 'la mesa', 'stół', 'La mesa es grande.'),
    makeCard(4, 'la silla', 'krzesło'),
    makeCard(5, 'el libro', 'książka'),
  ];

  it('builds ABCD questions with 4 unique options including the right answer', () => {
    const qs = buildTestQuestions({
      cards: deck,
      mode: 'abcd',
      direction: 'front_to_back',
      frontLang: 'es',
      backLang: 'pl',
      rng: lcg(42),
    });
    expect(qs.length).toBe(5);
    for (const q of qs) {
      expect(q.options.length).toBe(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.options).toContain(q.answer);
      expect(q.promptLang).toBe('es');
      expect(q.answerLang).toBe('pl');
    }
  });

  it('pulls fallback distractors from distractorPool when scope has fewer than 4 cards', () => {
    const smallScope = deck.slice(0, 2);
    const qs = buildTestQuestions({
      cards: smallScope,
      distractorPool: deck,
      mode: 'abcd',
      direction: 'front_to_back',
      rng: lcg(7),
    });
    expect(qs.length).toBe(2);
    for (const q of qs) {
      expect(q.options.length).toBe(4);
      expect(q.options).toContain(q.answer);
    }
  });

  it('deduplicates identical distractors cleanly', () => {
    const dupDeck = [
      makeCard(1, 'hola', 'cześć'),
      makeCard(2, 'buenas', 'cześć'),
      makeCard(3, 'adiós', 'pa'),
    ];
    const qs = buildTestQuestions({
      cards: dupDeck,
      mode: 'abcd',
      direction: 'front_to_back',
      rng: lcg(3),
    });
    expect(uniqueAnswerCount(dupDeck, dupDeck, 'front_to_back')).toBe(2);
    for (const q of qs) {
      expect(q.options.length).toBe(2);
      expect(new Set(q.options).size).toBe(2);
      expect(q.options).toContain(q.answer);
    }
  });

  it('places example sentence on the es side without spoiling answers', () => {
    // Default es -> pl: forward shows example on prompt; reverse reveals example on answer
    const fwd = buildTestQuestions({
      cards: [deck[0]],
      mode: 'written',
      direction: 'front_to_back',
      frontLang: 'es',
      backLang: 'pl',
      rng: lcg(1),
    })[0];
    expect(fwd.promptExample).toBe('Abre la ventana.');
    expect(fwd.answerExample).toBeNull();

    const rev = buildTestQuestions({
      cards: [deck[0]],
      mode: 'written',
      direction: 'back_to_front',
      frontLang: 'es',
      backLang: 'pl',
      rng: lcg(1),
    })[0];
    expect(rev.promptExample).toBeNull();
    expect(rev.answerExample).toBe('Abre la ventana.');

    // Swapped pl -> es: forward hides example on prompt (pl), reveals on answer (es)
    const swappedFwd = buildTestQuestions({
      cards: [makeCard(9, 'okno', 'la ventana', 'Abre la ventana.')],
      mode: 'written',
      direction: 'front_to_back',
      frontLang: 'Polski',
      backLang: 'Español',
      rng: lcg(1),
    })[0];
    expect(swappedFwd.promptExample).toBeNull();
    expect(swappedFwd.answerExample).toBe('Abre la ventana.');
  });

  it('unions scope cards and distractorPool and excludes same-prompt ambiguous distractors', () => {
    // Scope cards not included in distractorPool (e.g. >500 cards in deck)
    const scope = [makeCard(10, 'uno', 'jeden'), makeCard(11, 'dos', 'dwa')];
    const disjointPool = [makeCard(12, 'tres', 'trzy')];
    expect(uniqueAnswerCount(scope, disjointPool, 'front_to_back')).toBe(3);
    expect(canRunAbcd(scope, disjointPool, 'front_to_back')).toBe(true);

    // Two cards with the same prompt cannot be distractors for each other
    const homographs = [
      makeCard(20, 'hola', 'cześć'),
      makeCard(21, 'hola', 'hej'),
    ];
    expect(canRunAbcd(homographs, [], 'front_to_back')).toBe(false);

    // With a 3rd distinct card, ABCD is possible and 'hola' never gets 'hej' as distractor for 'cześć'
    const withThird = [...homographs, makeCard(22, 'adiós', 'pa')];
    expect(canRunAbcd(withThird, [], 'front_to_back')).toBe(true);
    const qs = buildTestQuestions({
      cards: withThird,
      mode: 'abcd',
      direction: 'front_to_back',
      rng: lcg(5),
    });
    const qHola1 = qs.find((q) => q.card.id === 20)!;
    expect(qHola1.options).toEqual(expect.arrayContaining(['cześć', 'pa']));
    expect(qHola1.options).not.toContain('hej');
  });
});
