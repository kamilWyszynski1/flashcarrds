import Dexie, { type EntityTable } from 'dexie';

export interface DbUnit {
  id?: number;
  name: string;
  position: number;
  created_at: number;
}

export interface DbLesson {
  id?: number;
  unit_id: number;
  name: string;
  position: number;
  created_at: number;
}

export interface DbCard {
  id?: number;
  lesson_id: number;
  front: string;
  back: string;
  example: string | null;
  state: number | string;
  due: number;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_review: number | null;
  created_at: number;
  updated_at: number;
}

export interface DbSetting {
  key: string;
  value: string;
}

export interface DbUsage {
  day: string;
  count: number;
}

export const DEFAULT_SETTINGS: Record<string, string> = {
  daily_new_limit: '20',
  new_per_day: '20',
  front_lang: 'es',
  back_lang: 'pl',
  gemini_model: 'gemini-flash-latest',
  gemini_daily_limit: '60',
  extract_daily_cap: '60',
  gemini_rpm_limit: '6',
  gemini_paused: '0',
  extraction_paused: 'false',
  gemini_api_key: '',
  study_direction: 'front_to_back',
  haptics: 'true',
  theme: 'light',
};

export class FiszkiDatabase extends Dexie {
  units!: EntityTable<DbUnit, 'id'>;
  lessons!: EntityTable<DbLesson, 'id'>;
  cards!: EntityTable<DbCard, 'id'>;
  settings!: EntityTable<DbSetting, 'key'>;
  usage!: EntityTable<DbUsage, 'day'>;

  constructor(dbName = 'fiszki') {
    super(dbName);
    this.version(1).stores({
      units: '++id, position, name',
      lessons: '++id, unit_id, position, name',
      cards: '++id, lesson_id, due, state, front, back, updated_at',
      settings: 'key',
      usage: 'day',
    });
  }
}

export const db = new FiszkiDatabase();

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

export async function resetDatabase(targetDb: FiszkiDatabase = db): Promise<void> {
  await targetDb.transaction('rw', [targetDb.units, targetDb.lessons, targetDb.cards, targetDb.settings, targetDb.usage], async () => {
    await targetDb.units.clear();
    await targetDb.lessons.clear();
    await targetDb.cards.clear();
    await targetDb.settings.clear();
    await targetDb.usage.clear();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await targetDb.settings.put({ key, value });
    }
  });
}
