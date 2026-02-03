// ============================================================================
// GIT FILE HISTORY COMPONENT - File history modal
// ============================================================================

import type { GitFileHistoryEntry } from './types';

interface GitFileHistoryProps {
  isOpen: boolean;
  fileHistoryFile: string | null;
  fileHistoryCommits: GitFileHistoryEntry[];
  isLoadingFileHistory: boolean;
  formatRelativeTime: (dateStr: string) => string;
  onViewDiff: (file: string, isStaged: boolean, commit: string) => void;
  onClose: () => void;
}

export function GitFileHistory({
  isOpen,
  fileHistoryFile,
  fileHistoryCommits,
  isLoadingFileHistory,
  formatRelativeTime,
  onViewDiff,
  onClose,
}: GitFileHistoryProps) {
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
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-medium text-surface-100">File History</span>
            <span className="text-sm text-surface-400 font-mono truncate">{fileHistoryFile}</span>
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
          {isLoadingFileHistory ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
            </div>
          ) : fileHistoryCommits.length === 0 ? (
            <div className="text-center py-8 text-surface-500">No commits found for this file</div>
          ) : (
            <div className="divide-y divide-surface-800">
              {fileHistoryCommits.map((commit) => (
                <button
                  key={commit.hash}
                  onClick={() => fileHistoryFile && onViewDiff(fileHistoryFile, false, commit.hash)}
                  className="w-full flex items-start gap-3 px-4 py-3 hover:bg-surface-800/50 text-left"
                >
                  <span className="text-primary-400 font-mono text-xs">{commit.shortHash}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-surface-200 truncate">{commit.subject}</div>
                    <div className="text-xs text-surface-500">{commit.author} - {formatRelativeTime(commit.date)}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// GIT BLAME MODAL
// ============================================================================

import type { GitBlameLine } from './types';

interface GitBlameProps {
  isOpen: boolean;
  blameFile: string | null;
  blameLines: GitBlameLine[];
  isLoadingBlame: boolean;
  onClose: () => void;
}

export function GitBlame({
  isOpen,
  blameFile,
  blameLines,
  isLoadingBlame,
  onClose,
}: GitBlameProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-info-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span className="font-medium text-surface-100">Git Blame</span>
            <span className="text-sm text-surface-400 font-mono truncate">{blameFile}</span>
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
        <div className="flex-1 overflow-auto bg-surface-950">
          {isLoadingBlame ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
            </div>
          ) : blameLines.length === 0 ? (
            <div className="text-center py-8 text-surface-500">No blame information</div>
          ) : (
            <table className="w-full text-xs font-mono">
              <tbody>
                {blameLines.map((line, idx) => (
                  <tr key={idx} className="hover:bg-surface-800/50">
                    <td className="px-2 py-0.5 text-surface-500 text-right whitespace-nowrap border-r border-surface-800 w-12">
                      {line.lineNumber}
                    </td>
                    <td className="px-2 py-0.5 text-primary-400 whitespace-nowrap border-r border-surface-800 w-16">
                      {line.hash}
                    </td>
                    <td className="px-2 py-0.5 text-surface-400 whitespace-nowrap border-r border-surface-800 max-w-[120px] truncate">
                      {line.author}
                    </td>
                    <td className="px-2 py-0.5 text-surface-300 whitespace-pre">
                      {line.content}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
