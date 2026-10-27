import { describe, expect, it } from 'vitest';
import {
  BODY_LOG_LIMIT,
  buildBatchEditPrompt,
  buildGeneratePrompt,
  buildPrompt,
  buildRequestBody,
  cleanModel,
  DEFAULT_MODEL,
  editCardsWithGemini,
  editResponseSchema,
  extractFromGemini,
  extractWithModelFallback,
  FREE_TIER_MODELS,
  generateFromGemini,
  MAX_IMAGE_B64_BYTES,
  parseEditResponse,
  parseErrorBody,
  parseResponse,
  probeGeminiModel,
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

  it('FREE_TIER_MODELS list is valid and cleanModel passes for all entries', () => {
    expect(FREE_TIER_MODELS.length).toBeGreaterThanOrEqual(5);
    for (const m of FREE_TIER_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(() => cleanModel(m.id)).not.toThrow();
    }
  });

  describe('probeGeminiModel', () => {
    it('returns error when API key is missing or model name is invalid', async () => {
      const res1 = await probeGeminiModel({ apiKey: '', model: 'gemini-flash-latest' });
      expect(res1.ok).toBe(false);
      expect(res1.error).toContain('API key is not configured');

      const res2 = await probeGeminiModel({ apiKey: 'k', model: 'bad name with spaces' });
      expect(res2.ok).toBe(false);
      expect(res2.error).toContain('model name may only contain');
    });

    it('returns ok on 200 response', async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
          status: 200,
        });

      const res = await probeGeminiModel({
        apiKey: 'valid-key',
        model: 'gemini-flash-latest',
        fetchImpl: fakeFetch,
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns failure details on 503 response', async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            error: { code: 503, message: 'Model is currently overloaded.', status: 'UNAVAILABLE' },
          }),
          { status: 503 }
        );

      const res = await probeGeminiModel({
        apiKey: 'valid-key',
        model: 'gemini-flash-latest',
        fetchImpl: fakeFetch,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(res.error).toContain('503');
      expect(res.error).toContain('UNAVAILABLE');
    });
  });

  describe('extractWithModelFallback', () => {
    const dummyImages = [{ mime_type: 'image/jpeg', data: 'abc' }];

    it('throws error when candidateModels is empty', async () => {
      await expect(
        extractWithModelFallback(async () => ({ cards: [], model: 'm', hint: '' }), dummyImages, '', [])
      ).rejects.toThrow('No models specified');
    });

    it('falls back to second model when first model fails with 503', async () => {
      const progressUpdates: any[] = [];
      const fakeExtract = async (_imgs: any, _hint: any, _sig: any, opts: any) => {
        if (opts?.model === 'model-1') {
          const err: any = new Error('503 Service Unavailable: overloaded');
          err.status = 503;
          throw err;
        }
        return {
          cards: [
            {
              front: 'vino',
              back: 'wino',
              example: null,
              existing_in: null,
              existing_card_id: null,
              confidence: 1,
            },
          ],
          model: opts?.model || 'model-2',
          hint: '',
        };
      };

      const result = await extractWithModelFallback(
        fakeExtract,
        dummyImages,
        'hint text',
        ['model-1', 'model-2'],
        undefined,
        (p) => progressUpdates.push(p)
      );

      expect(result.cards.length).toBe(1);
      expect(result.cards[0].front).toBe('vino');
      expect(progressUpdates.length).toBe(2);
      expect(progressUpdates[0].currentModel).toBe('model-1');
      expect(progressUpdates[0].tried.length).toBe(0);
      expect(progressUpdates[1].currentModel).toBe('model-2');
      expect(progressUpdates[1].tried.length).toBe(1);
      expect(progressUpdates[1].tried[0].model).toBe('model-1');
    });

    it('stops immediately without fallback on auth error', async () => {
      let callCount = 0;
      const fakeExtract = async () => {
        callCount++;
        const err: any = new Error('API key not valid. Please pass a valid API key.');
        err.status = 400;
        err.code = 'no_api_key';
        throw err;
      };

      await expect(
        extractWithModelFallback(fakeExtract, dummyImages, '', ['model-1', 'model-2'])
      ).rejects.toThrow(/API key/);
      expect(callCount).toBe(1); // Never tried model-2
    });

    it('aborts when signal is already cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        extractWithModelFallback(
          async () => ({ cards: [], model: 'm', hint: '' }),
          dummyImages,
          '',
          ['model-1'],
          controller.signal
        )
      ).rejects.toThrow();
    });
  });

  describe('generateFromGemini & buildGeneratePrompt', () => {
    it('buildGeneratePrompt includes languages, prompt, and rules', () => {
      const p = buildGeneratePrompt('Español', 'Polski', 'conjugation of ser verb');
      expect(p).toContain('Español (front) -> Polski (back)');
      expect(p).toContain('conjugation of ser verb');
      expect(p).toContain('Do not repeat identical front values');
      expect(p).toContain('6–25 cards');
    });

    it('generateFromGemini validates empty API key or empty prompt', async () => {
      await expect(
        generateFromGemini({
          apiKey: '',
          model: 'gemini-flash-latest',
          prompt: 'test',
          frontLang: 'es',
          backLang: 'pl',
        })
      ).rejects.toThrow(/Gemini API key is not configured/);

      await expect(
        generateFromGemini({
          apiKey: 'key',
          model: 'gemini-flash-latest',
          prompt: '   ',
          frontLang: 'es',
          backLang: 'pl',
        })
      ).rejects.toThrow(/prompt cannot be empty/);
    });

    it('generateFromGemini returns cards on 200 OK', async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        cards: [
                          { front: 'yo soy', back: 'ja jestem', example: 'Yo soy estudiante.', confidence: 1.0 },
                          { front: 'tú eres', back: 'ty jesteś', confidence: 0.95 },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );

      const cards = await generateFromGemini({
        apiKey: 'test-key',
        model: 'gemini-flash-latest',
        prompt: 'ser present tense',
        frontLang: 'Español',
        backLang: 'Polski',
        fetchImpl: fakeFetch,
      });

      expect(cards.length).toBe(2);
      expect(cards[0].front).toBe('yo soy');
      expect(cards[0].back).toBe('ja jestem');
      expect(cards[0].example).toBe('Yo soy estudiante.');
      expect(cards[1].front).toBe('tú eres');
      expect(cards[1].example).toBeNull();
    });
  });

  describe('batchEdit & buildBatchEditPrompt', () => {
    it('buildBatchEditPrompt includes cards json and instruction', () => {
      const p = buildBatchEditPrompt('Español', 'Polski', 'differentiate ser vs estar', [
        { id: 1, front: 'es', back: 'jest' },
        { id: 2, front: 'está', back: 'jest', example: 'Está en casa.' },
      ]);
      expect(p).toContain('differentiate ser vs estar');
      expect(p).toContain('"id":1');
      expect(p).toContain('"front":"es"');
      expect(p).toContain('"id":2');
      expect(p).toContain('"example":"Está en casa."');
      expect(p).toContain('Return ONLY cards that actually need changes');
    });

    it('editResponseSchema has object with edits array', () => {
      const schema: any = editResponseSchema();
      expect(schema.type).toBe('object');
      expect(schema.properties.edits.type).toBe('array');
    });

    it('parseEditResponse parses valid edits and cleans fields', () => {
      const v = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    edits: [
                      { id: 1, front: 'es', back: 'jest (cecha stała)', example: 'Es profesor.' },
                      { id: 2, front: 'está', back: 'jest (stan tymczasowy)' },
                      { id: 'not an int', front: 'bad', back: 'bad' },
                      { id: 3, front: '', back: 'empty front' },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      };
      const edits = parseEditResponse(v);
      expect(edits.length).toBe(2);
      expect(edits[0]).toEqual({ id: 1, front: 'es', back: 'jest (cecha stała)', example: 'Es profesor.' });
      expect(edits[1]).toEqual({ id: 2, front: 'está', back: 'jest (stan tymczasowy)', example: null });
    });

    it('parseEditResponse handles errors and fences', () => {
      expect(() => parseEditResponse({ promptFeedback: { blockReason: 'OTHER' } })).toThrow('blocked by Gemini');
      expect(() => parseEditResponse({})).toThrow('no candidates');
      const candidateResp = {
        candidates: [
          {
            content: {
              parts: [{ text: '```json\n[{"id":5,"front":"a","back":"b"}]\n```' }],
            },
          },
        ],
      };
      expect(() => parseEditResponse(candidateResp)).not.toThrow();
    });

    it('editCardsWithGemini validates cards and returns raw edits', async () => {
      await expect(
        editCardsWithGemini({
          apiKey: 'key',
          model: 'gemini-flash-latest',
          prompt: 'edit',
          cards: [],
          frontLang: 'es',
          backLang: 'pl',
        })
      ).rejects.toThrow('no cards to edit');

      const fakeFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        edits: [{ id: 10, front: 'ser', back: 'być (cecha)', example: 'Ser bueno.' }],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );

      const edits = await editCardsWithGemini({
        apiKey: 'test-key',
        model: 'gemini-flash-latest',
        prompt: 'add disambiguation',
        cards: [{ id: 10, front: 'ser', back: 'być' }],
        frontLang: 'Español',
        backLang: 'Polski',
        fetchImpl: fakeFetch,
      });

      expect(edits.length).toBe(1);
      expect(edits[0].id).toBe(10);
      expect(edits[0].back).toBe('być (cecha)');
    });
  });
});

