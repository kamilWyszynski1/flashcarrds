import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { Button, Label, Toggle, TopBar } from '../components/ui';
import { api, isLocalBackend } from '../lib/api';
import { FREE_TIER_MODELS } from '../lib/gemini';
import { useStore } from '../lib/store';
import type { Theme } from '../lib/theme';
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
  const [canInstall, setCanInstall] = useState(!!deferredInstall);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [modelInput, setModelInput] = useState(settings?.gemini_model ?? 'gemini-flash-latest');
  const importRef = useRef<HTMLInputElement>(null);
  const installed = typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);

  useEffect(() => {
    if (settings?.gemini_model) {
      setModelInput(settings.gemini_model);
    }
  }, [settings?.gemini_model]);

  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      deferredInstall = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);

  const patch = async (p: SettingsPatch, msg?: string) => {
    try {
      const s = await api.patchSettings(p);
      setSettings(s);
      if (msg) toast(msg);
      return s;
    } catch (e) {
      toast((e as Error).message);
    }
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
        <Label>Appearance</Label>
        <Section>
          <Row title="Theme" text={settings.theme === 'light' ? 'Light (default)' : settings.theme === 'dark' ? 'Dark' : 'Follows your device setting'}>
            <select
              className="bg-surface-container rounded-full px-3 h-10 text-label-lg text-on-surface outline-none"
              aria-label="Theme"
              value={settings.theme}
              onChange={(e) => void patch({ theme: e.target.value as Theme })}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </Row>
        </Section>

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
          {isLocalBackend ? (
            <div className="py-3 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-body-md font-semibold text-on-surface">API key</div>
                  <div className="text-body-sm text-on-surface-variant">
                    {settings.gemini_api_key_set ? 'Stored locally in this browser' : 'Required for photo card extraction'}
                  </div>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-label-sm font-bold shrink-0 ${settings.gemini_api_key_set ? 'bg-tertiary-fixed text-on-tertiary-fixed' : 'bg-error-container text-on-error-container'}`}>
                  {settings.gemini_api_key_set ? 'configured' : 'missing'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  className="flex-1 min-w-0 bg-surface-container rounded-full px-3.5 h-10 text-body-md text-on-surface outline-none"
                  placeholder={settings.gemini_api_key_set ? '••••••••••••••••' : 'Paste Gemini API key (AIza...)'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && apiKeyInput.trim()) {
                      void (async () => {
                        await patch({ gemini_api_key: apiKeyInput.trim() }, 'API key saved');
                        setApiKeyInput('');
                      })();
                    }
                  }}
                />
                {apiKeyInput.trim() ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      await patch({ gemini_api_key: apiKeyInput.trim() }, 'API key saved');
                      setApiKeyInput('');
                    }}
                  >
                    Save
                  </Button>
                ) : settings.gemini_api_key_set ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      if (window.confirm('Remove your Gemini API key from this device?')) {
                        await patch({ gemini_api_key: '' }, 'API key removed');
                      }
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <Row title="API key" text={settings.gemini_api_key_set ? 'Configured via GEMINI_API_KEY on the server' : 'Not set – add GEMINI_API_KEY to the server’s .env and restart'}>
              <span className={`px-2.5 py-1 rounded-full text-label-sm font-bold ${settings.gemini_api_key_set ? 'bg-tertiary-fixed text-on-tertiary-fixed' : 'bg-error-container text-on-error-container'}`}>
                {settings.gemini_api_key_set ? 'configured' : 'missing'}
              </span>
            </Row>
          )}

          {isLocalBackend ? (
            <Row title="Model" text="Gemini model used for extraction">
              <div className="flex items-center gap-2">
                <input
                  className="bg-surface-container rounded-full px-3 h-10 text-label-lg text-on-surface outline-none text-right w-[180px]"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  onBlur={() => {
                    const val = modelInput.trim();
                    if (val && val !== settings.gemini_model) {
                      void patch({ gemini_model: val });
                    }
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  list="gemini-models"
                />
                <datalist id="gemini-models">
                  {FREE_TIER_MODELS.map((m) => (
                    <option key={m.id} value={m.id} label={m.label} />
                  ))}
                </datalist>
              </div>
            </Row>
          ) : (
            <Row title="Model" text="Set with FISZKI_GEMINI_MODEL on the server">
              <code className="text-label-lg text-on-surface whitespace-nowrap">{settings.gemini_model}</code>
            </Row>
          )}

          {isLocalBackend && (
            <Row title="Daily extraction cap" text="Safety limit for photo extractions">
              <select
                aria-label="Daily extraction cap"
                className="bg-surface-container rounded-full px-3 h-10 text-label-lg text-on-surface outline-none"
                value={settings.extract_daily_cap}
                onChange={(e) => void patch({ extract_daily_cap: Number(e.target.value) })}
              >
                <option value={0}>Unlimited</option>
                <option value={10}>10 / day</option>
                <option value={25}>25 / day</option>
                <option value={50}>50 / day</option>
                <option value={60}>60 / day</option>
                <option value={100}>100 / day</option>
                <option value={200}>200 / day</option>
              </select>
            </Row>
          )}

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
          {isLocalBackend
            ? "Your API key is stored only in this browser on your device and sent directly to Google's Gemini API over HTTPS."
            : 'The key and model are read-only here on purpose: nothing that can be done from the app (or with a stolen password) can change or reveal them. The daily cap and per-minute limit are also server settings (FISZKI_EXTRACT_DAILY_CAP, FISZKI_EXTRACT_PER_MINUTE); protect the whole app with FISZKI_BASIC_AUTH=user:password before exposing it.'}
        </p>

        <Label>Data</Label>
        <Section>
          <button type="button" onClick={() => void exportBackup()} className="w-full flex items-center gap-3 min-h-[60px] text-left">
            <div className="flex-1">
              <div className="text-body-md font-semibold text-on-surface">Export backup (JSON)</div>
              <div className="text-body-sm text-on-surface-variant">
                {overview?.total ?? 0} cards · stored on {isLocalBackend ? 'this device' : 'your server'}
              </div>
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
