import type { DraftAction, DraftRow } from './store';
import type { AiCardAddition, AiEditResponse } from './types';

export function rowAction(row: Pick<DraftRow, 'action'>): DraftAction {
  return row.action ?? 'edit';
}

/**
 * Convert an AI batch-edit response into Review rows.
 * Additions split/derived from an edited card are placed right after that card
 * so split pairs appear together during review.
 */
export function buildEditDraftRows(res: Pick<AiEditResponse, 'edits' | 'additions' | 'deletes'>): DraftRow[] {
  const edits = res.edits ?? [];
  const additions = res.additions ?? [];
  const deletes = res.deletes ?? [];

  const editedIds = new Set(edits.map((e) => e.card_id));
  const attachedAdds = new Map<number, AiCardAddition[]>();
  const standaloneAdds: AiCardAddition[] = [];

  for (const add of additions) {
    if (add.source_card_id != null && editedIds.has(add.source_card_id)) {
      const list = attachedAdds.get(add.source_card_id) ?? [];
      list.push(add);
      attachedAdds.set(add.source_card_id, list);
    } else {
      standaloneAdds.push(add);
    }
  }

  const rows: DraftRow[] = [];
  let key = 1;

  const pushAddition = (a: AiCardAddition) => {
    rows.push({
      action: 'add',
      front: a.front,
      back: a.back,
      example: a.example,
      confidence: 1,
      include: !a.existing_in,
      key: key++,
      lesson_id: a.lesson_id,
      lesson_name: a.lesson_name,
      source_front: a.source_front ?? null,
      existing_in: a.existing_in ?? null,
    });
  };

  for (const e of edits) {
    rows.push({
      action: 'edit',
      front: e.front,
      back: e.back,
      example: e.example,
      confidence: 1,
      include: true,
      key: key++,
      card_id: e.card_id,
      orig_front: e.orig_front,
      orig_back: e.orig_back,
      orig_example: e.orig_example,
      lesson_name: e.lesson_name,
    });
    const children = attachedAdds.get(e.card_id);
    if (children) {
      for (const a of children) pushAddition(a);
    }
  }

  for (const a of standaloneAdds) {
    pushAddition(a);
  }

  for (const d of deletes) {
    rows.push({
      action: 'delete',
      front: d.front,
      back: d.back,
      example: d.example,
      confidence: 1,
      include: true,
      key: key++,
      card_id: d.card_id,
      lesson_id: d.lesson_id,
      lesson_name: d.lesson_name,
    });
  }

  return rows;
}

export function partitionEditRows(rows: DraftRow[]) {
  const edits: DraftRow[] = [];
  const additions: DraftRow[] = [];
  const deletes: DraftRow[] = [];
  let incomplete = 0;

  for (const r of rows) {
    if (!r.include) continue;
    const act = rowAction(r);
    if (act === 'delete') {
      if (r.card_id != null) deletes.push(r);
      continue;
    }
    if (!r.front.trim() || !r.back.trim()) {
      incomplete += 1;
      continue;
    }
    if (act === 'add') {
      additions.push(r);
    } else if (r.card_id != null) {
      edits.push(r);
    }
  }

  return {
    edits,
    additions,
    deletes,
    incomplete,
    totalSelected: edits.length + additions.length + deletes.length,
  };
}

export function formatEditSubtitle(rows: DraftRow[]): string {
  let edits = 0;
  let additions = 0;
  let deletes = 0;
  for (const r of rows) {
    const act = rowAction(r);
    if (act === 'add') additions += 1;
    else if (act === 'delete') deletes += 1;
    else edits += 1;
  }
  const parts: string[] = [];
  if (edits > 0) parts.push(`${edits} ${edits === 1 ? 'edit' : 'edits'}`);
  if (additions > 0) parts.push(`${additions} new`);
  if (deletes > 0) parts.push(`${deletes} ${deletes === 1 ? 'delete' : 'deletes'}`);
  if (parts.length === 0) return 'No changes';
  return `${parts.join(' · ')} · review before saving`;
}

export function formatEditActionLabel(counts: { edits: number; additions: number; deletes: number }): string {
  const { edits, additions, deletes } = counts;
  const total = edits + additions + deletes;
  const nonZero = [edits > 0, additions > 0, deletes > 0].filter(Boolean).length;
  if (nonZero === 1) {
    if (edits > 0) return `Update ${edits} ${edits === 1 ? 'card' : 'cards'}`;
    if (additions > 0) return `Add ${additions} ${additions === 1 ? 'card' : 'cards'}`;
    return `Delete ${deletes} ${deletes === 1 ? 'card' : 'cards'}`;
  }
  return `Apply ${total} ${total === 1 ? 'change' : 'changes'}`;
}

export function formatEditToast(counts: { updated: number; created: number; deleted: number }): string {
  const parts: string[] = [];
  if (counts.updated > 0) parts.push(`${counts.updated} updated`);
  if (counts.created > 0) parts.push(`${counts.created} added`);
  if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);
  if (parts.length === 0) return 'No changes applied';
  if (parts.length === 1) {
    if (counts.updated > 0) return `${counts.updated} ${counts.updated === 1 ? 'card' : 'cards'} updated`;
    if (counts.created > 0) return `${counts.created} ${counts.created === 1 ? 'card' : 'cards'} added`;
    return `${counts.deleted} ${counts.deleted === 1 ? 'card' : 'cards'} deleted`;
  }
  return parts.join(', ');
}
