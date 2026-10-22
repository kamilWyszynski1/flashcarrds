import type { ExtractedCard } from './types';

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
  const fetchFn = opts.fetchImpl ?? (typeof window !== 'undefined' ? window.fetch.bind(window) : fetch);

  const url = `${baseUrl}/models/${model}:generateContent`;
  const bodyObj = buildRequestBody({
    frontLang: opts.frontLang,
    backLang: opts.backLang,
    hint: opts.hint,
    images: opts.images,
  });
  const bodyJson = JSON.stringify(bodyObj);

  const started = Date.now();
  const backoffMs = Math.min(RETRY_BACKOFF_MS, Math.floor(timeoutMs / 10));

  let attempt = 1;
  while (true) {
    if (opts.signal?.aborted) {
      const abortError = new DOMException('The user aborted a request.', 'AbortError');
      throw abortError;
    }

    const elapsedSoFar = Date.now() - started;
    const remainingBudgetMs = timeoutMs - elapsedSoFar;
    if (remainingBudgetMs <= 0) {
      const totalElapsed = Date.now() - started;
      const inner = `no answer from Gemini after ${totalElapsed} ms: timed out`;
      throw new Error(formatContext('sending request', model, opts.images, opts.hint, totalElapsed, inner));
    }

    // Set up timeout controller for this attempt
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
      resp = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: bodyJson,
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
      throw new Error(formatContext('sending request', model, opts.images, opts.hint, totalElapsed, inner));
    } finally {
      clearTimeout(attemptTimeoutId);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }

    const attemptElapsed = Date.now() - attemptStart;
    const totalElapsed = Date.now() - started;

    if (!resp.ok) {
      const { apiStatus, message } = parseErrorBody(text);
      const remainingAfterAttempt = timeoutMs - (Date.now() - started + backoffMs);
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
      throw new Error(formatContext('upstream_status', model, opts.images, opts.hint, totalElapsed, inner));
    }

    try {
      const jsonVal = JSON.parse(text);
      return parseResponse(jsonVal);
    } catch (e: any) {
      const inner = `could not understand Gemini's answer: ${e?.message || 'parse error'}`;
      throw new Error(formatContext('parse', model, opts.images, opts.hint, totalElapsed, inner));
    }
  }
}
