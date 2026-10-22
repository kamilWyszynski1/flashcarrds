import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button, Chip, Empty, ErrorBox, Footer, IconButton, Progress, Spinner, TopBar } from '../components/ui';
import { WordList } from '../components/WordRow';
import { api } from '../lib/api';
import { plural, unitShort } from '../lib/format';
import { useSheets } from '../lib/sheets';
import { useStore } from '../lib/store';
import { setEditingCard, setMenuTarget } from '../sheets/Sheets';
import type { Card, LessonDetail } from '../lib/types';

type Filter = 'all' | 'due' | 'new' | 'learned' | 'hard';

export function GroupDetail() {
  const { id } = useParams();
  const lessonId = Number(id);
  const navigate = useNavigate();
  const { overview, setTargetLessonId, toast } = useStore();
  const { openSheet } = useSheets();
  const [detail, setDetail] = useState<LessonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    try {
      setDetail(await api.lesson(lessonId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [lessonId]);

  // Reload whenever the global overview changes (cards saved, reviews done…).
  useEffect(() => {
    void load();
  }, [load, overview]);

  // Visiting a group makes it the default target for new cards.
  useEffect(() => {
    if (detail) setTargetLessonId(detail.id);
  }, [detail, setTargetLessonId]);

  const cards = useMemo(() => {
    if (!detail) return [];
    const needle = q.trim().toLowerCase();
    return detail.cards.filter((c) => {
      if (filter === 'hard' ? !(c.lapses > 0 || (c.reps > 0 && c.ease < 2)) : filter !== 'all' && c.status !== filter) return false;
      if (!needle) return true;
      return c.front.toLowerCase().includes(needle) || c.back.toLowerCase().includes(needle) || (c.example ?? '').toLowerCase().includes(needle);
    });
  }, [detail, q, filter]);

  if (error) {
    return (
      <div className="min-h-dvh bg-surface">
        <TopBar title="Lesson" back />
        <div className="p-4">
          <ErrorBox message={error} onRetry={() => void load()} />
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="min-h-dvh bg-surface">
        <TopBar title=" " back />
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </div>
    );
  }

  // The study queue only hands out new cards within today's budget.
  const todo = detail.due + Math.min(detail.new, overview?.new_available ?? detail.new);
  const progress = detail.total === 0 ? 0 : detail.learned / detail.total;
  const openCard = (c: Card) => {
    setEditingCard(c);
    openSheet('card');
  };

  return (
    <div className="min-h-dvh bg-surface pb-32">
      <TopBar
        title={detail.name}
        subtitle={`${unitShort(detail.unit.name)} · ${plural(detail.total, 'card')}`}
        back
        onBack={() => navigate('/')}
        right={
          <IconButton
            icon="more"
            label="Rename, move or delete"
            onClick={() => {
              setMenuTarget({ lessonId: detail.id });
              openSheet('lessonmenu');
            }}
          />
        }
      />
      <main className="max-w-app mx-auto px-margin-mobile pt-2">
        {detail.total > 0 && (
          <div className="rounded-2xl bg-surface-container-lowest shadow-card p-4 mb-3">
            <Progress value={progress} className="h-2" color={progress >= 1 ? 'bg-tertiary-container' : 'bg-primary-container'} />
            <div className="text-body-sm text-on-surface-variant mt-2 flex gap-3 flex-wrap">
              <Dot cls="bg-primary" label={`${detail.new} new`} />
              <Dot cls="bg-secondary-container" label={`${detail.due} due`} />
              {detail.learning > 0 && <Dot cls="bg-secondary-container" label={`${detail.learning} learning`} />}
              <Dot cls="bg-tertiary-container" label={`${detail.learned} learned`} />
            </div>
          </div>
        )}

        {detail.total === 0 ? (
          <Empty
            icon="camera"
            title="This lesson is empty"
            text="Photograph the vocabulary box of this lesson, or type the first card."
            action={
              <div className="flex gap-2">
                <Button icon="camera" onClick={() => navigate('/capture')}>
                  From photo
                </Button>
                <Button variant="tonal" icon="edit" onClick={() => { setEditingCard(null); openSheet('card'); }}>
                  Type
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <label className="flex items-center gap-2.5 bg-surface-container rounded-full px-4 h-12 mb-3 text-on-surface-variant">
              <Icon name="search" size={20} />
              <input className="flex-1 bg-transparent outline-none text-[16px] text-on-surface placeholder:text-outline" placeholder="Search in this lesson" value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="none" />
              {q && (
                <button type="button" aria-label="Clear" onClick={() => setQ('')}>
                  <Icon name="close" size={18} />
                </button>
              )}
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              <Chip on={filter === 'all'} onClick={() => setFilter('all')}>
                All {detail.total}
              </Chip>
              <Chip on={filter === 'due'} onClick={() => setFilter('due')}>
                Due {detail.due}
              </Chip>
              <Chip on={filter === 'new'} onClick={() => setFilter('new')}>
                New {detail.new}
              </Chip>
              <Chip on={filter === 'learned'} onClick={() => setFilter('learned')}>
                Learned {detail.learned}
              </Chip>
              <Chip on={filter === 'hard'} onClick={() => setFilter('hard')}>
                Hard
              </Chip>
            </div>
            {cards.length === 0 ? <p className="text-body-sm text-on-surface-variant text-center py-8">No cards match.</p> : <WordList cards={cards} onPick={openCard} />}
            {cards.length > 0 && cards.length < detail.total && (
              <div className="pt-3 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (cards.length === 0) return;
                    navigate(`/study?ids=${cards.map((c) => c.id).join(',')}&label=${encodeURIComponent(`${detail.name} · ${filter}`)}`);
                  }}
                >
                  Practise these {cards.length}
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      {detail.total > 0 && (
        <Footer>
          <Button variant="tonal" className="px-4" icon="plus" onClick={() => openSheet('addsource')}>
            Add
          </Button>
          <Button
            className="flex-1"
            icon="play"
            onClick={() => {
              if (todo > 0) navigate(`/study?scope=lesson:${detail.id}`);
              else {
                toast('Nothing due – practising the whole lesson');
                navigate(`/study?scope=lesson:${detail.id}&mode=all`);
              }
            }}
          >
            {todo > 0 ? `Study ${todo} due & new` : 'Practise all'}
          </Button>
        </Footer>
      )}
    </div>
  );
}

function Dot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={`w-2 h-2 rounded-full ${cls}`} />
      {label}
    </span>
  );
}
