import { describe, expect, it } from 'vitest';
import {
  BODY_LOG_LIMIT,
  buildPrompt,
  buildRequestBody,
  cleanModel,
  DEFAULT_MODEL,
  extractFromGemini,
  MAX_IMAGE_B64_BYTES,
  parseErrorBody,
  parseResponse,
  RateLimiter,
  truncateBody,
  validateImages,
} from './gemini';

describe('gemini', () => {
  it('prompt_mentions_languages_and_hint', () => {
    const p = buildPrompt('Español', 'Polski', 'Only the blue box.');
    expect(p).toContain('in Español');
    expect(p).toContain('in Polski');
    expect(p).toContain('Only the blue box.');
    const p2 = buildPrompt('Español', 'Polski', '   ');
    expect(p2).not.toContain("learner's instructions");
  });

  it('request_body_has_text_then_images_and_json_mode', () => {
    const imgs = [{ mime_type: 'image/jpeg', data: 'AAAA' }];
    const body: any = buildRequestBody({ images: imgs, hint: '', frontLang: 'A', backLang: 'B' });
    const parts = body.contents[0].parts;
    expect(parts.length).toBe(2);
    expect(parts[0].text).toBeDefined();
    expect(parts[1].inline_data.mime_type).toBe('image/jpeg');
    expect(body.generationConfig.response_mime_type).toBe('application/json');
  });

  it('parses_object_with_cards', () => {
    const v = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  cards: [
                    { front: ' hace sol ', back: 'jest słonecznie', confidence: 0.95 },
                    { front: 'llueve', back: 'pada', example: 'Hoy llueve.', confidence: 1.7 },
                    { front: '', back: '' },
                  ],
                }),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    };
    const cards = parseResponse(v);
    expect(cards.length).toBe(2);
    expect(cards[0].front).toBe('hace sol');
    expect(cards[0].example).toBeNull();
    expect(cards[1].example).toBe('Hoy llueve.');
    expect(cards[1].confidence).toBe(1.0); // clamped
  });

  it('parses_bare_array_and_code_fences_and_multiple_parts', () => {
    const v = {
      candidates: [
        {
          content: {
            parts: [
              { text: '```json\n[{"front":"a","back":"b"}' },
              { text: ',{"front":"c","back":"d","confidence":0.5}]\n```' },
            ],
          },
        },
      ],
    };
    const cards = parseResponse(v);
    expect(cards.length).toBe(2);
    expect(cards[0].confidence).toBe(1.0);
    expect(cards[1].confidence).toBe(0.5);
  });

  it('reports_blocked_empty_and_malformed', () => {
    const blocked = { promptFeedback: { blockReason: 'SAFETY' } };
    expect(() => parseResponse(blocked)).toThrow('blocked by Gemini (SAFETY)');

    const empty = { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] };
    expect(() => parseResponse(empty)).toThrow('MAX_TOKENS');

    const bad = { candidates: [{ content: { parts: [{ text: 'not json' }] } }] };
    expect(() => parseResponse(bad)).toThrow('not valid JSON');

    const noCards = { candidates: [{ content: { parts: [{ text: '{"foo":1}' }] } }] };
    expect(() => parseResponse(noCards)).toThrow('cards');

    expect(() => parseResponse({})).toThrow('no candidates');
  });

  it('model_name_is_validated', () => {
    expect(cleanModel(' models/gemini-2.5-flash ')).toBe('gemini-2.5-flash');
    expect(cleanModel('gemini-2.0-flash_exp.v1')).toBe('gemini-2.0-flash_exp.v1');
    expect(() => cleanModel('gemini flash; drop')).toThrow(DEFAULT_MODEL);
    expect(() => cleanModel('x'.repeat(81))).toThrow('too long');
    expect(() => cleanModel('models/')).toThrow('empty');
    expect(() => cleanModel('')).toThrow('empty');
  });

  it('body_truncation_keeps_char_boundaries', () => {
    expect(truncateBody('short', 10)).toBe('short');
    const long = 'x'.repeat(BODY_LOG_LIMIT + 5);
    const t = truncateBody(long, BODY_LOG_LIMIT);
    expect(t.endsWith('bytes total]')).toBe(true);
  });

  it('upstream_error_body_is_parsed_for_status_and_message', () => {
    const { apiStatus, message } = parseErrorBody('{"error":{"code":503,"message":"busy","status":"UNAVAILABLE"}}');
    expect(apiStatus).toBe('UNAVAILABLE');
    expect(message).toBe('busy');
    expect(parseErrorBody('<html>502</html>')).toEqual({});
    expect(parseErrorBody('{"error":"flat"}')).toEqual({});
  });

  it('image_validation', () => {
    expect(() => validateImages([])).toThrow('at least one image');
    expect(() => validateImages([{ mime_type: 'image/gif', data: 'x' }])).toThrow('unsupported');
    expect(() => validateImages([{ mime_type: 'image/jpeg', data: '' }])).toThrow('empty');
    expect(() => validateImages([{ mime_type: 'image/jpeg', data: 'x' }])).not.toThrow();

    const five = Array(5).fill({ mime_type: 'image/jpeg', data: 'x' });
    expect(() => validateImages(five)).toThrow('at most 4');

    const big = { mime_type: 'image/jpeg', data: 'x'.repeat(MAX_IMAGE_B64_BYTES + 1) };
    expect(() => validateImages([big])).toThrow('too large');

    const ok = { mime_type: 'image/jpeg', data: 'x'.repeat(MAX_IMAGE_B64_BYTES) };
    expect(() => validateImages([ok])).not.toThrow();
  });

  it('RateLimiter sliding window allows max requests then enforces wait', () => {
    const limiter = new RateLimiter(2);
    expect(limiter.check(1000)).toEqual({ ok: true });
    expect(limiter.check(2000)).toEqual({ ok: true });
    const blocked = limiter.check(3000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.waitSecs).toBeGreaterThanOrEqual(1);
    }
    // After 60 seconds from first event (1000 + 60001 = 61001)
    expect(limiter.check(61001)).toEqual({ ok: true });
  });

  it('extractFromGemini mocked fetch: 200 OK happy path', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      cards: [{ front: 'hola', back: 'cześć', confidence: 0.99 }],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );

    const cards = await extractFromGemini({
      apiKey: 'test-key',
      model: 'gemini-flash-latest',
      images: [{ mime_type: 'image/jpeg', data: 'abcd' }],
      hint: '',
      frontLang: 'es',
      backLang: 'pl',
      fetchImpl: fakeFetch,
    });
    expect(cards.length).toBe(1);
    expect(cards[0].front).toBe('hola');
    expect(cards[0].back).toBe('cześć');
  });

  it('extractFromGemini retries fast 503 once then succeeds', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 503,
              message: 'This model is currently experiencing high demand.',
              status: 'UNAVAILABLE',
            },
          }),
          { status: 503 }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ cards: [{ front: 'sol', back: 'słońce' }] }) }],
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    const cards = await extractFromGemini({
      apiKey: 'test-key',
      model: 'gemini-flash-latest',
      images: [{ mime_type: 'image/jpeg', data: 'abcd' }],
      hint: '',
      frontLang: 'es',
      backLang: 'pl',
      timeoutMs: 15_000,
      fetchImpl: fakeFetch,
    });
    expect(callCount).toBe(2);
    expect(cards[0].front).toBe('sol');
  });

  it('extractFromGemini formats 503 error with context when retry fails', async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: 'High demand.',
            status: 'UNAVAILABLE',
          },
        }),
        { status: 503 }
      );
    };

    await expect(
      extractFromGemini({
        apiKey: 'test-key',
        model: 'gemini-flash-latest',
        images: [{ mime_type: 'image/jpeg', data: 'abcd' }],
        hint: '',
        frontLang: 'es',
        backLang: 'pl',
        timeoutMs: 15_000,
        fetchImpl: fakeFetch,
      })
    ).rejects.toThrow(/Gemini extraction failed at stage 'upstream_status'/);
    expect(callCount).toBe(2); // Retried once, then failed
  });

  it('extractFromGemini aborts immediately when signal is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractFromGemini({
        apiKey: 'test-key',
        model: 'gemini-flash-latest',
        images: [{ mime_type: 'image/jpeg', data: 'abcd' }],
        hint: '',
        frontLang: 'es',
        backLang: 'pl',
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});
