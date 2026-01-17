// ============================================================================
// STATUS BADGE COMPONENT
// Modern pill-shaped badges with gradient backgrounds and pulse animations
// ============================================================================

import { clsx } from 'clsx';

type BadgeStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'live';
type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';
type BadgeVariant = 'solid' | 'soft' | 'outline' | 'glow';

interface StatusBadgeProps {
  status: BadgeStatus;
  children: React.ReactNode;
  size?: BadgeSize;
  variant?: BadgeVariant;
  icon?: React.ReactNode;
  pulse?: boolean;
  dot?: boolean;
  className?: string;
}

// Color configurations for each status
const STATUS_COLORS: Record<BadgeStatus, {
  solid: string;
  soft: string;
  outline: string;
  glow: string;
  dot: string;
  text: string;
}> = {
  success: {
    solid: 'bg-gradient-to-r from-emerald-600 to-emerald-500 text-white',
    soft: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    outline: 'border-emerald-500/50 text-emerald-400',
    glow: 'bg-emerald-500/20 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.3)]',
    dot: 'bg-emerald-500',
    text: 'text-emerald-400',
  },
  warning: {
    solid: 'bg-gradient-to-r from-amber-600 to-amber-500 text-white',
    soft: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    outline: 'border-amber-500/50 text-amber-400',
    glow: 'bg-amber-500/20 text-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.3)]',
    dot: 'bg-amber-500',
    text: 'text-amber-400',
  },
  error: {
    solid: 'bg-gradient-to-r from-rose-600 to-rose-500 text-white',
    soft: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    outline: 'border-rose-500/50 text-rose-400',
    glow: 'bg-rose-500/20 text-rose-400 shadow-[0_0_12px_rgba(244,63,94,0.3)]',
    dot: 'bg-rose-500',
    text: 'text-rose-400',
  },
  info: {
    solid: 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white',
    soft: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
    outline: 'border-indigo-500/50 text-indigo-400',
    glow: 'bg-indigo-500/20 text-indigo-400 shadow-[0_0_12px_rgba(99,102,241,0.3)]',
    dot: 'bg-indigo-500',
    text: 'text-indigo-400',
  },
  neutral: {
    solid: 'bg-gradient-to-r from-surface-600 to-surface-500 text-surface-100',
    soft: 'bg-surface-700/50 text-surface-300 border-surface-600/50',
    outline: 'border-surface-600 text-surface-400',
    glow: 'bg-surface-700/50 text-surface-300 shadow-[0_0_12px_rgba(148,163,184,0.1)]',
    dot: 'bg-surface-500',
    text: 'text-surface-400',
  },
  live: {
    solid: 'bg-gradient-to-r from-emerald-600 to-teal-500 text-white',
    soft: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    outline: 'border-emerald-500/50 text-emerald-400',
    glow: 'bg-emerald-500/20 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.4)]',
    dot: 'bg-emerald-500',
    text: 'text-emerald-400',
  },
};

// Size configurations
const SIZE_CLASSES: Record<BadgeSize, {
  padding: string;
  text: string;
  dot: string;
  icon: string;
}> = {
  xs: { padding: 'px-1.5 py-0.5', text: 'text-[10px]', dot: 'w-1.5 h-1.5', icon: 'w-2.5 h-2.5' },
  sm: { padding: 'px-2 py-0.5', text: 'text-xs', dot: 'w-2 h-2', icon: 'w-3 h-3' },
  md: { padding: 'px-2.5 py-1', text: 'text-xs', dot: 'w-2 h-2', icon: 'w-3.5 h-3.5' },
  lg: { padding: 'px-3 py-1.5', text: 'text-sm', dot: 'w-2.5 h-2.5', icon: 'w-4 h-4' },
};

