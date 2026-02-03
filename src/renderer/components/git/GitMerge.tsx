// ============================================================================
// GIT MERGE COMPONENT - Merge operations and modal
// ============================================================================

import type { ExtendedGitBranchInfo, MergeOptions } from './types';

interface GitMergeProps {
  cwd: string;
  branch: string;
  mergeInProgress: boolean;
  cherryPickInProgress: boolean;
  localBranches: ExtendedGitBranchInfo[];
  showMergeModal: boolean;
  mergeBranch: string | null;
  mergeOptions: MergeOptions;
  onMergeBranchChange: (branch: string | null) => void;
  onMergeOptionsChange: (options: MergeOptions) => void;
  onMerge: () => void;
  onMergeAbort: () => void;
  onCloseMergeModal: () => void;
  onCherryPickContinue: () => void;
  onCherryPickAbort: () => void;
}

export function GitMerge({
  branch,
  mergeInProgress,
  cherryPickInProgress,
  localBranches,
  showMergeModal,
  mergeBranch,
  mergeOptions,
  onMergeBranchChange,
  onMergeOptionsChange,
  onMerge,
  onMergeAbort,
  onCloseMergeModal,
  onCherryPickContinue,
  onCherryPickAbort,
}: GitMergeProps) {
  return (
    <>
      {/* Merge in progress banner */}
      {mergeInProgress && (
        <div className="flex items-center justify-between px-2 py-1.5 bg-warning-500/20 border border-warning-500/30 rounded text-xs">
          <span className="text-warning-400">Merge in progress - resolve conflicts and commit</span>
          <button
            onClick={onMergeAbort}
            className="px-2 py-0.5 bg-warning-500/30 hover:bg-warning-500/40 text-warning-300 rounded transition-colors"
          >
            Abort
          </button>
        </div>
      )}

      {/* Cherry-pick in progress banner */}
      {cherryPickInProgress && (
        <div className="flex items-center justify-between px-2 py-1.5 bg-accent-500/20 border border-accent-500/30 rounded text-xs">
          <span className="text-accent-400">Cherry-pick in progress</span>
          <div className="flex gap-1">
            <button
              onClick={onCherryPickContinue}
              className="px-2 py-0.5 bg-success-500/30 hover:bg-success-500/40 text-success-300 rounded transition-colors"
            >
              Continue
            </button>
            <button
              onClick={onCherryPickAbort}
              className="px-2 py-0.5 bg-accent-500/30 hover:bg-accent-500/40 text-accent-300 rounded transition-colors"
            >
              Abort
            </button>
          </div>
        </div>
      )}

      {/* Merge Modal */}
      {showMergeModal && (
        <MergeModal
          branch={branch}
          localBranches={localBranches}
          mergeBranch={mergeBranch}
          mergeOptions={mergeOptions}
          onMergeBranchChange={onMergeBranchChange}
          onMergeOptionsChange={onMergeOptionsChange}
          onMerge={onMerge}
          onClose={onCloseMergeModal}
        />
      )}
    </>
  );
}

// ============================================================================
// MERGE MODAL
// ============================================================================

interface MergeModalProps {
  branch: string;
  localBranches: ExtendedGitBranchInfo[];
  mergeBranch: string | null;
  mergeOptions: MergeOptions;
  onMergeBranchChange: (branch: string | null) => void;
  onMergeOptionsChange: (options: MergeOptions) => void;
  onMerge: () => void;
  onClose: () => void;
}

function MergeModal({
  branch,
  localBranches,
  mergeBranch,
  mergeOptions,
  onMergeBranchChange,
  onMergeOptionsChange,
  onMerge,
  onClose,
}: MergeModalProps) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700">
          <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <span className="font-medium text-surface-100">Merge Branch</span>
        </div>

        {/* Modal Content */}
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-surface-400 mb-1">
              Merge into <span className="font-mono text-primary-400">{branch}</span>
            </label>
            <select
              value={mergeBranch || ''}
              onChange={(e) => onMergeBranchChange(e.target.value || null)}
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

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-surface-300 cursor-pointer">
              <input
                type="checkbox"
                checked={mergeOptions.noFf}
                onChange={(e) => onMergeOptionsChange({ ...mergeOptions, noFf: e.target.checked })}
                className="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
              />
              <span>Create merge commit (--no-ff)</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-surface-300 cursor-pointer">
              <input
                type="checkbox"
                checked={mergeOptions.squash}
                onChange={(e) => onMergeOptionsChange({ ...mergeOptions, squash: e.target.checked })}
                className="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
              />
              <span>Squash commits (--squash)</span>
            </label>
          </div>
        </div>

        {/* Modal Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onMerge}
            disabled={!mergeBranch}
            className="px-4 py-2 text-sm bg-primary-500 hover:bg-primary-600 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded-lg transition-colors"
          >
            Merge
          </button>
        </div>
      </div>
    </div>
  );
}
