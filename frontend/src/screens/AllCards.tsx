import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { BottomNav, Chip, Empty, ErrorBox, Fab, IconButton, Spinner, TopBar } from '../components/ui';
import { WordList } from '../components/WordRow';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { useSheets } from '../lib/sheets';
import { useStore } from '../lib/store';
import { setEditingCard } from '../sheets/Sheets';
import type { Card } from '../lib/types';

type Filter = 'due' | 'new' | 'hard' | 'all' | 'alpha';

export function AllCards() {
  const navigate = useNavigate();
  const { overview, settings } = useStore();
  const { openSheet } = useSheets();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    let alive = true;
    api
      .cards({ sort: 'due', limit: 5000 })
      .then((c) => alive && (setCards(c), setError(null)))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [overview]);

  const shown = useMemo(() => {
    if (!cards) return [];
    const needle = q.trim().toLowerCase();
    let list = cards.filter((c) => {
      if (filter === 'due' && c.status !== 'due') return false;
      if (filter === 'new' && c.status !== 'new') return false;
      if (filter === 'hard' && !(c.lapses > 0 || (c.reps > 0 && c.ease < 2))) return false;
      if (!needle) return true;
      return c.front.toLowerCase().includes(needle) || c.back.toLowerCase().includes(needle) || (c.example ?? '').toLowerCase().includes(needle);
    });
    if (filter === 'alpha') list = [...list].sort((a, b) => a.front.localeCompare(b.front, undefined, { sensitivity: 'base' }));
    return list;
  }, [cards, q, filter]);

  const counts = useMemo(() => {
    const c = cards ?? [];
    return { due: c.filter((x) => x.status === 'due').length, new: c.filter((x) => x.status === 'new').length, hard: c.filter((x) => x.lapses > 0 || (x.reps > 0 && x.ease < 2)).length };
  }, [cards]);

  const lessons = overview?.units.reduce((n, u) => n + u.lessons.length, 0) ?? 0;
  const dueTotal = (overview?.due ?? 0) + (overview?.new_available ?? 0);

  return (
    <div className="min-h-dvh bg-surface pb-36">
      <TopBar
        title="All cards"
        subtitle={overview ? `${plural(overview.total, 'card')} · ${plural(overview.units.length, 'unit')} · ${plural(lessons, 'lesson')}` : ' '}
        right={
          shown.length > 0 ? (
            <IconButton
              icon="edit"
              label="Edit cards with prompt"
              onClick={() =>
                navigate('/edit-cards', {
                  state: {
                    cardIds: shown.slice(0, 200).map((c) => c.id),
                    scopeLabel: q || filter !== 'all' ? `${shown.length} matching cards` : `All ${Math.min(shown.length, 200)} cards`,
                  },
                })
              }
            />
          ) : undefined
        }
      />
      <main className="max-w-app mx-auto px-margin-mobile pt-2">
        {error && <ErrorBox message={error} />}
        {!cards && !error && (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        )}
        {cards && cards.length === 0 && (
          <Empty icon="cards" title="No cards yet" text="Add cards from a photo of your textbook or type them in." />
        )}
        {cards && cards.length > 0 && (
          <>
            <label className="flex items-center gap-2.5 bg-surface-container rounded-full px-4 h-12 mb-3 text-on-surface-variant">
              <Icon name="search" size={20} />
              <input
                className="flex-1 bg-transparent outline-none text-[16px] text-on-surface placeholder:text-outline"
                placeholder={settings ? `Search ${settings.front_lang} or ${settings.back_lang}…` : 'Search…'}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoCapitalize="none"
              />
              {q && (
                <button type="button" aria-label="Clear" onClick={() => setQ('')}>
                  <Icon name="close" size={18} />
                </button>
              )}
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              <Chip on={filter === 'all'} onClick={() => setFilter('all')}>
                All {cards.length}
              </Chip>
              <Chip on={filter === 'due'} onClick={() => setFilter('due')}>
                Due {counts.due}
              </Chip>
              <Chip on={filter === 'new'} onClick={() => setFilter('new')}>
                New {counts.new}
              </Chip>
              <Chip on={filter === 'hard'} onClick={() => setFilter('hard')}>
                Hard {counts.hard}
              </Chip>
              <Chip on={filter === 'alpha'} onClick={() => setFilter('alpha')}>
                A–Z
              </Chip>
            </div>
            {shown.length === 0 ? (
              <p className="text-body-sm text-on-surface-variant text-center py-8">No cards match.</p>
            ) : (
              <WordList
                cards={shown}
                showLesson
                onPick={(c) => {
                  setEditingCard(c);
                  openSheet('card');
                }}
              />
            )}
          </>
        )}
      </main>
      {dueTotal > 0 && <Fab icon="play" label={`Study all ${dueTotal}`} onClick={() => navigate('/study?scope=all')} />}
      <BottomNav due={dueTotal} />
    </div>
  );
}
