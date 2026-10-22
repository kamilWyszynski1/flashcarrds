/** @type {import('tailwindcss').Config} */
import plugin from 'tailwindcss/plugin';

// Design tokens from the Stitch export (Home screen) – Material-3 colour roles,
// Inter for body/labels, Plus Jakarta Sans for headlines and the flashcard.
// Colours are exposed as CSS variables (RGB triplets) so `bg-primary/20` works.
// Stitch only produced a light design; the dark palette below is derived and
// strictly opt-in: it is a plain variable swap under `html.dark`, which
// `src/lib/theme.ts` toggles from the "Theme" setting (default Light). Nothing
// here reacts to `prefers-color-scheme` on its own.

const light = {
  primary: '#3525cd',
  'on-primary': '#ffffff',
  'primary-container': '#4f46e5',
  'on-primary-container': '#dad7ff',
  'primary-fixed': '#e2dfff',
  'primary-fixed-dim': '#c3c0ff',
  'on-primary-fixed': '#0f0069',
  'on-primary-fixed-variant': '#3323cc',
  'inverse-primary': '#c3c0ff',
  secondary: '#9d4300',
  'on-secondary': '#ffffff',
  'secondary-container': '#fd761a',
  'on-secondary-container': '#5c2400',
  'secondary-fixed': '#ffdbca',
  'secondary-fixed-dim': '#ffb690',
  'on-secondary-fixed': '#341100',
  'on-secondary-fixed-variant': '#783200',
  tertiary: '#005338',
  'on-tertiary': '#ffffff',
  'tertiary-container': '#006e4b',
  'on-tertiary-container': '#67f4b7',
  'tertiary-fixed': '#6ffbbe',
  'tertiary-fixed-dim': '#4edea3',
  'on-tertiary-fixed': '#002113',
  'on-tertiary-fixed-variant': '#005236',
  error: '#ba1a1a',
  'on-error': '#ffffff',
  'error-container': '#ffdad6',
  'on-error-container': '#93000a',
  surface: '#f8f9ff',
  'surface-dim': '#cbdbf5',
  'surface-bright': '#f8f9ff',
  'surface-container-lowest': '#ffffff',
  'surface-container-low': '#eff4ff',
  'surface-container': '#e5eeff',
  'surface-container-high': '#dce9ff',
  'surface-container-highest': '#d3e4fe',
  'surface-variant': '#d3e4fe',
  'on-surface': '#0b1c30',
  'on-surface-variant': '#464555',
  'inverse-surface': '#213145',
  'inverse-on-surface': '#eaf1ff',
  outline: '#777587',
  'outline-variant': '#c7c4d8',
  background: '#f8f9ff',
  'on-background': '#0b1c30',
  'surface-tint': '#4d44e3',
  // Spaced-repetition grades (DESIGN.md): soft tint background + saturated label.
  again: '#e03131',
  'again-container': '#ffe3e3',
  hard: '#e8590c',
  'hard-container': '#ffe8d9',
  good: '#2f9e44',
  'good-container': '#dff5e4',
  easy: '#1971c2',
  'easy-container': '#dbeafe',
  scrim: '#000000',
};

