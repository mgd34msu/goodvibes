// ============================================================================
// LOADING OVERLAY COMPONENT
// Modern glass morphism overlay with gradient progress and glow effects
// ============================================================================

import { clsx } from 'clsx';
import { LoadingSpinner } from './LoadingSpinner';
import { useAppStore } from '../../stores/appStore';

interface LoadingOverlayProps {
  message?: string | null;
  variant?: 'default' | 'minimal' | 'fullscreen';
}

export function LoadingOverlay({ message, variant = 'default' }: LoadingOverlayProps) {
  const progress = useAppStore((s) => s.loadingProgress);
  const percentage = progress ? Math.round((progress.current / progress.total) * 100) : null;

  return (
    <div className={clsx(
      'fixed inset-0 z-[9999] flex items-center justify-center',
      'bg-surface-950/85 backdrop-blur-md',
      'animate-fade-in'
    )}>
      {/* Ambient glow effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-indigo-500/5 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full bg-violet-500/5 blur-2xl animate-pulse" />
      </div>

      {/* Main card */}
      <div className={clsx(
        'relative flex flex-col items-center gap-6 p-8',
        'bg-surface-900/60 backdrop-blur-xl',
        'rounded-2xl border border-surface-700/50',
        'shadow-2xl shadow-black/30',
        variant === 'minimal' && 'p-6 gap-4',
        variant === 'fullscreen' && 'p-10 gap-8'
      )}>
        {/* Spinner with glow */}
        <div className="relative">
          <LoadingSpinner
            size={variant === 'fullscreen' ? 'xl' : 'lg'}
            variant="default"
            color="primary"
          />
          {/* Outer glow ring */}
          <div className="absolute inset-0 rounded-full bg-indigo-500/20 blur-lg animate-pulse" />
        </div>

        {/* Text content */}
        <div className="text-center space-y-1">
          <h2 className={clsx(
            'font-semibold text-surface-50',
            variant === 'fullscreen' ? 'text-xl' : 'text-lg'
          )}>
            Loading
          </h2>
          {message && (
            <p className={clsx(
              'text-surface-400 max-w-xs',
              variant === 'fullscreen' ? 'text-base' : 'text-sm'
            )}>
              {message}
            </p>
          )}
        </div>

        {/* Progress bar */}
        {progress && (
          <div className="w-72 space-y-2">
            {/* Progress header */}
            <div className="flex justify-between items-center text-xs">
              <span className="text-surface-400 font-medium">Progress</span>
              <span className="text-surface-300 font-semibold tabular-nums">
                {percentage}%
              </span>
            </div>

            {/* Progress track */}
            <div className="relative h-2 bg-surface-800/80 rounded-full overflow-hidden">
              {/* Background shimmer */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-surface-700/30 to-transparent animate-shimmer" />

              {/* Progress fill with gradient and glow */}
              <div
                className={clsx(
                  'relative h-full rounded-full transition-all duration-500 ease-out',
                  'bg-gradient-to-r from-indigo-600 via-violet-500 to-indigo-500',
                  'shadow-[0_0_12px_rgba(99,102,241,0.6)]'
                )}
                style={{ width: `${percentage}%` }}
              >
                {/* Leading edge glow */}
                <div className="absolute right-0 top-0 bottom-0 w-4 bg-gradient-to-l from-white/30 to-transparent rounded-r-full" />
              </div>
            </div>

            {/* Progress details */}
            <div className="flex justify-between text-xs text-surface-500">
              <span>{progress.current} completed</span>
              <span>{progress.total - progress.current} remaining</span>
            </div>
          </div>
        )}

        {/* Decorative elements */}
        <div className="absolute top-0 left-0 w-20 h-20 border-l-2 border-t-2 border-indigo-500/20 rounded-tl-2xl" />
        <div className="absolute bottom-0 right-0 w-20 h-20 border-r-2 border-b-2 border-indigo-500/20 rounded-br-2xl" />
      </div>
    </div>
  );
}

// ============================================================================
// PROGRESS BAR COMPONENT - Standalone reusable progress bar
// ============================================================================

interface ProgressBarProps {
  value: number;
  max?: number;
  size?: 'sm' | 'md' | 'lg';
  color?: 'primary' | 'success' | 'warning' | 'error';
  showLabel?: boolean;
  className?: string;
}

const PROGRESS_COLORS = {
  primary: {
    gradient: 'from-indigo-600 via-violet-500 to-indigo-500',
    glow: 'shadow-[0_0_12px_rgba(99,102,241,0.5)]',
  },
  success: {
    gradient: 'from-emerald-600 via-teal-500 to-emerald-500',
    glow: 'shadow-[0_0_12px_rgba(16,185,129,0.5)]',
  },
  warning: {
    gradient: 'from-amber-600 via-orange-500 to-amber-500',
    glow: 'shadow-[0_0_12px_rgba(245,158,11,0.5)]',
  },
  error: {
    gradient: 'from-rose-600 via-red-500 to-rose-500',
    glow: 'shadow-[0_0_12px_rgba(244,63,94,0.5)]',
  },
};

const PROGRESS_SIZES = {
  sm: 'h-1',
  md: 'h-2',
  lg: 'h-3',
};

export function ProgressBar({
  value,
  max = 100,
  size = 'md',
  color = 'primary',
  showLabel = false,
  className,
}: ProgressBarProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));
  const colorConfig = PROGRESS_COLORS[color];

  return (
    <div className={clsx('w-full', className)}>
      {showLabel && (
        <div className="flex justify-between text-xs text-surface-400 mb-1">
          <span>Progress</span>
          <span className="font-medium text-surface-300">{Math.round(percentage)}%</span>
        </div>
      )}
      <div className={clsx(
        'relative bg-surface-800/80 rounded-full overflow-hidden',
        PROGRESS_SIZES[size]
      )}>
        <div
          className={clsx(
            'h-full rounded-full transition-all duration-300 ease-out',
            'bg-gradient-to-r',
            colorConfig.gradient,
            colorConfig.glow
          )}
          style={{ width: `${percentage}%` }}
        >
          {/* Leading edge highlight */}
          <div className="absolute right-0 top-0 bottom-0 w-2 bg-gradient-to-l from-white/25 to-transparent rounded-r-full" />
        </div>
      </div>
    </div>
  );
}
