import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { Button, GroupSelector, Label, fieldClass } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { lessonMeta, unitShort } from '../lib/format';
import { parsePairs } from '../lib/paste';
import { peekNewGroupPreset, takePickHandler, useSheets, type SheetName } from '../lib/sheets';
import { useStore, useTargetLesson } from '../lib/store';
import type { Card } from '../lib/types';

/** Renders whichever sheet the URL hash names. */
export function SheetHost() {
  const { open } = useSheets();
  if (!open) return null;
  const map: Record<SheetName, JSX.Element> = {
    pickgroup: <PickGroupSheet />,
    newgroup: <NewGroupSheet />,
    card: <CardSheet />,
    addsource: <AddSourceSheet />,
    paste: <PasteSheet />,
    lessonmenu: <LessonMenuSheet />,
    unitmenu: <UnitMenuSheet />,
  };
  return map[open] ?? null;
}

// Transient "which lesson/unit/card is this sheet about" – set by the opener.
let menuTarget: { lessonId?: number; unitId?: number } = {};
export function setMenuTarget(t: { lessonId?: number; unitId?: number }) {
  menuTarget = t;
}
let editingCard: Card | null = null;
export function setEditingCard(c: Card | null) {
  editingCard = c;
}

// ---------------------------------------------------------------------------

