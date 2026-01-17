// ============================================================================
// GIT BRANCHES COMPONENT - Branch management UI
// ============================================================================

import { clsx } from 'clsx';
import type { ExtendedGitBranchInfo } from './types';

interface GitBranchesProps {
  branch: string;
  ahead: number;
  behind: number;
  branches: ExtendedGitBranchInfo[];
  showBranchDropdown: boolean;
  showNewBranchInput: boolean;
  newBranchName: string;
  newBranchError: string | null;
  operationInProgress: string | null;
  branchDropdownRef: React.RefObject<HTMLDivElement | null>;
  onToggleDropdown: () => void;
  onCheckout: (branch: string) => void;
  onCreateBranch: () => void;
  onCancelNewBranch: () => void;
  onShowNewBranchInput: () => void;
  onNewBranchNameChange: (name: string) => void;
  onShowDeleteBranchModal: (branch: string) => void;
}

export function GitBranches({
  branch,
  ahead,
  behind,
  branches,
  showBranchDropdown,
  showNewBranchInput,
  newBranchName,
  newBranchError,
  operationInProgress,
  branchDropdownRef,
  onToggleDropdown,
  onCheckout,
  onCreateBranch,
  onCancelNewBranch,
  onShowNewBranchInput,
  onNewBranchNameChange,
  onShowDeleteBranchModal,
}: GitBranchesProps) {
  // Filter to local branches only
  const localBranches = branches.filter(b => !b.isRemote);

  return (
    <div className="relative dropdown-container" ref={branchDropdownRef}>
      <button
        onClick={onToggleDropdown}
        aria-expanded={showBranchDropdown}
        aria-haspopup="listbox"
        className={clsx(
          'w-full flex items-center gap-2 px-2 py-2 rounded text-sm transition-all duration-200',
          'leading-normal',
          showBranchDropdown
            ? 'bg-gradient-to-b from-primary-500/10 to-primary-600/5 border border-primary-500/50'
            : 'bg-surface-800 hover:bg-surface-700 border border-transparent'
        )}
      >
        <svg className="w-3.5 h-3.5 text-success-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18V6M6 6a3 3 0 100-6 3 3 0 000 6zm12 12a3 3 0 100-6 3 3 0 000 6zm0 0V9a3 3 0 00-3-3H9" />
        </svg>
        <span className="text-surface-100 font-mono truncate flex-1 text-left min-w-0">{branch}</span>
        {(ahead > 0 || behind > 0) && (
          <span className="text-xs text-surface-400 flex-shrink-0">
            {ahead > 0 && <span className="text-success-400">{ahead}+</span>}
            {ahead > 0 && behind > 0 && ' '}
            {behind > 0 && <span className="text-warning-400">{behind}-</span>}
          </span>
        )}
        <svg className={clsx(
          'w-3 h-3 transition-transform duration-200 flex-shrink-0',
          showBranchDropdown ? 'rotate-180 text-primary-400' : 'text-surface-400'
        )} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Branch Dropdown */}
      {showBranchDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-surface-800 border border-surface-700 rounded shadow-lg z-[9960] max-h-64 overflow-y-auto">
          {/* New Branch Input */}
          {showNewBranchInput ? (
            <div className="p-2 border-b border-surface-700">
              <input
                type="text"
                value={newBranchName}
                onChange={(e) => onNewBranchNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCreateBranch();
                  if (e.key === 'Escape') onCancelNewBranch();
                }}
                placeholder="New branch name..."
                className={clsx(
                  'w-full px-2 py-1 text-xs bg-surface-900 border rounded text-surface-100 placeholder-surface-500 focus:outline-none',
                  newBranchError
                    ? 'border-error-500 focus:border-error-500'
                    : 'border-surface-600 focus:border-primary-500'
                )}
                autoFocus
              />
              {/* Inline error message */}
              {newBranchError && (
                <div className="mt-1 px-1 text-[10px] text-error-400">
                  {newBranchError}
                </div>
              )}
              <div className="flex gap-1 mt-1">
                <button
                  onClick={onCreateBranch}
                  disabled={!newBranchName.trim() || operationInProgress === 'creating-branch'}
                  className="flex-1 px-2 py-1 text-xs bg-primary-500 hover:bg-primary-600 disabled:bg-surface-600 text-white rounded"
                >
                  {operationInProgress === 'creating-branch' ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={onCancelNewBranch}
                  className="px-2 py-1 text-xs bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={onShowNewBranchInput}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-primary-400 hover:bg-surface-700 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create new branch...
            </button>
          )}

          {/* Branch List */}
          {localBranches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-surface-500 italic">
              No local branches found
            </div>
          ) : (
            localBranches.map((branchItem) => {
              const hasParent = !!branchItem.parentBranch;
              const isMainBranch = branchItem.name === 'main' || branchItem.name === 'master';
              const canDelete = !branchItem.isCurrent && !isMainBranch;

              return (
                <div
                  key={branchItem.name}
                  className={clsx(
                    'group w-full flex items-center gap-2 py-1.5 text-xs hover:bg-surface-700 transition-colors',
                    branchItem.isCurrent && 'bg-surface-700/50',
                    hasParent ? 'px-5' : 'px-3'
                  )}
                >
                  <button
                    onClick={() => onCheckout(branchItem.name)}
                    disabled={branchItem.isCurrent}
                    className="flex items-center gap-2 flex-1 min-w-0"
                  >
                    {/* Tree line indicator for child branches */}
                    {hasParent && (
                      <span className="text-surface-600 text-[10px] -ml-2 mr-0">
                        {'|_'}
                      </span>
                    )}
                    {branchItem.isCurrent ? (
                      <svg className="w-3 h-3 text-success-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <span className="w-3 flex-shrink-0" />
                    )}
                    <div className="flex flex-col items-start min-w-0 flex-1">
                      <span className={clsx(
                        'font-mono truncate w-full text-left',
                        branchItem.isCurrent ? 'text-surface-100' : 'text-surface-300',
                        isMainBranch && 'font-semibold'
                      )}>
                        {branchItem.name}
                      </span>
                      {/* Show parent branch info */}
                      {hasParent && (
                        <span className="text-[10px] text-surface-500 truncate w-full text-left">
                          from {branchItem.parentBranch}
                          {branchItem.commitsAhead && branchItem.commitsAhead > 0 && (
                            <span className="text-primary-400 ml-1">+{branchItem.commitsAhead}</span>
                          )}
                        </span>
                      )}
                    </div>
                  </button>
                  {canDelete && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowDeleteBranchModal(branchItem.name);
                      }}
                      className="p-1 rounded hover:bg-error-500/20 text-error-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Delete branch"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// DELETE BRANCH MODAL
// ============================================================================

interface DeleteBranchModalProps {
  isOpen: boolean;
  branchToDelete: string | null;
  deleteBranchForce: boolean;
  onClose: () => void;
  onDelete: () => void;
  onForceChange: (force: boolean) => void;
}

export function DeleteBranchModal({
  isOpen,
  branchToDelete,
  deleteBranchForce,
  onClose,
  onDelete,
  onForceChange,
}: DeleteBranchModalProps) {
  if (!isOpen || !branchToDelete) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700 bg-error-500/10">
          <svg className="w-5 h-5 text-error-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <span className="font-medium text-surface-100">Delete Branch</span>
        </div>
        <div className="p-4 space-y-4">
          <p className="text-sm text-surface-300">
            Are you sure you want to delete branch{' '}
            <span className="font-mono text-primary-400">{branchToDelete}</span>?
          </p>
          <label className="flex items-center gap-2 text-sm text-surface-300 cursor-pointer">
            <input
              type="checkbox"
              checked={deleteBranchForce}
              onChange={(e) => onForceChange(e.target.checked)}
              className="rounded border-surface-600 bg-surface-800 text-error-500 focus:ring-error-500"
            />
            <span>Force delete (even if not merged)</span>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            className="px-4 py-2 text-sm bg-error-500 hover:bg-error-600 text-white rounded-lg transition-colors"
          >
            Delete Branch
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CHECKOUT CONFIRMATION MODAL
// ============================================================================

interface CheckoutConfirmModalProps {
  isOpen: boolean;
  pendingCheckoutBranch: string | null;
  stagedCount: number;
  unstagedCount: number;
  onCancel: () => void;
  onDiscardAndCheckout: () => void;
}

export function CheckoutConfirmModal({
  isOpen,
  pendingCheckoutBranch,
  stagedCount,
  unstagedCount,
  onCancel,
  onDiscardAndCheckout,
}: CheckoutConfirmModalProps) {
  if (!isOpen || !pendingCheckoutBranch) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-700 bg-warning-500/10">
          <svg className="w-5 h-5 text-warning-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="font-medium text-surface-100">Uncommitted Changes</span>
        </div>

        {/* Modal Content */}
        <div className="p-4 space-y-4">
          <p className="text-sm text-surface-300">
            You have uncommitted changes that will be lost if you switch to branch{' '}
            <span className="font-mono text-primary-400">{pendingCheckoutBranch}</span>.
          </p>

          {/* Summary of changes */}
          <div className="text-xs text-surface-400 space-y-1">
            {stagedCount > 0 && (
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold text-success-400 bg-success-400/20">S</span>
                <span>{stagedCount} staged file{stagedCount !== 1 ? 's' : ''}</span>
              </div>
            )}
            {unstagedCount > 0 && (
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold text-primary-400 bg-primary-400/20">M</span>
                <span>{unstagedCount} modified file{unstagedCount !== 1 ? 's' : ''}</span>
              </div>
            )}
          </div>

          <p className="text-xs text-surface-500">
            Consider committing your changes first, or discard them to switch branches.
          </p>
        </div>

        {/* Modal Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700 bg-surface-800/50">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onDiscardAndCheckout}
            className="px-4 py-2 text-sm bg-error-500/20 hover:bg-error-500/30 text-error-400 border border-error-500/30 rounded-lg transition-colors"
          >
            Discard Changes & Switch
          </button>
        </div>
      </div>
    </div>
  );
}
