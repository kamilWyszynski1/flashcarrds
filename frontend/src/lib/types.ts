// Types mirroring the Rust API (backend/src/models.rs).

export type Status = 'new' | 'due' | 'learning' | 'learned';
export type Grade = 'again' | 'hard' | 'good' | 'easy';
export type Direction = 'forward' | 'reverse';

export interface Unit {
  id: number;
  name: string;
  position: number;
}

export interface Lesson {
  id: number;
  unit_id: number;
  name: string;
  position: number;
}

export interface Counts {
  total: number;
  new: number;
  due: number;
  learning: number;
  learned: number;
}

export interface Card {
  id: number;
  lesson_id: number;
  lesson_name: string;
  unit_id: number;
  unit_name: string;
  front: string;
  back: string;
  example: string | null;
  state: number;
  status: Status;
  due: number;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_review: number | null;
  created_at: number;
  updated_at: number;
}

export interface LessonOverview extends Counts {
  id: number;
  unit_id: number;
  name: string;
  position: number;
}

export interface UnitOverview extends Counts {
  id: number;
  name: string;
  position: number;
  lessons: LessonOverview[];
}

export interface Overview extends Counts {
  now: number;
  new_available: number;
  new_studied_today: number;
  reviews_today: number;
  units: UnitOverview[];
}

export interface LessonDetail extends Lesson, Counts {
  unit: Unit;
  cards: Card[];
}

export interface Settings {
  front_lang: string;
  back_lang: string;
  study_direction: 'front_to_back' | 'back_to_front' | 'mixed';
  new_per_day: number;
  haptics: boolean;
  gemini_model: string;
  gemini_api_key_set: boolean;
  gemini_api_key_hint: string | null;
  last_lesson_id: number | null;
  /** Kill switch for "Cards from photo". */
  extraction_paused: boolean;
  extractions_today: number;
  extractions_total: number;
  /** Server-side daily cap (env `FISZKI_EXTRACT_DAILY_CAP`); 0 = unlimited. */
  extract_daily_cap: number;
}

export type SettingsPatch = Partial<Omit<Settings, 'gemini_api_key_set' | 'gemini_api_key_hint' | 'extractions_today' | 'extractions_total' | 'extract_daily_cap'>> & {
  gemini_api_key?: string;
};

export interface Preview {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface StudyItem {
  card: Card;
  direction: Direction;
  preview: Preview;
  preview_labels: { again: string; hard: string; good: string; easy: string };
}

export interface ReviewResult {
  card: Card;
  due_in_secs: number;
  due_label: string;
  /** Previews for the card's next review (used when it is re-queued in-session). */
  preview: Preview;
  preview_labels: StudyItem['preview_labels'];
}

export interface ExtractedCard {
  front: string;
  back: string;
  example?: string | null;
  confidence: number;
  existing_in?: string | null;
  existing_card_id?: number | null;
}

export interface ExtractResponse {
  cards: ExtractedCard[];
  model: string;
  hint: string;
}

export interface NewCard {
  front: string;
  back: string;
  example?: string | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