function PickGroupSheet() {
  const { overview, targetLessonId, setTargetLessonId } = useStore();
  const { closeSheet, openNewGroup } = useSheets();
  const units = overview?.units ?? [];

  const pick = (id: number) => {
    const handler = takePickHandler();
    if (handler) handler(id);
    else setTargetLessonId(id);
    closeSheet();
  };

  return (
    <Sheet title="Save to…" onClose={closeSheet}>
      <button type="button" onClick={() => openNewGroup({ kind: 'lesson' }, { replace: true })} className="w-full flex items-center gap-3 min-h-[52px] px-1.5 rounded-xl text-left active:bg-surface-container-low">
        <span className="w-9 h-9 rounded-[10px] bg-primary-fixed text-on-primary-fixed-variant flex items-center justify-center">
          <Icon name="plus" size={20} strokeWidth={2.4} />
        </span>
        <span className="text-body-md font-semibold text-primary">New lesson or unit</span>
      </button>
      {units.length === 0 && <p className="text-body-sm text-on-surface-variant px-1.5 py-3">No groups yet – create your first unit and lesson above.</p>}
      {[...units].reverse().map((u) => (
        <div key={u.id}>
          <Label>{u.name}</Label>
          {u.lessons.length === 0 && <div className="text-body-sm text-on-surface-variant pl-6 py-2">No lessons yet</div>}
          {u.lessons.map((l) => {
            const sel = l.id === targetLessonId;
            return (
              <button key={l.id} type="button" onClick={() => pick(l.id)} className={`w-full flex items-center gap-3 min-h-[52px] pl-6 pr-1.5 rounded-xl text-left active:bg-surface-container-low ${sel ? 'bg-primary-fixed/40' : ''}`}>
                <span className={`w-9 h-9 rounded-[10px] flex items-center justify-center ${sel ? 'bg-primary-fixed text-on-primary-fixed-variant' : 'bg-surface-container text-on-surface-variant'}`}>
                  <Icon name="cards" size={20} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-body-md font-semibold text-on-surface truncate">{l.name}</span>
                  <span className="block text-label-sm text-on-surface-variant">{lessonMeta(l)}</span>
                </span>
                {sel && <Icon name="check" size={20} strokeWidth={2.5} className="text-primary" />}
              </button>
            );
          })}
        </div>
      ))}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function NewGroupSheet() {
  const { overview, refresh, setTargetLessonId, toast } = useStore();
  const { closeSheet } = useSheets();
  const preset = peekNewGroupPreset();
  const target = useTargetLesson();
  const units = overview?.units ?? [];
  const [kind, setKind] = useState<'lesson' | 'unit'>(units.length === 0 ? 'unit' : preset?.kind ?? 'lesson');
  const [name, setName] = useState('');
  const [unitId, setUnitId] = useState<number | null>(preset?.unitId ?? target?.unit.id ?? units[units.length - 1]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 320);
    return () => clearTimeout(t);
  }, []);

  const create = async () => {
    const n = name.trim();
    if (!n) {
      setErr('Give it a name first.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (kind === 'unit') {
        const u = await api.createUnit(n);
        await refresh();
        toast(`Created unit “${u.name}”`);
        // Follow up with a lesson inside the new unit – you almost always want one.
        setKind('lesson');
        setUnitId(u.id);
        setName('');
        setBusy(false);
        return;
      }
      if (unitId === null) {
        setErr('Create a unit first.');
        setBusy(false);
        return;
      }
      const l = await api.createLesson(unitId, n);
      await refresh();
      setTargetLessonId(l.id);
      const handler = takePickHandler();
      if (handler) handler(l.id);
      toast(`Created “${l.name}” in ${unitShort(units.find((u) => u.id === unitId)?.name ?? 'unit')}`);
      closeSheet();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const unitOptions = units.map((u) => ({ id: u.id, name: u.name }));

  return (
    <Sheet title="New group" onClose={closeSheet}>
      <div className="flex bg-surface-container rounded-full p-1 mb-1">
        {(['lesson', 'unit'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            disabled={k === 'lesson' && units.length === 0}
            className={`flex-1 min-h-[40px] rounded-full text-label-lg font-semibold transition-colors disabled:opacity-40 ${kind === k ? 'bg-surface-container-lowest text-on-surface shadow-card' : 'text-on-surface-variant'}`}
          >
            {k === 'lesson' ? 'Lesson' : 'Unit (chapter)'}
          </button>
        ))}
      </div>
      <Label>Name</Label>
      <input
        ref={inputRef}
        className={fieldClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void create()}
        placeholder={kind === 'lesson' ? 'e.g. 3.3 En el restaurante' : 'e.g. Unidad 4 · ¿Qué quieres hacer?'}
        enterKeyHint="done"
      />
      {kind === 'lesson' && (
        <>
          <Label>Inside unit</Label>
          <div className="relative">
            <select className={`${fieldClass} appearance-none pr-10`} value={unitId ?? ''} onChange={(e) => setUnitId(Number(e.target.value))}>
              {unitOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={20} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
          </div>
        </>
      )}
      <p className="text-body-sm text-on-surface-variant mt-2">Tip: mirror your book – units contain lessons, lessons contain cards.</p>
      {err && <p className="text-body-sm text-error mt-2">{err}</p>}
      <div className="flex gap-2.5 mt-5">
        <Button variant="outline" className="flex-1" onClick={closeSheet}>
          Cancel
        </Button>
        <Button className="flex-[2]" onClick={() => void create()} disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function CardSheet() {
  const { settings, cardDraft, setCardDraft, refresh, toast, overview } = useStore();
  const { closeSheet, openPicker } = useSheets();
  const target = useTargetLesson();
  const editing = editingCard;
  // Opening the group picker unmounts this sheet, so the chosen lesson is kept
  // in the store draft rather than in component state.
  const lessonId: number | null = cardDraft.lessonId ?? editing?.lesson_id ?? target?.lesson.id ?? null;
  const setLessonId = (id: number) => setCardDraft((d) => ({ ...d, lessonId: id }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const frontRef = useRef<HTMLInputElement>(null);

  // Seed the draft from the card being edited (once).
  useEffect(() => {
    if (editing && cardDraft.id !== editing.id) {
      setCardDraft({ id: editing.id, front: editing.front, back: editing.back, example: editing.example ?? '', lessonId: editing.lesson_id });
    } else if (!editing && cardDraft.id !== undefined) {
      setCardDraft({ front: '', back: '', example: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!editing) {
      const t = setTimeout(() => frontRef.current?.focus({ preventScroll: true }), 320);
      return () => clearTimeout(t);
    }
  }, [editing]);

  const lessonInfo = useMemo(() => {
    for (const u of overview?.units ?? []) {
      const l = u.lessons.find((x) => x.id === lessonId);
      if (l) return { unit: u.name, lesson: l.name };
    }
    return null;
  }, [overview, lessonId]);

  const save = async (next: boolean) => {
    const front = cardDraft.front.trim();
    const back = cardDraft.back.trim();
    if (!front || !back) {
      setErr('Both sides are required.');
      return;
    }
    if (lessonId === null) {
      setErr('Pick a lesson to save into.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (editing) {
        await api.updateCard(editing.id, { front, back, example: cardDraft.example.trim(), lesson_id: lessonId });
        toast('Card updated');
      } else {
        await api.createCard(lessonId, { front, back, example: cardDraft.example.trim() || null });
        toast(`Saved to ${lessonInfo?.lesson ?? 'lesson'}${next ? ' · add another' : ''}`);
      }
      void refresh();
      setEditingCard(null);
      if (next) {
        // Keep the chosen lesson so the next card lands in the same place.
        setCardDraft({ front: '', back: '', example: '', lessonId });
        setBusy(false);
        frontRef.current?.focus();
      } else {
        setCardDraft({ front: '', back: '', example: '' });
        closeSheet();
      }
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!confirm(`Delete “${editing.front}”?`)) return;
    setBusy(true);
    try {
      await api.deleteCard(editing.id);
      toast('Card deleted');
      setEditingCard(null);
      setCardDraft({ front: '', back: '', example: '' });
      void refresh();
      closeSheet();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const resetProgress = async () => {
    if (!editing) return;
    if (!confirm('Forget the review history of this card and treat it as new?')) return;
    try {
      await api.updateCard(editing.id, { reset_progress: true });
      toast('Progress reset');
      void refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const close = () => {
    setEditingCard(null);
    closeSheet();
  };

  return (
    <Sheet title={editing ? 'Edit card' : 'New card'} onClose={close}>
      <Label>{settings?.front_lang ?? 'Front'} (front)</Label>
      <input ref={frontRef} className={fieldClass} value={cardDraft.front} onChange={(e) => setCardDraft((d) => ({ ...d, front: e.target.value }))} placeholder="la ventana" autoCapitalize="none" enterKeyHint="next" />
      <Label>{settings?.back_lang ?? 'Back'} (back)</Label>
      <input className={fieldClass} value={cardDraft.back} onChange={(e) => setCardDraft((d) => ({ ...d, back: e.target.value }))} placeholder="okno" autoCapitalize="none" enterKeyHint="next" />
      <Label optional>Example</Label>
      <input
        className={fieldClass}
        value={cardDraft.example}
        onChange={(e) => setCardDraft((d) => ({ ...d, example: e.target.value }))}
        placeholder="Abre la ventana, por favor."
        enterKeyHint="done"
        onKeyDown={(e) => e.key === 'Enter' && void save(false)}
      />
      <Label>Group</Label>
      <GroupSelector compact unit={lessonInfo?.unit} lesson={lessonInfo?.lesson} onClick={() => openPicker((id) => setLessonId(id))} />
      {editing && (
        <div className="flex gap-4 mt-3 text-label-lg">
          <button type="button" className="text-error font-semibold min-h-[40px]" onClick={() => void remove()}>
            Delete card
          </button>
          <button type="button" className="text-on-surface-variant font-semibold min-h-[40px]" onClick={() => void resetProgress()}>
            Reset progress
          </button>
        </div>
      )}
      {err && <p className="text-body-sm text-error mt-2">{err}</p>}
      <div className="flex gap-2.5 mt-5">
        <Button variant="outline" className="flex-1" onClick={close}>
          Cancel
        </Button>
        {!editing && (
          <Button variant="tonal" className="flex-1" onClick={() => void save(true)} disabled={busy}>
            Save + next
          </Button>
        )}
        <Button className="flex-1" onClick={() => void save(false)} disabled={busy}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function AddSourceSheet() {
  const { closeSheet, openSheet } = useSheets();
  const navigate = useNavigate();
  const target = useTargetLesson();
  const go = (fn: () => void) => {
    // Replace the sheet entry so back from the next screen skips the menu.
    fn();
  };
  const Opt = ({ icon, title, text, onClick, accent }: { icon: 'camera' | 'edit' | 'list'; title: string; text: string; onClick: () => void; accent?: boolean }) => (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3 min-h-[60px] px-1.5 rounded-xl text-left active:bg-surface-container-low">
      <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${accent ? 'bg-primary-fixed text-on-primary-fixed-variant' : 'bg-surface-container text-on-surface-variant'}`}>
        <Icon name={icon} size={22} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-body-md font-semibold text-on-surface">{title}</span>
        <span className="block text-body-sm text-on-surface-variant">{text}</span>
      </span>
      <Icon name="chevronRight" size={20} className="text-outline-variant" />
    </button>
  );
  return (
    <Sheet title={target ? `Add to ${target.lesson.name}` : 'Add cards'} onClose={closeSheet}>
      <Opt icon="camera" accent title="From a photo" text="Snap the book page, review, save" onClick={() => go(() => navigate('/capture', { replace: true }))} />
      <Opt icon="edit" title="Type a card" text="One word at a time" onClick={() => go(() => { setEditingCard(null); openSheet('card', { replace: true }); })} />
      <Opt icon="list" title="Paste a list" text="“palabra – słowo” per line" onClick={() => go(() => openSheet('paste', { replace: true }))} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function PasteSheet() {
  const { closeSheet } = useSheets();
  const { setDraft } = useStore();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const parsed = useMemo(() => parsePairs(text), [text]);
  const ok = parsed.filter((c) => c.back).length;

  const review = () => {
    setDraft({ source: 'paste', hint: '', cards: parsed.map((c, i) => ({ ...c, include: !!c.back, key: i + 1 })) });
    navigate('/review', { replace: true });
  };

  return (
    <Sheet title="Paste a list" onClose={closeSheet}>
      <p className="text-body-sm text-on-surface-variant">One card per line, front and back separated by “–”, “-”, “;”, “:” or a tab. A third part becomes the example sentence.</p>
      <textarea className={`${fieldClass} mt-3 min-h-[160px]`} rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'la ventana – okno\nla puerta – drzwi – Abre la puerta.'} autoCapitalize="none" />
      <div className="text-body-sm text-on-surface-variant mt-2">
        {parsed.length === 0 ? 'Nothing to import yet.' : `${ok} of ${parsed.length} lines look like pairs${ok < parsed.length ? ' – the rest can be fixed on the next screen' : ''}.`}
      </div>
      <div className="flex gap-2.5 mt-5">
        <Button variant="outline" className="flex-1" onClick={closeSheet}>
          Cancel
        </Button>
        <Button className="flex-[2]" onClick={review} disabled={parsed.length === 0}>
          Review {parsed.length || ''} cards
        </Button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function LessonMenuSheet() {
  const { overview, refresh, toast } = useStore();
  const { closeSheet } = useSheets();
  const navigate = useNavigate();
  const id = menuTarget.lessonId;
  const lesson = overview?.units.flatMap((u) => u.lessons).find((l) => l.id === id);
  const units = overview?.units ?? [];
  const [name, setName] = useState(lesson?.name ?? '');
  const [unitId, setUnitId] = useState<number>(lesson?.unit_id ?? units[0]?.id ?? 0);
  const [err, setErr] = useState<string | null>(null);
  if (!lesson) return <Sheet onClose={closeSheet}>Lesson not found.</Sheet>;

  const save = async () => {
    try {
      await api.updateLesson(lesson.id, { name: name.trim(), unit_id: unitId });
      await refresh();
      toast('Lesson updated');
      closeSheet();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete “${lesson.name}” and its ${lesson.total} cards? This cannot be undone.`)) return;
    try {
      await api.deleteLesson(lesson.id);
      await refresh();
      toast('Lesson deleted');
      navigate('/', { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Sheet title="Lesson" onClose={closeSheet}>
      <Label>Name</Label>
      <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} />
      <Label>Inside unit</Label>
      <div className="relative">
        <select className={`${fieldClass} appearance-none pr-10`} value={unitId} onChange={(e) => setUnitId(Number(e.target.value))}>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={20} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
      </div>
      {err && <p className="text-body-sm text-error mt-2">{err}</p>}
      <div className="flex gap-2.5 mt-5">
        <Button variant="danger" className="px-4" icon="trash" onClick={() => void remove()} aria-label="Delete lesson" />
        <Button variant="outline" className="flex-1" onClick={closeSheet}>
          Cancel
        </Button>
        <Button className="flex-1" onClick={() => void save()} disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

function UnitMenuSheet() {
  const { overview, refresh, toast } = useStore();
  const { closeSheet } = useSheets();
  const unit = overview?.units.find((u) => u.id === menuTarget.unitId);
  const [name, setName] = useState(unit?.name ?? '');
  const [err, setErr] = useState<string | null>(null);
  if (!unit) return <Sheet onClose={closeSheet}>Unit not found.</Sheet>;

  const save = async () => {
    try {
      await api.renameUnit(unit.id, name.trim());
      await refresh();
      toast('Unit renamed');
      closeSheet();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete “${unit.name}” with ${unit.lessons.length} lessons and ${unit.total} cards? This cannot be undone.`)) return;
    try {
      await api.deleteUnit(unit.id);
      await refresh();
      toast('Unit deleted');
      closeSheet();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Sheet title="Unit" onClose={closeSheet}>
      <Label>Name</Label>
      <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} />
      {err && <p className="text-body-sm text-error mt-2">{err}</p>}
      <div className="flex gap-2.5 mt-5">
        <Button variant="danger" className="px-4" icon="trash" onClick={() => void remove()} aria-label="Delete unit" />
        <Button variant="outline" className="flex-1" onClick={closeSheet}>
          Cancel
        </Button>
        <Button className="flex-1" onClick={() => void save()} disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
