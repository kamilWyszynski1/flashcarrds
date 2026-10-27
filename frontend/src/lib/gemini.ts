import type { ExtractedCard, ExtractOptions, ExtractResponse } from './types';

export interface FreeTierModelInfo {
  id: string;
  label: string;
}

export const FREE_TIER_MODELS: FreeTierModelInfo[] = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash Latest' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (fast)' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (fast)' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (fast)' },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite Latest (fast)' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
];

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-flash-latest';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const RETRY_IF_FASTER_THAN_MS = 10_000;
export const RETRY_BACKOFF_MS = 1_500;
export const MIN_RETRY_BUDGET_MS = 500;
export const BODY_LOG_LIMIT = 2048;

export const MAX_IMAGES = 4;
export const MAX_IMAGE_B64_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_B64_BYTES = 20 * 1024 * 1024;
export const MAX_HINT_CHARS = 2000;
export const MAX_EDIT_CARDS = 200;

export function cleanModel(m: string): string {
  let cleaned = m.trim();
  if (cleaned.startsWith('models/')) {
    cleaned = cleaned.slice('models/'.length);
  }
  if (!cleaned) {
    throw new Error('model name must not be empty');
  }
  if (cleaned.length > 80) {
    throw new Error('model name is too long (max 80 characters)');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(cleaned)) {
    throw new Error(`model name may only contain letters, digits, '-', '.' and '_' (e.g. ${DEFAULT_MODEL})`);
  }
  return cleaned;
}

export function validateImages(images: { mime_type: string; data: string }[]): void {
  if (images.length === 0) {
    throw new Error('at least one image is required');
  }
  if (images.length > MAX_IMAGES) {
    throw new Error(`at most ${MAX_IMAGES} images per extraction`);
  }
  let total = 0;
  for (const img of images) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(img.mime_type)) {
      throw new Error(`unsupported image type ${img.mime_type}`);
    }
    if (!img.data) {
      throw new Error('empty image');
    }
    if (img.data.length > MAX_IMAGE_B64_BYTES) {
      throw new Error(`image is too large (max ~${Math.floor((MAX_IMAGE_B64_BYTES * 3) / 4 / 1024 / 1024)} MB after encoding)`);
    }
    total += img.data.length;
  }
  if (total > MAX_TOTAL_B64_BYTES) {
    throw new Error(`images are too large together (max ~${Math.floor((MAX_TOTAL_B64_BYTES * 3) / 4 / 1024 / 1024)} MB after encoding)`);
  }
}

export function buildPrompt(frontLang: string, backLang: string, hint: string): string {
  const h = hint.trim();
  let p = `You are helping a learner build vocabulary flashcards from photos of pages of a language textbook.
Each photo shows one or two pages. Extract the vocabulary items a learner would want to memorise.

Card format:
- "front": the word or short phrase in ${frontLang}, exactly as printed (keep accents, ¿¡, and the article for nouns when it is printed).
- "back": its translation in ${backLang}. If the page prints translations, use them; otherwise translate it yourself, briefly (1–4 words, add a short disambiguation in parentheses only when needed).
- "example": a short example sentence in ${frontLang} taken from the page if one is printed next to the item; otherwise omit the field.
- "confidence": a number from 0 to 1. Use values below 0.7 when the text is blurry, cut off, or when you had to guess the translation.

Rules:
- One item per vocabulary entry; do not merge items; do not invent items that are not on the page.
- Skip page numbers, headings, instructions for exercises, and grammar tables unless the learner asks for them.
- Do not repeat the same front twice.
- If nothing suitable is on the page, return an empty list.
`;
  if (h) {
    p += `\nThe learner's instructions for this photo (follow them, they take priority over the rules above):\n${h}\n`;
  }
  p += `\nReturn only JSON matching the schema.`;
  return p;
}

