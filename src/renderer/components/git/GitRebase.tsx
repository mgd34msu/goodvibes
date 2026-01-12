// ============================================================================
// GIT REBASE COMPONENT - Rebase operations and modal
// ============================================================================

import type { ExtendedGitBranchInfo, GitReflogEntry } from './types';

interface GitRebaseProps {
  branch: string;
  rebaseInProgress: boolean;
  localBranches: ExtendedGitBranchInfo[];
  showRebaseModal: boolean;
  rebaseBranch: string | null;
  showReflogModal: boolean;
  reflogEntries: GitReflogEntry[];
  isLoadingReflog: boolean;
  formatRelativeTime: (dateStr: string) => string;
  onRebaseBranchChange: (branch: string | null) => void;
  onShowRebaseModal: () => void;
  onCloseRebaseModal: () => void;
  onRebase: () => void;
  onRebaseAbort: () => void;
  onRebaseContinue: () => void;
  onRebaseSkip: () => void;
  onViewReflog: () => void;
  onCloseReflogModal: () => void;
  onResetToReflog: (index: number, hard: boolean) => void;
}

export function GitRebase({
  branch,
  rebaseInProgress,
  localBranches,
  showRebaseModal,
  rebaseBranch,
  showReflogModal,
  reflogEntries,
  isLoadingReflog,
  formatRelativeTime,
  onRebaseBranchChange,
  onShowRebaseModal,
  onCloseRebaseModal,
  onRebase,
  onRebaseAbort,
  onRebaseContinue,
  onRebaseSkip,
  onViewReflog,
  onCloseReflogModal,
  onResetToReflog,
}: GitRebaseProps) {
  return (
    <>
      {/* Rebase in progress banner */}
      {rebaseInProgress && (
        <div className="flex items-center justify-between px-2 py-1.5 bg-accent-500/20 border border-accent-500/30 rounded text-xs">
          <span className="text-accent-400">Rebase in progress</span>
          <div className="flex gap-1">
            <button
              onClick={onRebaseContinue}
              className="px-2 py-0.5 bg-success-500/30 hover:bg-success-500/40 text-success-300 rounded transition-colors"
            >
              Continue
            </button>
            <button
              onClick={onRebaseSkip}
              className="px-2 py-0.5 bg-warning-500/30 hover:bg-warning-500/40 text-warning-300 rounded transition-colors"
            >
              Skip
            </button>
            <button
              onClick={onRebaseAbort}
              className="px-2 py-0.5 bg-accent-500/30 hover:bg-accent-500/40 text-accent-300 rounded transition-colors"
            >
              Abort
            </button>
          </div>
        </div>
      )}

      {/* Reflog Button */}
      <button
        onClick={onViewReflog}
        className="w-full flex items-center gap-2 px-2 py-1.5 bg-surface-800 hover:bg-surface-700 rounded text-xs text-surface-400 hover:text-surface-200 transition-colors"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>View Reflog</span>
      </button>

      {/* Rebase Button */}
      <button
        onClick={onShowRebaseModal}
        disabled={rebaseInProgress}
        className="w-full flex items-center gap-2 px-2 py-1.5 bg-surface-800 hover:bg-surface-700 rounded text-xs text-surface-400 hover:text-surface-200 transition-colors disabled:opacity-50"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span>Rebase onto...</span>
      </button>

      {/* Rebase Modal */}
      {showRebaseModal && (
        <RebaseModal
          branch={branch}
          localBranches={localBranches}
          rebaseBranch={rebaseBranch}
          onRebaseBranchChange={onRebaseBranchChange}
          onRebase={onRebase}
          onClose={onCloseRebaseModal}
        />
      )}

      {/* Reflog Modal */}
      {showReflogModal && (
        <ReflogModal
          reflogEntries={reflogEntries}
          isLoadingReflog={isLoadingReflog}
          formatRelativeTime={formatRelativeTime}
          onResetToReflog={onResetToReflog}
          onClose={onCloseReflogModal}
        />
      )}
    </>
  );
}

// ============================================================================
// REBASE MODAL
// ============================================================================

interface RebaseModalProps {
  branch: string;
  localBranches: ExtendedGitBranchInfo[];
  rebaseBranch: string | null;
  onRebaseBranchChange: (branch: string | null) => void;
  onRebase: () => void;
  onClose: () => void;
}

function RebaseModal({
  branch,
  localBranches,
  rebaseBranch,
  onRebaseBranchChange,
  onRebase,
  onClose,
}: RebaseModalProps) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700">
          <svg className="w-5 h-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span className="font-medium text-surface-100">Rebase onto Branch</span>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-surface-400 mb-1">
              Rebase <span className="font-mono text-primary-400">{branch}</span> onto
            </label>
            <select
              value={rebaseBranch || ''}
              onChange={(e) => onRebaseBranchChange(e.target.value || null)}
              className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 focus:outline-none focus:border-primary-500"
            >
              <option value="">Select a branch...</option>
              {localBranches
                .filter(b => b.name !== branch)
                .map(b => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
            </select>
          </div>
          <p className="text-xs text-surface-500">
            This will replay your commits on top of the selected branch. May cause conflicts that need to be resolved.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onRebase}
            disabled={!rebaseBranch}
            className="px-4 py-2 text-sm bg-accent-500 hover:bg-accent-600 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded-lg transition-colors"
          >
            Rebase
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// REFLOG MODAL
// ============================================================================

interface ReflogModalProps {
  reflogEntries: GitReflogEntry[];
  isLoadingReflog: boolean;
  formatRelativeTime: (dateStr: string) => string;
  onResetToReflog: (index: number, hard: boolean) => void;
  onClose: () => void;
}

function ReflogModal({
  reflogEntries,
  isLoadingReflog,
  formatRelativeTime,
  onResetToReflog,
  onClose,
}: ReflogModalProps) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-medium text-surface-100">Reflog - HEAD History</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoadingReflog ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
            </div>
          ) : reflogEntries.length === 0 ? (
            <div className="text-center py-8 text-surface-500">No reflog entries</div>
          ) : (
            <div className="divide-y divide-surface-800">
              {reflogEntries.map((entry) => (
                <div key={entry.index} className="group flex items-center gap-3 px-4 py-2 hover:bg-surface-800/50">
                  <span className="text-primary-400 font-mono text-xs">{entry.shortHash}</span>
                  <span className="px-1.5 py-0.5 text-[10px] bg-surface-700 text-surface-400 rounded">{entry.action}</span>
                  <span className="flex-1 text-sm text-surface-200 truncate">{entry.message}</span>
                  <span className="text-xs text-surface-500">{formatRelativeTime(entry.date)}</span>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => onResetToReflog(entry.index, false)}
                      className="px-2 py-1 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                      title="Soft reset"
                    >
                      Reset
                    </button>
                    <button
                      onClick={() => onResetToReflog(entry.index, true)}
                      className="px-2 py-1 text-[10px] bg-error-500/20 hover:bg-error-500/30 text-error-400 rounded"
                      title="Hard reset (discards changes)"
                    >
                      Hard
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
