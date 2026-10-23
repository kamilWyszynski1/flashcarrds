import { ApiError } from './api.errors';
import { httpApi } from './api.http';
import { localApi } from './api.local';
import type {
  Card,
  ExtractOptions,
  ExtractResponse,
  Grade,
  Lesson,
  LessonDetail,
  NewCard,
  Overview,
  ReviewResult,
  Settings,
  SettingsPatch,
  StudyItem,
  Unit,
} from './types';

export type { ExtractOptions };
export { ApiError };

export interface FiszkiApi {
  overview: () => Promise<Overview>;

  units: () => Promise<Unit[]>;
  createUnit: (name: string) => Promise<Unit>;
  renameUnit: (id: number, name: string) => Promise<Unit>;
  deleteUnit: (id: number) => Promise<void>;

  lessons: () => Promise<Lesson[]>;
  lesson: (id: number) => Promise<LessonDetail>;
  createLesson: (unit_id: number, name: string) => Promise<Lesson>;
  updateLesson: (id: number, patch: { name?: string; unit_id?: number }) => Promise<Lesson>;
  deleteLesson: (id: number) => Promise<void>;

  cards: (f?: { lesson_id?: number; unit_id?: number; q?: string; status?: string; sort?: string; limit?: number }) => Promise<Card[]>;
  createCard: (lesson_id: number, c: NewCard) => Promise<Card>;
  createCards: (lesson_id: number, cards: NewCard[]) => Promise<{ created: number; ids: number[]; lesson: Lesson }>;
  updateCard: (id: number, patch: { front?: string; back?: string; example?: string; lesson_id?: number; reset_progress?: boolean }) => Promise<Card>;
  deleteCard: (id: number) => Promise<void>;

  studyQueue: (p?: { scope?: string; mode?: string; ids?: string; limit?: number; direction?: string }) => Promise<StudyItem[]>;
  review: (card_id: number, grade: Grade, direction: string) => Promise<ReviewResult>;

  extract: (
    images: { mime_type: string; data: string }[],
    hint: string,
    signal?: AbortSignal,
    opts?: ExtractOptions,
  ) => Promise<ExtractResponse>;
  probeModel?: (model: string, signal?: AbortSignal, timeoutMs?: number) => Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }>;

  settings: () => Promise<Settings>;
  patchSettings: (p: SettingsPatch) => Promise<Settings>;

  exportBackup: () => Promise<unknown>;
  importBackup: (b: unknown) => Promise<{ units_created: number; lessons_created: number; cards_created: number; cards_skipped: number }>;
}

export const isLocalBackend: boolean = import.meta.env.VITE_BACKEND !== 'http';

export const api: FiszkiApi = isLocalBackend ? localApi : httpApi;
