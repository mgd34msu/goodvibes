// ============================================================================
// LOADING SPINNER COMPONENT
// Modern gradient spinner with glow effect and multiple variants
// ============================================================================

import { clsx } from 'clsx';

interface LoadingSpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'default' | 'dots' | 'pulse' | 'orbital';
  className?: string;
  color?: 'primary' | 'success' | 'warning' | 'error';
  /** Screen reader label for accessibility */
  label?: string;
}

const SIZE_CLASSES = {
  xs: { container: 'w-3 h-3', border: 'border', dot: 'w-1 h-1' },
  sm: { container: 'w-4 h-4', border: 'border-2', dot: 'w-1.5 h-1.5' },
  md: { container: 'w-6 h-6', border: 'border-2', dot: 'w-2 h-2' },
  lg: { container: 'w-10 h-10', border: 'border-[3px]', dot: 'w-2.5 h-2.5' },
  xl: { container: 'w-14 h-14', border: 'border-4', dot: 'w-3 h-3' },
};

const COLOR_CLASSES = {
  primary: {
    gradient: 'from-indigo-500 via-violet-500 to-indigo-500',
    glow: 'shadow-[0_0_15px_rgba(99,102,241,0.5)]',
    dot: 'bg-indigo-500',
    ring: 'border-indigo-500/30',
    accent: 'border-t-indigo-500',
  },
  success: {
    gradient: 'from-emerald-500 via-teal-500 to-emerald-500',
    glow: 'shadow-[0_0_15px_rgba(16,185,129,0.5)]',
    dot: 'bg-emerald-500',
    ring: 'border-emerald-500/30',
    accent: 'border-t-emerald-500',
  },
  warning: {
    gradient: 'from-amber-500 via-orange-500 to-amber-500',
    glow: 'shadow-[0_0_15px_rgba(245,158,11,0.5)]',
    dot: 'bg-amber-500',
    ring: 'border-amber-500/30',
    accent: 'border-t-amber-500',
  },
  error: {
    gradient: 'from-rose-500 via-red-500 to-rose-500',
    glow: 'shadow-[0_0_15px_rgba(244,63,94,0.5)]',
    dot: 'bg-rose-500',
    ring: 'border-rose-500/30',
    accent: 'border-t-rose-500',
  },
};

export function LoadingSpinner({
  size = 'md',
  variant = 'default',
  className,
  color = 'primary',
  label = 'Loading...',
}: LoadingSpinnerProps) {
  const sizeConfig = SIZE_CLASSES[size];
  const colorConfig = COLOR_CLASSES[color];

  // Default: Gradient ring spinner with glow
  if (variant === 'default') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={clsx('relative', sizeConfig.container, className)}
      >
        {/* Glow layer */}
        <div
          aria-hidden="true"
          className={clsx(
            'absolute inset-0 rounded-full opacity-50 blur-sm animate-spin',
            sizeConfig.border,
            'border-transparent',
            colorConfig.accent
          )}
        />
        {/* Main spinner ring */}
        <div
          aria-hidden="true"
          className={clsx(
            'absolute inset-0 rounded-full animate-spin',
            sizeConfig.border,
            'border-surface-700/50',
            colorConfig.accent
          )}
        />
        {/* Inner glow dot */}
        <div
          aria-hidden="true"
          className={clsx(
            'absolute inset-0 flex items-center justify-center'
          )}
        >
          <div
            className={clsx(
              'rounded-full animate-pulse',
              colorConfig.dot,
              colorConfig.glow,
              size === 'xs' && 'w-0.5 h-0.5',
              size === 'sm' && 'w-1 h-1',
              size === 'md' && 'w-1.5 h-1.5',
              size === 'lg' && 'w-2 h-2',
              size === 'xl' && 'w-2.5 h-2.5'
            )}
          />
        </div>
        {/* Screen reader only label */}
        <span className="sr-only">{label}</span>
      </div>
    );
  }

  // Dots variant: Three bouncing dots
  if (variant === 'dots') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={clsx('flex items-center gap-1', className)}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className={clsx(
              'rounded-full',
              colorConfig.dot,
              colorConfig.glow,
              sizeConfig.dot,
              'animate-bounce'
            )}
            style={{
              animationDelay: `${i * 150}ms`,
              animationDuration: '600ms',
            }}
          />
        ))}
        <span className="sr-only">{label}</span>
      </div>
    );
  }

  // Pulse variant: Expanding ring
  if (variant === 'pulse') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={clsx('relative', sizeConfig.container, className)}
      >
        {/* Pulsing rings */}
        <div
          aria-hidden="true"
          className={clsx(
            'absolute inset-0 rounded-full',
            sizeConfig.border,
            colorConfig.ring,
            'animate-ping'
          )}
        />
        <div
          aria-hidden="true"
          className={clsx(
            'absolute inset-0 rounded-full',
            sizeConfig.border,
            colorConfig.ring,
            'animate-ping'
          )}
          style={{ animationDelay: '300ms' }}
        />
        {/* Center dot */}
        <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          <div
            className={clsx(
              'rounded-full',
              colorConfig.dot,
              colorConfig.glow,
              sizeConfig.dot
            )}
          />
        </div>
        <span className="sr-only">{label}</span>
      </div>
    );
  }

  // Orbital variant: Orbiting dots
  if (variant === 'orbital') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={clsx('relative', sizeConfig.container, className)}
      >
        {/* Orbit track */}
        <div
          aria-hidden="true"
          className={clsx(
            'absolute inset-0 rounded-full border border-surface-700/30'
          )}
        />
        {/* Orbiting dot */}
        <div aria-hidden="true" className="absolute inset-0 animate-spin" style={{ animationDuration: '1s' }}>
          <div
            className={clsx(
              'absolute rounded-full',
              colorConfig.dot,
              colorConfig.glow,
              sizeConfig.dot
            )}
            style={{
              top: '0',
              left: '50%',
              transform: 'translate(-50%, -50%)',
            }}
          />
        </div>
        {/* Second orbiting dot (opposite) */}
        <div
          aria-hidden="true"
          className="absolute inset-0 animate-spin"
          style={{ animationDuration: '1s', animationDelay: '500ms' }}
        >
          <div
            className={clsx(
              'absolute rounded-full opacity-50',
              colorConfig.dot,
              sizeConfig.dot
            )}
            style={{
              bottom: '0',
              left: '50%',
              transform: 'translate(-50%, 50%)',
            }}
          />
        </div>
        <span className="sr-only">{label}</span>
      </div>
    );
  }

  return null;
}

// Inline loading indicator for text
export function InlineLoader({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={clsx('inline-flex items-center gap-0.5', className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1 h-1 rounded-full bg-current animate-bounce"
          style={{
            animationDelay: `${i * 100}ms`,
            animationDuration: '500ms',
          }}
        />
      ))}
    </span>
  );
}
