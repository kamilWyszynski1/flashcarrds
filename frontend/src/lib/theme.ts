// Colour theme. Stitch only delivered a light design, so Light is the default
// for everyone; Dark (a derived palette, see tailwind.config.js) and System are
// opt-in via Settings. The preference is persisted server-side with the other
// settings and mirrored to localStorage so index.html can apply it before the
// first paint (no flash of the wrong theme for people who opted into dark).

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];
export const DEFAULT_THEME: Theme = 'light';
/** localStorage key – keep in sync with the inline boot script in index.html. */
export const THEME_KEY = 'fiszki.theme';
/** `surface` of each palette; used for <meta name="theme-color"> (browser/PWA chrome). */
export const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#f8f9ff', dark: '#0f141f' };

const DARK_MQ = '(prefers-color-scheme: dark)';

export function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

/** Pure: what the page should actually render for a preference. */
export function resolveTheme(pref: Theme, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_MQ).matches;
}

/** Toggle `html.dark`, update theme-color and cache the preference. */
export function applyTheme(pref: Theme): ResolvedTheme {
  const resolved = resolveTheme(pref, systemPrefersDark());
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => (m.content = THEME_COLOR[resolved]));
  }
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode / quota – the server copy is authoritative anyway */
  }
  return resolved;
}

/**
 * Re-apply when the OS theme flips while the preference is "system".
 * Returns an unsubscribe function; a no-op for explicit light/dark.
 */
export function watchSystemTheme(pref: Theme): () => void {
  if (pref !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(DARK_MQ);
  const onChange = () => applyTheme('system');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
