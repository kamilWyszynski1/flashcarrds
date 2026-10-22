import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './Icon';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'tonal' | 'outline' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-primary-container text-on-primary hover:bg-primary shadow-md',
  tonal: 'bg-primary-fixed text-on-primary-fixed-variant',
  outline: 'border border-outline-variant text-on-surface bg-transparent',
  ghost: 'text-primary bg-transparent',
  danger: 'bg-error-container text-on-error-container',
};

export function Button({
  variant = 'primary',
  className = '',
  children,
  icon,
  size = 'md',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: IconName; size?: 'md' | 'lg' | 'sm' }) {
  const h = size === 'lg' ? 'h-[60px]' : size === 'sm' ? 'h-10 px-4 text-label-md' : 'h-[52px]';
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-full px-5 font-body text-label-lg font-semibold transition-[transform,filter] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none ${h} ${variants[variant]} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={20} />}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`w-12 h-12 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high active:bg-surface-container-highest transition-colors disabled:opacity-40 ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// App bars & navigation
// ---------------------------------------------------------------------------

export function TopBar({
  title,
  subtitle,
  back,
  onBack,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: boolean;
  onBack?: () => void;
  right?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-30 pt-safe-top bg-surface/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
      <div className="h-16 px-2 flex items-center gap-1 max-w-app mx-auto">
        {back && <IconButton icon="back" label="Back" onClick={onBack ?? (() => navigate(-1))} />}
        <div className={`flex-1 min-w-0 flex flex-col ${back ? '' : 'pl-3'}`}>
          <h1 className="font-display text-headline-sm font-bold text-on-surface truncate">{title}</h1>
          {subtitle && <span className="font-body text-label-sm text-on-surface-variant truncate">{subtitle}</span>}
        </div>
        {right}
      </div>
    </header>
  );
}

export function BottomNav({ due }: { due?: number }) {
  const item = 'flex-1 flex flex-col items-center justify-center min-h-[48px] py-1 transition-colors';
  const cls = ({ isActive }: { isActive: boolean }) => `${item} ${isActive ? 'text-primary font-semibold' : 'text-on-surface-variant'}`;
  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 pb-safe bg-surface/90 backdrop-blur-xl shadow-top">
      <div className="flex justify-around items-center h-16 max-w-app mx-auto px-margin-mobile">
        <NavLink to="/" end className={cls}>
          <Icon name="book" />
          <span className="text-label-md mt-0.5">Groups</span>
        </NavLink>
        <NavLink to="/all" className={cls}>
          <Icon name="cards" />
          <span className="text-label-md mt-0.5">All cards</span>
        </NavLink>
        <NavLink to="/study?scope=all" className={cls}>
          <div className="relative flex items-center justify-center">
            <Icon name="play" />
            {!!due && (
              <span className="absolute -top-1.5 -right-3 bg-secondary-container text-on-secondary-container text-label-sm px-1.5 rounded-full leading-4 font-bold">
                {due > 99 ? '99+' : due}
              </span>
            )}
          </div>
          <span className="text-label-md mt-0.5">Study</span>
        </NavLink>
      </div>
    </nav>
  );
}

/** Extended FAB sitting 16 px above the bottom nav (thumb zone). */
export function Fab({ icon, label, onClick, className = '' }: { icon: IconName; label: string; onClick: () => void; className?: string }) {
  return (
    <div className={`fixed z-30 right-4 bottom-[calc(4rem+env(safe-area-inset-bottom,0px)+1rem)] ${className}`}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="h-14 px-5 rounded-full bg-primary-container text-on-primary flex items-center gap-2 shadow-float hover:bg-primary active:scale-95 transition-all"
      >
        <Icon name={icon} />
        <span className="text-label-lg font-semibold tracking-wide">{label}</span>
      </button>
    </div>
  );
}

/** Sticky footer above the gesture bar for primary actions. */
export function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur-xl shadow-top">
      <div className="max-w-app mx-auto px-margin-mobile pt-3 pb-safe">
        <div className="flex gap-2.5 pb-3">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form elements
// ---------------------------------------------------------------------------

export function Label({ children, optional }: { children: ReactNode; optional?: boolean }) {
  return (
    <div className="text-label-sm font-semibold tracking-wider uppercase text-on-surface-variant mt-4 mb-2 px-0.5">
      {children}
      {optional && <span className="font-normal normal-case tracking-normal"> (optional)</span>}
    </div>
  );
}

export const fieldClass =
  'w-full bg-surface-container-low text-on-surface text-[16px] leading-6 rounded-xl px-3.5 min-h-[52px] py-3 outline-none border-2 border-transparent focus:border-primary focus:bg-surface-container-lowest placeholder:text-outline resize-none';

export function Chip({ on, children, onClick, className = '' }: { on?: boolean; children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex items-center gap-1.5 min-h-[40px] px-3.5 rounded-full text-body-sm font-medium transition-colors ${
        on ? 'bg-primary-fixed text-on-primary-fixed-variant font-semibold' : 'bg-surface-container text-on-surface'
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative w-[52px] h-8 rounded-full transition-colors shrink-0 ${on ? 'bg-primary-container' : 'bg-surface-container-highest'}`}
    >
      <span className={`absolute top-1 w-6 h-6 rounded-full shadow transition-all ${on ? 'left-[26px] bg-on-primary' : 'left-1 bg-surface-container-lowest'}`} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Lists & misc
