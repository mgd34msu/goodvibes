// ============================================================================
// SKELETON LOADING COMPONENT
// Modern shimmer skeleton with pulse and glow effects
// ============================================================================

import React from 'react';
import { clsx } from 'clsx';

interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circular' | 'rectangular' | 'rounded';
  width?: string | number;
  height?: string | number;
  lines?: number;
  animate?: 'shimmer' | 'pulse' | 'none';
}

export function Skeleton({
  className,
  variant = 'text',
  width,
  height,
  lines = 1,
  animate = 'shimmer',
}: SkeletonProps) {
  const variantClasses = {
    text: 'rounded-md h-4',
    circular: 'rounded-full',
    rectangular: 'rounded-lg',
    rounded: 'rounded-xl',
  };

  const animationClasses = {
    shimmer: 'skeleton-shimmer',
    pulse: 'skeleton-pulse',
    none: '',
  };

  const style: React.CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
  };

  // Multi-line text skeleton with staggered widths
  if (lines > 1 && variant === 'text') {
    const lineWidths = generateLineWidths(lines);
    return (
      <div className={clsx('space-y-2.5', className)}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={clsx(
              'skeleton-base',
              variantClasses.text,
              animationClasses[animate]
            )}
            style={{
              ...style,
              width: style.width ?? lineWidths[i],
              animationDelay: animate === 'shimmer' ? `${i * 100}ms` : undefined,
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'skeleton-base',
        variantClasses[variant],
        animationClasses[animate],
        className
      )}
      style={style}
    />
  );
}

// Generate varied line widths for natural text appearance
function generateLineWidths(count: number): string[] {
  const widths: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      // Last line is shorter
      widths.push(`${40 + Math.random() * 30}%`);
    } else if (i === 0) {
      // First line is longer
      widths.push(`${85 + Math.random() * 15}%`);
    } else {
      // Middle lines vary
      widths.push(`${70 + Math.random() * 25}%`);
    }
  }
  return widths;
}

// ============================================================================
// PRE-BUILT SKELETON PATTERNS
// ============================================================================

export function SessionCardSkeleton(): React.JSX.Element {
  return (
    <div className="card-glass p-4 space-y-3">
      {/* Header with title and icon */}
      <div className="flex items-center justify-between">
        <Skeleton width="65%" height={20} variant="rounded" />
        <Skeleton variant="circular" width={28} height={28} />
      </div>

      {/* Description lines */}
      <Skeleton lines={2} />

      {/* Tags/badges */}
      <div className="flex gap-2 pt-1">
        <Skeleton width={64} height={26} variant="rounded" />
        <Skeleton width={80} height={26} variant="rounded" />
        <Skeleton width={56} height={26} variant="rounded" />
      </div>

      {/* Footer with meta info */}
      <div className="flex items-center justify-between pt-2 border-t border-surface-700/30">
        <Skeleton width={100} height={14} />
        <Skeleton width={60} height={14} />
      </div>
    </div>
  );
}

export function AnalyticsCardSkeleton(): React.JSX.Element {
  return (
    <div className="card-glass p-5 space-y-3">
      {/* Label */}
      <Skeleton width="45%" height={14} />

      {/* Large value */}
      <Skeleton width="70%" height={36} variant="rounded" />

      {/* Trend indicator */}
      <div className="flex items-center gap-2">
        <Skeleton variant="circular" width={20} height={20} />
        <Skeleton width={60} height={14} />
      </div>
    </div>
  );
}
