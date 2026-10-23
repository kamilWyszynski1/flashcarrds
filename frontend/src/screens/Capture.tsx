import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button, Chip, ErrorBox, Footer, GroupSelector, Label, Spinner, TopBar, fieldClass } from '../components/ui';
import { api, isLocalBackend } from '../lib/api';
import { describeExtractError } from '../lib/extractError';
import { FREE_TIER_MODELS, extractWithModelFallback, type FallbackProgress } from '../lib/gemini';
import { fmtBytes, prepareImage, type PreparedImage } from '../lib/image';
import { markCaptureFlowStart, useSheets } from '../lib/sheets';
import { useStore, useTargetLesson } from '../lib/store';

const HINT_CHIPS = [
  { label: 'Only the vocab box', text: 'Only the vocabulary box.' },
  { label: 'Skip exercises', text: 'Skip the exercises.' },
  { label: 'With example sentence', text: 'Add a short example sentence for each word.' },
  { label: 'Nouns with article', text: 'Nouns with their article.' },
  { label: 'Verbs in infinitive', text: 'Verbs in the infinitive.' },
];

const HINT_KEY = 'fiszki.lastHint';

// Photos of the last extraction, kept in memory (not persisted) so that
// "Edit hint & retry" on the Review screen does not force a re-shoot.
let lastImages: PreparedImage[] = [];

