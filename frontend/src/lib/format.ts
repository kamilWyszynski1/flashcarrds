import type { Card, Status } from './types';

/** "<1 min", "6 min", "3 h", "1 day", "4 days", "2 mo" – mirrors backend srs::human_interval. */
export function fmtInterval(secs: number): string {
  if (secs < 60) return '<1 min';
  if (secs < 3600) return `${Math.floor(secs / 60)} min`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h`;
  const days = secs / 86400;
  if (days < 30) {
    const d = Math.round(days);
    return d === 1 ? '1 day' : `${d} days`;
  }
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} y`;
}

/** Right-hand status text on a word row. */
export function cardStatusText(c: Card, now = Math.floor(Date.now() / 1000)): string {
  switch (c.status) {
    case 'new':
      return 'new';
    case 'due':
      return 'due';
    case 'learning':
      return `in ${fmtInterval(Math.max(0, c.due - now))}`;
    default:
      return `in ${fmtInterval(Math.max(0, c.due - now))}`;
  }
}

export const statusDot: Record<Status, string> = {
  new: 'bg-primary',
  due: 'bg-secondary-container',
  learning: 'bg-secondary-container',
  learned: 'bg-tertiary-container',
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Lesson/unit meta line: "41 cards · 7 due" / "32 cards · all learned" / "Empty". */
export function lessonMeta(c: { total: number; new: number; due: number; learned: number }): string {
  if (c.total === 0) return 'Empty · add from a photo';
  const parts: string[] = [plural(c.total, 'card')];
  if (c.due > 0) parts.push(`${c.due} due`);
  if (c.new > 0) parts.push(`${c.new} new`);
  if (c.due === 0 && c.new === 0) parts.push(c.learned === c.total ? 'all learned' : 'nothing due');
  return parts.join(' · ');
}

export function estimateMinutes(cards: number): number {
  return Math.max(1, Math.round((cards * 12) / 60));
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function short(s: string, n = 44): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** "Unidad 3 · ¿Dónde está Santiago?" → "Unidad 3" */
export function unitShort(name: string): string {
  return name.split(' · ')[0];
}

export function vibrate(ms: number, enabled = true) {
  if (enabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(ms);
    } catch {
      /* ignore */
    }
  }
}
