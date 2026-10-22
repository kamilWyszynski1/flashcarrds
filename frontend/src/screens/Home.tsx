import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge, BottomNav, Button, Card, Empty, ErrorBox, Fab, IconButton, Progress, Spinner, TopBar } from '../components/ui';
import { estimateMinutes, lessonMeta } from '../lib/format';
import { useSheets } from '../lib/sheets';
import { useStore } from '../lib/store';
import { setEditingCard, setMenuTarget } from '../sheets/Sheets';
import type { LessonOverview, UnitOverview } from '../lib/types';

export function Home() {
  const { overview, settings, loading, error, refresh } = useStore();
  const { openSheet, openNewGroup } = useSheets();
  const navigate = useNavigate();
  const [fabOpen, setFabOpen] = useState(false);

  const due = overview?.due ?? 0;
  const newAvail = overview?.new_available ?? 0;
  const todo = due + newAvail;

  return (
    <div className="min-h-dvh bg-surface pb-48">
      <TopBar
        leading={<img src="/icons/icon.svg" alt="" aria-hidden="true" className="h-8 w-8 rounded-lg" />}
        title={
          <span className="flex items-center gap-1.5">
            Fiszki <span className="text-outline-variant font-normal">•</span> <span className="text-label-md text-on-surface-variant font-medium">Groups</span>
          </span>
        }
        subtitle={settings ? `${settings.front_lang} → ${settings.back_lang}` : ' '}
        right={<IconButton icon="settings" label="Settings" onClick={() => navigate('/settings')} />}
      />

      <main className="max-w-app mx-auto px-margin-mobile pt-4 space-y-6">
        {error && <ErrorBox message={error} onRetry={() => void refresh()} />}
        {loading && !overview && (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        )}

        {overview && (
          <>
            {/* Due today hero */}
            <section className="relative overflow-hidden rounded-xl bg-surface-container-low shadow-card">
              <div className="p-5 relative z-10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      {todo > 0 && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary-container opacity-75" />}
                      <span className={`relative inline-flex rounded-full h-2 w-2 ${todo > 0 ? 'bg-secondary-container' : 'bg-tertiary-container'}`} />
                    </span>
                    <span className="text-label-sm text-secondary tracking-wider uppercase font-semibold">Repaso diario · Due today</span>
                  </div>
                  {overview.reviews_today > 0 && <span className="px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant text-label-sm">{overview.reviews_today} done today</span>}
                </div>
                <div className="mt-4 mb-2 flex items-baseline gap-1.5">
                  <span className="font-display text-flashcard-display-mobile text-on-surface font-bold">{todo}</span>
                  <span className="font-display text-headline-sm text-on-surface-variant font-medium">{todo === 1 ? 'fiszka' : 'fiszki'}</span>
                </div>
                <p className="text-body-sm text-on-surface-variant flex items-center gap-1.5 mb-5 flex-wrap">
                  {todo > 0 ? (
                    <>
                      <Icon name="clock" size={16} />
                      <span>≈ {estimateMinutes(todo)} min</span>
                      <span className="text-outline-variant">•</span>
                      <span>{newAvail} new</span>
                      <span className="text-outline-variant">•</span>
                      <span>{due} reviews</span>
                    </>
                  ) : overview.total === 0 ? (
                    <span>Add your first cards to start learning.</span>
                  ) : (
                    <span>All caught up – come back tomorrow or practise a group.</span>
                  )}
                </p>
                <Button size="lg" shape="rounded" className="w-full h-14" onClick={() => navigate('/study?scope=all')} disabled={todo === 0}>
                  <Icon name="play" size={20} fill="currentColor" strokeWidth={1.5} />
                  Study now
                </Button>
              </div>
              <div className="absolute -right-8 -bottom-10 w-44 h-44 rounded-full bg-primary-fixed/30 blur-2xl pointer-events-none" />
              <div className="absolute right-12 top-4 w-20 h-20 rounded-full bg-secondary-fixed/20 blur-xl pointer-events-none" />
            </section>

            {overview.units.length === 0 && (
              <Empty
                icon="book"
                title="No groups yet"
                text="Mirror your textbook: a unit (Unidad) contains lessons, lessons contain cards."
                action={
                  <Button icon="plus" onClick={() => openNewGroup({ kind: 'unit' })}>
                    Create first unit
                  </Button>
                }
              />
            )}

            <section className="flex flex-col space-y-6">
              {overview.units.map((u) => (
                <UnitBlock
                  key={u.id}
                  unit={u}
                  onLesson={(l) => navigate(`/group/${l.id}`)}
                  onMenu={() => {
                    setMenuTarget({ unitId: u.id });
                    openSheet('unitmenu');
                  }}
                  onAddLesson={() => openNewGroup({ kind: 'lesson', unitId: u.id })}
                />
              ))}
            </section>

            {overview.units.length > 0 && (
              <button type="button" onClick={() => openNewGroup({ kind: 'lesson' })} className="w-full flex items-center justify-center gap-2 min-h-[52px] border-2 border-dashed border-outline-variant rounded-xl text-primary font-semibold text-label-lg">
                <Icon name="plus" size={20} strokeWidth={2.2} /> New unit or lesson
              </button>
            )}
          </>
        )}
      </main>

      {/* FAB speed dial */}
      {fabOpen && <div className="fixed inset-0 z-30 bg-scrim/30 animate-fade-in" onClick={() => setFabOpen(false)} />}
      {fabOpen && (
        <div className="fixed z-40 right-4 bottom-[calc(4rem+env(safe-area-inset-bottom,0px)+5.5rem)] flex flex-col items-end gap-2.5 animate-toast-in">
          <SpeedDial
            icon="edit"
            label="Type a card"
            onClick={() => {
              setFabOpen(false);
              setEditingCard(null);
              openSheet('card');
            }}
          />
          <SpeedDial
            icon="list"
            label="Paste a list"
            onClick={() => {
              setFabOpen(false);
              openSheet('paste');
            }}
          />
          <SpeedDial
            icon="camera"
            label="From photo"
            onClick={() => {
              setFabOpen(false);
              navigate('/capture');
            }}
          />
        </div>
      )}
      {overview && overview.units.some((u) => u.lessons.length > 0) && (
        <Fab icon={fabOpen ? 'close' : 'plus'} label={fabOpen ? 'Close' : 'Add'} onClick={() => setFabOpen((o) => !o)} className="z-40" />
      )}
      <BottomNav due={todo} />
    </div>
  );
}

