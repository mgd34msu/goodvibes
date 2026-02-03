// ============================================================================
// TAG CHIP - Visual tag pill component with effects and interactions
// ============================================================================

import React from 'react';
import { clsx } from 'clsx';
import { X, Plus } from 'lucide-react';
import type { Tag } from '../../../shared/types/tag-types';

export interface TagChipProps {
  /** The tag to display */
  tag: Tag;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show usage count badge */
  showCount?: boolean;
  /** Show confidence indicator (for suggested tags) */
  showConfidence?: boolean;
  /** Confidence value (0-1) for suggested tags */
  confidence?: number;
  /** Show remove button on hover */
  removable?: boolean;
  /** Can be clicked to select */
  selectable?: boolean;
  /** Is currently selected */
  selected?: boolean;
  /** Suggested tag style (dashed border, plus icon) */
  suggested?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Remove handler */
  onRemove?: (e: React.MouseEvent) => void;
}

/**
 * TagChip - Visual tag pill component
 *
 * Features:
 * - Color tinting with tag.color
 * - Effect animations (shimmer, glow, pulse)
 * - Size variants (sm, md, lg)
 * - Suggested state with dashed border
 * - Removable with X button on hover
 * - Selectable with selected state
 * - Usage count badge
 * - Confidence indicator
 */
export function TagChip({
  tag,
  size = 'md',
  showCount = false,
  showConfidence = false,
  confidence,
  removable = false,
  selectable = false,
  selected = false,
  suggested = false,
  onClick,
  onRemove,
}: TagChipProps) {
  const [isHovered, setIsHovered] = React.useState(false);

  // Size variant classes
  const sizeClasses = {
    sm: 'text-xs py-0.5 px-1.5',
    md: 'text-sm py-1 px-2',
    lg: 'text-base py-1.5 px-3',
  }[size];

  const iconSize = {
    sm: 'w-3 h-3',
    md: 'w-3.5 h-3.5',
    lg: 'w-4 h-4',
  }[size];

  // Effect animation classes
  const effectClasses = tag.effect
    ? {
        shimmer: 'animate-shimmer-slide',
        glow: 'animate-glow-pulse',
        pulse: 'animate-pulse',
      }[tag.effect]
    : '';

  // Parse tag color for background tint (~15% opacity)
  const getColorStyle = (): React.CSSProperties => {
    if (!tag.color) return {};
    
    // Convert hex to rgba with low opacity for subtle tint
    const hexToRgba = (hex: string, alpha: number = 0.15) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    return {
      backgroundColor: hexToRgba(tag.color),
      borderColor: hexToRgba(tag.color, 0.3),
    };
  };

  const handleClick = () => {
    if (selectable && onClick) {
      onClick();
    }
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRemove) {
      onRemove(e);
    }
  };

  const isInteractive = selectable || removable;

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-1 rounded-full transition-all',
        sizeClasses,
        effectClasses,
        {
          // Border styles
          'border': true,
          'border-dashed': suggested,
          'border-solid': !suggested,
          'border-surface-600': !selected && !suggested,
          'border-primary-500 ring-1 ring-primary-500/50': selected,
          
          // Background styles
          'bg-surface-700/50': !tag.color,
          
          // Interactive styles
          'cursor-pointer hover:bg-surface-600/70': isInteractive,
          'opacity-60 hover:opacity-100': suggested,
          
          // Focus styles
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500': isInteractive,
        }
      )}
      style={tag.color ? getColorStyle() : undefined}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={`${suggested ? 'Suggested tag' : 'Tag'}: ${tag.name}`}
      aria-pressed={selected ? 'true' : undefined}
    >
      {/* Plus icon for suggested tags */}
      {suggested && (
        <Plus className={clsx(iconSize, 'text-surface-400')} />
      )}

      {/* Tag name */}
      <span className="whitespace-nowrap font-medium">
        {tag.name}
      </span>

      {/* Usage count badge */}
      {showCount && tag.usageCount > 0 && (
        <span className={clsx(
          'rounded-full px-1 text-xs font-semibold',
          'bg-surface-600 text-surface-300'
        )}>
          {tag.usageCount}
        </span>
      )}

      {/* Confidence indicator */}
      {showConfidence && confidence !== undefined && (
        <span className={clsx(
          'text-xs font-semibold',
          confidence >= 0.8 ? 'text-green-400' :
          confidence >= 0.6 ? 'text-yellow-400' :
          'text-surface-400'
        )}>
          {Math.round(confidence * 100)}%
        </span>
      )}

      {/* Remove button (shows on hover) */}
      {removable && isHovered && (
        <button
          onClick={handleRemove}
          className={clsx(
            'rounded-full p-0.5 transition-colors',
            'hover:bg-surface-800/70 hover:text-red-400',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500'
          )}
          aria-label={`Remove ${tag.name}`}
        >
          <X className={iconSize} />
        </button>
      )}
    </div>
  );
}

// Re-export icons for external use if needed
export { Plus as PlusIcon, X as XIcon } from 'lucide-react';