export function buildGeneratePrompt(frontLang: string, backLang: string, prompt: string): string {
  const p = prompt.trim();
  return `You are helping a learner create vocabulary flashcards.
The learner is studying ${frontLang} (front) -> ${backLang} (back).
The learner wants to create flashcards for:
${p}

Card format:
- "front": word, conjugated form (include subject pronoun like yo soy when conjugating verbs so each card is unambiguous, unless asked otherwise), or short phrase in ${frontLang} (keep accents, ¿¡, and articles for nouns when appropriate).
- "back": concise translation in ${backLang} (add brief disambiguation in parentheses when helpful).
- "example": optional short example sentence in ${frontLang} if requested or particularly helpful; otherwise omit.
- "confidence": number 0..1 (1.0 when certain).

Rules:
- Do not repeat identical front values.
- Keep the set focused and practical (typically 6–25 cards unless a specific count/list is requested).
- Return only JSON matching the schema.
`;
}

export interface EditCardInput {
  id: number;
  front: string;
  back: string;
  example?: string | null;
}

export interface RawCardEdit {
  id: number;
  front: string;
  back: string;
  example: string | null;
}

export function buildBatchEditPrompt(
  frontLang: string,
  backLang: string,
  prompt: string,
  cards: EditCardInput[],
): string {
  const p = prompt.trim();
  const inputCardsJson = JSON.stringify(
    cards.map((c) => ({
      id: c.id,
      front: c.front,
      back: c.back,
      ...(c.example ? { example: c.example } : {}),
    }))
  );
  return `You are helping a learner batch-edit existing vocabulary flashcards.
The flashcards have:
- "front" in ${frontLang}
- "back" in ${backLang}
- optional "example" sentence in ${frontLang}

The learner's instruction for editing these cards:
${p}

Rules:
- Return ONLY cards that actually need changes to satisfy the instruction; omit cards that need no change.
- Every returned item MUST keep its exact "id" from the input JSON list. Never invent new IDs.
- When adding context/disambiguation (e.g. differentiating ser vs estar), keep it concise (e.g. short note in parentheses on back or front as appropriate) while preserving accurate translations.
- Keep existing example if still valid (unless asked to change/remove it), or add/update example if requested/helpful.
- Return only JSON matching the schema.

Input cards:
${inputCardsJson}
`;
}

export function editResponseSchema(): unknown {
  return {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            front: { type: 'string' },
            back: { type: 'string' },
            example: { type: 'string' },
          },
          required: ['id', 'front', 'back'],
        },
      },
    },
    required: ['edits'],
  };
}

export function responseSchema(): unknown {
  return {
    type: 'object',
    properties: {
      cards: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            front: { type: 'string' },
            back: { type: 'string' },
            example: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['front', 'back', 'confidence'],
        },
      },
    },
    required: ['cards'],
  };
}

export function buildRequestBody(req: {
  frontLang: string;
  backLang: string;
  hint: string;
  images: { mime_type: string; data: string }[];
}): unknown {
  const parts: unknown[] = [{ text: buildPrompt(req.frontLang, req.backLang, req.hint) }];
  for (const img of req.images) {
    parts.push({ inline_data: { mime_type: img.mime_type, data: img.data } });
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: 'application/json',
      response_schema: responseSchema(),
    },
  };
}

export function stripCodeFence(s: string): string {
  let t = s.trim();
  if (t.startsWith('```json')) {
    t = t.slice('```json'.length);
  } else if (t.startsWith('```')) {
    t = t.slice('```'.length);
  }
  if (t.endsWith('```')) {
    t = t.slice(0, -3);
  }
  return t.trim();
}

