import { describe, expect, it } from 'vitest';
import {
  buildEditDraftRows,
  formatEditActionLabel,
  formatEditSubtitle,
  formatEditToast,
  partitionEditRows,
  rowAction,
} from './batchEdit';

describe('batchEdit helpers', () => {
  it('buildEditDraftRows interleaves split additions after edited source cards and keeps standalone splits', () => {
    const rows = buildEditDraftRows({
      edits: [
        {
          card_id: 1,
          front: 'acostarse',
          back: 'kłaść się spać',
          example: 'Me acuesto tarde.',
          orig_front: 'acostarse',
          orig_back: 'iść spać',
          orig_example: null,
          lesson_name: 'Rutina',
        },
      ],
      additions: [
        {
          front: 'acostar',
          back: 'kłaść kogoś spać',
          example: 'Acuesto al niño.',
          lesson_id: 10,
          lesson_name: 'Rutina',
          source_card_id: 1,
          source_front: 'acostarse',
          existing_in: null,
        },
        {
          front: 'levantar',
          back: 'podnosić',
          example: 'Levanto la mano.',
          lesson_id: 10,
          lesson_name: 'Rutina',
          source_card_id: 2, // untouched card (not in edits)
          source_front: 'levantarse',
          existing_in: null,
        },
        {
          front: 'ser',
          back: 'być',
          example: null,
          lesson_id: 10,
          lesson_name: 'Rutina',
          source_card_id: null,
          source_front: null,
          existing_in: 'Verbos',
        },
      ],
      deletes: [
        {
          card_id: 9,
          front: 'viejo',
          back: 'stary',
          example: null,
          lesson_id: 10,
          lesson_name: 'Rutina',
        },
      ],
    });

    expect(rows.map((r) => [r.action, r.front, r.include])).toEqual([
      ['edit', 'acostarse', true],
      ['add', 'acostar', true],
      ['add', 'levantar', true],
      ['add', 'ser', false], // unchecked by default because existing_in is set
      ['delete', 'viejo', true],
    ]);
    expect(rows[1].source_front).toBe('acostarse');
    expect(rows[2].source_front).toBe('levantarse');
  });

  it('partitionEditRows separates edits, additions, deletes, and counts incomplete rows', () => {
    const rows = buildEditDraftRows({
      edits: [
        {
          card_id: 1,
          front: 'ser',
          back: 'być (cecha)',
          example: null,
          orig_front: 'ser',
          orig_back: 'być',
          orig_example: null,
          lesson_name: 'L1',
        },
      ],
      additions: [
        {
          front: 'levantar',
          back: '',
          example: null,
          lesson_id: 1,
          lesson_name: 'L1',
        },
        {
          front: 'correr',
          back: 'biegać',
          example: null,
          lesson_id: 1,
          lesson_name: 'L1',
        },
      ],
      deletes: [
        {
          card_id: 5,
          front: 'obsolete',
          back: 'stary',
          example: null,
          lesson_id: 1,
          lesson_name: 'L1',
        },
      ],
    });
    const part = partitionEditRows(rows);
    expect(part.edits.length).toBe(1);
    expect(part.additions.length).toBe(1);
    expect(part.deletes.length).toBe(1);
    expect(part.incomplete).toBe(1);
    expect(part.totalSelected).toBe(3);

    // Legacy rows without action default to 'edit'
    expect(rowAction({ action: undefined })).toBe('edit');
  });

  it('formats subtitle, button label, and toast cleanly for single and mixed changes', () => {
    const rows = buildEditDraftRows({
      edits: [
        {
          card_id: 1,
          front: 'a',
          back: 'b',
          example: null,
          orig_front: 'a',
          orig_back: 'x',
          orig_example: null,
          lesson_name: 'L',
        },
      ],
      additions: [
        { front: 'c', back: 'd', example: null, lesson_id: 1, lesson_name: 'L' },
        { front: 'e', back: 'f', example: null, lesson_id: 1, lesson_name: 'L' },
      ],
      deletes: [{ card_id: 2, front: 'g', back: 'h', example: null, lesson_id: 1, lesson_name: 'L' }],
    });

    expect(formatEditSubtitle(rows)).toBe('1 edit · 2 new · 1 delete · review before saving');
    expect(formatEditActionLabel({ edits: 2, additions: 0, deletes: 0 })).toBe('Update 2 cards');
    expect(formatEditActionLabel({ edits: 0, additions: 1, deletes: 0 })).toBe('Add 1 card');
    expect(formatEditActionLabel({ edits: 0, additions: 0, deletes: 3 })).toBe('Delete 3 cards');
    expect(formatEditActionLabel({ edits: 1, additions: 2, deletes: 1 })).toBe('Apply 4 changes');

    expect(formatEditToast({ updated: 1, created: 0, deleted: 0 })).toBe('1 card updated');
    expect(formatEditToast({ updated: 0, created: 2, deleted: 0 })).toBe('2 cards added');
    expect(formatEditToast({ updated: 0, created: 0, deleted: 1 })).toBe('1 card deleted');
    expect(formatEditToast({ updated: 1, created: 2, deleted: 1 })).toBe('1 updated, 2 added, 1 deleted');
  });
});
