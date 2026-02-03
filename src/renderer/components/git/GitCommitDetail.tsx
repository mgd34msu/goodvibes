// ============================================================================
// GIT COMMIT DETAIL COMPONENT - Commit detail view modal
// ============================================================================

import { clsx } from 'clsx';
import type { GitCommitDetail } from './types';

interface GitCommitDetailProps {
  isOpen: boolean;
  selectedCommit: GitCommitDetail | null;
  isLoadingCommit: boolean;
  onClose: () => void;
  onViewDiff: (file: string, isStaged: boolean, commit: string) => void;
}

export function GitCommitDetailModal({
  isOpen,
  selectedCommit,
  isLoadingCommit,
  onClose,
  onViewDiff,
}: GitCommitDetailProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span className="font-medium text-surface-100">Commit Details</span>
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

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoadingCommit ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
            </div>
          ) : selectedCommit ? (
            <div className="space-y-4">
              {/* Commit Info */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-primary-400 font-mono text-sm">{selectedCommit.shortHash}</span>
                  <span className="text-surface-500 font-mono text-xs truncate">{selectedCommit.hash}</span>
                </div>
                <h3 className="text-lg font-medium text-surface-100">{selectedCommit.subject}</h3>
                {selectedCommit.body && (
                  <p className="text-sm text-surface-400 whitespace-pre-wrap">{selectedCommit.body}</p>
                )}
                <div className="flex items-center gap-4 text-xs text-surface-500">
                  <span>{selectedCommit.author}</span>
                  <span>{new Date(selectedCommit.date).toLocaleString()}</span>
                </div>
              </div>

              {/* Stats Summary */}
              <div className="flex items-center gap-4 py-2 px-3 bg-surface-800 rounded-lg text-sm">
                <span className="text-surface-400">
                  {selectedCommit.stats.filesChanged} file{selectedCommit.stats.filesChanged !== 1 ? 's' : ''} changed
                </span>
                {selectedCommit.stats.insertions > 0 && (
                  <span className="text-success-400">+{selectedCommit.stats.insertions}</span>
                )}
                {selectedCommit.stats.deletions > 0 && (
                  <span className="text-error-400">-{selectedCommit.stats.deletions}</span>
                )}
              </div>

              {/* Changed Files */}
              <div className="space-y-1">
                <h4 className="text-sm font-medium text-surface-300 mb-2">Changed Files</h4>
                {selectedCommit.files.map((file) => {
                  const statusColors: Record<string, string> = {
                    added: 'text-success-400 bg-success-400/20',
                    modified: 'text-primary-400 bg-primary-400/20',
                    deleted: 'text-error-400 bg-error-400/20',
                    renamed: 'text-accent-400 bg-accent-400/20',
                    copied: 'text-info-400 bg-info-400/20',
                  };
                  const statusLabels: Record<string, string> = {
                    added: 'A',
                    modified: 'M',
                    deleted: 'D',
                    renamed: 'R',
                    copied: 'C',
                  };

                  return (
                    <button
                      key={file.file}
                      onClick={() => onViewDiff(file.file, false, selectedCommit.hash)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-700/50 text-left group"
                      title="Click to view diff"
                    >
                      <span className={clsx('w-5 h-5 flex items-center justify-center rounded text-xs font-bold', statusColors[file.status])}>
                        {statusLabels[file.status]}
                      </span>
                      <span className="flex-1 text-sm text-surface-200 font-mono truncate group-hover:text-primary-400">
                        {file.oldPath ? `${file.oldPath} -> ` : ''}{file.file}
                      </span>
                      <span className="text-xs text-surface-500">
                        {file.insertions > 0 && <span className="text-success-400">+{file.insertions}</span>}
                        {file.insertions > 0 && file.deletions > 0 && ' / '}
                        {file.deletions > 0 && <span className="text-error-400">-{file.deletions}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-surface-500">
              Failed to load commit details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