export function parseResponse(v: any): ExtractedCard[] {
  if (v?.promptFeedback?.blockReason) {
    throw new Error(`request was blocked by Gemini (${v.promptFeedback.blockReason})`);
  }
  const candidate = v?.candidates?.[0];
  if (!candidate) {
    throw new Error('no candidates in response');
  }
  const parts = candidate.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? '').join('') : '';
  if (!text.trim()) {
    const finish = candidate.finishReason || 'unknown';
    throw new Error(`empty answer (finishReason: ${finish})`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (e) {
    throw new Error(`answer was not valid JSON: ${(e as Error).message}`);
  }
  let rawCards: any[];
  if (Array.isArray(parsed)) {
    rawCards = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cards)) {
    rawCards = parsed.cards;
  } else {
    throw new Error('answer has no "cards" array');
  }
  const out: ExtractedCard[] = [];
  for (const c of rawCards) {
    const front = String(c.front || '').trim();
    const back = String(c.back || '').trim();
    if (!front && !back) {
      continue;
    }
    const example = c.example ? String(c.example).trim() || null : null;
    const rawConf = typeof c.confidence === 'number' ? c.confidence : 1.0;
    const confidence = Math.max(0.0, Math.min(1.0, rawConf));
    out.push({ front, back, example, confidence, existing_in: null, existing_card_id: null });
  }
  return out;
}

export function parseEditResponse(v: any): RawCardEdit[] {
  if (v?.promptFeedback?.blockReason) {
    throw new Error(`request was blocked by Gemini (${v.promptFeedback.blockReason})`);
  }
  const candidate = v?.candidates?.[0];
  if (!candidate) {
    throw new Error('no candidates in response');
  }
  const parts = candidate.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? '').join('') : '';
  if (!text.trim()) {
    const finish = candidate.finishReason || 'unknown';
    throw new Error(`empty answer (finishReason: ${finish})`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (e) {
    throw new Error(`answer was not valid JSON: ${(e as Error).message}`);
  }
  let rawEdits: any[];
  if (Array.isArray(parsed)) {
    rawEdits = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.edits)) {
    rawEdits = parsed.edits;
  } else {
    throw new Error('answer has no "edits" array');
  }
  const out: RawCardEdit[] = [];
  for (const c of rawEdits) {
    if (typeof c?.id !== 'number' || !Number.isFinite(c.id)) {
      continue;
    }
    const front = String(c.front || '').trim();
    const back = String(c.back || '').trim();
    if (!front || !back) {
      continue;
    }
    const example = c.example ? String(c.example).trim() || null : null;
    out.push({
      id: Math.round(c.id),
      front,
      back,
      example,
    });
  }
  return out;
}

