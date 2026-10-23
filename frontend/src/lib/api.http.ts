import { ApiError } from './api.errors';
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
import type { FiszkiApi } from './api';

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'You seem to be offline – the server could not be reached.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const b = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, b.error ?? 'error', b.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const q = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const httpApi: FiszkiApi = {
  overview: () => request<Overview>('GET', '/overview'),

  units: () => request<Unit[]>('GET', '/units'),
  createUnit: (name: string) => request<Unit>('POST', '/units', { name }),
  renameUnit: (id: number, name: string) => request<Unit>('PATCH', `/units/${id}`, { name }),
  deleteUnit: (id: number) => request<void>('DELETE', `/units/${id}`),

  lessons: () => request<Lesson[]>('GET', '/lessons'),
  lesson: (id: number) => request<LessonDetail>('GET', `/lessons/${id}`),
  createLesson: (unit_id: number, name: string) => request<Lesson>('POST', '/lessons', { unit_id, name }),
  updateLesson: (id: number, patch: { name?: string; unit_id?: number }) => request<Lesson>('PATCH', `/lessons/${id}`, patch),
  deleteLesson: (id: number) => request<void>('DELETE', `/lessons/${id}`),

  cards: (f: { lesson_id?: number; unit_id?: number; q?: string; status?: string; sort?: string; limit?: number } = {}) =>
    request<Card[]>('GET', `/cards${q(f)}`),
  createCard: (lesson_id: number, c: NewCard) => request<Card>('POST', '/cards', { lesson_id, ...c }),
  createCards: (lesson_id: number, cards: NewCard[]) =>
    request<{ created: number; ids: number[]; lesson: Lesson }>('POST', '/cards/bulk', { lesson_id, cards }),
  updateCard: (id: number, patch: { front?: string; back?: string; example?: string; lesson_id?: number; reset_progress?: boolean }) =>
    request<Card>('PATCH', `/cards/${id}`, patch),
  deleteCard: (id: number) => request<void>('DELETE', `/cards/${id}`),

  studyQueue: (p: { scope?: string; mode?: string; ids?: string; limit?: number; direction?: string } = {}) =>
    request<StudyItem[]>('GET', `/study/queue${q(p)}`),
  review: (card_id: number, grade: Grade, direction: string) => request<ReviewResult>('POST', '/study/review', { card_id, grade, direction }),

  extract: (images: { mime_type: string; data: string }[], hint: string, signal?: AbortSignal, _opts?: ExtractOptions) =>
    request<ExtractResponse>('POST', '/extract', { images, hint }, signal),
  probeModel: async () => ({ ok: false, latencyMs: 0, error: 'Probing is only supported in local mode' }),

  settings: () => request<Settings>('GET', '/settings'),
  patchSettings: (p: SettingsPatch) => request<Settings>('PATCH', '/settings', p),

  exportBackup: () => request<unknown>('GET', '/export'),
  importBackup: (b: unknown) =>
    request<{ units_created: number; lessons_created: number; cards_created: number; cards_skipped: number }>('POST', '/import', b),
};
