// ============================================================================
// TAG FILTER BUTTON COMPONENT
// Button to open tag filter modal with active filter count badge
// ============================================================================

import { useState } from 'react';
import { clsx } from 'clsx';
import { Filter } from 'lucide-react';

export interface TagFilterButtonProps {
  /** Number of active tag filters */
  activeFilterCount: number;
  /** Click handler to open filter modal */
  onClick: () => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * TagFilterButton - Opens tag filter modal and displays active filter count
 *
 * Features:
 * - Filter icon button
 * - Badge showing count of active filters
 * - Tooltip explaining functionality
 * - Visual highlight when filters are active
 * - Keyboard shortcut hint (T key)
 * - Accessible with proper ARIA labels
 */
export function TagFilterButton({
  activeFilterCount,
  onClick,
  className,
}: TagFilterButtonProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const hasActiveFilters = activeFilterCount > 0;

  return (
    <div className={clsx('relative inline-flex', className)}>
      <button
        onClick={onClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={clsx(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all',
          'text-sm font-medium',
          // Active state (filters applied)
          hasActiveFilters
            ? 'bg-primary-500/20 text-primary-400 hover:bg-primary-500/30'
            : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200',
          // Focus styles
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500'
        )}
        aria-label={`Filter by tags${hasActiveFilters ? ` (${activeFilterCount} active)` : ''} - Press T`}
        title={undefined} // Use custom tooltip instead
      >
        <Filter className="w-4 h-4" />
        <span>Filter Tags</span>

        {/* Badge showing active filter count */}
        {hasActiveFilters && (
          <span
            className={clsx(
              'inline-flex items-center justify-center',
              'min-w-[1.25rem] h-5 px-1.5 rounded-full',
              'text-xs font-semibold',
              'bg-primary-500 text-white'
            )}
            aria-label={`${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
          >
            {activeFilterCount}
          </span>
        )}
      </button>

      {/* Tooltip with keyboard shortcut hint */}
      {showTooltip && (
        <div
          className={clsx(
            'absolute z-[9959] px-2 py-1 text-xs rounded shadow-lg',
            'bg-surface-800 text-surface-200 border border-surface-700',
            'whitespace-nowrap pointer-events-none',
            '-bottom-10 left-1/2 -translate-x-1/2'
          )}
        >
          Filter sessions by tags {hasActiveFilters && `(${activeFilterCount} active)`}
          <span className="ml-1 text-surface-400">• Press</span>
          <kbd className="ml-1 px-1.5 py-0.5 bg-surface-700 rounded text-xs font-mono">T</kbd>
          {/* Arrow pointing up to button */}
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-px">
            <div className="border-4 border-transparent border-b-surface-700" />
          </div>
        </div>
      )}
    </div>
  );
}

// Re-export icon for external use if needed
export { Filter as FilterIcon } from 'lucide-react';