export function truncateBody(s: string, limit = BODY_LOG_LIMIT): string {
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}… [${s.length} bytes total]`;
}

export function parseErrorBody(text: string): { apiStatus?: string; message?: string } {
  try {
    const v = JSON.parse(text);
    const apiStatus = v?.error?.status ? String(v.error.status) : undefined;
    const message = v?.error?.message ? String(v.error.message) : undefined;
    return { apiStatus, message };
  } catch {
    return {};
  }
}

export function formatContext(
  stage: string,
  model: string,
  images: { mime_type: string; data: string }[],
  hint: string,
  elapsedMs: number,
  innerMsg: string
): string {
  const sizes = images.map((img) => `${Math.floor((img.data.length * 3) / 4 / 1024)} KB`).join(', ');
  const imgStr = images.length === 1 ? '1 image' : `${images.length} images`;
  return `Gemini extraction failed at stage '${stage}' (model ${model}, ${imgStr} [${sizes}], hint ${hint.length} chars, ${elapsedMs} ms): ${innerMsg}`;
}

export class RateLimiter {
  private max: number;
  private hits: number[] = [];

  constructor(maxPerMinute = 6) {
    this.max = maxPerMinute;
  }

  setMax(max: number) {
    this.max = max;
  }

  reset() {
    this.hits = [];
  }

  check(nowMs = Date.now()): { ok: true } | { ok: false; waitSecs: number } {
    if (this.max <= 0) {
      return { ok: true };
    }
    const windowMs = 60_000;
    while (this.hits.length > 0 && nowMs - this.hits[0] >= windowMs) {
      this.hits.shift();
    }
    if (this.hits.length >= this.max) {
      const oldest = this.hits[0];
      const waitMs = Math.max(1000, windowMs - (nowMs - oldest));
      const waitSecs = Math.max(1, Math.ceil(waitMs / 1000));
      return { ok: false, waitSecs };
    }
    this.hits.push(nowMs);
    return { ok: true };
  }
}

interface SendGeminiRequestOpts<T> {
  url: string;
  apiKey: string;
  bodyJson: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  formatError: (stage: string, elapsedMs: number, innerMsg: string) => string;
  parseJson: (jsonVal: any) => T;
}

async function sendGeminiRequest<T>(opts: SendGeminiRequestOpts<T>): Promise<T> {
  const fetchFn = opts.fetchImpl ?? (typeof window !== 'undefined' ? window.fetch.bind(window) : fetch);
  const started = Date.now();
  const backoffMs = Math.min(RETRY_BACKOFF_MS, Math.floor(opts.timeoutMs / 10));

  let attempt = 1;
  while (true) {
    if (opts.signal?.aborted) {
      const abortError = new DOMException('The user aborted a request.', 'AbortError');
      throw abortError;
    }

    const elapsedSoFar = Date.now() - started;
    const remainingBudgetMs = opts.timeoutMs - elapsedSoFar;
    if (remainingBudgetMs <= 0) {
      const totalElapsed = Date.now() - started;
      const inner = `no answer from Gemini after ${totalElapsed} ms: timed out`;
      throw new Error(opts.formatError('sending request', totalElapsed, inner));
    }

    const attemptController = new AbortController();
    const attemptTimeoutId = setTimeout(() => {
      attemptController.abort(new DOMException('Request timed out', 'TimeoutError'));
    }, remainingBudgetMs);

    const onCallerAbort = () => {
      attemptController.abort(opts.signal?.reason || new DOMException('The user aborted a request.', 'AbortError'));
    };
    opts.signal?.addEventListener('abort', onCallerAbort);

    const attemptStart = Date.now();
    let resp: Response;
    let text = '';
    try {
      resp = await fetchFn(opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': opts.apiKey,
        },
        body: opts.bodyJson,
        signal: attemptController.signal,
      });
      text = await resp.text();
    } catch (e: any) {
      clearTimeout(attemptTimeoutId);
      opts.signal?.removeEventListener('abort', onCallerAbort);

      if (opts.signal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }

      const attemptElapsed = Date.now() - attemptStart;
      const totalElapsed = Date.now() - started;
      const isTimeout = e?.name === 'TimeoutError' || (e?.name === 'AbortError' && !opts.signal?.aborted);
      const inner = isTimeout
        ? `no answer from Gemini after ${attemptElapsed} ms: timed out`
        : `could not reach Gemini after ${attemptElapsed} ms: ${e?.message || 'network error'}`;
      throw new Error(opts.formatError('sending request', totalElapsed, inner));
    } finally {
      clearTimeout(attemptTimeoutId);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }

    const attemptElapsed = Date.now() - attemptStart;
    const totalElapsed = Date.now() - started;

    if (!resp.ok) {
      const { apiStatus, message } = parseErrorBody(text);
      const remainingAfterAttempt = opts.timeoutMs - (Date.now() - started + backoffMs);
      const willRetry =
        attempt === 1 &&
        resp.status === 503 &&
        attemptElapsed < RETRY_IF_FASTER_THAN_MS &&
        remainingAfterAttempt >= MIN_RETRY_BUDGET_MS;

      if (willRetry) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        attempt += 1;
        continue;
      }

      const statusPart = apiStatus ? ` ${apiStatus}` : '';
      const msg = message || truncateBody(text.trim(), 300);
      const inner = `Gemini answered HTTP ${resp.status}${statusPart}: ${msg}`;
      throw new Error(opts.formatError('upstream_status', totalElapsed, inner));
    }

    try {
      const jsonVal = JSON.parse(text);
      return opts.parseJson(jsonVal);
    } catch (e: any) {
      const inner = `could not understand Gemini's answer: ${e?.message || 'parse error'}`;
      throw new Error(opts.formatError('parse', totalElapsed, inner));
    }
  }
}

