import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button, Empty, ErrorBox, Footer, GroupSelector, IconButton, Label, TopBar } from '../components/ui';
import { api } from '../lib/api';
import { short } from '../lib/format';
import { captureFlowStart, historyIdx, useSheets } from '../lib/sheets';
import { useStore, useTargetLesson, type Draft } from '../lib/store';

type Row = Draft['cards'][number];

export function Review() {
  const navigate = useNavigate();
  const { draft, setDraft, refresh, toast } = useStore();
  const { openPicker } = useSheets();
  const target = useTargetLesson();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNew = useRef(false);
  const [existing, setExisting] = useState<Map<string, string> | null>(null);

  useEffect(() => {
    if (focusNew.current && listRef.current) {
      focusNew.current = false;
      const inputs = listRef.current.querySelectorAll<HTMLInputElement>('input[data-front]');
      inputs[inputs.length - 1]?.focus();
    }
  });

  // Duplicate hints for rows the server did not annotate (pasted / typed rows).
  useEffect(() => {
    let alive = true;
    api
      .cards({ limit: 10000 })
      .then((cards) => {
        if (!alive) return;
        const m = new Map<string, string>();
        for (const c of cards) m.set(normalize(c.front), c.lesson_name);
        setExisting(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!draft) {
    return (
      <div className="min-h-dvh bg-surface">
        <TopBar title="Review" back onBack={() => navigate('/', { replace: true })} />
        <Empty icon="sparkle" title="Nothing to review" text="Take a photo or paste a list first." action={<Button onClick={() => navigate('/capture', { replace: true })}>Cards from photo</Button>} />
      </div>
    );
  }

  const rows = draft.cards;
  const update = (key: number, patch: Partial<Row>) => setDraft((d) => d && { ...d, cards: d.cards.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const remove = (key: number) => setDraft((d) => d && { ...d, cards: d.cards.filter((r) => r.key !== key) });
  const add = () => {
    focusNew.current = true;
    setDraft((d) => d && { ...d, cards: [...d.cards, { front: '', back: '', confidence: 1, include: true, key: Math.max(0, ...d.cards.map((c) => c.key)) + 1 }] });
  };
  const swap = () => {
    setDraft((d) => d && { ...d, cards: d.cards.map((r) => ({ ...r, front: r.back, back: r.front })) });
    toast('Front and back swapped');
  };

  const selected = rows.filter((r) => r.include && r.front.trim() && r.back.trim());
  const incomplete = rows.filter((r) => r.include && (!r.front.trim() || !r.back.trim())).length;

  const save = async () => {
    if (!target || selected.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.createCards(
        target.lesson.id,
        selected.map((r) => ({ front: r.front.trim(), back: r.back.trim(), example: r.example?.trim() || null })),
      );
      setDraft(null);
      void refresh();
      const lessonId = target.lesson.id;
      toast(`${res.created} ${res.created === 1 ? 'card' : 'cards'} saved to “${res.lesson.name}”`, { label: 'View', onClick: () => navigate(`/group/${lessonId}`) });
      // Drop the capture flow from history so Back does not re-open it.
      const idx = historyIdx();
      const start = draft.source === 'photo' ? captureFlowStart() : null;
      if (start !== null && start >= 1 && idx >= start) navigate(start - 1 - idx);
      else if (start === 0) navigate('/', { replace: true });
      else if (idx >= 1) navigate(-1);
      else navigate('/', { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const subtitle = `${rows.length} ${rows.length === 1 ? 'card' : 'cards'} found · tap any text to edit`;

  return (
    <div className="min-h-dvh bg-surface pb-32">
      <TopBar title="Review" subtitle={subtitle} back right={<IconButton icon="swap" label="Swap front/back for all" onClick={swap} />} />
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

        {rows.length === 0 && <Empty icon="sparkle" title="No cards found" text="Try a sharper photo, a tighter crop, or a different hint." />}

        <div ref={listRef} className="space-y-2.5">
          {rows.map((r) => (
            <ReviewRow key={r.key} row={r} onChange={(p) => update(r.key, p)} onRemove={() => remove(r.key)} existingIn={existing?.get(normalize(r.front))} />
          ))}
        </div>

        <button type="button" onClick={add} className="mt-3 w-full flex items-center justify-center gap-2 min-h-[52px] border-2 border-dashed border-outline-variant rounded-xl text-primary font-semibold text-label-lg">
          <Icon name="plus" size={20} strokeWidth={2.2} /> Add a card the model missed
        </button>

        <Label>Save to</Label>
        <GroupSelector unit={target?.unit.name} lesson={target?.lesson.name} onClick={() => openPicker()} />
        {incomplete > 0 && <p className="text-body-sm text-on-surface-variant mt-2">{incomplete} ticked {incomplete === 1 ? 'row is' : 'rows are'} missing a side and will be skipped.</p>}
        {error && (
          <div className="mt-4">
            <ErrorBox message={error} />
          </div>
        )}
      </main>
      <Footer>
        <Button className="flex-1" disabled={selected.length === 0 || saving || !target} onClick={() => void save()}>
          {saving ? 'Saving…' : `Save ${selected.length} ${selected.length === 1 ? 'card' : 'cards'} to “${target?.lesson.name ?? '…'}”`}
        </Button>
      </Footer>
    </div>
  );
}

function ReviewRow({ row, onChange, onRemove, existingIn }: { row: Row; onChange: (p: Partial<Row>) => void; onRemove: () => void; existingIn?: string | null }) {
  const low = row.confidence < 0.7;
  const dup = row.existing_in ?? existingIn;
  const input = 'w-full bg-surface-container-low rounded-[10px] px-3 min-h-[44px] text-[16px] text-on-surface border-2 border-transparent focus:border-primary focus:bg-surface-container-lowest outline-none placeholder:text-outline';
  return (
    <div className={`grid grid-cols-[40px_1fr_40px] gap-x-1.5 gap-y-2 items-center rounded-xl bg-surface-container-lowest shadow-card py-2.5 pl-1.5 pr-2 ${row.include ? '' : 'opacity-50'}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={row.include}
        aria-label="Include card"
        onClick={() => onChange({ include: !row.include })}
        className="w-10 h-10 flex items-center justify-center rounded-full"
      >
        <span className={`w-6 h-6 rounded-[7px] border-2 flex items-center justify-center ${row.include ? 'bg-primary-container border-primary-container text-on-primary' : 'border-outline'}`}>
          {row.include && <Icon name="check" size={16} strokeWidth={3} />}
        </span>
      </button>
      <div className="flex flex-col gap-1.5 min-w-0">
        <input data-front className={input} value={row.front} onChange={(e) => onChange({ front: e.target.value })} placeholder="front" autoCapitalize="none" />
        <input className={`${input} ${low ? 'border-secondary-container' : ''}`} value={row.back} onChange={(e) => onChange({ back: e.target.value })} placeholder="back" autoCapitalize="none" />
        {row.example !== undefined && row.example !== null && (
          <input className={`${input} text-body-sm min-h-[40px]`} value={row.example} onChange={(e) => onChange({ example: e.target.value })} placeholder="example sentence" />
        )}
      </div>
      <button type="button" aria-label="Remove" onClick={onRemove} className="w-10 h-10 rounded-full flex items-center justify-center text-on-surface-variant">
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
    </div>
  );
}

function normalize(s: string): string {
  return s.trim().toLowerCase().split(/\s+/).join(' ');
}
