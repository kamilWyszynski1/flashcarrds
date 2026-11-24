import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge, Button, Empty, ErrorBox, IconButton, Spinner, TopBar } from '../components/ui';
import { api } from '../lib/api';
import { fmtDuration, plural, vibrate } from '../lib/format';
import { useStore } from '../lib/store';
import {
  buildTestQuestions,
  canRunAbcd,
  evaluateWrittenAnswer,
  gradeForScore,
  scorePercent,
  summarizeTestResults,
  type TestQuestion,
  type WrittenMatch,
} from '../lib/testQuiz';
import type { Card, TestDirection, TestMode, TestResult, TestScopeType } from '../lib/types';

const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

type Phase = 'setup' | 'quiz' | 'results';

interface AnswerRecord {
  question: TestQuestion;
  userAnswer: string;
  correct: boolean;
  match?: WrittenMatch;
  overridden?: boolean;
}

function parseScope(raw: string | null): { type: TestScopeType; id: number } | null {
  if (!raw) return null;
  if (raw.startsWith('unit:')) {
    const id = Number(raw.slice(5));
    return Number.isInteger(id) && id > 0 ? { type: 'unit', id } : null;
  }
  if (raw.startsWith('lesson:')) {
    const id = Number(raw.slice(7));
    return Number.isInteger(id) && id > 0 ? { type: 'lesson', id } : null;
  }
  return null;
}

