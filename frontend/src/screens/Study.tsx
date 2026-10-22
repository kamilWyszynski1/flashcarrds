import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button, Empty, ErrorBox, IconButton, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { vibrate } from '../lib/format';
import { applyGrade, createSession, current, isFinished, progress, shuffle, summarize, type SessionState } from '../lib/session';
import { useSheets } from '../lib/sheets';
import { useStore } from '../lib/store';
import { setEditingCard } from '../sheets/Sheets';
import type { Grade, StudyItem } from '../lib/types';

const GRADES: { g: Grade; label: string; cls: string }[] = [
  { g: 'again', label: 'Again', cls: 'bg-again-container text-again' },
  { g: 'hard', label: 'Hard', cls: 'bg-hard-container text-hard' },
  { g: 'good', label: 'Good', cls: 'bg-good-container text-good' },
  { g: 'easy', label: 'Easy', cls: 'bg-easy-container text-easy' },
];

export function Study() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { settings, overview, refresh, toast } = useStore();
  const { openSheet, open } = useSheets();
  const scope = params.get('scope') ?? (params.get('ids') ? '' : 'all');
  const mode = params.get('mode') ?? undefined;
  const ids = params.get('ids') ?? undefined;
  const label = params.get('label');

  const [session, setSession] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const finishedRef = useRef(false);

  // Scope label for the top of the screen.
  const scopeLabel = (() => {
    if (label) return label;
    if (ids) return 'Selected cards';
    if (scope.startsWith('lesson:')) {
      const id = Number(scope.slice(7));
      return overview?.units.flatMap((u) => u.lessons).find((l) => l.id === id)?.name ?? 'Lesson';
    }
    if (scope.startsWith('unit:')) {
      const id = Number(scope.slice(5));
      return overview?.units.find((u) => u.id === id)?.name ?? 'Unit';
    }
    return mode === 'all' ? 'All cards' : 'All groups · due today';
  })();

  const load = useCallback(async () => {
    setError(null);
    setSession(null);
    try {
      const items = await api.studyQueue({ scope: scope || undefined, mode, ids, limit: 200 });
      // Random order per session (also for explicit-id "repeat" sessions) so it is harder to anticipate.
      setSession(createSession(shuffle(items)));
      setFlipped(false);
      finishedRef.current = false;
    } catch (e) {
      setError((e as Error).message);
    }
  }, [scope, mode, ids]);

  useEffect(() => {
    void load();
  }, [load]);

  // When the session is complete, hand over to the summary (replace, so back skips the study screen).
  useEffect(() => {
    if (session && isFinished(session) && session.total > 0 && !finishedRef.current) {
      finishedRef.current = true;
      void refresh();
      navigate('/summary', { replace: true, state: { summary: summarize(session), scopeLabel, scope, mode, ids } });
    }
  }, [session, navigate, refresh, scopeLabel, scope, mode, ids]);

  const item: StudyItem | undefined = session ? current(session) : undefined;

  const flip = () => {
    if (!item) return;
    setFlipped((f) => !f);
    vibrate(8, settings?.haptics);
  };

  const grade = async (g: Grade) => {
    if (!item || !session || busy) return;
    setBusy(true);
    vibrate(12, settings?.haptics);
    try {
      const res = await api.review(item.card.id, g, item.direction);
      setSession((s) => (s ? applyGrade(s, g, res.due_in_secs, { card: res.card, preview: res.preview, preview_labels: res.preview_labels }) : s));
      setFlipped(false);
      setAnimKey((k) => k + 1);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Keyboard shortcuts for desktop testing: space = flip, 1-4 = grade.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === ' ') {
        e.preventDefault();
        flip();
      } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) void grade(GRADES[Number(e.key) - 1].g);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Refresh the current card after it was edited in the sheet.
  const prevOpen = useRef(open);
  useEffect(() => {
    if (prevOpen.current === 'card' && open === null && item) {
      api.cards({ lesson_id: item.card.lesson_id, limit: 5000 }).then((cards) => {
        const fresh = cards.find((c) => c.id === item.card.id);
        setSession((s) => {
          if (!s) return s;
          if (!fresh) return { ...s, queue: s.queue.filter((q) => q.card.id !== item.card.id), total: Math.max(1, s.total - 1) };
          return { ...s, queue: s.queue.map((q) => (q.card.id === fresh.id ? { ...q, card: fresh } : q)) };
        });
      });
    }
    prevOpen.current = open;
  }, [open, item]);

  const close = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/', { replace: true });
  };

  if (error) {
    return (
      <Shell onClose={close} scopeLabel={scopeLabel}>
        <div className="p-4">
          <ErrorBox message={error} onRetry={() => void load()} />
        </div>
      </Shell>
    );
  }
  if (!session) {
    return (
      <Shell onClose={close} scopeLabel={scopeLabel}>
        <div className="flex-1 flex items-center justify-center">
          <Spinner />
        </div>
      </Shell>
    );
  }
  if (session.total === 0) {
    const lessonScope = scope.startsWith('lesson:') || scope.startsWith('unit:');
    return (
      <Shell onClose={close} scopeLabel={scopeLabel}>
        <Empty
          icon="check"
          title="Nothing to study right now"
          text={lessonScope ? 'No cards are due in this group. You can still practise all of them.' : 'No cards are due. Add new cards or come back later.'}
          action={
            <div className="flex flex-col gap-2">
              {lessonScope && mode !== 'all' && (
                <Button onClick={() => navigate(`${location.pathname}?scope=${scope}&mode=all`, { replace: true })}>Practise all cards</Button>
              )}
              <Button variant="outline" onClick={close}>
                Back
              </Button>
            </div>
          }
        />
      </Shell>
    );
  }
  if (!item) return null;

  const forward = item.direction === 'forward';
  const frontText = forward ? item.card.front : item.card.back;
  const backText = forward ? item.card.back : item.card.front;
  const frontLang = forward ? settings?.front_lang : settings?.back_lang;
  const backLang = forward ? settings?.back_lang : settings?.front_lang;
  const tag = item.card.status === 'new' ? 'new' : item.card.status === 'due' ? 'due' : item.card.status === 'learning' ? 'again' : null;
  const remaining = session.queue.length;

  return (
    <div className="h-dvh bg-surface flex flex-col max-w-app mx-auto overflow-hidden">
      <div className="flex items-center gap-2 px-2 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)]">
        <IconButton icon="close" label="Close" onClick={close} />
        <div className="flex-1 h-2 bg-surface-container-high rounded-full overflow-hidden">
          <div className="h-full bg-primary-container rounded-full transition-[width] duration-300" style={{ width: `${progress(session) * 100}%` }} />
        </div>
        <div className="text-body-sm text-on-surface-variant min-w-[48px] text-right pr-2">{remaining} left</div>
      </div>
      <div className="text-body-sm text-on-surface-variant text-center px-4 pt-1.5 truncate">{scopeLabel}</div>

      <div className="flex-1 flex flex-col px-4 pt-3 min-h-0 [perspective:1200px]">
        <button
          type="button"
          key={animKey}
          onClick={flip}
          className={`relative flex-1 max-h-[520px] my-auto w-full text-left [transform-style:preserve-3d] transition-transform duration-[450ms] [transition-timing-function:cubic-bezier(.2,.7,.2,1)] ${flipped ? '[transform:rotateY(180deg)]' : ''}`}
          aria-label={flipped ? 'Card back' : 'Tap to reveal'}
        >
          <Face lang={frontLang} word={frontText} example={forward ? item.card.example : null} tag={tag} hint>
            <Icon name="touch" size={16} /> Tap to reveal
          </Face>
          <Face
            lang={backLang}
            word={backText}
            example={frontText}
            back
            hint
            onEdit={() => {
              setEditingCard(item.card);
              openSheet('card');
            }}
          >
            <Icon name="edit" size={16} /> Edit card
          </Face>
        </button>
      </div>

      {!flipped ? (
        <div className="px-4 pt-3.5 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          <Button size="lg" className="w-full" onClick={flip}>
            Show answer
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 px-4 pt-3.5 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          {GRADES.map(({ g, label, cls }) => (
            <button key={g} type="button" disabled={busy} onClick={() => void grade(g)} className={`min-h-[64px] rounded-2xl flex flex-col items-center justify-center font-bold text-[15px] active:scale-[0.97] transition-transform disabled:opacity-60 ${cls}`}>
              {label}
              <small className="font-medium text-[11px] opacity-75">{item.preview_labels[g]}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ children, onClose, scopeLabel }: { children: React.ReactNode; onClose: () => void; scopeLabel: string }) {
  return (
    <div className="h-dvh bg-surface flex flex-col max-w-app mx-auto">
      <div className="flex items-center gap-2 px-2 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)]">
        <IconButton icon="close" label="Close" onClick={onClose} />
        <div className="flex-1 text-body-sm text-on-surface-variant text-center truncate pr-12">{scopeLabel}</div>
      </div>
      {children}
    </div>
  );
}

function Face({
  lang,
  word,
  example,
  tag,
  back,
  hint,
  onEdit,
  children,
}: {
  lang?: string;
  word: string;
  example?: string | null;
  tag?: string | null;
  back?: boolean;
  hint?: boolean;
  onEdit?: () => void;
  children?: React.ReactNode;
}) {
  const long = word.length > 24;
  return (
    <div
      className={`absolute inset-0 [backface-visibility:hidden] rounded-3xl shadow-float flex flex-col items-center justify-center px-6 py-8 text-center ${
        back ? 'bg-primary-fixed [transform:rotateY(180deg)]' : 'bg-surface-container-lowest'
      }`}
    >
      <div className="absolute top-4 inset-x-0 text-label-sm tracking-[0.08em] uppercase text-on-surface-variant font-semibold">{lang}</div>
      {tag && (
        <span className={`absolute top-3.5 right-3.5 px-2.5 py-1 rounded-full text-label-sm font-bold ${tag === 'new' ? 'bg-primary-fixed text-on-primary-fixed-variant' : tag === 'due' ? 'bg-secondary-fixed text-on-secondary-fixed' : 'bg-again-container text-again'}`}>
          {tag}
        </span>
      )}
      <div className={`font-display text-on-surface font-bold leading-[1.15] tracking-[-0.02em] break-words max-w-full ${long ? 'text-[26px]' : 'text-[36px]'}`}>{word}</div>
      {example && <div className="mt-3.5 text-body-md text-on-surface-variant break-words max-w-full">{example}</div>}
      {hint && (
        <div className="absolute bottom-4 inset-x-0 flex items-center justify-center text-body-sm text-on-surface-variant">
          {onEdit ? (
            <span
              role="button"
              tabIndex={0}
              className="text-primary font-semibold min-h-[40px] px-3 inline-flex items-center gap-1.5"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              onKeyDown={(e) => e.key === 'Enter' && onEdit()}
            >
              {children}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">{children}</span>
          )}
        </div>
      )}
    </div>
  );
}