export async function extractFromGemini(opts: {
  apiKey: string;
  model: string;
  images: { mime_type: string; data: string }[];
  hint: string;
  frontLang: string;
  backLang: string;
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ExtractedCard[]> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    throw new Error('Gemini API key is not configured – set GEMINI_API_KEY on the server');
  }

  const model = cleanModel(opts.model);
  validateImages(opts.images);

  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl}/models/${model}:generateContent`;
  const bodyObj = buildRequestBody({
    frontLang: opts.frontLang,
    backLang: opts.backLang,
    hint: opts.hint,
    images: opts.images,
  });
  const bodyJson = JSON.stringify(bodyObj);

  return sendGeminiRequest({
    url,
    apiKey,
    bodyJson,
    timeoutMs,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    formatError: (stage, elapsedMs, innerMsg) =>
      formatContext(stage, model, opts.images, opts.hint, elapsedMs, innerMsg),
    parseJson: parseResponse,
  });
}

export async function generateFromGemini(opts: {
  apiKey: string;
  model: string;
  prompt: string;
  frontLang: string;
  backLang: string;
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ExtractedCard[]> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    throw new Error('Gemini API key is not configured – set GEMINI_API_KEY on the server');
  }

  const promptText = opts.prompt.trim();
  if (!promptText) {
    throw new Error('prompt cannot be empty');
  }

  const model = cleanModel(opts.model);
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl}/models/${model}:generateContent`;

  const bodyObj = {
    contents: [{ role: 'user', parts: [{ text: buildGeneratePrompt(opts.frontLang, opts.backLang, promptText) }] }],
    generationConfig: {
      temperature: 0.3,
      response_mime_type: 'application/json',
      response_schema: responseSchema(),
    },
  };
  const bodyJson = JSON.stringify(bodyObj);

  return sendGeminiRequest({
    url,
    apiKey,
    bodyJson,
    timeoutMs,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    formatError: (stage, elapsedMs, innerMsg) =>
      `Gemini card generation failed at stage '${stage}' (model ${model}, prompt ${promptText.length} chars, ${elapsedMs} ms): ${innerMsg}`,
    parseJson: parseResponse,
  });
}

export async function editCardsWithGemini(opts: {
  apiKey: string;
  model: string;
  prompt: string;
  cards: EditCardInput[];
  frontLang: string;
  backLang: string;
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<RawCardEdit[]> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    throw new Error('Gemini API key is not configured – set GEMINI_API_KEY on the server');
  }

  const promptText = opts.prompt.trim();
  if (!promptText) {
    throw new Error('prompt cannot be empty');
  }

  if (opts.cards.length === 0) {
    throw new Error('no cards to edit');
  }
  if (opts.cards.length > MAX_EDIT_CARDS) {
    throw new Error(`too many cards (max ${MAX_EDIT_CARDS})`);
  }

  const model = cleanModel(opts.model);
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl}/models/${model}:generateContent`;

  const bodyObj = {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildBatchEditPrompt(opts.frontLang, opts.backLang, promptText, opts.cards) }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: 'application/json',
      response_schema: editResponseSchema(),
    },
  };
  const bodyJson = JSON.stringify(bodyObj);

  return sendGeminiRequest({
    url,
    apiKey,
    bodyJson,
    timeoutMs,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    formatError: (stage, elapsedMs, innerMsg) =>
      `Gemini card edit failed at stage '${stage}' (model ${model}, ${opts.cards.length} cards, prompt ${promptText.length} chars, ${elapsedMs} ms): ${innerMsg}`,
    parseJson: parseEditResponse,
  });
}

export interface ProbeModelOptions {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ProbeModelResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

export async function probeGeminiModel(opts: ProbeModelOptions): Promise<ProbeModelResult> {
  const apiKey = (opts.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, latencyMs: 0, error: 'Gemini API key is not configured' };
  }

  let model: string;
  try {
    model = cleanModel(opts.model);
  } catch (e: any) {
    return { ok: false, latencyMs: 0, error: e.message };
  }

  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 6000;
  const fetchFn = opts.fetchImpl ?? (typeof window !== 'undefined' ? window.fetch.bind(window) : fetch);

  const url = `${baseUrl}/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
    generationConfig: { maxOutputTokens: 4 },
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Probe timed out', 'TimeoutError'));
  }, timeoutMs);

  const onCallerAbort = () => {
    controller.abort(opts.signal?.reason || new DOMException('The user aborted a request.', 'AbortError'));
  };
  opts.signal?.addEventListener('abort', onCallerAbort);

  const started = Date.now();
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (resp.ok) {
      return { ok: true, latencyMs, status: resp.status };
    }
    const text = await resp.text().catch(() => '');
    const { apiStatus, message } = parseErrorBody(text);
    const statusPart = apiStatus ? ` ${apiStatus}` : '';
    const msg = message || truncateBody(text.trim(), 200) || `HTTP ${resp.status}`;
    return { ok: false, latencyMs, status: resp.status, error: `HTTP ${resp.status}${statusPart}: ${msg}` };
  } catch (e: any) {
    const latencyMs = Date.now() - started;
    if (opts.signal?.aborted) {
      throw new DOMException('The user aborted a request.', 'AbortError');
    }
    const isTimeout = e?.name === 'TimeoutError' || (e?.name === 'AbortError' && !opts.signal?.aborted);
    const errText = isTimeout ? 'Timed out' : (e?.message || 'Network error');
    return { ok: false, latencyMs, error: errText };
  } finally {
    clearTimeout(timeoutId);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
}

