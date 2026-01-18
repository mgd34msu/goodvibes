// ============================================================================
// SESSION VIEW STATE COMPONENTS (Loading, Empty, Error)
// ============================================================================

import { SessionCardSkeleton } from '../../common/Skeleton';

// ============================================================================
// LOADING SKELETON
// ============================================================================

export function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <SessionCardSkeleton key={i} />
      ))}
    </div>
  );
}

// ============================================================================
// EMPTY STATE
// ============================================================================

interface EmptyStateProps {
  filter: string;
  search: string;
}

export function EmptyState({ filter, search }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="text-5xl mb-4">{'\uD83D\uDCCB'}</div>
        <h2 className="text-lg font-semibold text-surface-100 mb-2">
          {search ? 'No matching sessions' : `No ${filter === 'all' ? '' : filter} sessions`}
        </h2>
        <p className="text-sm text-surface-400">
          {search
            ? 'Try a different search term'
            : filter === 'favorites'
              ? 'Star sessions to add them to favorites'
              : filter === 'archived'
                ? 'Archived sessions will appear here'
                : 'Start a new Claude session to see it here'}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// ERROR STATE
// ============================================================================

interface ErrorStateProps {
  error: unknown;
}

export function ErrorState({ error }: ErrorStateProps): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="text-5xl mb-4">{'\uD83D\uDE15'}</div>
        <h2 className="text-lg font-semibold text-surface-100 mb-2">Failed to load sessions</h2>
        <p className="text-sm text-surface-400 mb-4">
          {error instanceof Error ? error.message : 'An unexpected error occurred'}
        </p>
        <button onClick={() => window.location.reload()} className="btn btn-secondary">
          Retry
        </button>
      </div>
    </div>
  );
}