export function Capture() {
  const navigate = useNavigate();
  const location = useLocation();
  const retry = Boolean((location.state as { retry?: boolean } | null)?.retry);
  const { settings, setSettings, setDraft, draft, toast } = useStore();
  const { openPicker } = useSheets();
  const target = useTargetLesson();
  const [images, setImages] = useState<PreparedImage[]>(() => (retry ? lastImages : []));
  const [hint, setHint] = useState(() => (retry && draft ? draft.hint : localStorage.getItem(HINT_KEY) ?? ''));
  const [preparing, setPreparing] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'extracting'>('idle');
  const [error, setError] = useState<string | null>(null);

  const currentModel = settings?.gemini_model ?? 'gemini-flash-latest';
  const [selectedModel, setSelectedModel] = useState<string>(currentModel);
  const [activeModel, setActiveModel] = useState<string>(currentModel);
  const [probing, setProbing] = useState<string | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<FallbackProgress | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (settings?.gemini_model) {
      setSelectedModel(settings.gemini_model);
      setActiveModel(settings.gemini_model);
    }
  }, [settings?.gemini_model]);

  // Remember the history position of this screen so that saving on Review can
  // unwind back to wherever the user came from (Home, a lesson, …). A retry
  // re-enters this screen with `replace`, so the original mark is kept.
  useEffect(() => {
    if (!retry) markCaptureFlowStart();
  }, [retry]);

  // Object URLs are tiny; the first one is reused as the Review thumbnail, so
  // we only revoke when the user explicitly retakes.
  const retake = () => {
    images.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    lastImages = [];
    setImages([]);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPreparing(true);
    setError(null);
    try {
      const prepared: PreparedImage[] = [];
      for (const f of Array.from(files).slice(0, 4 - images.length)) prepared.push(await prepareImage(f));
      setImages((cur) => [...cur, ...prepared].slice(0, 4));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = '';
      if (galleryRef.current) galleryRef.current.value = '';
    }
  };

  const toggleChip = (text: string) => {
    setHint((h) => {
      if (h.includes(text)) return h.replace(text, '').replace(/\s{2,}/g, ' ').trim();
      return `${h.trim()} ${text}`.trim();
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

  const CLIENT_TIMEOUT_MS = 60_000;

  const extract = async (overrideModel?: string) => {
    if (images.length === 0) return;
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
    localStorage.setItem(HINT_KEY, hint);
    setError(null);
    setPhase('uploading');
    const ac = new AbortController();
    abortRef.current = ac;
    let timedOut = false;
    const t = setTimeout(() => setPhase('extracting'), 600);
    const guard = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, CLIENT_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await api.extract(
        images.map((i) => ({ mime_type: i.mime_type, data: i.data })),
        hint,
        ac.signal,
        { model: modelToUse }
      );
      lastImages = images;
      if (res.model && res.model !== settings.gemini_model) {
        void api.settings().then(setSettings);
      }
      setDraft({
        source: 'photo',
        hint,
        model: res.model,
        previewUrl: images[0]?.previewUrl,
        cards: res.cards.map((c, i) => ({ ...c, include: !c.existing_in, key: i + 1 })),
      });
      if (res.cards.length === 0) toast('No vocabulary found – try a sharper photo or a different hint.');
      navigate('/review', { replace: retry });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (timedOut) setError(`No answer from Gemini after ${Math.round((Date.now() - started) / 1000)} s – try another model or "Auto-try free models".`);
        return;
      }
      setError(describeExtractError(e));
    } finally {
      clearTimeout(t);
      clearTimeout(guard);
      setPhase('idle');
      abortRef.current = null;
    }
  };

  const extractTryingModels = async () => {
    if (images.length === 0) return;
    if (!settings?.gemini_api_key_set) {
      setError(
        isLocalBackend
          ? 'Gemini API key is not configured – add your key in Settings.'
          : 'The server has no Gemini API key – set GEMINI_API_KEY in its .env and restart it.'
      );
      return;
    }
    localStorage.setItem(HINT_KEY, hint);
    setError(null);
    setPhase('uploading');
    const ac = new AbortController();
    abortRef.current = ac;
    const t = setTimeout(() => setPhase('extracting'), 600);

    const orderedModels = [
      selectedModel,
      ...FREE_TIER_MODELS.map((m) => m.id).filter((id) => id !== selectedModel),
    ];

    try {
      const res = await extractWithModelFallback(
        (imgs, h, sig, opts) => api.extract(imgs, h, sig, opts),
        images.map((i) => ({ mime_type: i.mime_type, data: i.data })),
        hint,
        orderedModels,
        ac.signal,
        (progress) => {
          setActiveModel(progress.currentModel);
          setFallbackStatus(progress);
        }
      );
      lastImages = images;
      if (res.model) {
        setSelectedModel(res.model);
        void api.settings().then(setSettings);
      }
      setDraft({
        source: 'photo',
        hint,
        model: res.model,
        previewUrl: images[0]?.previewUrl,
        cards: res.cards.map((c, i) => ({ ...c, include: !c.existing_in, key: i + 1 })),
      });
      toast(`Extracted with ${res.model}!`);
      if (res.cards.length === 0) toast('No vocabulary found – try a sharper photo or a different hint.');
      navigate('/review', { replace: retry });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        return;
      }
      setError(describeExtractError(e));
    } finally {
      clearTimeout(t);
      setPhase('idle');
      setFallbackStatus(null);
      abortRef.current = null;
    }
  };

  const switchModelWhileExtracting = (newModel: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSelectedModel(newModel);
    setActiveModel(newModel);
    void api.patchSettings({ gemini_model: newModel }).then(setSettings);
    setTimeout(() => {
      void extract(newModel);
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
        <h2 className="font-display text-headline-md text-on-surface">Reading the page…</h2>
        <div className="text-body-sm text-on-surface-variant mt-1.5">
          {fallbackStatus
            ? `Trying free models: ${fallbackStatus.attemptIndex + 1} of ${fallbackStatus.totalModels}`
            : 'Usually 3–8 seconds · gives up after about 30 s'}
        </div>

        <div className="mt-6 flex flex-col gap-2.5 text-left text-body-md text-on-surface-variant w-full max-w-xs">
          <Step done>Photo ready ({images.map((i) => fmtBytes(i.bytes)).join(', ')})</Step>
          <Step done={phase === 'extracting'}>Sending to API</Step>
          <Step done={false}>
            Trying <span className="font-semibold text-primary">{currentLabel}</span>…
          </Step>
        </div>

        {fallbackStatus && fallbackStatus.tried.length > 0 && (
          <div className="mt-4 p-3 bg-surface-container rounded-xl text-left text-body-sm text-on-surface-variant w-full max-w-xs space-y-1">
            <div className="font-semibold text-label-sm uppercase text-on-surface-variant mb-1">Attempt history</div>
            {fallbackStatus.tried.map((t) => (
              <div key={t.model} className="flex items-center gap-1.5 truncate">
                <span className="text-error font-bold">✗</span>
                <span className="font-mono text-xs truncate">{t.model}</span>
                <span className="text-xs text-outline shrink-0">(busy)</span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 w-full max-w-xs flex flex-col items-center gap-2">
          <div className="text-label-sm text-on-surface-variant">Model taking too long? Switch & retry:</div>
          <select
            className="w-full bg-surface-container rounded-full px-4 h-10 text-label-md text-on-surface outline-none border border-outline-variant/60"
            value={activeModel}
            onChange={(e) => switchModelWhileExtracting(e.target.value)}
          >
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <Button variant="outline" className="mt-6" onClick={cancel}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-surface pb-32">
      <TopBar title="Cards from photo" back />
      <main className="max-w-app mx-auto px-margin-mobile pt-2">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFiles(e.target.files)} />
        <input ref={galleryRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />

        {images.length === 0 ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={preparing}
            className="w-full aspect-[4/3.2] rounded-2xl bg-surface-container-lowest border-2 border-dashed border-outline-variant flex flex-col items-center justify-center text-center p-4"
          >
            {preparing ? (
              <Spinner />
            ) : (
              <>
                <Icon name="camera" size={44} strokeWidth={1.8} className="text-primary mb-2" />
                <div className="text-body-md font-semibold text-on-surface">Take a photo of the page</div>
                <div className="text-body-sm text-on-surface-variant mt-1">
                  Opens the camera · or{' '}
                  <span
                    className="underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      galleryRef.current?.click();
                    }}
                  >
                    choose from gallery
                  </span>
                </div>
              </>
            )}
          </button>
        ) : (
          <div className="space-y-2">
            <div className="relative rounded-2xl overflow-hidden bg-surface-container aspect-[4/3]">
              <img src={images[0].previewUrl} alt="Page" className="w-full h-full object-contain" />
              <div className="absolute right-2.5 bottom-2.5 flex gap-2">
                <PhotoButton icon="refresh" label="Retake" onClick={retake} />
                {images.length < 4 && <PhotoButton icon="plus" label="Add page" onClick={() => fileRef.current?.click()} />}
              </div>
              {preparing && (
                <div className="absolute inset-0 bg-scrim/30 flex items-center justify-center">
                  <Spinner />
                </div>
              )}
            </div>
            {images.length > 1 && (
              <div className="flex gap-2">
                {images.map((im, i) => (
                  <div key={im.previewUrl} className="relative w-16 h-16 rounded-[10px] overflow-hidden bg-surface-container">
                    <img src={im.previewUrl} alt={`Page ${i + 1}`} className="w-full h-full object-cover" />
                    <button type="button" aria-label="Remove page" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))} className="absolute top-0.5 right-0.5 w-6 h-6 rounded-full bg-scrim/60 text-white flex items-center justify-center">
                      <Icon name="close" size={14} strokeWidth={2.5} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="text-body-sm text-on-surface-variant">
              {images.length} {images.length === 1 ? 'page' : 'pages'} · {fmtBytes(images.reduce((a, b) => a + b.bytes, 0))} to upload
            </div>
          </div>
        )}

        <Label optional>What to extract</Label>
        <textarea
          className={fieldClass}
          rows={3}
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="e.g. only the blue “Vocabulario” box, skip the exercise; add the gender for nouns"
        />
        <div className="flex flex-wrap gap-2 mt-2.5">
          {HINT_CHIPS.map((c) => (
            <Chip key={c.text} on={hint.includes(c.text)} onClick={() => toggleChip(c.text)}>
              {c.label}
            </Chip>
          ))}
        </div>

        <Label>Save to</Label>
        <GroupSelector unit={target?.unit.name} lesson={target?.lesson.name} onClick={() => openPicker()} />
        <div className="text-body-sm text-on-surface-variant mt-2">You can still change the group on the review screen.</div>

        <Label>Gemini model</Label>
        <div className="flex items-center gap-2">
          <select
            className="flex-1 min-w-0 bg-surface-container-low rounded-xl px-3.5 h-[52px] text-body-md font-semibold text-on-surface outline-none border-2 border-transparent focus:border-primary"
            value={selectedModel}
            onChange={(e) => void handleModelChange(e.target.value)}
          >
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {isLocalBackend && (
            <Button
              variant="tonal"
              size="sm"
              className="h-[52px] px-3.5 whitespace-nowrap text-label-md shrink-0"
              onClick={() => void findResponsiveModel()}
              disabled={probing !== null}
            >
              {probing ? (
                <>
                  <Spinner className="w-4 h-4 border-2" />
                  <span className="text-xs">Checking…</span>
                </>
              ) : (
                <>
                  <Icon name="sparkle" size={16} />
                  <span>Find not-busy</span>
                </>
              )}
            </Button>
          )}
        </div>
        {probing && (
          <div className="text-body-sm text-primary mt-1 px-1">
            Probing {probing}…
          </div>
        )}

        {!settings?.gemini_api_key_set && settings && (
          <div className="mt-4 rounded-xl bg-secondary-fixed/60 text-on-secondary-fixed p-3.5 text-body-sm flex gap-3 items-start">
            <Icon name="key" size={20} />
            <div>
              {isLocalBackend ? (
                <>
                  No Gemini API key configured on this device. Paste your key in{' '}
                  <button type="button" className="font-semibold underline" onClick={() => navigate('/settings')}>
                    Settings
                  </button>{' '}
                  to enable photo extraction.
                </>
              ) : (
                <>
                  The server has no Gemini API key, so photo extraction is off. Add <code>GEMINI_API_KEY</code> to the server’s <code>.env</code> and restart it (status in{' '}
                  <button type="button" className="font-semibold underline" onClick={() => navigate('/settings')}>
                    Settings
                  </button>
                  ).
                </>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="mt-4">
            <ErrorBox message={error} />
          </div>
        )}
      </main>
      <Footer>
        <Button className="flex-1 min-w-0" icon="sparkle" disabled={images.length === 0 || preparing || !target} onClick={() => void extract()}>
          Extract cards
        </Button>
        <Button
          variant="tonal"
          className="shrink-0"
          disabled={images.length === 0 || preparing || !target}
          onClick={() => void extractTryingModels()}
          title="Try free-tier Gemini models one by one until one responds"
        >
          Auto-try free models
        </Button>
      </Footer>
    </div>
  );
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 items-center">
      <Icon name="check" size={20} strokeWidth={2.5} className={done ? 'text-tertiary' : 'text-outline-variant'} />
      <span>{children}</span>
    </div>
  );
}

function PhotoButton({ icon, label, onClick }: { icon: 'refresh' | 'plus'; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="bg-scrim/55 text-white rounded-full px-3.5 min-h-[40px] text-body-sm font-semibold flex items-center gap-1.5 backdrop-blur">
      <Icon name={icon} size={16} strokeWidth={2.2} />
      {label}
    </button>
  );
}
