import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Empty } from '../components/ui';
import { fmtDuration, plural } from '../lib/format';
import type { Summary as SummaryData } from '../lib/session';

interface State {
  summary: SummaryData;
  scopeLabel: string;
  scope?: string;
  mode?: string;
  ids?: string;
}

export function Summary() {
  const navigate = useNavigate();
  const state = useLocation().state as State | null;

  if (!state?.summary) {
    return <Empty icon="check" title="No session to summarise" action={<Button onClick={() => navigate('/', { replace: true })}>Back to groups</Button>} />;
  }
  const s = state.summary;
  const ring = `conic-gradient(rgb(var(--c-good)) 0 ${s.accuracy}%, rgb(var(--c-surface-container-highest)) ${s.accuracy}% 100%)`;
  const missedIds = s.missed.map((m) => m.cardId).join(',');

  return (
    <div className="min-h-dvh bg-surface flex flex-col items-center text-center px-6 pt-[calc(env(safe-area-inset-top,0px)+2rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] max-w-app mx-auto">
      <div className="w-[150px] h-[150px] rounded-full grid place-items-center mb-4" style={{ background: ring }}>
        <div className="w-[118px] h-[118px] rounded-full bg-surface grid place-items-center font-display text-[30px] font-bold text-on-surface">{s.accuracy}%</div>
      </div>
      <h2 className="font-display text-headline-md text-on-surface">Session done 🎉</h2>
      <div className="text-body-sm text-on-surface-variant mt-1">
        {state.scopeLabel} · {plural(s.total, 'card')} · {fmtDuration(s.durationMs)}
      </div>

      <div className="grid grid-cols-4 gap-2 w-full mt-5">
        <Stat n={s.counts.again} label="Again" cls="text-again" />
        <Stat n={s.counts.hard} label="Hard" cls="text-hard" />
        <Stat n={s.counts.good} label="Good" cls="text-good" />
        <Stat n={s.counts.easy} label="Easy" cls="text-easy" />
      </div>

      {s.missed.length > 0 && (
        <div className="w-full mt-5 rounded-2xl bg-surface-container-lowest shadow-card p-4 text-left">
          <div className="text-body-sm text-on-surface-variant mb-1.5">To revisit (marked “Again”)</div>
          {s.missed.map((m) => (
            <div key={m.cardId} className="py-2 border-b border-outline-variant/40 last:border-b-0 text-body-md">
              <span className="font-semibold text-on-surface">{m.front}</span> <span className="text-on-surface-variant">· {m.back}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2.5 w-full mt-auto pt-6">
        {s.missed.length > 0 && (
          <Button size="lg" onClick={() => navigate(`/study?ids=${missedIds}&label=${encodeURIComponent(`${state.scopeLabel} · again`)}`, { replace: true })}>
            Repeat the {s.missed.length} missed
          </Button>
        )}
        <Button variant="outline" onClick={() => navigate('/', { replace: true })}>
          Back to groups
        </Button>
      </div>
    </div>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div className="rounded-2xl bg-surface-container-lowest shadow-card py-2.5 px-1">
      <b className={`block text-[20px] ${cls}`}>{n}</b>
      <span className="text-label-sm text-on-surface-variant">{label}</span>
    </div>
  );
}
