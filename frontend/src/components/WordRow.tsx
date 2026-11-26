import { cardStatusText, statusDot } from '../lib/format';
import type { Card } from '../lib/types';

export function WordRow({
  card,
  showLesson,
  showExample,
  onClick,
  now,
}: {
  card: Card;
  showLesson?: boolean;
  showExample?: boolean;
  onClick?: () => void;
  now?: number;
}) {
  const example = showExample ? card.example?.trim() : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex flex-col justify-center min-h-[56px] py-3 px-1 text-left border-b border-outline-variant/40 last:border-b-0 active:bg-surface-container-low"
    >
      <div className="w-full flex items-center gap-3">
        <i className={`w-2 h-2 rounded-full shrink-0 ${statusDot[card.status]}`} aria-label={card.status} />
        <div className="flex-1 min-w-0">
          <div className="text-body-md font-semibold text-on-surface truncate">{card.front}</div>
          <div className="text-body-sm text-on-surface-variant truncate">
            {card.back}
            {showLesson && <span className="opacity-80"> · {card.lesson_name}</span>}
          </div>
        </div>
        <span className="text-body-sm text-on-surface-variant shrink-0">{cardStatusText(card, now)}</span>
      </div>
      {example && (
        <div
          data-testid="word-row-example"
          className="mt-1.5 ml-5 pl-2.5 border-l-2 border-primary/30 text-body-sm italic text-on-surface-variant break-words"
        >
          {example}
        </div>
      )}
    </button>
  );
}

export function WordList({
  cards,
  showLesson,
  showExample,
  onPick,
  now,
}: {
  cards: Card[];
  showLesson?: boolean;
  showExample?: boolean;
  onPick: (c: Card) => void;
  now?: number;
}) {
  return (
    <div className="rounded-2xl bg-surface-container-lowest shadow-card px-3">
      {cards.map((c) => (
        <WordRow key={c.id} card={c} showLesson={showLesson} showExample={showExample} onClick={() => onPick(c)} now={now} />
      ))}
    </div>
  );
}
