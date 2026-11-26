import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button, Empty, ErrorBox, Footer, GroupSelector, IconButton, Label, TopBar } from '../components/ui';
import { api } from '../lib/api';
import { formatEditActionLabel, formatEditSubtitle, formatEditToast, partitionEditRows, rowAction } from '../lib/batchEdit';
import { short } from '../lib/format';
import { captureFlowStart, historyIdx, useSheets } from '../lib/sheets';
import { useStore, useTargetLesson, type DraftRow } from '../lib/store';

type Row = DraftRow;

export function Review() {
  const navigate = useNavigate();
  const { draft, setDraft, refresh, toast } = useStore();
  const { openPicker } = useSheets();
  const target = useTargetLesson();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNew = useRef(false);
  const [existing, setExisting] = useState<Map<string, { id: number; lesson: string }[]> | null>(null);

  useEffect(() => {
    if (focusNew.current && listRef.current) {
      focusNew.current = false;
      const inputs = listRef.current.querySelectorAll<HTMLInputElement>('input[data-front]');
      inputs[inputs.length - 1]?.focus();
    }
  });

  // Duplicate hints for rows the server did not annotate (pasted / typed / manually added rows).
  useEffect(() => {
    let alive = true;
    api
      .cards({ limit: 10000 })
      .then((cards) => {
        if (!alive) return;
        const m = new Map<string, { id: number; lesson: string }[]>();
        for (const c of cards) {
          const norm = normalize(c.front);
          const list = m.get(norm) ?? [];
          list.push({ id: c.id, lesson: c.lesson_name });
          m.set(norm, list);
        }
        setExisting(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const deletingIds = useMemo(() => {
    if (!draft || draft.source !== 'edit') return new Set<number>();
    return new Set(
      draft.cards
        .filter((r) => r.include && rowAction(r) === 'delete' && r.card_id != null)
        .map((r) => r.card_id!),
    );
  }, [draft]);

  if (!draft) {
    return (
      <div className="min-h-dvh bg-surface">
        <TopBar title="Review" back onBack={() => navigate('/', { replace: true })} />
        <Empty icon="sparkle" title="Nothing to review" text="Take a photo or paste a list first." action={<Button onClick={() => navigate('/capture', { replace: true })}>Cards from photo</Button>} />
      </div>
    );
  }

  const isEdit = draft.source === 'edit';
  const isPrompt = draft.source === 'prompt';

  const rows = draft.cards;
  const update = (key: number, patch: Partial<Row>) => setDraft((d) => d && { ...d, cards: d.cards.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const remove = (key: number) => setDraft((d) => d && { ...d, cards: d.cards.filter((r) => r.key !== key) });
  const add = () => {
    focusNew.current = true;
    setDraft((d) => {
      if (!d) return d;
      const nextKey = Math.max(0, ...d.cards.map((c) => c.key)) + 1;
      const base: Row = { front: '', back: '', confidence: 1, include: true, key: nextKey };
      if (d.source === 'edit') {
        base.action = 'add';
        base.lesson_id = d.editLessonId ?? target?.lesson.id ?? null;
        base.lesson_name = d.editLessonId ? null : (target?.lesson.name ?? null);
      }
      return { ...d, cards: [...d.cards, base] };
    });
  };
  const swap = () => {
    setDraft((d) => d && { ...d, cards: d.cards.map((r) => ({ ...r, front: r.back, back: r.front })) });
    toast('Front and back swapped');
  };

  const editPart = isEdit ? partitionEditRows(rows) : null;
  const selected = isEdit ? [] : rows.filter((r) => r.include && r.front.trim() && r.back.trim());
  const incomplete = isEdit
    ? editPart!.incomplete
    : rows.filter((r) => r.include && (!r.front.trim() || !r.back.trim())).length;

  const hasUnassignedAdditions = Boolean(
    isEdit && editPart!.additions.some((r) => !r.lesson_id && !draft.editLessonId),
  );
  const canSaveEdit = Boolean(
    isEdit && editPart!.totalSelected > 0 && (!hasUnassignedAdditions || Boolean(target)),
  );
  const onlyDeletesSelected = Boolean(
    isEdit && editPart!.deletes.length > 0 && editPart!.edits.length === 0 && editPart!.additions.length === 0,
  );

  const existingLessonFor = (front: string): string | undefined => {
    const entries = existing?.get(normalize(front));
    if (!entries) return undefined;
    return entries.find((e) => !deletingIds.has(e.id))?.lesson;
  };

  const save = async () => {
    if (isEdit) {
      if (!canSaveEdit || !editPart) return;
    } else {
      if (selected.length === 0 || !target) return;
    }
    setSaving(true);
    setError(null);
    let mutated = false;
    try {
      if (isEdit && editPart) {
        let updated = 0;
        let created = 0;
        let deleted = 0;

        if (editPart.edits.length > 0) {
          const res = await api.updateCardsBulk(
            editPart.edits.map((r) => ({
              id: r.card_id!,
              front: r.front.trim(),
              back: r.back.trim(),
              example: r.example?.trim() || null,
            })),
          );
          updated = res.updated;
          mutated = true;
        }

        if (editPart.additions.length > 0) {
          const byLesson = new Map<number, Row[]>();
          for (const r of editPart.additions) {
            const lessonId = r.lesson_id ?? draft.editLessonId ?? target!.lesson.id;
            const group = byLesson.get(lessonId) ?? [];
            group.push(r);
            byLesson.set(lessonId, group);
          }
          for (const [lessonId, group] of byLesson) {
            const res = await api.createCards(
              lessonId,
              group.map((r) => ({
                front: r.front.trim(),
                back: r.back.trim(),
                example: r.example?.trim() || null,
              })),
            );
            created += res.created;
            mutated = true;
          }
        }

        if (editPart.deletes.length > 0) {
          const res = await api.deleteCardsBulk(editPart.deletes.map((r) => r.card_id!));
          deleted = res.deleted;
          mutated = true;
        }

        setDraft(null);
        void refresh();
        toast(formatEditToast({ updated, created, deleted }));
      } else {
        const res = await api.createCards(
          target!.lesson.id,
          selected.map((r) => ({ front: r.front.trim(), back: r.back.trim(), example: r.example?.trim() || null })),
        );
        setDraft(null);
        void refresh();
        const lessonId = target!.lesson.id;
        toast(`${res.created} ${res.created === 1 ? 'card' : 'cards'} saved to “${res.lesson.name}”`, { label: 'View', onClick: () => navigate(`/group/${lessonId}`) });
      }

      // Drop the capture/edit flow from history so Back does not re-open it.
      const idx = historyIdx();
      const start = (draft.source === 'photo' || draft.source === 'prompt' || draft.source === 'edit') ? captureFlowStart() : null;
      if (start !== null && start >= 1 && idx >= start) navigate(start - 1 - idx);
      else if (start === 0) navigate('/', { replace: true });
      else if (idx >= 1) navigate(-1);
      else navigate('/', { replace: true });
    } catch (e) {
      if (mutated) void refresh();
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const subtitle = isEdit
    ? formatEditSubtitle(rows)
    : `${rows.length} ${rows.length === 1 ? 'card' : 'cards'} found · tap any text to edit`;

  return (
    <div className="min-h-dvh bg-surface pb-32">
      <TopBar
        title={isEdit ? 'Review changes' : 'Review'}
        subtitle={subtitle}
        back
        right={!isEdit ? <IconButton icon="swap" label="Swap front/back for all" onClick={swap} /> : undefined}
      />
      <main className="max-w-app mx-auto px-margin-mobile pt-2">
        {draft.source === 'photo' && (
          <div className="flex gap-3 items-center rounded-xl bg-surface-container-lowest shadow-card p-3 mb-3">
            {draft.previewUrl ? (
              <img src={draft.previewUrl} alt="" className="w-14 h-14 rounded-[10px] object-cover bg-surface-container shrink-0" />
            ) : (
              <div className="w-14 h-14 rounded-[10px] bg-surface-container flex items-center justify-center text-on-surface-variant shrink-0">
                <Icon name="image" size={22} />
              </div>
            )}
            <div className="flex-1 min-w-0 text-body-sm text-on-surface-variant leading-snug">
              Hint: <i>“{draft.hint.trim() ? short(draft.hint.trim()) : 'no hint'}”</i>
              <br />
              <button type="button" className="text-primary font-semibold min-h-[40px]" onClick={() => navigate('/capture', { replace: true, state: { retry: true } })}>
                Not right? Edit hint &amp; retry
              </button>
            </div>
          </div>
        )}

        {(isPrompt || isEdit) && (
          <div className="flex gap-3 items-center rounded-xl bg-surface-container-lowest shadow-card p-3 mb-3">
            <div className="w-12 h-12 rounded-[10px] bg-primary-fixed text-on-primary-fixed-variant flex items-center justify-center shrink-0">
              <Icon name="sparkle" size={22} />
            </div>
            <div className="flex-1 min-w-0 text-body-sm text-on-surface-variant leading-snug">
              Prompt: <i>“{draft.hint.trim() ? short(draft.hint.trim()) : 'no prompt'}”</i>
              <br />
              <button
                type="button"
                className="text-primary font-semibold min-h-[40px]"
                onClick={() =>
                  navigate(
                    isEdit ? `/edit-cards${draft.editLessonId ? `?lesson=${draft.editLessonId}` : ''}` : '/prompt',
                    { replace: true, state: { retry: true, cardIds: draft.editCardIds, scopeLabel: draft.editScopeLabel } }
                  )
                }
              >
                Not right? Edit prompt &amp; retry
              </button>
            </div>
          </div>
        )}

        {rows.length === 0 && <Empty icon="sparkle" title={isEdit ? 'No pending changes' : 'No cards found'} text={isEdit ? 'All suggested changes were dismissed.' : 'Try a sharper photo, a tighter crop, or a different hint.'} />}

        <div ref={listRef} className="space-y-2.5">
          {rows.map((r) => (
            <ReviewRow
              key={r.key}
              row={r}
              onChange={(p) => update(r.key, p)}
              onRemove={() => remove(r.key)}
              existingIn={existingLessonFor(r.front)}
              isEdit={isEdit}
              editLessonId={draft.editLessonId}
            />
          ))}
        </div>

        {!isEdit ? (
          <>
            <button type="button" onClick={add} className="mt-3 w-full flex items-center justify-center gap-2 min-h-[52px] border-2 border-dashed border-outline-variant rounded-xl text-primary font-semibold text-label-lg">
              <Icon name="plus" size={20} strokeWidth={2.2} /> Add a card the model missed
            </button>

            <Label>Save to</Label>
            <GroupSelector unit={target?.unit.name} lesson={target?.lesson.name} onClick={() => openPicker()} />
          </>
        ) : (
          <>
            {(draft.editLessonId || target) && (
              <button type="button" onClick={add} className="mt-3 w-full flex items-center justify-center gap-2 min-h-[52px] border-2 border-dashed border-outline-variant rounded-xl text-primary font-semibold text-label-lg">
                <Icon name="plus" size={20} strokeWidth={2.2} /> Add another card
              </button>
            )}
            {hasUnassignedAdditions && (
              <>
                <Label>Save new cards to</Label>
                <GroupSelector unit={target?.unit.name} lesson={target?.lesson.name} onClick={() => openPicker()} />
              </>
            )}
            <p className="text-body-sm text-on-surface-variant mt-3">Uncheck any item to skip it. Study progress is kept on edited cards.</p>
          </>
        )}

        {incomplete > 0 && <p className="text-body-sm text-on-surface-variant mt-2">{incomplete} ticked {incomplete === 1 ? 'row is' : 'rows are'} missing a side and will be skipped.</p>}
        {error && (
          <div className="mt-4">
            <ErrorBox message={error} />
          </div>
        )}
      </main>
      <Footer>
        {isEdit && editPart ? (
          <Button
            variant={onlyDeletesSelected ? 'danger' : 'primary'}
            className="flex-1"
            disabled={!canSaveEdit || saving}
            onClick={() => void save()}
          >
            {saving
              ? 'Applying…'
              : formatEditActionLabel({
                  edits: editPart.edits.length,
                  additions: editPart.additions.length,
                  deletes: editPart.deletes.length,
                })}
          </Button>
        ) : (
          <Button className="flex-1" disabled={selected.length === 0 || saving || !target} onClick={() => void save()}>
            {saving ? 'Saving…' : `Save ${selected.length} ${selected.length === 1 ? 'card' : 'cards'} to “${target?.lesson.name ?? '…'}”`}
          </Button>
        )}
      </Footer>
    </div>
  );
}

function ReviewRow({
  row,
  onChange,
  onRemove,
  existingIn,
  isEdit,
  editLessonId,
}: {
  row: Row;
  onChange: (p: Partial<Row>) => void;
  onRemove: () => void;
  existingIn?: string | null;
  isEdit?: boolean;
  editLessonId?: number;
}) {
  const action = isEdit ? rowAction(row) : 'add';
  const isDelete = isEdit && action === 'delete';
  const isAdd = isEdit && action === 'add';
  const isModify = isEdit && action === 'edit';
  const low = row.confidence < 0.7;
  const dup = (!isEdit || isAdd) ? (row.existing_in ?? existingIn) : null;
  const input = 'w-full bg-surface-container-low rounded-[10px] px-3 min-h-[44px] text-[16px] text-on-surface border-2 border-transparent focus:border-primary focus:bg-surface-container-lowest outline-none placeholder:text-outline';

  const badge = isDelete
    ? { label: 'Delete', cls: 'bg-again-container text-again' }
    : isAdd
      ? { label: 'New', cls: 'bg-good-container text-good' }
      : { label: 'Edit', cls: 'bg-primary-fixed text-on-primary-fixed-variant' };

  return (
    <div
      data-testid={isEdit ? `review-row-${action}` : 'review-row'}
      className={`grid grid-cols-[40px_1fr_40px] gap-x-1.5 gap-y-2 items-center rounded-xl bg-surface-container-lowest shadow-card py-2.5 pl-1.5 pr-2 ${
        isDelete && row.include ? 'ring-1 ring-again/40' : ''
      } ${row.include ? '' : 'opacity-50'}`}
    >
      {isEdit && (
        <div className="col-start-2 col-span-2 flex items-center gap-2 min-w-0 flex-wrap">
          <span className={`px-2 py-0.5 rounded-full text-label-sm font-bold shrink-0 ${badge.cls}`}>{badge.label}</span>
          {isAdd && row.source_front && (
            <span className="text-label-md text-on-surface-variant truncate">from {row.source_front}</span>
          )}
          {row.lesson_name && !editLessonId && (
            <span className="text-label-md text-outline truncate">in {row.lesson_name}</span>
          )}
        </div>
      )}
      <button
        type="button"
        role="checkbox"
        aria-checked={row.include}
        aria-label={isDelete ? 'Confirm delete' : 'Include card'}
        onClick={() => onChange({ include: !row.include })}
        className="w-10 h-10 flex items-center justify-center rounded-full"
      >
        <span
          className={`w-6 h-6 rounded-[7px] border-2 flex items-center justify-center ${
            row.include
              ? isDelete
                ? 'bg-again border-again text-on-error'
                : 'bg-primary-container border-primary-container text-on-primary'
              : 'border-outline'
          }`}
        >
          {row.include && <Icon name="check" size={16} strokeWidth={3} />}
        </span>
      </button>
      {isDelete ? (
        <div className="flex flex-col gap-0.5 min-w-0 py-1 px-1">
          <div className="text-body-md font-semibold text-on-surface line-through opacity-80 break-words">{row.front}</div>
          <div className="text-body-sm text-on-surface-variant line-through opacity-80 break-words">{row.back}</div>
          {row.example?.trim() && (
            <div className="text-body-sm italic text-on-surface-variant/80 line-through break-words mt-0.5">{row.example.trim()}</div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 min-w-0">
          <input data-front className={input} value={row.front} onChange={(e) => onChange({ front: e.target.value })} placeholder="front" autoCapitalize="none" />
          <input className={`${input} ${low ? 'border-secondary-container' : ''}`} value={row.back} onChange={(e) => onChange({ back: e.target.value })} placeholder="back" autoCapitalize="none" />
          {row.example !== undefined && row.example !== null ? (
            <input className={`${input} text-body-sm min-h-[40px]`} value={row.example} onChange={(e) => onChange({ example: e.target.value })} placeholder="example sentence" />
          ) : (
            <button type="button" onClick={() => onChange({ example: '' })} className="self-start text-label-md text-primary font-medium px-1">
              + example
            </button>
          )}
        </div>
      )}
      <button type="button" aria-label={isDelete ? 'Keep card' : 'Remove'} onClick={onRemove} className="w-10 h-10 rounded-full flex items-center justify-center text-on-surface-variant">
        <Icon name="close" size={20} />
      </button>
      {low && (
        <div className="col-start-2 col-span-2 text-label-md text-secondary flex items-center gap-1.5">
          <Icon name="warning" size={14} strokeWidth={2.5} /> Low confidence – check this one
        </div>
      )}
      {dup && (
        <div className="col-start-2 col-span-2 text-label-md text-on-surface-variant">
          Already in {dup}
          {row.include ? '' : ' – unchecked to avoid a duplicate'}
        </div>
      )}
      {isModify && (
        <div className="col-start-2 col-span-2 text-label-md text-on-surface-variant space-y-0.5">
          {row.orig_front !== undefined && (row.orig_front !== row.front || row.orig_back !== row.back) && (
            <div>
              Was: <span className="line-through opacity-80">{row.orig_front}</span> → <span className="line-through opacity-80">{row.orig_back}</span>
            </div>
          )}
          {row.orig_example && row.orig_example !== (row.example?.trim() || null) && (
            <div>
              Prev example: <span className="line-through opacity-80">{row.orig_example}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function normalize(s: string): string {
  return s.trim().toLowerCase().split(/\s+/).join(' ');
}