export interface FallbackProgress {
  currentModel: string;
  attemptIndex: number;
  totalModels: number;
  tried: { model: string; error: string }[];
}

export async function runWithModelFallback<T>(
  runFn: (signal: AbortSignal | undefined, opts: ExtractOptions) => Promise<T>,
  candidateModels: string[],
  signal?: AbortSignal,
  onProgress?: (progress: FallbackProgress) => void,
): Promise<T> {
  if (candidateModels.length === 0) {
    throw new Error('No models specified for extraction');
  }

  const tried: { model: string; error: string }[] = [];
  const totalModels = candidateModels.length;

  for (let i = 0; i < candidateModels.length; i++) {
    const currentModel = candidateModels[i];
    if (signal?.aborted) {
      throw new DOMException('The user aborted a request.', 'AbortError');
    }

    onProgress?.({
      currentModel,
      attemptIndex: i,
      totalModels,
      tried: [...tried],
    });

    try {
      const res = await runFn(signal, {
        model: currentModel,
        timeoutMs: 12_000,
        skipRateLimit: i > 0,
      });
      return res;
    } catch (e: any) {
      if (e?.name === 'AbortError' || signal?.aborted) {
        throw e;
      }
      const msg = (e?.message || '').toLowerCase();
      const isAuthOrConfigError =
        (e?.status === 400 && (e?.code === 'no_api_key' || msg.includes('api key'))) ||
        (e?.status === 403 && (e?.code === 'paused' || msg.includes('paused'))) ||
        msg.includes('api_key_invalid') ||
        msg.includes('api key not valid');

      if (isAuthOrConfigError) {
        throw e;
      }

      const shortErr = (e?.message || 'failed').slice(0, 150);
      tried.push({ model: currentModel, error: shortErr });

      if (i === candidateModels.length - 1) {
        const errorSummary = tried.map((t) => `${t.model}: ${t.error}`).join('; ');
        throw new Error(`All ${totalModels} free-tier models failed (${errorSummary})`);
      }
    }
  }

  throw new Error('All models exhausted');
}

export async function extractWithModelFallback(
  extractFn: (
    images: { mime_type: string; data: string }[],
    hint: string,
    signal?: AbortSignal,
    opts?: ExtractOptions,
  ) => Promise<ExtractResponse>,
  images: { mime_type: string; data: string }[],
  hint: string,
  candidateModels: string[],
  signal?: AbortSignal,
  onProgress?: (progress: FallbackProgress) => void,
): Promise<ExtractResponse> {
  return runWithModelFallback(
    (sig, opts) => extractFn(images, hint, sig, opts),
    candidateModels,
    signal,
    onProgress,
  );
}