export function StatusBadge({
  status,
  children,
  size = 'sm',
  variant = 'soft',
  icon,
  pulse = false,
  dot = false,
  className,
}: StatusBadgeProps) {
  const colorConfig = STATUS_COLORS[status];
  const sizeConfig = SIZE_CLASSES[size];

  // Auto-enable pulse for live status
  const shouldPulse = pulse || status === 'live';

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full font-medium',
        'transition-all duration-200',
        sizeConfig.padding,
        sizeConfig.text,
        colorConfig[variant],
        variant === 'outline' && 'border',
        variant !== 'solid' && 'border',
        className
      )}
    >
      {/* Status dot indicator */}
      {dot && (
        <span className="relative flex">
          <span
            className={clsx(
              'rounded-full',
              sizeConfig.dot,
              colorConfig.dot
            )}
          />
          {shouldPulse && (
            <span
              className={clsx(
                'absolute inset-0 rounded-full animate-ping',
                colorConfig.dot,
                'opacity-75'
              )}
            />
          )}
        </span>
      )}

      {/* Icon */}
      {icon && (
        <span className={clsx('flex-shrink-0', sizeConfig.icon)}>
          {icon}
        </span>
      )}

      {/* Label text */}
      <span>{children}</span>
    </span>
  );
}

// ============================================================================
// PRESET BADGES - Common status indicators
// ============================================================================

interface PresetBadgeProps {
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
}

export function LiveBadge({ size = 'sm', variant = 'glow', className }: PresetBadgeProps) {
  return (
    <StatusBadge status="live" size={size} variant={variant} dot pulse className={className}>
      Live
    </StatusBadge>
  );
}

export function OnlineBadge({ size = 'sm', variant = 'soft', className }: PresetBadgeProps) {
  return (
    <StatusBadge status="success" size={size} variant={variant} dot className={className}>
      Online
    </StatusBadge>
  );
}

export function OfflineBadge({ size = 'sm', variant = 'soft', className }: PresetBadgeProps) {
  return (
    <StatusBadge status="neutral" size={size} variant={variant} dot className={className}>
      Offline
    </StatusBadge>
  );
}

export function PendingBadge({ size = 'sm', variant = 'soft', className }: PresetBadgeProps) {
  return (
    <StatusBadge status="warning" size={size} variant={variant} dot pulse className={className}>
      Pending
    </StatusBadge>
  );
}

export function ErrorBadge({ size = 'sm', variant = 'soft', className }: PresetBadgeProps) {
  return (
    <StatusBadge
      status="error"
      size={size}
      variant={variant}
      icon={
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01" />
        </svg>
      }
      className={className}
    >
      Error
    </StatusBadge>
  );
}

export function NewBadge({ size = 'xs', variant = 'solid', className }: PresetBadgeProps) {
  return (
    <StatusBadge status="info" size={size} variant={variant} className={className}>
      New
    </StatusBadge>
  );
}

export function BetaBadge({ size = 'xs', variant = 'outline', className }: PresetBadgeProps) {
  return (
    <StatusBadge status="warning" size={size} variant={variant} className={className}>
      Beta
    </StatusBadge>
  );
}

// ============================================================================
// COUNT BADGE - For notification counts
// ============================================================================

interface CountBadgeProps {
  count: number;
  max?: number;
  status?: 'success' | 'warning' | 'error' | 'info' | 'neutral';
  size?: BadgeSize;
  className?: string;
}

export function CountBadge({
  count,
  max = 99,
  status = 'error',
  size = 'xs',
  className,
}: CountBadgeProps) {
  const displayCount = count > max ? `${max}+` : count.toString();

  if (count <= 0) return null;

  return (
    <span
      className={clsx(
        'inline-flex items-center justify-center rounded-full font-bold',
        'min-w-[1.25rem] aspect-square',
        STATUS_COLORS[status].solid,
        size === 'xs' && 'text-[10px] min-w-[1rem]',
        size === 'sm' && 'text-xs min-w-[1.25rem]',
        size === 'md' && 'text-xs min-w-[1.5rem]',
        size === 'lg' && 'text-sm min-w-[1.75rem]',
        // Expand for 2+ digit numbers
        count > 9 && 'px-1.5',
        className
      )}
    >
      {displayCount}
    </span>
  );
}
