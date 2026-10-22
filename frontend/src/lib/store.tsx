import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { ExtractedCard, Overview, Settings } from './types';

/** Cards waiting on the Review screen (from a photo or a pasted list). */
export interface Draft {
  source: 'photo' | 'paste' | 'manual';
  cards: (ExtractedCard & { include: boolean; key: number })[];
  hint: string;
  previewUrl?: string;
  model?: string;
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; onClick: () => void };
}

/**
 * State of the "New card" / "Edit card" sheet. It lives in the store (not in
 * the sheet component) because opening the group picker from the sheet
 * swaps the sheet out of the DOM; everything the user chose must survive that.
 */
export interface CardDraft {
  id?: number;
  front: string;
  back: string;
  example: string;
  /** Lesson picked in the sheet's group selector (undefined = default target). */
  lessonId?: number;
}

interface Store {
  overview: Overview | null;
  settings: Settings | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setSettings: (s: Settings) => void;

  /** Lesson new cards go to (Capture / Review / New card). */
  targetLessonId: number | null;
  setTargetLessonId: (id: number | null) => void;

  draft: Draft | null;
  setDraft: (d: Draft | null | ((d: Draft | null) => Draft | null)) => void;

  cardDraft: CardDraft;
  setCardDraft: (d: CardDraft | ((d: CardDraft) => CardDraft)) => void;

  toast: (text: string, action?: Toast['action']) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

const Ctx = createContext<Store | null>(null);

const DRAFT_KEY = 'fiszki.draft';
const TARGET_KEY = 'fiszki.targetLessonId';
const EMPTY_CARD: CardDraft = { front: '', back: '', example: '' };

export function StoreProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetLessonId, setTargetState] = useState<number | null>(() => {
    const v = localStorage.getItem(TARGET_KEY);
    return v ? Number(v) : null;
  });
  const [draft, setDraftState] = useState<Draft | null>(() => {
    try {
      const v = sessionStorage.getItem(DRAFT_KEY);
      return v ? (JSON.parse(v) as Draft) : null;
    } catch {
      return null;
    }
  });
  const [cardDraft, setCardDraft] = useState<CardDraft>(EMPTY_CARD);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([api.overview(), api.settings()]);
      setOverview(o);
      setSettingsState(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // Default target: last used lesson (server), else first lesson that exists.
  useEffect(() => {
    if (!overview) return;
    const lessons = overview.units.flatMap((u) => u.lessons);
    const valid = (id: number | null) => id !== null && lessons.some((l) => l.id === id);
    if (valid(targetLessonId)) return;
    const next = valid(settings?.last_lesson_id ?? null) ? settings!.last_lesson_id : lessons[0]?.id ?? null;
    setTargetState(next);
  }, [overview, settings, targetLessonId]);

  const setTargetLessonId = useCallback((id: number | null) => {
    setTargetState(id);
    if (id === null) localStorage.removeItem(TARGET_KEY);
    else localStorage.setItem(TARGET_KEY, String(id));
  }, []);

  const setDraft = useCallback((d: Draft | null | ((d: Draft | null) => Draft | null)) => {
    setDraftState((prev) => {
      const next = typeof d === 'function' ? d(prev) : d;
      try {
        // Previews are object URLs – not persistable; everything else is small.
        if (next) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...next, previewUrl: undefined }));
        else sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* quota – ignore */
      }
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (text: string, action?: Toast['action']) => {
      const id = ++toastId.current;
      setToasts((t) => [...t.slice(-1), { id, text, action }]);
      window.setTimeout(() => dismissToast(id), action ? 5000 : 2800);
    },
    [dismissToast],
  );

  const value = useMemo<Store>(
    () => ({
      overview,
      settings,
      loading,
      error,
      refresh,
      setSettings: setSettingsState,
      targetLessonId,
      setTargetLessonId,
      draft,
      setDraft,
      cardDraft,
      setCardDraft,
      toast,
      toasts,
      dismissToast,
    }),
    [overview, settings, loading, error, refresh, targetLessonId, setTargetLessonId, draft, setDraft, cardDraft, toast, toasts, dismissToast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

/** Resolve the target lesson + unit names from the cached overview. */
export function useTargetLesson() {
  const { overview, targetLessonId } = useStore();
  return useMemo(() => {
    if (!overview || targetLessonId === null) return null;
    for (const u of overview.units) {
      const l = u.lessons.find((x) => x.id === targetLessonId);
      if (l) return { lesson: l, unit: u };
    }
    return null;
  }, [overview, targetLessonId]);
}
