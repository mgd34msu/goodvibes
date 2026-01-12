// ============================================================================
// GIT STASH COMPONENT - Stash operations
// ============================================================================

import { clsx } from 'clsx';
import type { GitStashEntry, ExpandedSections } from './types';

interface GitStashProps {
  stashes: GitStashEntry[];
  expandedSections: { stashes: boolean };
  showStashModal: boolean;
  stashMessage: string;
  hasChangesToStash: boolean;
  stagedCount: number;
  unstagedCount: number;
  toggleSection: (section: keyof ExpandedSections) => void;
  onStashMessageChange: (message: string) => void;
  onShowStashModal: () => void;
  onCloseStashModal: () => void;
  onStashPush: () => void;
  onStashPop: (index: number) => void;
  onStashApply: (index: number) => void;
  onStashDrop: (index: number) => void;
}

export function GitStash({
  stashes,
  expandedSections,
  showStashModal,
  stashMessage,
  hasChangesToStash,
  stagedCount,
  unstagedCount,
  toggleSection,
  onStashMessageChange,
  onShowStashModal,
  onCloseStashModal,
  onStashPush,
  onStashPop,
  onStashApply,
  onStashDrop,
}: GitStashProps) {
  return (
    <>
      {/* Stashes Section */}
      <div className="border border-surface-700 rounded overflow-hidden">
        <div
          className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors cursor-pointer"
        >
          <button
            onClick={() => toggleSection('stashes')}
            className="flex items-center gap-2 flex-1 text-left"
          >
            <svg
              className={clsx('w-3 h-3 text-surface-400 transition-transform', expandedSections.stashes && 'rotate-90')}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-xs font-medium text-surface-300">Stashes</span>
            {stashes.length > 0 && (
              <span className="text-xs text-surface-500">({stashes.length})</span>
            )}
          </button>
          {hasChangesToStash && (
            <button
              onClick={onShowStashModal}
              className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
              title="Stash changes"
            >
              + Stash
            </button>
          )}
        </div>
        {expandedSections.stashes && (
          <div className="max-h-32 overflow-y-auto">
            {stashes.length === 0 ? (
              <div className="px-2 py-3 text-xs text-surface-500 text-center italic">
                No stashes
              </div>
            ) : (
              stashes.map((stash) => (
                <div
                  key={stash.index}
                  className="group flex items-center gap-2 px-2 py-1.5 hover:bg-surface-700/50 transition-colors"
                >
                  <span className="text-accent-400 font-mono text-[10px] flex-shrink-0">
                    @{'{' + stash.index + '}'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-surface-200 truncate">{stash.message || 'WIP'}</div>
                    {stash.branch && (
                      <div className="text-[10px] text-surface-500">on {stash.branch}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => onStashPop(stash.index)}
                      className="p-1 rounded hover:bg-success-500/20 text-success-400"
                      title="Pop (apply and remove)"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                      </svg>
                    </button>
                    <button
                      onClick={() => onStashApply(stash.index)}
                      className="p-1 rounded hover:bg-primary-500/20 text-primary-400"
                      title="Apply (keep stash)"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                    </button>
                    <button
                      onClick={() => onStashDrop(stash.index)}
                      className="p-1 rounded hover:bg-error-500/20 text-error-400"
                      title="Drop"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Stash Modal */}
      {showStashModal && (
        <StashModal
          stashMessage={stashMessage}
          stagedCount={stagedCount}
          unstagedCount={unstagedCount}
          onStashMessageChange={onStashMessageChange}
          onStashPush={onStashPush}
          onClose={onCloseStashModal}
        />
      )}
    </>
  );
}

// ============================================================================
// STASH MODAL
// ============================================================================

interface StashModalProps {
  stashMessage: string;
  stagedCount: number;
  unstagedCount: number;
  onStashMessageChange: (message: string) => void;
  onStashPush: () => void;
  onClose: () => void;
}

function StashModal({
  stashMessage,
  stagedCount,
  unstagedCount,
  onStashMessageChange,
  onStashPush,
  onClose,
}: StashModalProps) {
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
          <svg className="w-5 h-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
          </svg>
          <span className="font-medium text-surface-100">Stash Changes</span>
        </div>

        {/* Modal Content */}
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-surface-400 mb-1">
              Stash message (optional)
            </label>
            <input
              type="text"
              value={stashMessage}
              onChange={(e) => onStashMessageChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onStashPush(); }}
              placeholder="Describe what you're stashing..."
              className="w-full px-3 py-2 text-sm bg-surface-800 border border-surface-700 rounded-lg text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500"
              autoFocus
            />
          </div>

          <div className="text-xs text-surface-400 space-y-1">
            <p>This will stash:</p>
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
            onClick={onStashPush}
            className="px-4 py-2 text-sm bg-accent-500 hover:bg-accent-600 text-white rounded-lg transition-colors"
          >
            Stash
          </button>
        </div>
      </div>
    </div>
  );
}
