import { ApiError } from './api.errors';
import type { FiszkiApi } from './api';
import { db, DEFAULT_SETTINGS, type DbCard, type DbLesson, type DbUnit } from './db';
import {
  RateLimiter,
  cleanModel,
  extractFromGemini,
  validateImages,
  MAX_HINT_CHARS,
} from './gemini';
import {
  fmtDays,
  fmtIntervalSecs,
  INITIAL_EASE,
  newCard,
  preview,
  previewLabels,
  schedule,
  STATE_LEARNING,
  STATE_NEW,
  STATE_RELEARNING,
  STATE_REVIEW,
  stateToNumber,
  statusFor,
  type Grade,
  type SrsState,
} from './srs';
import type {
  Card,
  Counts,
  ExtractedCard,
  ExtractResponse,
  Lesson,
  LessonDetail,
  NewCard,
  Overview,
  ReviewResult,
  Settings,
  SettingsPatch,
  StudyItem,
  Unit,
  UnitOverview,
} from './types';

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

export function startOfLocalDay(nowEpochSecs: number): number {
  const d = new Date(nowEpochSecs * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export const rateLimiter = new RateLimiter(6);

export function resetRateLimiter(): void {
  rateLimiter.reset();
}

export function normalizeFront(s: string): string {
  return s.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export async function recordExtraction(now: number): Promise<{ today: number; total: number }> {
  const d = new Date(now * 1000);
  const dayStr = d.toISOString().slice(0, 10);
  const row = await db.usage.get(dayStr);
  const count = (row?.count ?? 0) + 1;
  await db.usage.put({ day: dayStr, count });

  const allUsages = await db.usage.toArray();
  const total = allUsages.reduce((sum, u) => sum + u.count, 0);
  return { today: count, total };
}

export async function getExtractionUsage(now: number): Promise<{ today: number; total: number }> {
  const d = new Date(now * 1000);
  const dayStr = d.toISOString().slice(0, 10);
  const row = await db.usage.get(dayStr);
  const allUsages = await db.usage.toArray();
  const total = allUsages.reduce((sum, u) => sum + u.count, 0);
  return { today: row?.count ?? 0, total };
}

function cleanUnitName(name: string): string {
  const n = name.trim();
  if (!n) {
    throw new ApiError(400, 'validation', 'unit name cannot be empty');
  }
  if (n.length > 120) {
    throw new ApiError(400, 'validation', 'name is too long (max 120 characters)');
  }
  return n;
}

function cleanLessonName(name: string): string {
  const n = name.trim();
  if (!n) {
    throw new ApiError(400, 'validation', 'lesson name cannot be empty');
  }
  if (n.length > 120) {
    throw new ApiError(400, 'validation', 'name is too long (max 120 characters)');
  }
  return n;
}

function cleanCard(c: NewCard): { front: string; back: string; example: string | null } {
  const front = c.front?.trim() ?? '';
  const back = c.back?.trim() ?? '';
  if (!front || !back) {
    throw new ApiError(400, 'validation', 'front and back are required');
  }
  if (front.length > 500 || back.length > 500) {
    throw new ApiError(400, 'validation', 'card text is too long (max 500 characters per side)');
  }
  const example = c.example ? c.example.trim() || null : null;
  return { front, back, example };
}

function enrichCard(c: DbCard, lesson: DbLesson | undefined, unit: DbUnit | undefined, now: number): Card {
  const stateNum = stateToNumber(c.state as any);
  const status = statusFor(stateNum, c.due, now);
  let interval_label: string;
  if (stateNum === STATE_NEW) {
    interval_label = 'new';
  } else if (stateNum === STATE_LEARNING || stateNum === STATE_RELEARNING) {
    interval_label = fmtIntervalSecs(Math.max(60, c.due - c.updated_at));
  } else {
    interval_label = fmtDays(Math.max(1, c.interval_days));
  }

  return {
    id: c.id!,
    lesson_id: c.lesson_id,
    lesson_name: lesson?.name ?? '',
    unit_id: unit?.id ?? 0,
    unit_name: unit?.name ?? '',
    front: c.front,
    back: c.back,
    example: c.example,
    state: stateNum,
    status,
    due: c.due,
    interval_days: c.interval_days,
    ease: c.ease,
    reps: c.reps,
    lapses: c.lapses,
    last_review: c.last_review,
    created_at: c.created_at,
    updated_at: c.updated_at,
    interval_label,
  };
}

async function setSettingValue(key: string, value: string): Promise<void> {
  await db.settings.put({ key, value });
}

function cardToSrs(c: DbCard): SrsState {
  return {
    state: stateToNumber(c.state as any),
    due: c.due,
    interval_days: c.interval_days,
    ease: c.ease,
    reps: c.reps,
    lapses: c.lapses,
    last_review: c.last_review,
  };
}

function shuffle<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

export const localApi: FiszkiApi = {
  async overview(): Promise<Overview> {
    const now = nowTs();
    const [units, lessons, cards] = await Promise.all([
      db.units.toArray(),
      db.lessons.toArray(),
      db.cards.toArray(),
    ]);

    units.sort((a, b) => a.position - b.position || (a.id ?? 0) - (b.id ?? 0));
    lessons.sort((a, b) => a.position - b.position || (a.id ?? 0) - (b.id ?? 0));

    const lessonCardsMap = new Map<number, DbCard[]>();
    for (const c of cards) {
      let list = lessonCardsMap.get(c.lesson_id);
      if (!list) {
        list = [];
        lessonCardsMap.set(c.lesson_id, list);
      }
      list.push(c);
    }

    const totalCounts: Counts = { total: 0, new: 0, due: 0, learning: 0, learned: 0 };

    const unitOverviews: UnitOverview[] = units.map(u => {
      const uCounts: Counts = { total: 0, new: 0, due: 0, learning: 0, learned: 0 };
      const unitLessons = lessons.filter(l => l.unit_id === u.id);

      const lessonOverviews = unitLessons.map(l => {
        const lCards = lessonCardsMap.get(l.id!) ?? [];
        const lCounts: Counts = { total: lCards.length, new: 0, due: 0, learning: 0, learned: 0 };
        for (const c of lCards) {
          const s = stateToNumber(c.state as any);
          if (s === STATE_NEW) {
            lCounts.new += 1;
          } else if (c.due <= now) {
            lCounts.due += 1;
          } else if (s === STATE_LEARNING || s === STATE_RELEARNING) {
            lCounts.learning += 1;
          } else {
            lCounts.learned += 1;
          }
        }
        uCounts.total += lCounts.total;
        uCounts.new += lCounts.new;
        uCounts.due += lCounts.due;
        uCounts.learning += lCounts.learning;
        uCounts.learned += lCounts.learned;

        return {
          id: l.id!,
          unit_id: l.unit_id,
          name: l.name,
          position: l.position,
          ...lCounts,
        };
      });

      totalCounts.total += uCounts.total;
      totalCounts.new += uCounts.new;
      totalCounts.due += uCounts.due;
      totalCounts.learning += uCounts.learning;
      totalCounts.learned += uCounts.learned;

      return {
        id: u.id!,
        name: u.name,
        position: u.position,
        ...uCounts,
        lessons: lessonOverviews,
      };
    });

    const dailyLimitStr = (await db.settings.get('new_per_day'))?.value
      ?? (await db.settings.get('daily_new_limit'))?.value
      ?? DEFAULT_SETTINGS.daily_new_limit;
    const dailyLimit = parseInt(dailyLimitStr, 10) || 20;

    const startOfDay = startOfLocalDay(now);
    let newStudiedToday = 0;
    let reviewsToday = 0;
    for (const c of cards) {
      if (c.updated_at >= startOfDay && c.reps > 0) {
        reviewsToday += 1;
        if (c.reps === 1 && stateToNumber(c.state as any) !== STATE_NEW) {
          newStudiedToday += 1;
        }
      }
    }

    const newAvailable = Math.min(totalCounts.new, Math.max(0, dailyLimit - newStudiedToday));

    return {
      now,
      ...totalCounts,
      new_available: newAvailable,
      new_studied_today: newStudiedToday,
      reviews_today: reviewsToday,
      units: unitOverviews,
    };
  },

  async units(): Promise<Unit[]> {
    const units = await db.units.toArray();
    units.sort((a, b) => a.position - b.position || (a.id ?? 0) - (b.id ?? 0));
    return units.map(u => ({ id: u.id!, name: u.name, position: u.position }));
  },

  async createUnit(name: string): Promise<Unit> {
    const cleaned = cleanUnitName(name);
    const maxPosUnit = await db.units.orderBy('position').last();
    const position = (maxPosUnit?.position ?? 0) + 1;
    const id = (await db.units.add({
      name: cleaned,
      position,
      created_at: nowTs(),
    })) as number;
    return { id, name: cleaned, position };
  },

  async renameUnit(id: number, name: string): Promise<Unit> {
    const cleaned = cleanUnitName(name);
    const existing = await db.units.get(id);
    if (!existing) {
      throw new ApiError(404, 'not_found', `unit ${id} not found`);
    }
    await db.units.update(id, { name: cleaned });
    return { id, name: cleaned, position: existing.position };
  },

  async deleteUnit(id: number): Promise<void> {
    const existing = await db.units.get(id);
    if (!existing) {
      throw new ApiError(404, 'not_found', `unit ${id} not found`);
    }
    await db.transaction('rw', [db.units, db.lessons, db.cards], async () => {
      const lessons = await db.lessons.where('unit_id').equals(id).toArray();
      const lessonIds = lessons.map(l => l.id!);
      for (const lid of lessonIds) {
        await db.cards.where('lesson_id').equals(lid).delete();
      }
      await db.lessons.where('unit_id').equals(id).delete();
      await db.units.delete(id);
    });
  },

  async lessons(): Promise<Lesson[]> {
    const [units, lessons] = await Promise.all([db.units.toArray(), db.lessons.toArray()]);
    const unitPosMap = new Map(units.map(u => [u.id!, u.position]));
    lessons.sort((a, b) => {
      const uA = unitPosMap.get(a.unit_id) ?? 0;
      const uB = unitPosMap.get(b.unit_id) ?? 0;
      if (uA !== uB) return uA - uB;
      if (a.unit_id !== b.unit_id) return a.unit_id - b.unit_id;
      if (a.position !== b.position) return a.position - b.position;
      return (a.id ?? 0) - (b.id ?? 0);
    });
    return lessons.map(l => ({ id: l.id!, unit_id: l.unit_id, name: l.name, position: l.position }));
  },

  async lesson(id: number): Promise<LessonDetail> {
    const now = nowTs();
    const lesson = await db.lessons.get(id);
    if (!lesson) {
      throw new ApiError(404, 'not_found', `lesson ${id} not found`);
    }
    const unit = await db.units.get(lesson.unit_id);
    if (!unit) {
      throw new ApiError(404, 'not_found', 'unit not found');
    }

    const cards = await db.cards.where('lesson_id').equals(id).toArray();
    const enrichedCards = cards.map(c => enrichCard(c, lesson, unit, now));

    const counts: Counts = { total: enrichedCards.length, new: 0, due: 0, learning: 0, learned: 0 };
    for (const c of enrichedCards) {
      switch (c.status) {
        case 'new':
          counts.new += 1;
          break;
        case 'due':
          counts.due += 1;
          break;
        case 'learning':
          counts.learning += 1;
          break;
        default:
          counts.learned += 1;
          break;
      }
    }

    return {
      id: lesson.id!,
      unit_id: lesson.unit_id,
      name: lesson.name,
      position: lesson.position,
      unit: { id: unit.id!, name: unit.name, position: unit.position },
      ...counts,
      cards: enrichedCards,
    };
  },

  async createLesson(unit_id: number, name: string): Promise<Lesson> {
    const cleaned = cleanLessonName(name);
    const unit = await db.units.get(unit_id);
    if (!unit) {
      throw new ApiError(400, 'validation', `unit ${unit_id} does not exist`);
    }
    const unitLessons = await db.lessons.where('unit_id').equals(unit_id).toArray();
    const maxPos = unitLessons.reduce((max, l) => Math.max(max, l.position), 0);
    const position = maxPos + 1;
    const id = (await db.lessons.add({
      unit_id,
      name: cleaned,
      position,
      created_at: nowTs(),
    })) as number;
    return { id, unit_id, name: cleaned, position };
  },

  async updateLesson(id: number, patch: { name?: string; unit_id?: number }): Promise<Lesson> {
    const existing = await db.lessons.get(id);
    if (!existing) {
      throw new ApiError(404, 'not_found', `lesson ${id} not found`);
    }
    let name = existing.name;
    let unit_id = existing.unit_id;
    let position = existing.position;

    if (patch.name !== undefined) {
      name = cleanLessonName(patch.name);
    }
    if (patch.unit_id !== undefined && patch.unit_id !== existing.unit_id) {
      const newUnit = await db.units.get(patch.unit_id);
      if (!newUnit) {
        throw new ApiError(400, 'validation', `unit ${patch.unit_id} does not exist`);
      }
      unit_id = patch.unit_id;
      const targetLessons = await db.lessons.where('unit_id').equals(unit_id).toArray();
      const maxPos = targetLessons.reduce((max, l) => Math.max(max, l.position), 0);
      position = maxPos + 1;
    }
    await db.lessons.update(id, { name, unit_id, position });
    return { id, unit_id, name, position };
  },

  async deleteLesson(id: number): Promise<void> {
    const existing = await db.lessons.get(id);
    if (!existing) {
      throw new ApiError(404, 'not_found', `lesson ${id} not found`);
    }
    await db.transaction('rw', [db.lessons, db.cards], async () => {
      await db.cards.where('lesson_id').equals(id).delete();
      await db.lessons.delete(id);
    });
  },

  async cards(f: { lesson_id?: number; unit_id?: number; q?: string; status?: string; sort?: string; limit?: number } = {}): Promise<Card[]> {
    const now = nowTs();
    let dbCards = await db.cards.toArray();
    const [lessons, units] = await Promise.all([db.lessons.toArray(), db.units.toArray()]);
    const lessonMap = new Map(lessons.map(l => [l.id!, l]));
    const unitMap = new Map(units.map(u => [u.id!, u]));

    if (f.lesson_id !== undefined) {
      dbCards = dbCards.filter(c => c.lesson_id === f.lesson_id);
    }
    if (f.unit_id !== undefined) {
      dbCards = dbCards.filter(c => {
        const l = lessonMap.get(c.lesson_id);
        return l && l.unit_id === f.unit_id;
      });
    }

    if (f.status && f.status !== 'all') {
      const s = f.status.toLowerCase();
      dbCards = dbCards.filter(c => {
        const stateNum = stateToNumber(c.state as any);
        if (s === 'new') return stateNum === STATE_NEW;
        if (s === 'due') return stateNum !== STATE_NEW && c.due <= now;
        if (s === 'learning') return stateNum === STATE_LEARNING || stateNum === STATE_RELEARNING;
        if (s === 'mastered' || s === 'known') return stateNum === STATE_REVIEW && c.interval_days >= 21;
        if (s === 'review') return stateNum === STATE_REVIEW;
        if (s === 'learned') return stateNum === STATE_REVIEW && c.due > now;
        if (s === 'hard') return c.lapses > 0 || (c.reps > 0 && c.ease < 2.0);
        throw new ApiError(400, 'validation', `unknown status filter '${f.status}'`);
      });
    }

    if (f.q && f.q.trim()) {
      const needle = f.q.trim().toLowerCase();
      dbCards = dbCards.filter(c =>
        c.front.toLowerCase().includes(needle) ||
        c.back.toLowerCase().includes(needle) ||
        (c.example && c.example.toLowerCase().includes(needle))
      );
    }

    if (f.sort === 'alpha') {
      dbCards.sort((a, b) => a.front.toLowerCase().localeCompare(b.front.toLowerCase()) || (a.id! - b.id!));
    } else if (f.sort === 'due') {
      dbCards.sort((a, b) => {
        const aNew = stateToNumber(a.state as any) === STATE_NEW ? 1 : 0;
        const bNew = stateToNumber(b.state as any) === STATE_NEW ? 1 : 0;
        if (aNew !== bNew) return aNew - bNew;
        if (a.due !== b.due) return a.due - b.due;
        return a.id! - b.id!;
      });
    } else {
      // default: newest created first
      dbCards.sort((a, b) => b.created_at - a.created_at || b.id! - a.id!);
    }

    const limit = Math.max(1, Math.min(10000, f.limit ?? 2000));
    if (dbCards.length > limit) {
      dbCards = dbCards.slice(0, limit);
    }

    return dbCards.map(c => {
      const l = lessonMap.get(c.lesson_id);
      const u = l ? unitMap.get(l.unit_id) : undefined;
      return enrichCard(c, l, u, now);
    });
  },

  async createCard(lesson_id: number, c: NewCard): Promise<Card> {
    const res = await this.createCards(lesson_id, [c]);
    const card = await db.cards.get(res.ids[0]);
    const lesson = await db.lessons.get(lesson_id);
    const unit = lesson ? await db.units.get(lesson.unit_id) : undefined;
    return enrichCard(card!, lesson, unit, nowTs());
  },

  async createCards(lesson_id: number, cards: NewCard[]): Promise<{ created: number; ids: number[]; lesson: Lesson }> {
    if (cards.length === 0) {
      throw new ApiError(400, 'validation', 'no cards to save');
    }
    if (cards.length > 500) {
      throw new ApiError(400, 'validation', 'too many cards in one request (max 500)');
    }
    const lesson = await db.lessons.get(lesson_id);
    if (!lesson) {
      throw new ApiError(400, 'validation', `lesson ${lesson_id} does not exist`);
    }

    const cleanedCards = cards.map(c => cleanCard(c));
    const ts = nowTs();
    const srs = newCard(ts);

    const ids: number[] = [];
    await db.transaction('rw', [db.cards, db.settings], async () => {
      for (const c of cleanedCards) {
        const id = await db.cards.add({
          lesson_id,
          front: c.front,
          back: c.back,
          example: c.example,
          state: STATE_NEW,
          due: srs.due,
          interval_days: srs.interval_days,
          ease: srs.ease,
          reps: 0,
          lapses: 0,
          last_review: null,
          created_at: ts,
          updated_at: ts,
        });
        ids.push(id as number);
      }
      await db.settings.put({ key: 'last_lesson_id', value: String(lesson_id) });
    });

    return {
      created: ids.length,
      ids,
      lesson: { id: lesson.id!, unit_id: lesson.unit_id, name: lesson.name, position: lesson.position },
    };
  },

  async updateCard(
    id: number,
    patch: { front?: string; back?: string; example?: string; lesson_id?: number; reset_progress?: boolean }
  ): Promise<Card> {
    const cur = await db.cards.get(id);
    if (!cur) {
      throw new ApiError(404, 'not_found', `card ${id} not found`);
    }

    const front = patch.front !== undefined ? patch.front.trim() : cur.front;
    const back = patch.back !== undefined ? patch.back.trim() : cur.back;
    if (!front || !back) {
      throw new ApiError(400, 'validation', 'front and back are required');
    }
    if (front.length > 500 || back.length > 500) {
      throw new ApiError(400, 'validation', 'card text is too long (max 500 characters per side)');
    }

    let example = cur.example;
    if (patch.example !== undefined) {
      example = patch.example.trim() || null;
    }

    let lesson_id = cur.lesson_id;
    if (patch.lesson_id !== undefined && patch.lesson_id !== cur.lesson_id) {
      const lesson = await db.lessons.get(patch.lesson_id);
      if (!lesson) {
        throw new ApiError(400, 'validation', `lesson ${patch.lesson_id} does not exist`);
      }
      lesson_id = patch.lesson_id;
    }

    const ts = nowTs();
    const updateFields: Partial<DbCard> = {
      front,
      back,
      example,
      lesson_id,
      updated_at: ts,
    };

    if (patch.reset_progress) {
      const s = newCard(ts);
      updateFields.state = STATE_NEW;
      updateFields.due = s.due;
      updateFields.interval_days = s.interval_days;
      updateFields.ease = s.ease;
      updateFields.reps = 0;
      updateFields.lapses = 0;
      updateFields.last_review = null;
    }

    await db.cards.update(id, updateFields);
    const updated = await db.cards.get(id);
    const lesson = await db.lessons.get(updated!.lesson_id);
    const unit = lesson ? await db.units.get(lesson.unit_id) : undefined;
    return enrichCard(updated!, lesson, unit, ts);
  },

  async deleteCard(id: number): Promise<void> {
    const cur = await db.cards.get(id);
    if (!cur) {
      throw new ApiError(404, 'not_found', `card ${id} not found`);
    }
    await db.cards.delete(id);
  },

  async studyQueue(p: { scope?: string; mode?: string; ids?: string; limit?: number; direction?: string } = {}): Promise<StudyItem[]> {
    const now = nowTs();
    const [allDbCards, lessons, units] = await Promise.all([
      db.cards.toArray(),
      db.lessons.toArray(),
      db.units.toArray(),
    ]);
    const lessonMap = new Map(lessons.map(l => [l.id!, l]));
    const unitMap = new Map(units.map(u => [u.id!, u]));

    const enrichedMap = new Map<number, Card>();
    for (const c of allDbCards) {
      const l = lessonMap.get(c.lesson_id);
      const u = l ? unitMap.get(l.unit_id) : undefined;
      enrichedMap.set(c.id!, enrichCard(c, l, u, now));
    }

    let cards: Card[] = [];
    const limit = Math.max(1, Math.min(1000, p.limit ?? 200));

    if (p.ids && p.ids.trim()) {
      for (const idStr of p.ids.split(',')) {
        const id = parseInt(idStr.trim(), 10);
        if (isNaN(id)) {
          throw new ApiError(400, 'validation', `bad card id '${idStr}'`);
        }
        const c = enrichedMap.get(id);
        if (c) cards.push(c);
      }
    } else {
      let filtered = Array.from(enrichedMap.values());
      const scope = p.scope?.trim() || 'all';
      if (scope === 'all') {
        // all
      } else if (scope.startsWith('lesson:')) {
        const lessonId = parseInt(scope.slice('lesson:'.length), 10);
        if (isNaN(lessonId)) throw new ApiError(400, 'validation', `bad scope '${scope}'`);
        filtered = filtered.filter(c => c.lesson_id === lessonId);
      } else if (scope.startsWith('unit:')) {
        const unitId = parseInt(scope.slice('unit:'.length), 10);
        if (isNaN(unitId)) throw new ApiError(400, 'validation', `bad scope '${scope}'`);
        filtered = filtered.filter(c => c.unit_id === unitId);
      } else {
        throw new ApiError(400, 'validation', `unknown scope '${scope}'`);
      }

      const mode = p.mode ?? 'due';
      const dailyLimitStr = (await db.settings.get('new_per_day'))?.value
        ?? (await db.settings.get('daily_new_limit'))?.value
        ?? DEFAULT_SETTINGS.daily_new_limit;
      const dailyLimit = parseInt(dailyLimitStr, 10) || 20;

      const startOfDay = startOfLocalDay(now);
      let newStudiedToday = 0;
      for (const c of allDbCards) {
        if (c.updated_at >= startOfDay && c.reps === 1 && stateToNumber(c.state as any) !== STATE_NEW) {
          newStudiedToday += 1;
        }
      }

      let newBudget = mode === 'all' ? Infinity : Math.max(0, dailyLimit - newStudiedToday);

      const due = filtered.filter(c => c.state !== STATE_NEW && c.due <= now);
      due.sort((a, b) => a.due - b.due || a.id - b.id);
      cards.push(...due);

      const rest = filtered.filter(c => !(c.state !== STATE_NEW && c.due <= now));
      const newCards = rest.filter(c => c.state === STATE_NEW);
      newCards.sort((a, b) => a.created_at - b.created_at || a.id - b.id);

      for (const c of newCards) {
        if (newBudget <= 0) break;
        newBudget -= 1;
        cards.push(c);
      }

      const laterCards = rest.filter(c => c.state !== STATE_NEW);
      laterCards.sort((a, b) => a.due - b.due || a.id - b.id);

      if (mode === 'all') {
        cards.push(...laterCards);
      } else if (cards.length === 0 && laterCards.length > 0) {
        // Fallback when nothing is due or new in scope
        cards.push(...laterCards);
      }

      cards = cards.slice(0, limit);
      shuffle(cards);
    }

    cards = cards.slice(0, limit);

    const studyDirectionSetting = (await db.settings.get('study_direction'))?.value ?? DEFAULT_SETTINGS.study_direction;
    const directionOverride = p.direction ?? studyDirectionSetting;

    return cards.map((card, i) => {
      const srsState: SrsState = {
        state: card.state,
        due: card.due,
        interval_days: card.interval_days,
        ease: card.ease,
        reps: card.reps,
        lapses: card.lapses,
        last_review: card.last_review,
      };
      const pview = preview(srsState, now);
      const labels = previewLabels(srsState, now);

      let direction = 'forward';
      if (directionOverride === 'back_to_front') {
        direction = 'reverse';
      } else if (directionOverride === 'mixed') {
        // Pseudo-random mixed direction per card index & time
        direction = (card.id + i + now) % 2 === 0 ? 'reverse' : 'forward';
      }

      return {
        card,
        direction: direction as 'forward' | 'reverse',
        preview: pview,
        preview_labels: labels,
      };
    });
  },

  async review(card_id: number, grade: Grade, _direction: string): Promise<ReviewResult> {
    const validGrades: Grade[] = ['again', 'hard', 'good', 'easy'];
    if (!validGrades.includes(grade)) {
      throw new ApiError(400, 'validation', `unknown grade '${grade}'`);
    }

    const card = await db.cards.get(card_id);
    if (!card) {
      throw new ApiError(404, 'not_found', `card ${card_id} not found`);
    }

    const now = nowTs();
    const srsBefore = cardToSrs(card);
    const srsAfter = schedule(srsBefore, grade, now);

    await db.cards.update(card_id, {
      state: stateToNumber(srsAfter.state),
      due: srsAfter.due,
      interval_days: srsAfter.interval_days,
      ease: srsAfter.ease,
      reps: srsAfter.reps,
      lapses: srsAfter.lapses,
      last_review: now,
      updated_at: now,
    });

    const updated = await db.cards.get(card_id);
    const lesson = await db.lessons.get(updated!.lesson_id);
    const unit = lesson ? await db.units.get(lesson.unit_id) : undefined;
    const enriched = enrichCard(updated!, lesson, unit, now);

    const due_in_secs = srsAfter.due - now;
    const due_label = fmtIntervalSecs(due_in_secs);
    const pview = preview(srsAfter, now);
    const labels = previewLabels(srsAfter, now);

    return {
      card: enriched,
      due_in_secs,
      due_label,
      preview: pview,
      preview_labels: labels,
    };
  },

  async extract(images: { mime_type: string; data: string }[], hint: string, signal?: AbortSignal): Promise<ExtractResponse> {
    try {
      validateImages(images);
    } catch (e: any) {
      throw new ApiError(400, 'validation', e.message);
    }
    const truncatedHint = (hint ?? '').slice(0, MAX_HINT_CHARS);

    const settingsRows = await db.settings.toArray();
    const map = new Map(settingsRows.map((s) => [s.key, s.value]));

    const extractionPaused = map.get('extraction_paused') === 'true' || map.get('gemini_paused') === '1';
    if (extractionPaused) {
      throw new ApiError(403, 'paused', 'Extraction is paused – switch it back on in Settings');
    }

    const apiKey = (map.get('gemini_api_key') ?? '').trim();
    if (!apiKey) {
      throw new ApiError(400, 'no_api_key', 'Gemini API key is not configured – add your key in Settings');
    }

    const rawModel = map.get('gemini_model') ?? DEFAULT_SETTINGS.gemini_model;
    let model: string;
    try {
      model = cleanModel(rawModel);
    } catch (e: any) {
      throw new ApiError(400, 'validation', e.message);
    }

    const capStr = map.get('extract_daily_cap') ?? map.get('gemini_daily_limit') ?? DEFAULT_SETTINGS.gemini_daily_limit;
    const cap = parseInt(capStr, 10) || 0;
    const now = nowTs();
    const currentUsage = await getExtractionUsage(now);
    if (cap > 0 && currentUsage.today >= cap) {
      throw new ApiError(429, 'rate_limit', `Daily extraction limit reached (${cap}/day) – try again tomorrow`);
    }

    const rpmStr = map.get('gemini_rpm_limit') ?? DEFAULT_SETTINGS.gemini_rpm_limit;
    const rpm = parseInt(rpmStr, 10) || 6;
    rateLimiter.setMax(rpm);
    const limiterCheck = rateLimiter.check();
    if (!limiterCheck.ok) {
      throw new ApiError(429, 'rate_limit', `Too many extractions in a row – wait ${limiterCheck.waitSecs}s and try again`);
    }

    await recordExtraction(now);

    const frontLang = map.get('front_lang') ?? DEFAULT_SETTINGS.front_lang;
    const backLang = map.get('back_lang') ?? DEFAULT_SETTINGS.back_lang;

    let extractedCards: ExtractedCard[];
    try {
      extractedCards = await extractFromGemini({
        apiKey,
        model,
        images,
        hint: truncatedHint,
        frontLang,
        backLang,
        signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError' || signal?.aborted) {
        throw e;
      }
      throw new ApiError(502, 'upstream', e.message);
    }

    const [allDbCards, allLessons] = await Promise.all([db.cards.toArray(), db.lessons.toArray()]);
    const lessonMap = new Map(allLessons.map((l) => [l.id!, l.name]));

    const existingFronts = new Map<string, { id: number; lessonName: string }>();
    for (const c of allDbCards) {
      const norm = normalizeFront(c.front);
      if (!existingFronts.has(norm)) {
        existingFronts.set(norm, { id: c.id!, lessonName: lessonMap.get(c.lesson_id) ?? '' });
      }
    }

    const seen = new Set<string>();
    const deduplicated: ExtractedCard[] = [];
    for (const card of extractedCards) {
      const norm = normalizeFront(card.front);
      if (seen.has(norm)) {
        continue;
      }
      seen.add(norm);

      const existing = existingFronts.get(norm);
      if (existing) {
        card.existing_in = existing.lessonName;
        card.existing_card_id = existing.id;
      }
      deduplicated.push(card);
    }

    return {
      cards: deduplicated,
      model,
      hint: truncatedHint,
    };
  },

  async settings(): Promise<Settings> {
    const all = await db.settings.toArray();
    const map = new Map(all.map((s) => [s.key, s.value]));

    const front_lang = map.get('front_lang') ?? DEFAULT_SETTINGS.front_lang;
    const back_lang = map.get('back_lang') ?? DEFAULT_SETTINGS.back_lang;
    const study_direction = (map.get('study_direction') as any) ?? DEFAULT_SETTINGS.study_direction;
    const new_per_day = parseInt(map.get('new_per_day') ?? map.get('daily_new_limit') ?? DEFAULT_SETTINGS.daily_new_limit, 10);
    const haptics = map.get('haptics') !== 'false';
    const gemini_model = map.get('gemini_model') ?? DEFAULT_SETTINGS.gemini_model;
    const gemini_api_key = map.get('gemini_api_key') ?? '';
    const gemini_api_key_set = Boolean(gemini_api_key);
    const last_lesson_id_val = map.get('last_lesson_id');
    const last_lesson_id = last_lesson_id_val ? parseInt(last_lesson_id_val, 10) : null;
    const extraction_paused = map.get('extraction_paused') === 'true' || map.get('gemini_paused') === '1';
    const extract_daily_cap = parseInt(map.get('extract_daily_cap') ?? map.get('gemini_daily_limit') ?? DEFAULT_SETTINGS.gemini_daily_limit, 10);
    const theme = (map.get('theme') as any) ?? DEFAULT_SETTINGS.theme;

    const usage = await getExtractionUsage(nowTs());

    return {
      front_lang,
      back_lang,
      study_direction,
      new_per_day,
      haptics,
      gemini_model,
      gemini_api_key_set,
      last_lesson_id,
      extraction_paused,
      extractions_today: usage.today,
      extractions_total: usage.total,
      extract_daily_cap,
      theme,
    };
  },

  async patchSettings(p: SettingsPatch): Promise<Settings> {
    if (p.front_lang !== undefined) {
      const v = p.front_lang.trim();
      if (!v) throw new ApiError(400, 'validation', 'front_lang cannot be empty');
      await setSettingValue('front_lang', v);
    }
    if (p.back_lang !== undefined) {
      const v = p.back_lang.trim();
      if (!v) throw new ApiError(400, 'validation', 'back_lang cannot be empty');
      await setSettingValue('back_lang', v);
    }
    if (p.study_direction !== undefined) {
      if (!['front_to_back', 'back_to_front', 'mixed'].includes(p.study_direction)) {
        throw new ApiError(400, 'validation', 'study_direction must be front_to_back, back_to_front or mixed');
      }
      await setSettingValue('study_direction', p.study_direction);
    }
    if (p.new_per_day !== undefined) {
      if (p.new_per_day < 0 || p.new_per_day > 500) {
        throw new ApiError(400, 'validation', 'new_per_day must be between 0 and 500');
      }
      await setSettingValue('new_per_day', String(p.new_per_day));
      await setSettingValue('daily_new_limit', String(p.new_per_day));
    }
    if (p.haptics !== undefined) {
      await setSettingValue('haptics', p.haptics ? 'true' : 'false');
    }
    if (p.last_lesson_id !== undefined) {
      await setSettingValue('last_lesson_id', p.last_lesson_id === null ? '' : String(p.last_lesson_id));
    }
    if (p.extraction_paused !== undefined) {
      await setSettingValue('extraction_paused', p.extraction_paused ? 'true' : 'false');
      await setSettingValue('gemini_paused', p.extraction_paused ? '1' : '0');
    }
    if (p.theme !== undefined) {
      const t = p.theme.trim().toLowerCase();
      if (!['light', 'dark', 'system'].includes(t)) {
        throw new ApiError(400, 'validation', 'theme must be light, dark, or system');
      }
      await setSettingValue('theme', t);
    }
    if (p.gemini_model !== undefined) {
      try {
        const m = cleanModel(p.gemini_model);
        await setSettingValue('gemini_model', m);
      } catch (e: any) {
        throw new ApiError(400, 'validation', e.message);
      }
    }
    if (p.gemini_api_key !== undefined) {
      await setSettingValue('gemini_api_key', p.gemini_api_key.trim());
    }
    if (p.extract_daily_cap !== undefined) {
      if (p.extract_daily_cap < 0 || p.extract_daily_cap > 1000) {
        throw new ApiError(400, 'validation', 'extract_daily_cap must be between 0 and 1000');
      }
      await setSettingValue('extract_daily_cap', String(p.extract_daily_cap));
      await setSettingValue('gemini_daily_limit', String(p.extract_daily_cap));
    }
    if (p.gemini_rpm_limit !== undefined) {
      rateLimiter.setMax(p.gemini_rpm_limit);
      await setSettingValue('gemini_rpm_limit', String(p.gemini_rpm_limit));
    }
    return this.settings();
  },

  async exportBackup(): Promise<unknown> {
    const [units, lessons, cards] = await Promise.all([
      db.units.toArray(),
      db.lessons.toArray(),
      db.cards.toArray(),
    ]);

    units.sort((a, b) => a.position - b.position || (a.id ?? 0) - (b.id ?? 0));
    lessons.sort((a, b) => a.position - b.position || (a.id ?? 0) - (b.id ?? 0));
    cards.sort((a, b) => a.front.toLowerCase().localeCompare(b.front.toLowerCase()) || (a.id! - b.id!));

    const exportUnits = units.map(u => ({
      name: u.name,
      lessons: lessons
        .filter(l => l.unit_id === u.id)
        .map(l => ({
          name: l.name,
          cards: cards
            .filter(c => c.lesson_id === l.id)
            .map(c => ({
              front: c.front,
              back: c.back,
              example: c.example,
              state: stateToNumber(c.state as any),
              due: c.due,
              interval_days: c.interval_days,
              ease: c.ease,
              reps: c.reps,
              lapses: c.lapses,
              last_review: c.last_review,
            })),
        })),
    }));

    return {
      version: 1,
      exported_at: nowTs(),
      units: exportUnits,
    };
  },

  async importBackup(b: any): Promise<{ units_created: number; lessons_created: number; cards_created: number; cards_skipped: number }> {
    const rep = { units_created: 0, lessons_created: 0, cards_created: 0, cards_skipped: 0 };
    if (!b || !Array.isArray(b.units)) {
      return rep;
    }

    const ts = nowTs();
    await db.transaction('rw', [db.units, db.lessons, db.cards], async () => {
      for (const bu of b.units) {
        if (!bu || typeof bu.name !== 'string') continue;
        const uName = bu.name.trim();
        const existingUnits = await db.units.toArray();
        let unit = existingUnits.find(u => u.name.toLowerCase() === uName.toLowerCase());
        let unit_id: number;
        if (!unit) {
          const maxPos = existingUnits.reduce((max, u) => Math.max(max, u.position), 0);
          unit_id = (await db.units.add({
            name: uName,
            position: maxPos + 1,
            created_at: ts,
          })) as number;
          rep.units_created += 1;
        } else {
          unit_id = unit.id!;
        }

        if (!Array.isArray(bu.lessons)) continue;
        for (const bl of bu.lessons) {
          if (!bl || typeof bl.name !== 'string') continue;
          const lName = bl.name.trim();
          const existingLessons = await db.lessons.where('unit_id').equals(unit_id).toArray();
          let lesson = existingLessons.find(l => l.name.toLowerCase() === lName.toLowerCase());
          let lesson_id: number;
          if (!lesson) {
            const maxPos = existingLessons.reduce((max, l) => Math.max(max, l.position), 0);
            lesson_id = (await db.lessons.add({
              unit_id,
              name: lName,
              position: maxPos + 1,
              created_at: ts,
            })) as number;
            rep.lessons_created += 1;
          } else {
            lesson_id = lesson.id!;
          }

          if (!Array.isArray(bl.cards)) continue;
          for (const bc of bl.cards) {
            if (!bc || typeof bc.front !== 'string' || typeof bc.back !== 'string') {
              rep.cards_skipped += 1;
              continue;
            }
            const front = bc.front.trim();
            const back = bc.back.trim();
            if (!front || !back) {
              rep.cards_skipped += 1;
              continue;
            }

            const existingCards = await db.cards.where('lesson_id').equals(lesson_id).toArray();
            const exists = existingCards.find(c =>
              c.front.toLowerCase() === front.toLowerCase() &&
              c.back.toLowerCase() === back.toLowerCase()
            );
            if (exists) {
              rep.cards_skipped += 1;
              continue;
            }

            const stateNum = stateToNumber(bc.state ?? STATE_NEW);
            const due = stateNum === STATE_NEW || !bc.due ? ts : bc.due;
            await db.cards.add({
              lesson_id,
              front,
              back,
              example: bc.example ? String(bc.example).trim() || null : null,
              state: stateNum,
              due,
              interval_days: typeof bc.interval_days === 'number' ? Math.max(0, bc.interval_days) : 0.0,
              ease: typeof bc.ease === 'number' ? Math.max(1.3, bc.ease) : INITIAL_EASE,
              reps: typeof bc.reps === 'number' ? Math.max(0, bc.reps) : 0,
              lapses: typeof bc.lapses === 'number' ? Math.max(0, bc.lapses) : 0,
              last_review: bc.last_review ?? null,
              created_at: ts,
              updated_at: ts,
            });
            rep.cards_created += 1;
          }
        }
      }
    });

    return rep;
  },
};
