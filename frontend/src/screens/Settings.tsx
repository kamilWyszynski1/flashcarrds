import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { Button, Label, Toggle, TopBar, fieldClass } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import type { Settings as SettingsData, SettingsPatch } from '../lib/types';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: BeforeInstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
  });
}

export function Settings() {
  const { settings, setSettings, overview, toast, refresh } = useStore();
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [canInstall, setCanInstall] = useState(!!deferredInstall);
  const importRef = useRef<HTMLInputElement>(null);
  const installed = typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);

  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      deferredInstall = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);

  useEffect(() => {
    if (settings) setModel(settings.gemini_model);
  }, [settings]);

  const patch = async (p: SettingsPatch, msg?: string) => {
    setSaving(true);
    try {
      const s = await api.patchSettings(p);
      setSettings(s);
      if (msg) toast(msg);
      return s;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveKey = async () => {
    const k = key.trim();
    if (!k) return;
    const s = await patch({ gemini_api_key: k }, 'API key saved');
    if (s) setKey('');
  };

  const commitModel = async () => {
    if (!settings) return;
    const m = model.trim();
    if (m === settings.gemini_model) return;
    // Blank = reset to the server default; the server validates the name and returns the effective one.
    const s = await patch({ gemini_model: m }, m ? `Model set to ${m}` : 'Model reset to default');
    setModel(s ? s.gemini_model : settings.gemini_model);
  };

  const exportBackup = async () => {
    try {
      const data = await api.exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fiszki-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const importBackup = async (f: File | undefined) => {
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const rep = await api.importBackup(data);
      await refresh();
      toast(`Imported ${rep.cards_created} cards (${rep.cards_skipped} skipped)`);
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`);
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const install = async () => {
    if (!deferredInstall) return;
    await deferredInstall.prompt();
    const { outcome } = await deferredInstall.userChoice;
    if (outcome === 'accepted') toast('Installed – look for Fiszki on your home screen');
    deferredInstall = null;
    setCanInstall(false);
  };

  if (!settings) return <TopBar title="Settings" back />;

  return (
    <div className="min-h-dvh bg-surface pb-10">
      <TopBar title="Settings" back />
      <main className="max-w-app mx-auto px-margin-mobile">
        <Label>Card sides</Label>
        <Section>
          <Row title="Front language" text="What you see first">
            <LangInput value={settings.front_lang} onCommit={(v) => void patch({ front_lang: v })} />
          </Row>
          <Row title="Back language" text="The answer">
            <LangInput value={settings.back_lang} onCommit={(v) => void patch({ back_lang: v })} />
          </Row>
          <Row title="Study direction" text="Which side is shown first">
            <select
              className="bg-surface-container rounded-full px-3 h-10 text-label-lg text-on-surface outline-none"
              value={settings.study_direction}
              onChange={(e) => void patch({ study_direction: e.target.value as SettingsData['study_direction'] })}
            >
              <option value="front_to_back">Front → Back</option>
              <option value="back_to_front">Back → Front</option>
              <option value="mixed">Mixed</option>
            </select>
          </Row>
        </Section>
        <p className="text-body-sm text-on-surface-variant mt-2 px-1">
          Languages are only labels on the card and in the extraction prompt – change them any time (e.g. Polski → English).
        </p>

        <Label>Study</Label>
        <Section>
          <Row title="New cards per day" text="Spaced repetition limit">
            <select className="bg-surface-container rounded-full px-3 h-10 text-label-lg text-on-surface outline-none" value={settings.new_per_day} onChange={(e) => void patch({ new_per_day: Number(e.target.value) })}>
              {[5, 10, 15, 20, 30, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Row>
          <Row title="Haptic feedback" text="Vibrate on flip and grade">
            <Toggle on={settings.haptics} onChange={(v) => void patch({ haptics: v })} label="Haptic feedback" />
          </Row>
        </Section>

        <Label>Gemini (photo extraction)</Label>
        <Section>
          <div className="py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-body-md font-semibold text-on-surface">API key</div>
                <div className="text-body-sm text-on-surface-variant">
                  {settings.gemini_api_key_set ? `Configured (${settings.gemini_api_key_hint})` : 'Not set – required for “Cards from photo”'}
                </div>
              </div>
              {settings.gemini_api_key_set && (
                <Button variant="outline" size="sm" onClick={() => void patch({ gemini_api_key: '' }, 'API key removed')}>
                  Remove
                </Button>
              )}
            </div>
            <div className="flex gap-2 mt-3">
              <input className={`${fieldClass} min-h-[44px] py-2`} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.gemini_api_key_set ? 'Paste a new key to replace' : 'AIza…'} autoComplete="off" />
              <Button size="sm" className="h-[44px] shrink-0" disabled={!key.trim() || saving} onClick={() => void saveKey()}>
                Save
              </Button>
            </div>
            <p className="text-body-sm text-on-surface-variant mt-2">
              Get a key at{' '}
              <a className="text-primary underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                aistudio.google.com/apikey
              </a>
              . It is stored on your server only and never sent to the browser.
            </p>
          </div>
          <Row title="Model" text="Blank = default (gemini-flash-latest)">
            <input
              className="bg-surface-container rounded-full px-3 h-10 text-label-lg text-on-surface outline-none w-[170px]"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => void commitModel()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder="gemini-flash-latest"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Row>
          <Row title="Pause extraction" text={settings.extraction_paused ? 'Photo requests are rejected' : 'Kill switch for the Gemini key'}>
            <Toggle on={settings.extraction_paused} onChange={(v) => void patch({ extraction_paused: v }, v ? 'Extraction paused' : 'Extraction resumed')} label="Pause extraction" />
          </Row>
          <Row title="Usage" text="Extraction requests (failed ones count too)">
            <span className="text-label-lg text-on-surface tabular-nums whitespace-nowrap">
              {settings.extractions_today}
              {settings.extract_daily_cap > 0 ? ` / ${settings.extract_daily_cap}` : ''} today · {settings.extractions_total} total
            </span>
          </Row>
        </Section>
        <p className="text-body-sm text-on-surface-variant mt-2 px-1">
          The daily cap and per-minute limit are set on the server (<code>FISZKI_EXTRACT_DAILY_CAP</code>, <code>FISZKI_EXTRACT_PER_MINUTE</code>); protect the whole app with{' '}
          <code>FISZKI_BASIC_AUTH=user:password</code> before exposing it.
        </p>

        <Label>Data</Label>
        <Section>
          <button type="button" onClick={() => void exportBackup()} className="w-full flex items-center gap-3 min-h-[60px] text-left">
            <div className="flex-1">
              <div className="text-body-md font-semibold text-on-surface">Export backup (JSON)</div>
              <div className="text-body-sm text-on-surface-variant">{overview?.total ?? 0} cards · stored on your server</div>
            </div>
            <Icon name="download" size={22} className="text-on-surface-variant" />
          </button>
          <button type="button" onClick={() => importRef.current?.click()} className="w-full flex items-center gap-3 min-h-[60px] text-left border-t border-outline-variant/40">
            <div className="flex-1">
              <div className="text-body-md font-semibold text-on-surface">Import backup</div>
              <div className="text-body-sm text-on-surface-variant">Merges; existing cards are kept</div>
            </div>
            <Icon name="upload" size={22} className="text-on-surface-variant" />
          </button>
          <input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void importBackup(e.target.files?.[0])} />
          <div className="flex items-center gap-3 min-h-[60px] border-t border-outline-variant/40">
            <div className="flex-1">
              <div className="text-body-md font-semibold text-on-surface">Install as app</div>
              <div className="text-body-sm text-on-surface-variant">{installed ? 'Running as an installed app' : canInstall ? 'Adds an icon to your home screen' : 'Use Chrome menu → “Add to Home screen”'}</div>
            </div>
            {installed ? (
              <span className="px-2.5 py-1 rounded-full bg-tertiary-fixed text-on-tertiary-fixed text-label-sm font-bold">installed</span>
            ) : canInstall ? (
              <Button size="sm" onClick={() => void install()}>
                Install
              </Button>
            ) : null}
          </div>
        </Section>
        <p className="text-body-sm text-on-surface-variant mt-6 text-center">Fiszki · {import.meta.env.VITE_APP_VERSION ?? 'dev'}</p>
      </main>
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl bg-surface-container-lowest shadow-card px-4 divide-y divide-outline-variant/40">{children}</div>;
}

function Row({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 min-h-[60px] py-2">
      <div className="flex-1 min-w-0">
        <div className="text-body-md font-semibold text-on-surface">{title}</div>
        {text && <div className="text-body-sm text-on-surface-variant">{text}</div>}
      </div>
      {children}
    </div>
  );
}

function LangInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => {
    setV(value);
  }, [value]);
  return (
    <input
      className="bg-surface-container rounded-full px-3 h-10 text-label-lg text-on-surface outline-none w-[120px] text-right"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v.trim() !== value && onCommit(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      list="lang-suggestions"
    />
  );
}