// ---------------------------------------------------------------------------

export function Card({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`block w-full text-left rounded-2xl bg-surface-container-lowest shadow-card ${className}`}>
      {children}
    </Tag>
  );
}

export function Progress({ value, className = '', color = 'bg-primary-container' }: { value: number; className?: string; color?: string }) {
  return (
    <div className={`w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden ${className}`}>
      <div className={`h-full rounded-full transition-[width] duration-300 ${color}`} style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'due' | 'new' | 'ok' }) {
  const t = {
    neutral: 'bg-surface-container-high text-on-surface-variant',
    due: 'bg-secondary-fixed text-on-secondary-fixed',
    new: 'bg-primary-fixed text-on-primary-fixed-variant',
    ok: 'bg-tertiary-fixed text-on-tertiary-fixed',
  }[tone];
  return <span className={`px-2.5 py-1 rounded-full text-label-sm font-bold whitespace-nowrap ${t}`}>{children}</span>;
}

export function Spinner({ className = '' }: { className?: string }) {
  return <div className={`w-10 h-10 rounded-full border-4 border-surface-container-highest border-t-primary animate-spin ${className}`} />;
}

export function Empty({ icon, title, text, action }: { icon: IconName; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-12 text-on-surface-variant">
      <div className="w-16 h-16 rounded-2xl bg-primary-fixed text-on-primary-fixed-variant flex items-center justify-center mb-4">
        <Icon name={icon} size={30} />
      </div>
      <div className="font-display text-headline-sm text-on-surface">{title}</div>
      {text && <p className="text-body-sm mt-1 max-w-[28ch]">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl bg-error-container text-on-error-container p-4 text-body-sm flex items-start gap-3">
      <Icon name="warning" size={20} />
      <div className="flex-1">{message}</div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-semibold underline">
          Retry
        </button>
      )}
    </div>
  );
}

/** Lesson/unit "Save to…" selector button. */
export function GroupSelector({ unit, lesson, onClick, compact }: { unit?: string; lesson?: string; onClick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 text-left bg-surface-container-lowest border border-outline-variant/60 rounded-xl px-3 ${compact ? 'min-h-[52px]' : 'min-h-[60px]'}`}
    >
      <span className="w-10 h-10 rounded-xl bg-primary-fixed text-on-primary-fixed-variant flex items-center justify-center shrink-0">
        <Icon name="folder" size={20} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-label-sm text-on-surface-variant truncate">{unit ?? 'No unit yet'}</span>
        <span className="block text-body-md font-semibold text-on-surface truncate">{lesson ?? 'Choose a lesson'}</span>
      </span>
      <Icon name="chevronDown" size={20} className="text-on-surface-variant" />
    </button>
  );
}