const dark = {
  ...light,
  primary: '#c3c0ff',
  // `text-on-primary` is only ever used on `bg-primary-container`, which stays
  // #4f46e5 in dark, so the label must stay white (M3's #1e0c9c was invisible).
  'on-primary': '#ffffff',
  'primary-container': '#4f46e5',
  'on-primary-container': '#e2dfff',
  'inverse-primary': '#3525cd',
  secondary: '#ffb690',
  'on-secondary': '#541e00',
  'secondary-container': '#fd761a',
  'on-secondary-container': '#3a1200',
  tertiary: '#4edea3',
  'on-tertiary': '#00382a',
  'tertiary-container': '#006e4b',
  'on-tertiary-container': '#67f4b7',
  error: '#ffb4ab',
  'on-error': '#690005',
  'error-container': '#93000a',
  'on-error-container': '#ffdad6',
  surface: '#0f141f',
  'surface-dim': '#0f141f',
  'surface-bright': '#353a46',
  'surface-container-lowest': '#0a0e17',
  'surface-container-low': '#171c28',
  'surface-container': '#1b202d',
  'surface-container-high': '#262b38',
  'surface-container-highest': '#313644',
  'surface-variant': '#313644',
  'on-surface': '#e1e6f4',
  'on-surface-variant': '#c7c4d8',
  'inverse-surface': '#e1e6f4',
  'inverse-on-surface': '#2b3140',
  outline: '#918fa0',
  'outline-variant': '#464555',
  background: '#0f141f',
  'on-background': '#e1e6f4',
  again: '#ff8787',
  'again-container': '#3b1f1f',
  hard: '#ffa94d',
  'hard-container': '#3a2a18',
  good: '#69db7c',
  'good-container': '#1c3324',
  easy: '#74c0fc',
  'easy-container': '#172a3d',
};

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
};
const vars = (palette) => Object.fromEntries(Object.entries(palette).map(([k, v]) => [`--c-${k}`, hexToRgb(v)]));
const colors = Object.fromEntries(Object.keys(light).map((k) => [k, `rgb(var(--c-${k}) / <alpha-value>)`]));

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors,
      borderRadius: { DEFAULT: '0.25rem', lg: '0.5rem', xl: '0.75rem', '2xl': '1.125rem', '3xl': '1.5rem', full: '9999px' },
      spacing: {
        margin: '1rem',
        gutter: '1rem',
        'gutter-sm': '0.75rem',
        'space-xs': '0.25rem',
        'space-sm': '0.5rem',
        'space-md': '1rem',
        'space-lg': '1.5rem',
        'space-xl': '2rem',
        'margin-mobile': '1rem',
        'margin-tablet': '1.5rem',
        nav: '4rem',
        safe: 'env(safe-area-inset-bottom, 0px)',
      },
      fontFamily: {
        body: ['Inter', 'Roboto', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'Roboto', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'label-sm': ['10px', { lineHeight: '14px', letterSpacing: '0.04em', fontWeight: '600' }],
        'label-md': ['12px', { lineHeight: '16px', letterSpacing: '0.02em', fontWeight: '500' }],
        'label-lg': ['14px', { lineHeight: '20px', letterSpacing: '0.01em', fontWeight: '600' }],
        'body-sm': ['13px', { lineHeight: '18px', letterSpacing: '0.01em', fontWeight: '400' }],
        'body-md': ['15px', { lineHeight: '22px', letterSpacing: '0em', fontWeight: '400' }],
        'body-lg': ['18px', { lineHeight: '28px', letterSpacing: '-0.01em', fontWeight: '400' }],
        'headline-sm': ['18px', { lineHeight: '24px', letterSpacing: '0em', fontWeight: '600' }],
        'headline-md': ['22px', { lineHeight: '28px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-lg': ['32px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg-mobile': ['26px', { lineHeight: '34px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'flashcard-display': ['32px', { lineHeight: '42px', letterSpacing: '-0.015em', fontWeight: '600' }],
        'flashcard-display-mobile': ['28px', { lineHeight: '36px', letterSpacing: '-0.01em', fontWeight: '600' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(20,24,40,.06), 0 6px 20px rgba(20,24,40,.08)',
        float: '0 2px 4px rgba(20,24,40,.08), 0 12px 32px rgba(20,24,40,.14)',
        top: '0 -1px 12px rgba(0,0,0,0.05)',
      },
      maxWidth: { app: '480px' },
      keyframes: {
        'sheet-in': { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'toast-in': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'sheet-in': 'sheet-in .28s cubic-bezier(.2,.7,.2,1)',
        'fade-in': 'fade-in .2s ease-out',
        'toast-in': 'toast-in .2s ease-out',
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': { ...vars(light), colorScheme: 'light' },
        ':root.dark': { ...vars(dark), colorScheme: 'dark' },
      });
    }),
  ],
};
