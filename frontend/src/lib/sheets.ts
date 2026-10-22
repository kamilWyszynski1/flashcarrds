import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Bottom sheets are addressed by the URL hash (`#sheet-card`), so the Android
 * back gesture closes the sheet first – exactly like a native app – and the
 * router keeps a single source of truth.
 */
export type SheetName = 'pickgroup' | 'newgroup' | 'card' | 'addsource' | 'paste' | 'lessonmenu' | 'unitmenu';

const PREFIX = '#sheet-';

// Module-level because it is transient UI state that should not trigger renders.
let pickHandler: ((lessonId: number) => void) | null = null;
let newGroupPreset: { kind: 'lesson' | 'unit'; unitId?: number } | null = null;

export function useSheets() {
  const location = useLocation();
  const navigate = useNavigate();
  const open: SheetName | null = location.hash.startsWith(PREFIX) ? (location.hash.slice(PREFIX.length) as SheetName) : null;

  const openSheet = useCallback(
    (name: SheetName, opts: { replace?: boolean } = {}) => {
      navigate({ pathname: location.pathname, search: location.search, hash: `${PREFIX}${name}` }, { replace: opts.replace });
    },
    [navigate, location.pathname, location.search],
  );

  const closeSheet = useCallback(() => {
    if (!location.hash) return;
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate({ pathname: location.pathname, search: location.search, hash: '' }, { replace: true });
  }, [navigate, location.hash, location.pathname, location.search]);

  /** Open the group picker; `onPick` runs after the user chooses (defaults to setting the global target). */
  const openPicker = useCallback(
    (onPick?: (lessonId: number) => void, opts: { replace?: boolean } = {}) => {
      pickHandler = onPick ?? null;
      openSheet('pickgroup', opts);
    },
    [openSheet],
  );

  const openNewGroup = useCallback(
    (preset: { kind: 'lesson' | 'unit'; unitId?: number } = { kind: 'lesson' }, opts: { replace?: boolean } = {}) => {
      newGroupPreset = preset;
      openSheet('newgroup', opts);
    },
    [openSheet],
  );

  return { open, openSheet, closeSheet, openPicker, openNewGroup };
}

export function takePickHandler() {
  const h = pickHandler;
  pickHandler = null;
  return h;
}

export function peekNewGroupPreset() {
  return newGroupPreset;
}

/** Index of the current entry in the router's history stack (0 = first entry of this document). */
export function historyIdx(): number {
  return (window.history.state as { idx?: number } | null)?.idx ?? 0;
}

const CAPTURE_IDX_KEY = 'fiszki.captureIdx';

/** Remember where the photo flow started so Review can unwind history back to that screen. */
export function markCaptureFlowStart() {
  sessionStorage.setItem(CAPTURE_IDX_KEY, String(historyIdx()));
}

export function captureFlowStart(): number | null {
  const v = sessionStorage.getItem(CAPTURE_IDX_KEY);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
