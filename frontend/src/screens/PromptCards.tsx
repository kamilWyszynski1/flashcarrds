import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button, Chip, ErrorBox, Footer, GroupSelector, Label, Spinner, TopBar, fieldClass } from '../components/ui';
import { api, isLocalBackend } from '../lib/api';
import { describeExtractError } from '../lib/extractError';
import { FREE_TIER_MODELS, MAX_EDIT_CARDS, runWithModelFallback, type FallbackProgress } from '../lib/gemini';
import { markCaptureFlowStart, useSheets } from '../lib/sheets';
import { useStore, useTargetLesson } from '../lib/store';
import type { Card, LessonDetail } from '../lib/types';

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
          done ? 'bg-primary-container text-on-primary' : 'border-2 border-outline-variant text-transparent'
        }`}
      >
        <Icon name="check" size={14} strokeWidth={3} />
      </span>
      <span className={done ? 'text-on-surface' : ''}>{children}</span>
    </div>
  );
}

const PROMPT_CHIPS = [
  { label: 'Present conjugation', text: 'All 6 persons in the present tense with subject pronouns.' },
  { label: 'With example sentence', text: 'Add a short example sentence for each card.' },
  { label: 'Nouns with article', text: 'Nouns with their article.' },
  { label: 'Add context in ()', text: 'Add brief disambiguating context in parentheses.' },
];

const PROMPT_KEY = 'fiszki.lastPrompt';
const CLIENT_TIMEOUT_MS = 60_000;

export function PromptCreate() {
  const navigate = useNavigate();
  const location = useLocation();
  const retry = Boolean((location.state as { retry?: boolean } | null)?.retry);
  const { settings, setSettings, setDraft, draft, toast } = useStore();
  const { openPicker } = useSheets();
  const target = useTargetLesson();

  const [prompt, setPrompt] = useState(() => (retry && draft?.source === 'prompt' ? draft.hint : localStorage.getItem(PROMPT_KEY) ?? ''));
  const [phase, setPhase] = useState<'idle' | 'generating'>('idle');
  const [error, setError] = useState<string | null>(null);

  const currentModel = settings?.gemini_model ?? 'gemini-flash-latest';
  const [selectedModel, setSelectedModel] = useState<string>(currentModel);
  const [activeModel, setActiveModel] = useState<string>(currentModel);
  const [probing, setProbing] = useState<string | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<FallbackProgress | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (settings?.gemini_model) {
      setSelectedModel(settings.gemini_model);
      setActiveModel(settings.gemini_model);
    }
  }, [settings?.gemini_model]);

  useEffect(() => {
    if (!retry) markCaptureFlowStart();
  }, [retry]);

  const toggleChip = (text: string) => {
    setPrompt((p) => {
      if (p.includes(text)) return p.replace(text, '').replace(/\s{2,}/g, ' ').trim();
      return `${p.trim()} ${text}`.trim();
    });
  };

  const modelOptions = [
    ...(!FREE_TIER_MODELS.some((m) => m.id === selectedModel)
      ? [{ id: selectedModel, label: `${selectedModel} (custom)` }]
      : []),
    ...FREE_TIER_MODELS,
  ];

  const handleModelChange = async (newModel: string) => {
    setSelectedModel(newModel);
    setActiveModel(newModel);
    try {
      const s = await api.patchSettings({ gemini_model: newModel });
      setSettings(s);
    } catch (e: any) {
      toast(e.message);
    }
  };

  const findResponsiveModel = async () => {
    if (!settings?.gemini_api_key_set) {
      setError(
        isLocalBackend
          ? 'Gemini API key is not configured – add your key in Settings.'
          : 'The server has no Gemini API key – set GEMINI_API_KEY in its .env and restart it.'
      );
      return;
    }
    setError(null);
    for (const m of FREE_TIER_MODELS) {
      setProbing(m.label);
      try {
        const res = await api.probeModel?.(m.id);
        if (res?.ok) {
          await handleModelChange(m.id);
          toast(`Switched to ${m.label} (${res.latencyMs} ms)`);
          setProbing(null);
          return;
        }
      } catch {}
    }
    setProbing(null);
    toast('All free-tier models appear busy or unreachable right now');
  };

  const generate = async (overrideModel?: string) => {
    if (!prompt.trim() || !target) return;
    if (!settings?.gemini_api_key_set) {
      setError(
        isLocalBackend
          ? 'Gemini API key is not configured – add your key in Settings.'
          : 'The server has no Gemini API key – set GEMINI_API_KEY in its .env and restart it.'
      );
      return;
    }
    const modelToUse = overrideModel ?? selectedModel;
    setActiveModel(modelToUse);
    setFallbackStatus(null);
    localStorage.setItem(PROMPT_KEY, prompt);
    setError(null);
    setPhase('generating');
    const ac = new AbortController();
    abortRef.current = ac;
    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, CLIENT_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await api.generate(prompt, ac.signal, { model: modelToUse });
      if (res.model && res.model !== settings.gemini_model) {
        void api.settings().then(setSettings);
      }
      setDraft({
        source: 'prompt',
        hint: prompt,
        model: res.model,
        cards: res.cards.map((c, i) => ({ ...c, include: !c.existing_in, key: i + 1 })),
      });
      if (res.cards.length === 0) toast('No cards generated – try a more specific prompt.');
      navigate('/review', { replace: retry });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (timedOut) setError(`No answer from Gemini after ${Math.round((Date.now() - started) / 1000)} s – try another model or "Auto-try free models".`);
        return;
      }
      setError(describeExtractError(e));
    } finally {
      clearTimeout(guard);
      setPhase('idle');
      abortRef.current = null;
    }
  };

  const generateTryingModels = async () => {
    if (!prompt.trim() || !target) return;
    if (!settings?.gemini_api_key_set) {
      setError(
        isLocalBackend
          ? 'Gemini API key is not configured – add your key in Settings.'
          : 'The server has no Gemini API key – set GEMINI_API_KEY in its .env and restart it.'
      );
      return;
    }
    localStorage.setItem(PROMPT_KEY, prompt);
    setError(null);
    setPhase('generating');
    const ac = new AbortController();
    abortRef.current = ac;

    const orderedModels = [
      selectedModel,
      ...FREE_TIER_MODELS.map((m) => m.id).filter((id) => id !== selectedModel),
    ];

    try {
      const res = await runWithModelFallback(
        (sig, opts) => api.generate(prompt, sig, opts),
        orderedModels,
        ac.signal,
        (progress) => {
          setActiveModel(progress.currentModel);
          setFallbackStatus(progress);
        }
      );
      if (res.model) {
        setSelectedModel(res.model);
        void api.settings().then(setSettings);
      }
      setDraft({
        source: 'prompt',
        hint: prompt,
        model: res.model,
        cards: res.cards.map((c, i) => ({ ...c, include: !c.existing_in, key: i + 1 })),
      });
      toast(`Generated with ${res.model}!`);
      if (res.cards.length === 0) toast('No cards generated – try a more specific prompt.');
      navigate('/review', { replace: retry });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        return;
      }
      setError(describeExtractError(e));
    } finally {
      setPhase('idle');
      setFallbackStatus(null);
      abortRef.current = null;
    }
  };

  const switchModelWhileGenerating = (newModel: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSelectedModel(newModel);
    setActiveModel(newModel);
    void api.patchSettings({ gemini_model: newModel }).then(setSettings);
    setTimeout(() => {
      void generate(newModel);
    }, 50);
  };

  const cancel = () => {
    abortRef.current?.abort();
    setPhase('idle');
    setFallbackStatus(null);
  };

  if (phase !== 'idle') {
    const currentLabel = FREE_TIER_MODELS.find((m) => m.id === activeModel)?.label ?? activeModel;
    return (
      <div className="min-h-dvh bg-surface flex flex-col items-center justify-center text-center px-6 py-10 max-w-app mx-auto">
        <Spinner className="w-16 h-16 border-[5px] mb-6" />
        <h2 className="font-display text-headline-md text-on-surface">Generating cards…</h2>
        <div className="text-body-sm text-on-surface-variant mt-1.5">
          {fallbackStatus
            ? `Trying free models: ${fallbackStatus.attemptIndex + 1} of ${fallbackStatus.totalModels}`
            : 'Usually 3–8 seconds · gives up after about 30 s'}
        </div>

        <div className="mt-6 flex flex-col gap-2.5 text-left text-body-md text-on-surface-variant w-full max-w-xs">
          <Step done>Prompt ready</Step>
          <Step done={phase === 'generating'}>Sending to API</Step>
          <Step done={false}>
            Trying <span className="font-semibold text-primary">{currentLabel}</span>…
          </Step>
        </div>

        {fallbackStatus && fallbackStatus.tried.length > 0 && (
          <div className="mt-4 p-3 bg-surface-container rounded-xl text-left text-body-sm text-on-surface-variant w-full max-w-xs space-y-1">
            <div className="font-medium text-label-sm uppercase tracking-wider text-outline mb-1.5">Previous attempts</div>
            {fallbackStatus.tried.map((t, idx) => (
              <div key={idx} className="text-label-md flex justify-between gap-2">
                <span className="truncate">{t.model}</span>
                <span className="text-error shrink-0">{t.error}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 w-full max-w-xs">
          <label className="text-label-sm text-on-surface-variant text-left block">
            Stuck? Switch model now:
            <div className="relative mt-1">
              <select
                value={selectedModel}
                onChange={(e) => switchModelWhileGenerating(e.target.value)}
                className={`${fieldClass} appearance-none pr-8 cursor-pointer text-body-sm py-2`}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-on-surface-variant">
                <Icon name="chevronDown" size={18} />
              </div>
            </div>
          </label>

          <Button variant="outline" onClick={cancel} className="w-full">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-surface pb-32">
      <TopBar title="Cards from prompt" back />
      <main className="max-w-app mx-auto px-margin-mobile pt-2">
        <Label>What flashcards to create</Label>
        <textarea
          className={fieldClass}
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. conjugation of ser verb in present tense, or common restaurant phrases"
        />

        <div className="flex flex-wrap gap-2 mt-2">
          {PROMPT_CHIPS.map((c) => (
            <Chip key={c.label} on={prompt.includes(c.text)} onClick={() => toggleChip(c.text)}>
              {c.label}
            </Chip>
          ))}
        </div>

        <Label>Save to</Label>
        <GroupSelector unit={target?.unit.name} lesson={target?.lesson.name} onClick={() => openPicker()} />
        <p className="text-body-sm text-on-surface-variant mt-1.5">You can still change the group on the review screen.</p>

        <Label>Gemini model</Label>
        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <select
              value={selectedModel}
              onChange={(e) => void handleModelChange(e.target.value)}
              className={`${fieldClass} appearance-none pr-8 cursor-pointer text-body-md`}
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-on-surface-variant">
              <Icon name="chevronDown" size={18} />
            </div>
          </div>
          {isLocalBackend && (
            <Button
              variant="tonal"
              className="shrink-0"
              onClick={() => void findResponsiveModel()}
              disabled={probing !== null}
            >
              {probing ? `Checking ${probing}…` : 'Find not-busy'}
            </Button>
          )}
        </div>

        {!settings?.gemini_api_key_set && (
          <div className="mt-3 p-3 bg-secondary-container/30 border border-secondary-container rounded-xl text-body-sm text-on-surface">
            <div className="font-semibold flex items-center gap-1.5 text-secondary">
              <Icon name="warning" size={16} /> Gemini API key needed
            </div>
            <p className="mt-1">
              {isLocalBackend ? (
                <>
                  Cards from prompt uses the free Gemini API.{' '}
                  <button
                    type="button"
                    className="text-primary font-semibold underline"
                    onClick={() => navigate('/settings')}
                  >
                    Add your free key in Settings
                  </button>
                  .
                </>
              ) : (
                'The server is missing GEMINI_API_KEY – add it to the server’s .env and restart it.'
              )}
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4">
            <ErrorBox message={error} />
          </div>
        )}
      </main>

      <Footer>
        <Button
          className="flex-1 min-w-0"
          icon="sparkle"
          disabled={!prompt.trim() || !target}
          onClick={() => void generate()}
        >
          Generate cards
        </Button>
        <Button
          variant="tonal"
          className="shrink-0"
          disabled={!prompt.trim() || !target}
          onClick={() => void generateTryingModels()}
        >
          Auto-try free models
        </Button>
      </Footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

const EDIT_CHIPS = [
  { label: 'Disambiguate (e.g. ser vs estar)', text: 'Add brief context in parentheses to differentiate easily confused words (e.g. ser vs estar).' },
  { label: 'Add example sentences', text: 'Add a short example sentence where missing.' },
  { label: 'Nouns with article', text: 'Ensure nouns include their definite article (el/la).' },
  { label: 'Subject pronouns', text: 'Add subject pronouns to conjugated verbs where ambiguous.' },
];

const EDIT_PROMPT_KEY = 'fiszki.lastEditPrompt';

export function BatchEdit() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const lessonIdParam = searchParams.get('lesson');
  const lessonId = lessonIdParam ? Number(lessonIdParam) : null;

  const state = location.state as { retry?: boolean; filteredIds?: number[]; cardIds?: number[]; scopeLabel?: string } | null;
  const retry = Boolean(state?.retry);
  const { settings, setSettings, setDraft, draft, toast } = useStore();

  const [prompt, setPrompt] = useState(() => (retry && draft?.source === 'edit' ? draft.hint : localStorage.getItem(EDIT_PROMPT_KEY) ?? ''));
  const [phase, setPhase] = useState<'idle' | 'editing'>('idle');
  const [error, setError] = useState<string | null>(null);

  const currentModel = settings?.gemini_model ?? 'gemini-flash-latest';
  const [selectedModel, setSelectedModel] = useState<string>(currentModel);
  const [activeModel, setActiveModel] = useState<string>(currentModel);
  const [probing, setProbing] = useState<string | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<FallbackProgress | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const [lessonDetail, setLessonDetail] = useState<LessonDetail | null>(null);
  const [loadedCards, setLoadedCards] = useState<Card[]>([]);
  const [scopeMode, setScopeMode] = useState<'filtered' | 'all'>('filtered');

  const filteredIds = state?.filteredIds ?? (retry && draft?.source === 'edit' && draft.editCardIds && lessonDetail && draft.editCardIds.length < lessonDetail.cards.length ? draft.editCardIds : undefined);
  const explicitCardIds = state?.cardIds ?? (retry && draft?.source === 'edit' ? draft.editCardIds : undefined);

  useEffect(() => {
    if (settings?.gemini_model) {
      setSelectedModel(settings.gemini_model);
      setActiveModel(settings.gemini_model);
    }
  }, [settings?.gemini_model]);

  useEffect(() => {
    if (!retry) markCaptureFlowStart();
  }, [retry]);

  useEffect(() => {
    let alive = true;
    if (lessonId) {
      api.lesson(lessonId)
        .then((l) => {
          if (!alive) return;
          setLessonDetail(l);
        })
        .catch((e) => {
          if (!alive) return;
          setError((e as Error).message);
        });
    } else if (explicitCardIds && explicitCardIds.length > 0) {
      api.cards({ limit: 5000 })
        .then((cards) => {
          if (!alive) return;
          const idSet = new Set(explicitCardIds);
          setLoadedCards(cards.filter((c) => idSet.has(c.id)));
        })
        .catch((e) => {
          if (!alive) return;
          setError((e as Error).message);
        });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId, explicitCardIds?.join(',')]);

  const hasFilterChoice = Boolean(lessonDetail && filteredIds && filteredIds.length > 0 && filteredIds.length < lessonDetail.cards.length);

  const scopedCards: Card[] = useMemo(() => {
    if (lessonDetail) {
      const cards = hasFilterChoice && scopeMode === 'filtered'
        ? lessonDetail.cards.filter((c) => filteredIds!.includes(c.id))
        : lessonDetail.cards;
      return cards.slice(0, MAX_EDIT_CARDS);
    }
    if (loadedCards.length > 0) {
      return loadedCards.slice(0, MAX_EDIT_CARDS);
    }
    return [];
  }, [lessonDetail, hasFilterChoice, scopeMode, filteredIds, loadedCards]);

  const scopeSubtitle = useMemo(() => {
    if (lessonDetail) {
      return `${scopedCards.length} ${scopedCards.length === 1 ? 'card' : 'cards'} in “${lessonDetail.name}”`;
    }
    if (state?.scopeLabel) {
      return state.scopeLabel;
    }
    if (draft?.editScopeLabel) {
      return draft.editScopeLabel;
    }
    return `${scopedCards.length} ${scopedCards.length === 1 ? 'card' : 'cards'}`;
  }, [lessonDetail, scopedCards.length, state?.scopeLabel, draft?.editScopeLabel]);

  const toggleChip = (text: string) => {
    setPrompt((p) => {
      if (p.includes(text)) return p.replace(text, '').replace(/\s{2,}/g, ' ').trim();
      return `${p.trim()} ${text}`.trim();
    });
  };

  const modelOptions = [
    ...(!FREE_TIER_MODELS.some((m) => m.id === selectedModel)
      ? [{ id: selectedModel, label: `${selectedModel} (custom)` }]
      : []),
    ...FREE_TIER_MODELS,
  ];

  const handleModelChange = async (newModel: string) => {
    setSelectedModel(newModel);
    setActiveModel(newModel);
    try {
      const s = await api.patchSettings({ gemini_model: newModel });
      setSettings(s);
    } catch (e: any) {
      toast(e.message);
    }
  };

  const findResponsiveModel = async () => {
    if (!settings?.gemini_api_key_set) {
      setError(
        isLocalBackend
          ? 'Gemini API key is not configured – add your key in Settings.'
          : 'The server has no Gemini API key – set GEMINI_API_KEY in its .env and restart it.'
      );
      return;
    }
    setError(null);
    for (const m of FREE_TIER_MODELS) {
      setProbing(m.label);
      try {
        const res = await api.probeModel?.(m.id);
        if (res?.ok) {
          await handleModelChange(m.id);
          toast(`Switched to ${m.label} (${res.latencyMs} ms)`);
          setProbing(null);
          return;
        }
      } catch {}
    }
    setProbing(null);
    toast('All free-tier models appear busy or unreachable right now');
  };

  const runEdit = async (overrideModel?: string) => {
    if (!prompt.trim() || scopedCards.length === 0) return;
    if (!settings?.gemini_api_key_set) {
      setError(
        isLocalBackend
          ? 'Gemini API key is not configured – add your key in Settings.'
          : 'The server has no Gemini API key – set GEMINI_API_KEY in its .env and restart it.'
      );
      return;
    }
    const modelToUse = overrideModel ?? selectedModel;
    setActiveModel(modelToUse);
    setFallbackStatus(null);
    localStorage.setItem(EDIT_PROMPT_KEY, prompt);
    setError(null);
    setPhase('editing');
    const ac = new AbortController();
    abortRef.current = ac;
    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, CLIENT_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await api.aiEditCards(
        scopedCards.map((c) => c.id),
        prompt,
        ac.signal,
        { model: modelToUse }
      );
      if (res.model && res.model !== settings.gemini_model) {
        void api.settings().then(setSettings);
      }
      if (res.edits.length === 0) {
        setError('No cards needed changes for that prompt – try making your instruction more specific.');
        return;
      }
      setDraft({
        source: 'edit',
        hint: prompt,
        model: res.model,
        editLessonId: lessonId ?? undefined,
        editCardIds: scopedCards.map((c) => c.id),
        editScopeLabel: scopeSubtitle,
        cards: res.edits.map((e, i) => ({
          front: e.front,
          back: e.back,
          example: e.example,
          confidence: 1,
          include: true,
          key: i + 1,
          card_id: e.card_id,
          orig_front: e.orig_front,
          orig_back: e.orig_back,
          orig_example: e.orig_example,
          lesson_name: e.lesson_name,
        })),
      });
      navigate('/review', { replace: retry });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (timedOut) setError(`No answer from Gemini after ${Math.round((Date.now() - started) / 1000)} s – try another model or "Auto-try free models".`);
        return;
      }
      setError(describeExtractError(e));
    } finally {
      clearTimeout(guard);
      setPhase('idle');
      abortRef.current = null;
    }
  };

  const runEditTryingModels = async () => {
    if (!prompt.trim() || scopedCards.length === 0) return;
    if (!settings?.gemini_api_key_set) {
      setError(
        isLocalBackend
          ? 'Gemini API key is not configured – add your key in Settings.'
          : 'The server has no Gemini API key – set GEMINI_API_KEY in its .env and restart it.'
      );
      return;
    }
    localStorage.setItem(EDIT_PROMPT_KEY, prompt);
    setError(null);
    setPhase('editing');
    const ac = new AbortController();
    abortRef.current = ac;

    const orderedModels = [
      selectedModel,
      ...FREE_TIER_MODELS.map((m) => m.id).filter((id) => id !== selectedModel),
    ];

    try {
      const res = await runWithModelFallback(
        (sig, opts) => api.aiEditCards(scopedCards.map((c) => c.id), prompt, sig, opts),
        orderedModels,
        ac.signal,
        (progress) => {
          setActiveModel(progress.currentModel);
          setFallbackStatus(progress);
        }
      );
      if (res.model) {
        setSelectedModel(res.model);
        void api.settings().then(setSettings);
      }
      if (res.edits.length === 0) {
        setError('No cards needed changes for that prompt – try making your instruction more specific.');
        return;
      }
      setDraft({
        source: 'edit',
        hint: prompt,
        model: res.model,
        editLessonId: lessonId ?? undefined,
        editCardIds: scopedCards.map((c) => c.id),
        editScopeLabel: scopeSubtitle,
        cards: res.edits.map((e, i) => ({
          front: e.front,
          back: e.back,
          example: e.example,
          confidence: 1,
          include: true,
          key: i + 1,
          card_id: e.card_id,
          orig_front: e.orig_front,
          orig_back: e.orig_back,
          orig_example: e.orig_example,
          lesson_name: e.lesson_name,
        })),
      });
      navigate('/review', { replace: retry });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        return;
      }
      setError(describeExtractError(e));
    } finally {
      setPhase('idle');
      setFallbackStatus(null);
      abortRef.current = null;
    }
  };

  const switchModelWhileEditing = (newModel: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSelectedModel(newModel);
    setActiveModel(newModel);
    void api.patchSettings({ gemini_model: newModel }).then(setSettings);
    setTimeout(() => {
      void runEdit(newModel);
    }, 50);
  };

  const cancel = () => {
    abortRef.current?.abort();
    setPhase('idle');
    setFallbackStatus(null);
  };

  if (phase !== 'idle') {
    const currentLabel = FREE_TIER_MODELS.find((m) => m.id === activeModel)?.label ?? activeModel;
    return (
      <div className="min-h-dvh bg-surface flex flex-col items-center justify-center text-center px-6 py-10 max-w-app mx-auto">
        <Spinner className="w-16 h-16 border-[5px] mb-6" />
        <h2 className="font-display text-headline-md text-on-surface">Editing cards…</h2>
        <div className="text-body-sm text-on-surface-variant mt-1.5">
          {fallbackStatus
            ? `Trying free models: ${fallbackStatus.attemptIndex + 1} of ${fallbackStatus.totalModels}`
            : 'Usually 3–8 seconds · gives up after about 30 s'}
        </div>

        <div className="mt-6 flex flex-col gap-2.5 text-left text-body-md text-on-surface-variant w-full max-w-xs">
          <Step done>{scopedCards.length} cards loaded</Step>
          <Step done={phase === 'editing'}>Sending to API</Step>
          <Step done={false}>
            Trying <span className="font-semibold text-primary">{currentLabel}</span>…
          </Step>
        </div>

        {fallbackStatus && fallbackStatus.tried.length > 0 && (
          <div className="mt-4 p-3 bg-surface-container rounded-xl text-left text-body-sm text-on-surface-variant w-full max-w-xs space-y-1">
            <div className="font-medium text-label-sm uppercase tracking-wider text-outline mb-1.5">Previous attempts</div>
            {fallbackStatus.tried.map((t, idx) => (
              <div key={idx} className="text-label-md flex justify-between gap-2">
                <span className="truncate">{t.model}</span>
                <span className="text-error shrink-0">{t.error}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 w-full max-w-xs">
          <label className="text-label-sm text-on-surface-variant text-left block">
            Stuck? Switch model now:
            <div className="relative mt-1">
              <select
                value={selectedModel}
                onChange={(e) => switchModelWhileEditing(e.target.value)}
                className={`${fieldClass} appearance-none pr-8 cursor-pointer text-body-sm py-2`}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-on-surface-variant">
                <Icon name="chevronDown" size={18} />
              </div>
            </div>
          </label>

          <Button variant="outline" onClick={cancel} className="w-full">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-surface pb-32">
      <TopBar title="Edit with prompt" subtitle={scopeSubtitle} back />
      <main className="max-w-app mx-auto px-margin-mobile pt-2">
        {hasFilterChoice && (
          <div className="flex gap-2 mb-3">
            <Chip on={scopeMode === 'filtered'} onClick={() => setScopeMode('filtered')}>
              Filtered ({filteredIds!.length})
            </Chip>
            <Chip on={scopeMode === 'all'} onClick={() => setScopeMode('all')}>
              Whole lesson ({lessonDetail!.cards.length})
            </Chip>
          </div>
        )}

        <div className="bg-surface-container-low rounded-xl p-3.5 text-body-sm text-on-surface-variant mb-4">
          <span className="font-semibold text-on-surface">{scopeSubtitle}</span>. Only cards relevant to your prompt will be modified, and you can review every change before saving.
        </div>

        <Label>How to edit these cards</Label>
        <textarea
          className={fieldClass}
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. differentiate between verb ser and estar by adding context in parentheses"
        />

        <div className="flex flex-wrap gap-2 mt-2">
          {EDIT_CHIPS.map((c) => (
            <Chip key={c.label} on={prompt.includes(c.text)} onClick={() => toggleChip(c.text)}>
              {c.label}
            </Chip>
          ))}
        </div>

        <Label>Gemini model</Label>
        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <select
              value={selectedModel}
              onChange={(e) => void handleModelChange(e.target.value)}
              className={`${fieldClass} appearance-none pr-8 cursor-pointer text-body-md`}
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-on-surface-variant">
              <Icon name="chevronDown" size={18} />
            </div>
          </div>
          {isLocalBackend && (
            <Button
              variant="tonal"
              className="shrink-0"
              onClick={() => void findResponsiveModel()}
              disabled={probing !== null}
            >
              {probing ? `Checking ${probing}…` : 'Find not-busy'}
            </Button>
          )}
        </div>

        {!settings?.gemini_api_key_set && (
          <div className="mt-3 p-3 bg-secondary-container/30 border border-secondary-container rounded-xl text-body-sm text-on-surface">
            <div className="font-semibold flex items-center gap-1.5 text-secondary">
              <Icon name="warning" size={16} /> Gemini API key needed
            </div>
            <p className="mt-1">
              {isLocalBackend ? (
                <>
                  Editing cards uses the free Gemini API.{' '}
                  <button
                    type="button"
                    className="text-primary font-semibold underline"
                    onClick={() => navigate('/settings')}
                  >
                    Add your free key in Settings
                  </button>
                  .
                </>
              ) : (
                'The server is missing GEMINI_API_KEY – add it to the server’s .env and restart it.'
              )}
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4">
            <ErrorBox message={error} />
          </div>
        )}
      </main>

      <Footer>
        <Button
          className="flex-1 min-w-0"
          icon="sparkle"
          disabled={!prompt.trim() || scopedCards.length === 0}
          onClick={() => void runEdit()}
        >
          Preview edits
        </Button>
        <Button
          variant="tonal"
          className="shrink-0"
          disabled={!prompt.trim() || scopedCards.length === 0}
          onClick={() => void runEditTryingModels()}
        >
          Auto-try free models
        </Button>
      </Footer>
    </div>
  );
}