function SpeedDial({ icon, label, onClick }: { icon: 'edit' | 'camera' | 'list'; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2.5 bg-surface-container-lowest text-on-surface px-4 min-h-[48px] rounded-2xl shadow-float font-medium text-body-md">
      <Icon name={icon} size={22} className="text-primary" />
      {label}
    </button>
  );
}

function UnitBlock({ unit, onLesson, onMenu, onAddLesson }: { unit: UnitOverview; onLesson: (l: LessonOverview) => void; onMenu: () => void; onAddLesson: () => void }) {
  const done = unit.total > 0 && unit.due === 0 && unit.new === 0 && unit.learned === unit.total;
  return (
    <div className="flex flex-col space-y-2">
      <div className="flex items-center justify-between px-1 min-h-[40px]">
        <button type="button" onClick={onMenu} className="min-w-0 flex-1 text-left py-2">
          <span className="text-label-sm font-semibold tracking-wider text-on-surface-variant uppercase truncate block">{unit.name}</span>
        </button>
        {done ? (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-tertiary-container/15 text-tertiary text-label-sm font-medium shrink-0">
            <Icon name="check" size={14} strokeWidth={3} /> Done
          </span>
        ) : unit.due > 0 ? (
          <span className="text-label-sm text-on-surface-variant shrink-0">{unit.due} due</span>
        ) : unit.new > 0 ? (
          <span className="text-label-sm text-on-surface-variant shrink-0">{unit.new} new</span>
        ) : null}
      </div>
      {unit.lessons.length === 0 && (
        <button type="button" onClick={onAddLesson} className="text-left rounded-xl bg-surface-container-low px-4 py-3 text-body-sm text-on-surface-variant">
          No lessons yet – <span className="text-primary font-semibold">add one</span>
        </button>
      )}
      {unit.lessons.map((l) => {
        const progress = l.total === 0 ? 0 : l.learned / l.total;
        const notStarted = l.total > 0 && l.new === l.total;
        return (
          <Card key={l.id} className={`p-4 hover:shadow-md transition-shadow ${l.total === 0 ? 'opacity-80' : ''}`} onClick={() => onLesson(l)}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col min-w-0 flex-1">
                <span className="font-display text-headline-sm text-on-surface font-semibold truncate">{l.name}</span>
                <span className="text-body-sm text-on-surface-variant mt-0.5">{l.total === 0 ? 'Empty · add from a photo' : lessonMeta(l)}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {l.due > 0 ? <Badge tone="due">{l.due} due</Badge> : notStarted ? <Badge>New</Badge> : l.new > 0 ? <Badge tone="new">{l.new} new</Badge> : null}
                <Icon name="chevronRight" size={20} className="text-outline-variant" />
              </div>
            </div>
            {l.total > 0 && <Progress value={progress} className="mt-4" color={progress >= 1 ? 'bg-tertiary-container' : 'bg-primary-container'} />}
          </Card>
        );
      })}
    </div>
  );
}
