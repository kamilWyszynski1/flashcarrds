import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WordList, WordRow } from './WordRow';
import type { Card } from '../lib/types';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 1,
    lesson_id: 1,
    lesson_name: 'Saludos',
    unit_id: 1,
    unit_name: 'Unidad 1',
    front: 'el café',
    back: 'kawa',
    example: 'Tomo un café solo por la mañana.',
    state: 0,
    status: 'new',
    due: 0,
    interval_days: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    last_review: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('WordRow / WordList', () => {
  it('hides example by default', () => {
    const html = renderToStaticMarkup(createElement(WordRow, { card: makeCard() }));
    expect(html).toContain('el café');
    expect(html).toContain('kawa');
    expect(html).not.toContain('word-row-example');
    expect(html).not.toContain('Tomo un café solo por la mañana.');
  });

  it('renders trimmed example when showExample is true', () => {
    const html = renderToStaticMarkup(
      createElement(WordRow, {
        card: makeCard({ example: '  Tomo un café solo por la mañana.  ' }),
        showExample: true,
      }),
    );
    expect(html).toContain('data-testid="word-row-example"');
    expect(html).toContain('>Tomo un café solo por la mañana.<');
  });

  it('omits example block when card.example is null or blank', () => {
    for (const example of [null, '', '   ']) {
      const html = renderToStaticMarkup(
        createElement(WordRow, {
          card: makeCard({ example }),
          showExample: true,
        }),
      );
      expect(html).not.toContain('word-row-example');
    }
  });

  it('WordList forwards showExample to all rendered cards', () => {
    const cards = [
      makeCard({ id: 1, front: 'el café', back: 'kawa', example: 'Un café, por favor.' }),
      makeCard({ id: 2, front: 'el agua', back: 'woda', example: null }),
    ];
    const html = renderToStaticMarkup(
      createElement(WordList, { cards, showExample: true, onPick: () => {} }),
    );
    expect(html).toContain('Un café, por favor.');
    expect(html.match(/data-testid="word-row-example"/g)?.length).toBe(1);
  });
});
