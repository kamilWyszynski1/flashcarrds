import { useEffect, type ReactNode } from 'react';
import { useStore } from '../lib/store';

/** Bottom sheet with scrim; closing is delegated to the router (back gesture). */
export function Sheet({ title, onClose, children }: { title?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-scrim/40 animate-fade-in" onClick={onClose} />
      <div className="relative max-w-app w-full mx-auto bg-surface-container-lowest rounded-t-3xl shadow-float animate-sheet-in max-h-[88dvh] flex flex-col">
        <div className="w-9 h-1 rounded-full bg-outline-variant mx-auto mt-2 mb-3 shrink-0" />
        {title && <h2 className="font-display text-headline-md text-on-surface px-4 pb-3 shrink-0">{title}</h2>}
        <div className="overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">{children}</div>
      </div>
    </div>
  );
}

export function ToastHost() {
  const { toasts, dismissToast } = useStore();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed z-50 inset-x-4 bottom-[calc(4rem+env(safe-area-inset-bottom,0px)+5.75rem)] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto max-w-app mx-auto w-full bg-inverse-surface text-inverse-on-surface rounded-xl px-4 py-3.5 shadow-float flex items-center gap-3 animate-toast-in" role="status">
          <span className="flex-1 text-body-md">{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="text-inverse-primary font-bold text-label-lg min-h-[40px] px-2"
              onClick={() => {
                dismissToast(t.id);
                t.action!.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="text-inverse-primary font-bold text-label-lg min-h-[40px] px-1" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            OK
          </button>
        </div>
      ))}
    </div>
  );
}