export function Test() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { overview, settings, refresh, toast } = useStore();

  const parsedScope = useMemo(() => parseScope(params.get('scope')), [params]);
  const initialModeParam = params.get('mode');
  const initialDirectionParam = params.get('direction');

  const [cards, setCards] = useState<Card[] | null>(null);
  const [pool, setPool] = useState<Card[]>([]);
  const [history, setHistory] = useState<TestResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('setup');
  const [mode, setMode] = useState<TestMode>(initialModeParam === 'written' ? 'written' : 'abcd');
  const [direction, setDirection] = useState<TestDirection>(() => {
    if (initialDirectionParam === 'front_to_back' || initialDirectionParam === 'back_to_front' || initialDirectionParam === 'mixed') {
      return initialDirectionParam;
    }
    return settings?.study_direction ?? 'front_to_back';
  });
  const directionTouched = useRef(Boolean(initialDirectionParam));

  // Sync default direction from settings once loaded (if user hasn't picked one).
  useEffect(() => {
    if (!directionTouched.current && settings?.study_direction) {
      setDirection(settings.study_direction);
    }
  }, [settings?.study_direction]);

  // Quiz state
  const [questions, setQuestions] = useState<TestQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  // Per-question interaction state
  const [pickedOption, setPickedOption] = useState<string | null>(null);
  const [writtenInput, setWrittenInput] = useState('');
  const [currentFeedback, setCurrentFeedback] = useState<AnswerRecord | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Result saving state
  const [previousBest, setPreviousBest] = useState<number | null>(null);
  const [savingResult, setSavingResult] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedResult, setSavedResult] = useState<TestResult | null>(null);
  const finishedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const attemptSeqRef = useRef(0);

  const scopeKey = parsedScope ? `${parsedScope.type}:${parsedScope.id}` : '';
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  const scopeName = useMemo(() => {
    if (!parsedScope || !overview) return parsedScope?.type === 'unit' ? 'Unit' : 'Lesson';
    if (parsedScope.type === 'unit') {
      return overview.units.find((u) => u.id === parsedScope.id)?.name ?? 'Unit';
    }
    for (const u of overview.units) {
      const l = u.lessons.find((x) => x.id === parsedScope.id);
      if (l) return l.name;
    }
    return 'Lesson';
  }, [parsedScope, overview]);

  const load = useCallback(async () => {
    if (!parsedScope) return;
    const seq = ++loadSeqRef.current;
    attemptSeqRef.current += 1;
    setPhase('setup');
    setQuestions([]);
    setIndex(0);
    setAnswers([]);
    setPickedOption(null);
    setWrittenInput('');
    setCurrentFeedback(null);
    setPreviousBest(null);
    setSavedResult(null);
    setSaveError(null);
    setSavingResult(false);
    finishedRef.current = false;
    setError(null);
    setCards(null);
    try {
      const cardFilter = parsedScope.type === 'unit' ? { unit_id: parsedScope.id, limit: 2000 } : { lesson_id: parsedScope.id, limit: 2000 };
      const [scopeCards, allCards, pastResults] = await Promise.all([
        api.cards(cardFilter),
        api.cards({ limit: 500 }),
        api.testResults({ scope_type: parsedScope.type, scope_id: parsedScope.id, limit: 10000 }),
      ]);
      if (loadSeqRef.current !== seq) return;
      setCards(scopeCards);
      setPool(allCards);
      setHistory(pastResults);
    } catch (e) {
      if (loadSeqRef.current !== seq) return;
      setError((e as Error).message);
    }
  }, [parsedScope]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarizeTestResults(history), [history]);
  const abcdAvailable = useMemo(() => {
    if (!cards || cards.length === 0) return false;
    return canRunAbcd(cards, pool, direction);
  }, [cards, pool, direction]);

  // If ABCD isn't possible (e.g. only 1 card in entire deck), auto-select written mode on setup.
  useEffect(() => {
    if (phase === 'setup' && cards && cards.length > 0 && !abcdAvailable && mode === 'abcd') {
      setMode('written');
    }
  }, [phase, cards, abcdAvailable, mode]);

  const startTest = useCallback(
    (chosenMode: TestMode = mode, chosenDirection: TestDirection = direction) => {
      if (!cards || cards.length === 0) return;
      const effectiveMode = chosenMode === 'abcd' && !canRunAbcd(cards, pool, chosenDirection) ? 'written' : chosenMode;
      const pendingBest =
        phase === 'results' && !saveError && answers.length > 0
          ? scorePercent(answers.filter((a) => a.correct).length, answers.length)
          : null;
      const knownBest =
        summary?.best_score !== undefined && pendingBest !== null
          ? Math.max(summary.best_score, pendingBest)
          : summary?.best_score ?? pendingBest;

      attemptSeqRef.current += 1;
      setMode(effectiveMode);
      setDirection(chosenDirection);
      const q = buildTestQuestions({
        cards,
        distractorPool: pool,
        mode: effectiveMode,
        direction: chosenDirection,
        frontLang: settings?.front_lang,
        backLang: settings?.back_lang,
      });
      setQuestions(q);
      setIndex(0);
      setAnswers([]);
      setPickedOption(null);
      setWrittenInput('');
      setCurrentFeedback(null);
      setPreviousBest(knownBest);
      setSavedResult(null);
      setSaveError(null);
      setSavingResult(false);
      finishedRef.current = false;
      setStartedAt(Date.now());
      setDurationMs(0);
      setPhase('quiz');
    },
    [cards, pool, mode, direction, phase, saveError, answers, settings?.front_lang, settings?.back_lang, summary?.best_score],
  );

  // Focus written input whenever advancing to a new written question.
  useEffect(() => {
    if (phase === 'quiz' && mode === 'written' && !currentFeedback) {
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
  }, [phase, mode, index, currentFeedback]);

  const persistResult = useCallback(
    async (finalAnswers: AnswerRecord[], elapsedMs: number, testMode: TestMode, testDir: TestDirection) => {
      if (!parsedScope || finalAnswers.length === 0) return;
      const attemptSeq = attemptSeqRef.current;
      const targetScopeKey = `${parsedScope.type}:${parsedScope.id}`;
      const correct = finalAnswers.filter((a) => a.correct).length;
      setSavingResult(true);
      setSaveError(null);
      try {
        const res = await api.saveTestResult({
          scope_type: parsedScope.type,
          scope_id: parsedScope.id,
          mode: testMode,
          direction: testDir,
          correct,
          total: finalAnswers.length,
          duration_ms: elapsedMs,
        });
        if (scopeKeyRef.current === targetScopeKey) {
          setHistory((prev) => [res, ...prev]);
        }
        if (attemptSeqRef.current === attemptSeq) {
          setSavedResult(res);
        }
        void refresh();
      } catch (e) {
        if (attemptSeqRef.current === attemptSeq) {
          setSaveError((e as Error).message);
        }
      } finally {
        if (attemptSeqRef.current === attemptSeq) {
          setSavingResult(false);
        }
      }
    },
    [parsedScope, refresh],
  );

  const currentQuestion = questions[index];

  const handlePickOption = useCallback(
    (option: string) => {
      if (!currentQuestion || currentFeedback) return;
      const correct = option === currentQuestion.answer;
      vibrate(correct ? 10 : 25, settings?.haptics);
      setPickedOption(option);
      setCurrentFeedback({
        question: currentQuestion,
        userAnswer: option,
        correct,
      });
    },
    [currentQuestion, currentFeedback, settings?.haptics],
  );

  const handleCheckWritten = useCallback(
    (skip = false) => {
      if (!currentQuestion || currentFeedback) return;
      const trimmed = writtenInput.trim();
      if (!skip && !trimmed) return;
      const evalRes = skip ? { correct: false, match: 'wrong' as WrittenMatch } : evaluateWrittenAnswer(trimmed, currentQuestion.answer);
      vibrate(evalRes.correct ? 10 : 25, settings?.haptics);
      setCurrentFeedback({
        question: currentQuestion,
        userAnswer: skip ? '' : trimmed,
        correct: evalRes.correct,
        match: evalRes.match,
      });
    },
    [currentQuestion, currentFeedback, writtenInput, settings?.haptics],
  );

  const handleOverrideCorrect = () => {
    if (!currentFeedback || currentFeedback.correct) return;
    setCurrentFeedback({ ...currentFeedback, correct: true, overridden: true });
    toast('Marked as correct');
  };

  const handleNext = useCallback(() => {
    if (!currentFeedback) return;
    const updatedAnswers = [...answers, currentFeedback];
    setAnswers(updatedAnswers);
    setCurrentFeedback(null);
    setPickedOption(null);
    setWrittenInput('');

    if (index + 1 >= questions.length) {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const elapsed = Math.max(0, Date.now() - startedAt);
      setDurationMs(elapsed);
      setPhase('results');
      void persistResult(updatedAnswers, elapsed, mode, direction);
    } else {
      setIndex((i) => i + 1);
    }
  }, [currentFeedback, answers, index, questions.length, startedAt, persistResult, mode, direction]);

  // Keyboard shortcuts during quiz
  useEffect(() => {
    if (phase !== 'quiz') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
      const tag = (e.target as HTMLElement)?.tagName;
      const onInteractive = tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (mode === 'abcd') {
        if (!currentFeedback && currentQuestion) {
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          const idxByNum = ['1', '2', '3', '4'].indexOf(e.key);
          const idxByLet = ['a', 'b', 'c', 'd'].indexOf(e.key.toLowerCase());
          const idx = idxByNum >= 0 ? idxByNum : idxByLet;
          if (idx >= 0 && idx < currentQuestion.options.length) {
            e.preventDefault();
            handlePickOption(currentQuestion.options[idx]);
          }
        } else if (currentFeedback && !onInteractive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          handleNext();
        }
      } else if (mode === 'written') {
        if (currentFeedback && !onInteractive && e.key === 'Enter') {
          e.preventDefault();
          handleNext();
        } else if (!currentFeedback && !onInteractive && tag !== 'INPUT' && e.key === 'Enter') {
          e.preventDefault();
          handleCheckWritten(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, mode, currentFeedback, currentQuestion, handlePickOption, handleNext, handleCheckWritten]);

  const goBackToOrigin = () => {
    if (parsedScope?.type === 'lesson') {
      navigate(`/group/${parsedScope.id}`);
    } else {
      navigate('/');
    }
  };

  const closeQuiz = () => {
    if (phase === 'quiz' && (answers.length > 0 || currentFeedback)) {
      if (!window.confirm('Leave this test? Your current attempt will not be saved.')) return;
    }
    goBackToOrigin();
  };

  if (!parsedScope) {
    return (
      <div className="min-h-dvh bg-surface">
        <TopBar title="Test" back onBack={() => navigate('/')} />
        <Empty
          icon="quiz"
          title="No group selected"
          text="Pick a unit or lesson from Groups to start a test."
          action={<Button onClick={() => navigate('/')}>Back to groups</Button>}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-dvh bg-surface">
        <TopBar title={`Test · ${scopeName}`} back onBack={goBackToOrigin} />
        <div className="max-w-app mx-auto p-4">
          <ErrorBox message={error} onRetry={() => void load()} />
        </div>
      </div>
    );
  }

  if (cards === null) {
    return (
      <div className="min-h-dvh bg-surface">
        <TopBar title={`Test · ${scopeName}`} back onBack={goBackToOrigin} />
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="min-h-dvh bg-surface">
        <TopBar title={`Test · ${scopeName}`} back onBack={goBackToOrigin} />
        <Empty
          icon="quiz"
          title="No cards to test"
          text={`Add some cards to this ${parsedScope.type} before taking a test.`}
          action={<Button onClick={goBackToOrigin}>Back</Button>}
        />
      </div>
    );
  }

  const frontLangLabel = settings?.front_lang ?? 'Front';
  const backLangLabel = settings?.back_lang ?? 'Back';

  // -------------------------------------------------------------------------
  // Phase 1: Setup
  // -------------------------------------------------------------------------
  if (phase === 'setup') {
    const bestGrade = summary ? gradeForScore(summary.best_score) : null;
    return (
      <div className="min-h-dvh bg-surface pb-10">
        <TopBar
          title={`Test · ${scopeName}`}
          subtitle={`${parsedScope.type === 'unit' ? 'Unit' : 'Lesson'} · ${plural(cards.length, 'card')}`}
          back
          onBack={goBackToOrigin}
        />
        <main className="max-w-app mx-auto px-margin-mobile pt-4 space-y-5">
          {summary && bestGrade && (
            <section className="rounded-2xl bg-surface-container-lowest shadow-card p-4 flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-primary-fixed text-on-primary-fixed-variant flex items-center justify-center shrink-0">
                <Icon name="award" size={24} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-body-md font-semibold text-on-surface">Best result</span>
                  <Badge tone={bestGrade.tone}>
                    Grade {bestGrade.letter} · {summary.best_score}%
                  </Badge>
                </div>
                <div className="text-body-sm text-on-surface-variant mt-0.5">
                  {summary.best_correct}/{summary.best_total} ({summary.best_mode === 'abcd' ? 'ABCD' : 'Written'}) · {plural(summary.attempts, 'attempt')}
                  {summary.attempts > 1 && summary.last_score !== summary.best_score ? ` · last ${summary.last_score}%` : ''}
                </div>
              </div>
            </section>
          )}

          <section>
            <div className="text-label-sm font-semibold tracking-wider uppercase text-on-surface-variant mb-2.5 px-0.5">Test type</div>
            <div className="grid grid-cols-1 gap-2.5">
              <ModeCard
                selected={mode === 'abcd'}
                disabled={!abcdAvailable}
                icon="quiz"
                title="Multiple choice (ABCD)"
                description={
                  abcdAvailable
                    ? 'Pick the right translation from up to 4 options'
                    : 'Needs at least 2 distinct cards in your deck'
                }
                onClick={() => setMode('abcd')}
              />
              <ModeCard
                selected={mode === 'written'}
                icon="edit"
                title="Written answers"
                description="Type the translation from memory"
                onClick={() => setMode('written')}
              />
            </div>
          </section>

          <section>
            <div className="text-label-sm font-semibold tracking-wider uppercase text-on-surface-variant mb-2.5 px-0.5">Question direction</div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'front_to_back', label: `${frontLangLabel} → ${backLangLabel}` },
                  { id: 'back_to_front', label: `${backLangLabel} → ${frontLangLabel}` },
                  { id: 'mixed', label: 'Mixed' },
                ] as const
              ).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={direction === d.id}
                  onClick={() => {
                    directionTouched.current = true;
                    setDirection(d.id);
                  }}
                  className={`min-h-[44px] px-2.5 rounded-xl text-body-sm font-semibold transition-colors truncate ${
                    direction === d.id
                      ? 'bg-primary-fixed text-on-primary-fixed-variant ring-2 ring-primary/40'
                      : 'bg-surface-container text-on-surface-variant'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </section>

          <p className="text-body-sm text-on-surface-variant px-0.5">
            Covers all {plural(cards.length, 'card')} in random order. Taking a test does not alter your spaced-repetition schedule.
          </p>

          <Button size="lg" shape="rounded" className="w-full h-14" icon="play" onClick={() => startTest(mode, direction)}>
            {summary ? `Retake test · ${plural(cards.length, 'question')}` : `Start test · ${plural(cards.length, 'question')}`}
          </Button>
        </main>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Phase 2: Quiz
  // -------------------------------------------------------------------------
  if (phase === 'quiz' && currentQuestion) {
    const pct = questions.length === 0 ? 0 : (index + (currentFeedback ? 1 : 0)) / questions.length;
    const isLast = index + 1 >= questions.length;
    const longPrompt = currentQuestion.prompt.length > 26;

    return (
      <div className="min-h-dvh bg-surface flex flex-col max-w-app mx-auto">
        <div className="flex items-center gap-2 px-2 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)]">
          <IconButton icon="close" label="Close test" onClick={closeQuiz} />
          <div className="flex-1 h-2 bg-surface-container-high rounded-full overflow-hidden">
            <div className="h-full bg-primary-container rounded-full transition-[width] duration-300" style={{ width: `${pct * 100}%` }} />
          </div>
          <div className="text-body-sm text-on-surface-variant min-w-[52px] text-right pr-2 tabular-nums">
            {index + 1} / {questions.length}
          </div>
        </div>
        <div className="flex items-center justify-center gap-2 px-4 pt-1 pb-2 text-body-sm text-on-surface-variant">
          <span className="truncate">{scopeName}</span>
          <span className="text-outline-variant">•</span>
          <span className="shrink-0 font-semibold uppercase text-label-sm">{mode === 'abcd' ? 'ABCD' : 'Written'}</span>
        </div>

        <main className="flex-1 flex flex-col px-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] gap-4">
          {/* Prompt card */}
          <div className="rounded-3xl bg-surface-container-lowest shadow-card px-6 py-7 text-center flex flex-col items-center justify-center min-h-[156px] relative">
            {currentQuestion.promptLang && (
              <div className="text-label-sm tracking-[0.08em] uppercase text-on-surface-variant font-semibold mb-2">
                {currentQuestion.promptLang}
              </div>
            )}
            <div className={`font-display font-bold text-on-surface leading-[1.18] tracking-[-0.02em] break-words max-w-full ${longPrompt ? 'text-[22px]' : 'text-[30px]'}`}>
              {currentQuestion.prompt}
            </div>
            {currentQuestion.promptExample?.trim() && (
              <div className="mt-3 px-3 py-1.5 rounded-xl bg-surface-container-low text-body-sm italic text-on-surface-variant break-words max-w-full">
                {currentQuestion.promptExample.trim()}
              </div>
            )}
          </div>

          {/* ABCD options */}
          {mode === 'abcd' && (
            <div className="flex flex-col gap-2.5">
              {currentQuestion.options.map((opt, idx) => {
                const letter = OPTION_LETTERS[idx] ?? String(idx + 1);
                const isPicked = pickedOption === opt;
                const isCorrectOpt = opt === currentQuestion.answer;
                let style = 'bg-surface-container-lowest text-on-surface shadow-card border-2 border-transparent active:scale-[0.99]';
                let badgeStyle = 'bg-surface-container text-on-surface-variant';
                if (currentFeedback) {
                  if (isCorrectOpt) {
                    style = 'bg-good-container text-good border-2 border-good font-semibold';
                    badgeStyle = 'bg-good text-on-primary dark:text-surface';
                  } else if (isPicked && !isCorrectOpt) {
                    style = 'bg-again-container text-again border-2 border-again font-semibold';
                    badgeStyle = 'bg-again text-on-primary dark:text-surface';
                  } else {
                    style = 'bg-surface-container-low text-on-surface-variant opacity-60 border-2 border-transparent';
                  }
                }
                return (
                  <button
                    key={`${idx}-${opt}`}
                    type="button"
                    disabled={Boolean(currentFeedback)}
                    onClick={() => handlePickOption(opt)}
                    className={`w-full min-h-[56px] rounded-2xl px-3.5 py-3 flex items-center gap-3 text-left transition-all ${style}`}
                  >
                    <span className={`w-8 h-8 rounded-xl flex items-center justify-center text-label-lg font-bold shrink-0 ${badgeStyle}`}>
                      {letter}
                    </span>
                    <span className="flex-1 text-body-md break-words">{opt}</span>
                    {currentFeedback && isCorrectOpt && <Icon name="check" size={20} strokeWidth={2.5} />}
                    {currentFeedback && isPicked && !isCorrectOpt && <Icon name="close" size={20} strokeWidth={2.5} />}
                  </button>
                );
              })}
            </div>
          )}

          {/* Written answer */}
          {mode === 'written' && (
            <div className="flex flex-col gap-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (currentFeedback) handleNext();
                  else handleCheckWritten(false);
                }}
                className="flex flex-col gap-3"
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={writtenInput}
                  disabled={Boolean(currentFeedback)}
                  onChange={(e) => setWrittenInput(e.target.value)}
                  placeholder={`Type in ${currentQuestion.answerLang ?? 'answer language'}…`}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="done"
                  className="w-full bg-surface-container-lowest text-on-surface text-[18px] leading-6 rounded-2xl px-4 min-h-[56px] py-3.5 outline-none border-2 border-outline-variant/60 focus:border-primary shadow-card placeholder:text-outline disabled:opacity-75"
                />
                {!currentFeedback && (
                  <div className="flex gap-2.5">
                    <Button variant="outline" className="flex-1" onClick={() => handleCheckWritten(true)}>
                      Don’t know
                    </Button>
                    <Button type="submit" className="flex-[2]" disabled={!writtenInput.trim()}>
                      Check
                    </Button>
                  </div>
                )}
              </form>
            </div>
          )}

          {/* Feedback banner */}
          {currentFeedback && (
            <div
              className={`rounded-2xl p-4 ${
                currentFeedback.correct ? 'bg-good-container text-good' : 'bg-again-container text-again'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-body-md flex items-center gap-1.5">
                    <Icon name={currentFeedback.correct ? 'check' : 'close'} size={18} strokeWidth={2.5} />
                    {currentFeedback.correct
                      ? currentFeedback.overridden
                        ? 'Marked as correct'
                        : currentFeedback.match === 'accent'
                          ? 'Correct! Watch the accents'
                          : 'Correct!'
                      : currentFeedback.userAnswer
                        ? 'Not quite'
                        : 'Skipped'}
                  </div>
                  {(!currentFeedback.correct || currentFeedback.match === 'accent') && (
                    <div className="text-body-md mt-1 text-on-surface">
                      <span className="text-on-surface-variant text-body-sm">Answer: </span>
                      <span className="font-semibold">{currentQuestion.answer}</span>
                    </div>
                  )}
                  {currentQuestion.answerExample?.trim() && (
                    <div className="text-body-sm italic mt-1.5 text-on-surface-variant">
                      {currentQuestion.answerExample.trim()}
                    </div>
                  )}
                </div>
                {mode === 'written' && !currentFeedback.correct && currentFeedback.userAnswer && (
                  <button
                    type="button"
                    onClick={handleOverrideCorrect}
                    className="text-label-md font-semibold underline text-on-surface shrink-0 py-1"
                  >
                    I was right
                  </button>
                )}
              </div>
            </div>
          )}

          {currentFeedback && (
            <div className="mt-auto pt-2">
              <Button size="lg" shape="rounded" className="w-full h-14" onClick={handleNext}>
                {isLast ? 'See results' : 'Next question'}
              </Button>
            </div>
          )}
        </main>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Phase 3: Results
  // -------------------------------------------------------------------------
  const correctCount = answers.filter((a) => a.correct).length;
  const totalCount = answers.length;
  const score = scorePercent(correctCount, totalCount);
  const grade = gradeForScore(score);
  const missed = answers.filter((a) => !a.correct);

  const ringColor =
    grade.tone === 'ok'
      ? 'rgb(var(--c-good))'
      : grade.tone === 'new'
        ? 'rgb(var(--c-primary-container))'
        : grade.tone === 'due'
          ? 'rgb(var(--c-hard))'
          : 'rgb(var(--c-again))';
  const ring = `conic-gradient(${ringColor} 0 ${score}%, rgb(var(--c-surface-container-highest)) ${score}% 100%)`;

  const improved = previousBest !== null && score > previousBest;
  const tiedBest = previousBest !== null && score === previousBest;
  const altMode: TestMode = mode === 'abcd' ? 'written' : 'abcd';
  const canTryAltMode = altMode === 'written' || abcdAvailable;

  return (
    <div className="min-h-dvh bg-surface flex flex-col items-center text-center px-6 pt-[calc(env(safe-area-inset-top,0px)+2rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] max-w-app mx-auto">
      <div className="w-[152px] h-[152px] rounded-full grid place-items-center mb-3" style={{ background: ring }}>
        <div className="w-[120px] h-[120px] rounded-full bg-surface flex flex-col items-center justify-center">
          <span className="font-display text-[30px] font-bold text-on-surface leading-none">{score}%</span>
          <span className="text-label-md font-bold text-on-surface-variant mt-1">Grade {grade.letter}</span>
        </div>
      </div>

      <h2 className="font-display text-headline-md text-on-surface">
        {score === 100 ? 'Perfect score! 🎉' : score >= 80 ? 'Great job!' : score >= 60 ? 'Good effort!' : 'Keep practising!'}
      </h2>
      <div className="text-body-sm text-on-surface-variant mt-1">
        {scopeName} · {mode === 'abcd' ? 'ABCD' : 'Written'} · {correctCount}/{totalCount} · {fmtDuration(durationMs)}
      </div>

      {/* Comparison with previous best */}
      <div className="mt-3">
        {previousBest === null ? (
          <Badge tone={grade.tone}>First test saved</Badge>
        ) : improved ? (
          <Badge tone="ok">New best! +{score - previousBest}% (was {previousBest}%)</Badge>
        ) : tiedBest ? (
          <Badge tone="new">Matched best score ({previousBest}%)</Badge>
        ) : (
          <Badge tone="neutral">Best stays {previousBest}% · retake to beat it</Badge>
        )}
      </div>

      {saveError && (
        <div className="w-full mt-4 text-left">
          <ErrorBox
            message={`Could not save result: ${saveError}`}
            onRetry={() => void persistResult(answers, durationMs, mode, direction)}
          />
        </div>
      )}
      {savingResult && !savedResult && (
        <div className="text-body-sm text-on-surface-variant mt-2">Saving result…</div>
      )}

      <div className="grid grid-cols-3 gap-2 w-full mt-5">
        <ResultStat value={String(correctCount)} label="Correct" cls="text-good" />
        <ResultStat value={String(missed.length)} label="Missed" cls="text-again" />
        <ResultStat value={grade.letter} label="Grade" cls="text-primary" />
      </div>

      {missed.length > 0 ? (
        <div className="w-full mt-5 rounded-2xl bg-surface-container-lowest shadow-card p-4 text-left">
          <div className="text-label-sm font-semibold tracking-wider uppercase text-on-surface-variant mb-2">
            Missed ({missed.length})
          </div>
          {missed.map((m, i) => (
            <div key={`${m.question.card.id}-${i}`} className="py-2.5 border-b border-outline-variant/40 last:border-b-0">
              <div className="text-body-md font-semibold text-on-surface">{m.question.prompt}</div>
              <div className="text-body-sm mt-0.5 flex flex-wrap gap-x-2">
                <span className="text-good font-semibold">{m.question.answer}</span>
                <span className="text-again line-through">{m.userAnswer || 'skipped'}</span>
              </div>
              {m.question.card.example?.trim() && (
                <div className="text-label-md italic text-on-surface-variant mt-0.5">{m.question.card.example.trim()}</div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="w-full mt-5 rounded-2xl bg-good-container/60 text-good p-4 text-body-md font-semibold">
          Every answer was right!
        </div>
      )}

      <div className="flex flex-col gap-2.5 w-full mt-auto pt-6">
        <Button size="lg" shape="rounded" icon="refresh" onClick={() => startTest(mode, direction)}>
          Retake test
        </Button>
        <div className="flex gap-2.5">
          {canTryAltMode && (
            <Button variant="tonal" className="flex-1" onClick={() => startTest(altMode, direction)}>
              Try {altMode === 'abcd' ? 'ABCD' : 'Written'}
            </Button>
          )}
          <Button variant="outline" className="flex-1" onClick={() => setPhase('setup')}>
            Options
          </Button>
        </div>
        <Button variant="ghost" onClick={goBackToOrigin}>
          {parsedScope.type === 'lesson' ? 'Back to lesson' : 'Back to groups'}
        </Button>
      </div>
    </div>
  );
}

function ModeCard({
  selected,
  disabled,
  icon,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  disabled?: boolean;
  icon: 'quiz' | 'edit';
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={`w-full rounded-2xl p-4 flex items-center gap-3.5 text-left transition-all disabled:opacity-45 disabled:pointer-events-none ${
        selected
          ? 'bg-primary-fixed/60 dark:bg-primary/15 ring-2 ring-primary shadow-card'
          : 'bg-surface-container-lowest shadow-card'
      }`}
    >
      <span
        className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
          selected ? 'bg-primary-container text-on-primary' : 'bg-surface-container text-on-surface-variant'
        }`}
      >
        <Icon name={icon} size={22} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-body-md font-semibold text-on-surface">{title}</span>
        <span className="block text-body-sm text-on-surface-variant">{description}</span>
      </span>
      {selected && <Icon name="check" size={20} strokeWidth={2.5} className="text-primary shrink-0" />}
    </button>
  );
}

function ResultStat({ value, label, cls }: { value: string; label: string; cls: string }) {
  return (
    <div className="rounded-2xl bg-surface-container-lowest shadow-card py-2.5 px-1">
      <b className={`block text-[20px] ${cls}`}>{value}</b>
      <span className="text-label-sm text-on-surface-variant">{label}</span>
    </div>
  );
}
