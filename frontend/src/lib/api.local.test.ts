import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { localApi } from './api.local';
import { resetDatabase } from './db';

describe('localApi (IndexedDB)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('overview is empty initially', async () => {
    const o = await localApi.overview();
    expect(o.total).toBe(0);
    expect(o.units.length).toBe(0);
    expect(o.new_available).toBe(0);
    expect(o.new_studied_today).toBe(0);
    expect(o.reviews_today).toBe(0);
  });

  it('unit/lesson/card CRUD and validation errors', async () => {
    // Validation errors
    await expect(localApi.createUnit('   ')).rejects.toThrow('unit name cannot be empty');
    await expect(localApi.createLesson(999, 'Test Lesson')).rejects.toThrow('unit 999 does not exist');

    // Create unit and lesson
    const unit = await localApi.createUnit('Unidad 1 · Saludos');
    expect(unit.id).toBeDefined();
    expect(unit.name).toBe('Unidad 1 · Saludos');
    expect(unit.position).toBe(1);

    const lesson = await localApi.createLesson(unit.id, '1.1 Vocabulario');
    expect(lesson.unit_id).toBe(unit.id);
    expect(lesson.name).toBe('1.1 Vocabulario');
    expect(lesson.position).toBe(1);

    await expect(localApi.createLesson(unit.id, '   ')).rejects.toThrow('lesson name cannot be empty');

    // Rename unit
    const renamed = await localApi.renameUnit(unit.id, 'Unidad 1');
    expect(renamed.name).toBe('Unidad 1');

    // List units & lessons
    const units = await localApi.units();
    expect(units.length).toBe(1);
    expect(units[0].name).toBe('Unidad 1');

    const lessons = await localApi.lessons();
    expect(lessons.length).toBe(1);
    expect(lessons[0].name).toBe('1.1 Vocabulario');

    // Create card validation
    await expect(localApi.createCard(lesson.id, { front: '', back: 'cześć' })).rejects.toThrow('front and back are required');
    await expect(localApi.createCard(lesson.id, { front: 'hola', back: '' })).rejects.toThrow('front and back are required');
    await expect(localApi.createCard(9999, { front: 'hola', back: 'cześć' })).rejects.toThrow('lesson 9999 does not exist');

    // Create single card
    const card = await localApi.createCard(lesson.id, {
      front: 'hola',
      back: 'cześć',
      example: '¡Hola amigo!',
    });
    expect(card.id).toBeDefined();
    expect(card.front).toBe('hola');
    expect(card.back).toBe('cześć');
    expect(card.example).toBe('¡Hola amigo!');
    expect(card.status).toBe('new');
    expect(card.lesson_name).toBe('1.1 Vocabulario');
    expect(card.unit_name).toBe('Unidad 1');
    expect(card.interval_label).toBe('new');

    // Lesson detail
    const detail = await localApi.lesson(lesson.id);
    expect(detail.id).toBe(lesson.id);
    expect(detail.unit.id).toBe(unit.id);
    expect(detail.total).toBe(1);
    expect(detail.new).toBe(1);
    expect(detail.cards.length).toBe(1);

    // Update card
    const updated = await localApi.updateCard(card.id, {
      back: 'cześć / dzień dobry',
      example: '',
    });
    expect(updated.back).toBe('cześć / dzień dobry');
    expect(updated.example).toBeNull();

    // Delete card
    await localApi.deleteCard(card.id);
    const remainingCards = await localApi.cards({ lesson_id: lesson.id });
    expect(remainingCards.length).toBe(0);
    await expect(localApi.deleteCard(card.id)).rejects.toThrow('not found');
  });

  it('bulk create validation and card counts', async () => {
    const unit = await localApi.createUnit('Unidad 2');
    const lesson = await localApi.createLesson(unit.id, '2.1 Comer');

    await expect(localApi.createCards(lesson.id, [])).rejects.toThrow('no cards to save');
    await expect(localApi.createCards(lesson.id, [{ front: '', back: 'chleb' }])).rejects.toThrow('front and back are required');

    const res = await localApi.createCards(lesson.id, [
      { front: 'el pan', back: 'chleb' },
      { front: 'la leche', back: 'mleko', example: 'Leche fría' },
      { front: 'el queso', back: 'ser' },
    ]);
    expect(res.created).toBe(3);
    expect(res.ids.length).toBe(3);
    expect(res.lesson.id).toBe(lesson.id);

    const cards = await localApi.cards({ lesson_id: lesson.id });
    expect(cards.length).toBe(3);

    // Settings remembers last_lesson_id
    const settings = await localApi.settings();
    expect(settings.last_lesson_id).toBe(lesson.id);
  });

  it('updateCardsBulk validates input, updates content, and preserves SRS schedule', async () => {
    const unit = await localApi.createUnit('Unidad 2.5');
    const lesson = await localApi.createLesson(unit.id, '2.5 SRS');

    const created = await localApi.createCard(lesson.id, {
      front: 'el café',
      back: 'kawa',
      example: 'Café caliente',
    });

    // Review card to move it out of 'new' state and set SRS fields
    const reviewed = await localApi.review(created.id, 'good', 'forward');
    expect(reviewed.card.status).toBe('learned');
    expect(reviewed.card.reps).toBe(1);

    // Validation errors
    await expect(localApi.updateCardsBulk([])).rejects.toThrow('no updates to apply');
    await expect(localApi.updateCardsBulk([{ id: created.id, front: '', back: 'kawa' }])).rejects.toThrow(
      'front and back are required'
    );
    await expect(localApi.updateCardsBulk([{ id: created.id, front: 'el café', back: '' }])).rejects.toThrow(
      'front and back are required'
    );
    await expect(
      localApi.updateCardsBulk(
        Array.from({ length: 501 }, (_, i) => ({ id: i + 1, front: 'f', back: 'b' }))
      )
    ).rejects.toThrow('too many updates');

    // Successfully apply bulk update, including a non-existent card ID
    const res = await localApi.updateCardsBulk([
      {
        id: created.id,
        front: 'el café solo',
        back: 'czarna kawa',
        example: 'Un café solo, por favor',
      },
      {
        id: 999999, // non-existent card
        front: 'fantasma',
        back: 'duch',
      },
    ]);

    expect(res.updated).toBe(1);

    // Verify card content was updated but SRS state was strictly preserved
    const cards = await localApi.cards({ lesson_id: lesson.id });
    expect(cards.length).toBe(1);
    const updatedCard = cards[0];
    expect(updatedCard.front).toBe('el café solo');
    expect(updatedCard.back).toBe('czarna kawa');
    expect(updatedCard.example).toBe('Un café solo, por favor');
    expect(updatedCard.status).toBe('learned');
    expect(updatedCard.reps).toBe(1);
    expect(updatedCard.lapses).toBe(reviewed.card.lapses);
    expect(updatedCard.interval_label).toBe(reviewed.card.interval_label);
    expect(updatedCard.due).toBe(reviewed.card.due);
    expect(updatedCard.interval_days).toBe(reviewed.card.interval_days);
  });

  it('cards search and status filters', async () => {
    const unit = await localApi.createUnit('Unidad 3');
    const lesson = await localApi.createLesson(unit.id, '3.1 Viajar');

    await localApi.createCards(lesson.id, [
      { front: 'el tren', back: 'pociąg', example: 'El tren rápido' },
      { front: 'el coche', back: 'samochód' },
      { front: 'el avión', back: 'samolot' },
    ]);

    // Case-insensitive search on front, back, and example
    const q1 = await localApi.cards({ q: 'TREN' });
    expect(q1.length).toBe(1);
    expect(q1[0].front).toBe('el tren');

    const q2 = await localApi.cards({ q: 'samochód' });
    expect(q2.length).toBe(1);

    const q3 = await localApi.cards({ q: 'rápido' });
    expect(q3.length).toBe(1);

    const q4 = await localApi.cards({ q: 'nonexistent' });
    expect(q4.length).toBe(0);

    // Status filter
    const newCards = await localApi.cards({ status: 'new' });
    expect(newCards.length).toBe(3);

    const dueCards = await localApi.cards({ status: 'due' });
    expect(dueCards.length).toBe(0);

    await expect(localApi.cards({ status: 'bogus' })).rejects.toThrow('unknown status filter');

    // Sorting
    const alphaCards = await localApi.cards({ sort: 'alpha' });
    expect(alphaCards[0].front).toBe('el avión');
  });

  it('overview counts and daily new budget', async () => {
    const unit = await localApi.createUnit('Unidad 4');
    const l1 = await localApi.createLesson(unit.id, '4.1');
    const l2 = await localApi.createLesson(unit.id, '4.2');

    await localApi.createCards(l1.id, [
      { front: 'a1', back: 'b1' },
      { front: 'a2', back: 'b2' },
      { front: 'a3', back: 'b3' },
    ]);
    await localApi.createCards(l2.id, [
      { front: 'a4', back: 'b4' },
      { front: 'a5', back: 'b5' },
    ]);

    await localApi.patchSettings({ new_per_day: 3 });

    let o = await localApi.overview();
    expect(o.total).toBe(5);
    expect(o.new).toBe(5);
    expect(o.new_available).toBe(3);
    expect(o.units[0].total).toBe(5);
    expect(o.units[0].lessons.length).toBe(2);

    // Review one card as 'good'
    const cards = await localApi.cards({ lesson_id: l1.id });
    const r = await localApi.review(cards[0].id, 'good', 'forward');
    expect(r.card.status).toBe('learned');
    expect(r.due_label).toBe('1 day');

    o = await localApi.overview();
    expect(o.new).toBe(4);
    expect(o.learned).toBe(1);
    expect(o.new_studied_today).toBe(1);
    expect(o.reviews_today).toBe(1);
    expect(o.new_available).toBe(2); // 3 budget - 1 studied
  });

  it('study queue ordering, limit, shuffle, and fallback', async () => {
    const unit = await localApi.createUnit('Unidad 5');
    const l1 = await localApi.createLesson(unit.id, '5.1');

    const res = await localApi.createCards(l1.id, [
      { front: 'c1', back: 'x1' },
      { front: 'c2', back: 'x2' },
      { front: 'c3', back: 'x3' },
      { front: 'c4', back: 'x4' },
    ]);

    await localApi.patchSettings({ new_per_day: 2 });

    // Capped by daily new budget
    const q1 = await localApi.studyQueue({ scope: `lesson:${l1.id}` });
    expect(q1.length).toBe(2);
    expect(q1[0].preview_labels.good).toBe('1 day');
    expect(q1[0].preview_labels.easy).toBe('4 days');

    // mode=all ignores budget
    const qAll = await localApi.studyQueue({ scope: `lesson:${l1.id}`, mode: 'all' });
    expect(qAll.length).toBe(4);

    // Explicit IDs
    const qIds = await localApi.studyQueue({ ids: `${res.ids[2]},${res.ids[0]}` });
    expect(qIds.length).toBe(2);
    expect(qIds[0].card.id).toBe(res.ids[2]);
    expect(qIds[1].card.id).toBe(res.ids[0]);

    // Direction override
    const qRev = await localApi.studyQueue({ direction: 'back_to_front' });
    expect(qRev.every(i => i.direction === 'reverse')).toBe(true);

    // Invalid scope
    await expect(localApi.studyQueue({ scope: 'invalid:1' })).rejects.toThrow('unknown scope');
  });

  it('review progression and lapse into relearning', async () => {
    const unit = await localApi.createUnit('Unidad 6');
    const lesson = await localApi.createLesson(unit.id, '6.1');
    const card = await localApi.createCard(lesson.id, { front: 'palabra', back: 'słowo' });

    // 1st review: good -> graduates to review (learned)
    const r1 = await localApi.review(card.id, 'good', 'forward');
    expect(r1.card.status).toBe('learned');
    expect(r1.card.reps).toBe(1);
    expect(r1.due_label).toBe('1 day');
    expect(r1.preview_labels.again).toBe('10 min');

    // 2nd review: again -> lapse into relearning
    const r2 = await localApi.review(card.id, 'again', 'forward');
    expect(r2.card.status).toBe('learning');
    expect(r2.card.lapses).toBe(1);
    expect(r2.due_label).toBe('10 min');

    // Invalid grade
    await expect(localApi.review(card.id, 'meh' as any, 'forward')).rejects.toThrow('unknown grade');
    await expect(localApi.review(99999, 'good', 'forward')).rejects.toThrow('not found');
  });

  it('cascade deletes', async () => {
    const unit = await localApi.createUnit('Unidad 7');
    const lesson1 = await localApi.createLesson(unit.id, '7.1');
    const lesson2 = await localApi.createLesson(unit.id, '7.2');

    await localApi.createCard(lesson1.id, { front: 'f1', back: 'b1' });
    await localApi.createCard(lesson2.id, { front: 'f2', back: 'b2' });

    expect((await localApi.cards()).length).toBe(2);

    // Delete single lesson cascades cards of that lesson
    await localApi.deleteLesson(lesson1.id);
    expect((await localApi.cards({ lesson_id: lesson1.id })).length).toBe(0);
    expect((await localApi.cards({ lesson_id: lesson2.id })).length).toBe(1);

    // Delete unit cascades all lessons and remaining cards
    await localApi.deleteUnit(unit.id);
    expect((await localApi.lessons()).length).toBe(0);
    expect((await localApi.cards()).length).toBe(0);
    await expect(localApi.deleteUnit(unit.id)).rejects.toThrow('not found');
  });

  it('export/import roundtrip and deduplication', async () => {
    const unit = await localApi.createUnit('Unidad 8');
    const lesson = await localApi.createLesson(unit.id, '8.1');
    await localApi.createCards(lesson.id, [
      { front: 'hola', back: 'cześć' },
      { front: 'adiós', back: 'pa' },
    ]);

    const backup = await localApi.exportBackup() as any;
    expect(backup.version).toBe(1);
    expect(backup.units.length).toBe(1);
    expect(backup.units[0].lessons[0].cards.length).toBe(2);

    // Import into fresh database
    await resetDatabase();
    const rep1 = await localApi.importBackup(backup);
    expect(rep1.units_created).toBe(1);
    expect(rep1.lessons_created).toBe(1);
    expect(rep1.cards_created).toBe(2);
    expect(rep1.cards_skipped).toBe(0);

    // Second import skips duplicates
    const rep2 = await localApi.importBackup(backup);
    expect(rep2.units_created).toBe(0);
    expect(rep2.lessons_created).toBe(0);
    expect(rep2.cards_created).toBe(0);
    expect(rep2.cards_skipped).toBe(2);
  });

  it('settings roundtrip and patching', async () => {
    const s = await localApi.settings();
    expect(s.front_lang).toBe('es');
    expect(s.back_lang).toBe('pl');
    expect(s.theme).toBe('light');

    const patched = await localApi.patchSettings({
      front_lang: 'Español',
      back_lang: 'Polski',
      study_direction: 'mixed',
      new_per_day: 25,
      theme: 'dark',
      gemini_api_key: 'test-key-1234',
    });
    expect(patched.front_lang).toBe('Español');
    expect(patched.back_lang).toBe('Polski');
    expect(patched.study_direction).toBe('mixed');
    expect(patched.new_per_day).toBe(25);
    expect(patched.theme).toBe('dark');
    expect(patched.gemini_api_key_set).toBe(true);

    // Validation
    await expect(localApi.patchSettings({ theme: 'sepia' as any })).rejects.toThrow('theme must be');
    await expect(localApi.patchSettings({ new_per_day: -5 })).rejects.toThrow('between 0 and 500');
    await expect(localApi.patchSettings({ study_direction: 'diagonal' as any })).rejects.toThrow('study_direction must be');
  });

  describe('extract (Gemini integration & safeguards)', () => {
    it('requires Gemini API key', async () => {
      await expect(
        localApi.extract([{ mime_type: 'image/jpeg', data: 'dGVzdA==' }], '')
      ).rejects.toThrow('Gemini API key is not configured');
    });

    it('validates image inputs', async () => {
      await localApi.patchSettings({ gemini_api_key: 'test-key' });

      await expect(localApi.extract([], '')).rejects.toThrow('at least one image is required');
      await expect(
        localApi.extract(
          [
            { mime_type: 'image/jpeg', data: 'a' },
            { mime_type: 'image/jpeg', data: 'b' },
            { mime_type: 'image/jpeg', data: 'c' },
            { mime_type: 'image/jpeg', data: 'd' },
            { mime_type: 'image/jpeg', data: 'e' },
          ],
          ''
        )
      ).rejects.toThrow('at most 4 images');
      await expect(
        localApi.extract([{ mime_type: 'application/pdf', data: 'dGVzdA==' }], '')
      ).rejects.toThrow('unsupported image type');
      await expect(
        localApi.extract([{ mime_type: 'image/jpeg', data: '' }], '')
      ).rejects.toThrow('empty image');
    });

    it('enforces extraction pause killswitch', async () => {
      await localApi.patchSettings({ gemini_api_key: 'test-key', extraction_paused: true });
      await expect(
        localApi.extract([{ mime_type: 'image/jpeg', data: 'dGVzdA==' }], '')
      ).rejects.toThrow('Extraction is paused');
    });

    it('enforces daily cap limit', async () => {
      await localApi.patchSettings({ gemini_api_key: 'test-key', extract_daily_cap: 1 });

      const fakeResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify([{ front: 'uno', back: 'jeden' }]) }],
            },
          },
        ],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(fakeResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      try {
        // First extraction succeeds and records usage
        const res1 = await localApi.extract([{ mime_type: 'image/jpeg', data: 'dGVzdA==' }], '');
        expect(res1.cards.length).toBe(1);

        // Second extraction hits daily cap
        await expect(
          localApi.extract([{ mime_type: 'image/jpeg', data: 'dGVzdA==' }], '')
        ).rejects.toThrow('Daily extraction limit reached');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('detects duplicate fronts and normalizes whitespace/casing', async () => {
      const unit = await localApi.createUnit('Unidad 9');
      const lesson = await localApi.createLesson(unit.id, '9.1 Animales');
      const existingCard = await localApi.createCard(lesson.id, {
        front: '  El   Gato  ',
        back: 'kot',
      });

      await localApi.patchSettings({ gemini_api_key: 'test-key' });

      const fakeResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    { front: 'el gato', back: 'kot domowy' },
                    { front: 'el perro', back: 'pies', example: 'El perro ladra.' },
                  ]),
                },
              ],
            },
          },
        ],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(fakeResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      try {
        const result = await localApi.extract([{ mime_type: 'image/jpeg', data: 'dGVzdA==' }], '');

        expect(result.cards.length).toBe(2);
        // First item is marked as duplicate
        expect(result.cards[0].front).toBe('el gato');
        expect(result.cards[0].existing_in).toBe('9.1 Animales');
        expect(result.cards[0].existing_card_id).toBe(existingCard.id);

        // Second item is new
        expect(result.cards[1].front).toBe('el perro');
        expect(result.cards[1].existing_in).toBeNull();
        expect(result.cards[1].existing_card_id).toBeNull();
        expect(result.cards[1].example).toBe('El perro ladra.');

        // Usage is recorded
        const settings = await localApi.settings();
        expect(settings.extractions_today).toBe(1);
        expect(settings.extractions_total).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('extract supports model override and persists winning model to settings', async () => {
      await localApi.patchSettings({ gemini_api_key: 'test-key', gemini_model: 'gemini-flash-latest' });

      let capturedUrl = '';
      const fakeResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify([{ front: 'luna', back: 'księżyc' }]) }],
            },
          },
        ],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify(fakeResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        const result = await localApi.extract(
          [{ mime_type: 'image/jpeg', data: 'dGVzdA==' }],
          '',
          undefined,
          { model: 'gemini-3.6-flash', skipRateLimit: true }
        );

        expect(result.cards.length).toBe(1);
        expect(result.cards[0].front).toBe('luna');
        expect(capturedUrl).toContain('models/gemini-3.6-flash:generateContent');

        // Check model was saved to settings
        const settings = await localApi.settings();
        expect(settings.gemini_model).toBe('gemini-3.6-flash');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('probeModel tests model responsiveness with configured key', async () => {
      await localApi.patchSettings({ gemini_api_key: 'test-key' });

      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
          status: 200,
        });
      };

      try {
        const probeRes = await localApi.probeModel?.('gemini-3.5-flash-lite');
        expect(probeRes?.ok).toBe(true);
        expect(probeRes?.status).toBe(200);
        expect(capturedUrl).toContain('models/gemini-3.5-flash-lite:generateContent');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('generate (Gemini prompt integration)', () => {
    it('requires Gemini API key', async () => {
      await expect(localApi.generate('Vocabulario de frutas')).rejects.toThrow(
        'Gemini API key is not configured'
      );
    });

    it('validates prompt input', async () => {
      await localApi.patchSettings({ gemini_api_key: 'test-key' });
      await expect(localApi.generate('   ')).rejects.toThrow('prompt cannot be empty');
    });

    it('enforces extraction pause killswitch', async () => {
      await localApi.patchSettings({ gemini_api_key: 'test-key', extraction_paused: true });
      await expect(localApi.generate('frutas')).rejects.toThrow(
        'Extraction is paused'
      );
    });

    it('enforces daily cap limit', async () => {
      await localApi.patchSettings({
        gemini_api_key: 'test-key',
        extraction_paused: false,
        extract_daily_cap: 1,
      });

      const fakeResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify([{ front: 'el té', back: 'herbata' }]) }],
            },
          },
        ],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(fakeResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      try {
        const res1 = await localApi.generate('bebidas');
        expect(res1.cards.length).toBe(1);

        await expect(localApi.generate('bebidas')).rejects.toThrow(
          'Daily extraction limit reached'
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('generates cards, detects duplicates against existing lessons, and records usage', async () => {
      const unit = await localApi.createUnit('Unidad 10');
      const lesson = await localApi.createLesson(unit.id, '10.1 Frutas');
      const existingCard = await localApi.createCard(lesson.id, {
        front: 'la manzana',
        back: 'jabłko',
      });

      await localApi.patchSettings({ gemini_api_key: 'test-key', extract_daily_cap: 50 });

      const fakeResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    { front: 'la manzana', back: 'jabłko' },
                    { front: 'el plátano', back: 'banan', example: 'Un plátano amarillo.' },
                  ]),
                },
              ],
            },
          },
        ],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(fakeResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      try {
        const res = await localApi.generate('frutas tropicales');
        expect(res.cards.length).toBe(2);

        // First card is recognized as duplicate
        expect(res.cards[0].front).toBe('la manzana');
        expect(res.cards[0].existing_in).toBe('10.1 Frutas');
        expect(res.cards[0].existing_card_id).toBe(existingCard.id);

        // Second card is new
        expect(res.cards[1].front).toBe('el plátano');
        expect(res.cards[1].existing_in).toBeNull();
        expect(res.cards[1].example).toBe('Un plátano amarillo.');

        // Usage is recorded in settings
        const settings = await localApi.settings();
        expect(settings.extractions_today).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('aiEditCards (batch editing with Gemini)', () => {
    it('validates prompt and card selection', async () => {
      await localApi.patchSettings({ gemini_api_key: 'test-key' });

      await expect(localApi.aiEditCards([1], '   ')).rejects.toThrow('prompt cannot be empty');
      await expect(localApi.aiEditCards([], 'add examples')).rejects.toThrow('no cards selected');
      await expect(
        localApi.aiEditCards(
          Array.from({ length: 201 }, (_, i) => i + 1),
          'add examples'
        )
      ).rejects.toThrow('too many cards (max 200)');
      await expect(localApi.aiEditCards([999999], 'add examples')).rejects.toThrow(
        'no valid cards found'
      );
    });

    it('filters out unchanged cards and computes diffs', async () => {
      const unit = await localApi.createUnit('Unidad 11');
      const lesson = await localApi.createLesson(unit.id, '11.1 Edits');

      const cardA = await localApi.createCard(lesson.id, {
        front: 'coche',
        back: 'auto',
      });
      const cardB = await localApi.createCard(lesson.id, {
        front: 'casa',
        back: 'dom',
      });

      await localApi.patchSettings({ gemini_api_key: 'test-key', extract_daily_cap: 50 });

      // Gemini returns Card A modified, but Card B identical to original
      const fakeResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    {
                      id: cardA.id,
                      front: 'el coche',
                      back: 'samochód',
                      example: 'El coche azul.',
                    },
                    {
                      id: cardB.id,
                      front: 'casa',
                      back: 'dom',
                    },
                  ]),
                },
              ],
            },
          },
        ],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(fakeResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      try {
        const res = await localApi.aiEditCards(
          [cardA.id, cardB.id],
          'Add definite articles and an example sentence'
        );

        expect(res.inspected).toBe(2);
        // Only cardA was changed, cardB was filtered out
        expect(res.edits.length).toBe(1);

        const edit = res.edits[0];
        expect(edit.card_id).toBe(cardA.id);
        expect(edit.front).toBe('el coche');
        expect(edit.orig_front).toBe('coche');
        expect(edit.back).toBe('samochód');
        expect(edit.orig_back).toBe('auto');
        expect(edit.example).toBe('El coche azul.');
        expect(edit.orig_example).toBeNull();
        expect(edit.lesson_name).toBe('11.1 Edits');

        // Usage counted as an extraction
        const settings = await localApi.settings();
        expect(settings.extractions_today).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
