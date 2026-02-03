// ============================================================================
// GIT REMOTE COMPONENT - Push/Pull/Fetch operations
// ============================================================================

import { clsx } from 'clsx';

interface GitRemoteProps {
  hasRemote: boolean;
  ahead: number;
  behind: number;
  isPushing: boolean;
  isPulling: boolean;
  isFetching: boolean;
  isMerging: boolean;
  mergeInProgress: boolean;
  onPush: () => void;
  onPull: () => void;
  onFetch: () => void;
  onShowMergeModal: () => void;
}

export function GitRemote({
  hasRemote,
  ahead,
  behind,
  isPushing,
  isPulling,
  isFetching,
  isMerging,
  mergeInProgress,
  onPush,
  onPull,
  onFetch,
  onShowMergeModal,
}: GitRemoteProps) {
  return (
    <div className="flex gap-1">
      {/* Push Button */}
      <button
        onClick={onPush}
        disabled={isPushing || !hasRemote || ahead === 0}
        className={clsx(
          'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors',
          hasRemote && ahead > 0
            ? 'bg-success-500/20 text-success-400 hover:bg-success-500/30'
            : 'bg-surface-800 text-surface-500 cursor-not-allowed'
        )}
        title={hasRemote
          ? (ahead > 0 ? `Push ${ahead} commit${ahead !== 1 ? 's' : ''}` : 'Nothing to push')
          : 'No remote configured'}
      >
        {isPushing ? (
          <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
          </svg>
        )}
        {ahead > 0 && <span>{ahead}</span>}
      </button>

      {/* Pull Button */}
      <button
        onClick={onPull}
        disabled={isPulling || !hasRemote || behind === 0}
        className={clsx(
          'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors',
          hasRemote && behind > 0
            ? 'bg-warning-500/20 text-warning-400 hover:bg-warning-500/30'
            : 'bg-surface-800 text-surface-500 cursor-not-allowed'
        )}
        title={hasRemote
          ? (behind > 0 ? `Pull ${behind} commit${behind !== 1 ? 's' : ''}` : 'Up to date')
          : 'No remote configured'}
      >
        {isPulling ? (
          <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 13l-5 5m0 0l-5-5m5 5V6" />
          </svg>
        )}
        {behind > 0 && <span>{behind}</span>}
      </button>

      {/* Fetch Button */}
      <button
        onClick={onFetch}
        disabled={isFetching || !hasRemote}
        className={clsx(
          'px-2 py-1.5 text-xs rounded transition-colors',
          hasRemote
            ? 'bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-surface-200'
            : 'bg-surface-800 text-surface-500 cursor-not-allowed'
        )}
        title={hasRemote ? 'Fetch from remote' : 'No remote configured'}
      >
        {isFetching ? (
          <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        )}
      </button>

      {/* Merge Button */}
      <button
        onClick={onShowMergeModal}
        disabled={isMerging || mergeInProgress}
        className={clsx(
          'px-2 py-1.5 text-xs rounded transition-colors',
          mergeInProgress
            ? 'bg-warning-500/20 text-warning-400'
            : 'bg-surface-800 hover:bg-surface-700 text-surface-400 hover:text-surface-200'
        )}
        title={mergeInProgress ? 'Merge in progress' : 'Merge branch'}
      >
        {isMerging ? (
          <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
        )}
      </button>
    </div>
  );
}
