// ============================================================================
// SESSION FILTERS COMPONENT
// ============================================================================

import { clsx } from 'clsx';
import type { SessionFiltersProps, SessionFilter } from './types';

const FILTER_OPTIONS: SessionFilter[] = ['all', 'favorites', 'archived'];

export function SessionFilters({
  filter,
  onFilterChange,
  search,
  onSearchChange,
  tagFilterButton,
}: SessionFiltersProps) {
  return (
    <div className="px-5 py-4 border-b border-surface-800 bg-surface-900/80 h-[68px] flex items-center">
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-surface-100">Session History</h2>
          {/* Filter tabs - inline with title */}
          <div className="flex items-center gap-1.5">
            {FILTER_OPTIONS.map((f) => (
              <button
                key={f}
                onClick={() => onFilterChange(f)}
                className={clsx(
                  'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors',
                  filter === f
                    ? 'bg-primary-500/20 text-primary-400'
                    : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200'
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
            {/* Tag Filter Button */}
            {tagFilterButton}
          </div>
        </div>
        <input
          type="text"
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="input w-56 text-sm"
        />
      </div>
    </div>
  );
}
