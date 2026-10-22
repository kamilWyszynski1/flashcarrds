import { ApiError } from './api';

/**
 * Turn an `/api/extract` failure into one sentence the Capture screen can
 * show. The server's 502 message is already the full chain (stage, model,
 * image sizes, latency, upstream HTTP status and Gemini's own text), so it is
 * shown as-is; we only add a next step for the transient cases.
 */
export function describeExtractError(e: unknown): string {
  if (!(e instanceof ApiError)) return (e as Error)?.message || 'Extraction failed.';
  if (e.status === 502 && /HTTP 503|HTTP 429|no answer from Gemini|could not reach Gemini|high demand|overloaded/i.test(e.message)) {
    return `${e.message} — Gemini is busy or unreachable; try again in a minute.`;
  }
  return e.message;
}
