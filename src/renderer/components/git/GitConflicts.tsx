// ============================================================================
// GIT CONFLICTS COMPONENT - Conflict resolution UI
// ============================================================================

import { clsx } from 'clsx';
import type { GitConflictFile, ExpandedSections } from './types';

interface GitConflictsProps {
  conflictFiles: GitConflictFile[];
  expandedSections: { conflicts: boolean };
  toggleSection: (section: keyof ExpandedSections) => void;
  onResolveOurs: (file: string) => void;
  onResolveTheirs: (file: string) => void;
}

export function GitConflicts({
  conflictFiles,
  expandedSections,
  toggleSection,
  onResolveOurs,
  onResolveTheirs,
}: GitConflictsProps) {
  if (conflictFiles.length === 0) {
    return null;
  }

  return (
    <div className="border border-error-500/30 bg-error-500/10 rounded overflow-hidden">
      <button
        onClick={() => toggleSection('conflicts')}
        className="w-full flex items-center gap-2 px-2 py-1.5 bg-error-500/20 hover:bg-error-500/30 transition-colors"
      >
        <svg
          className={clsx('w-3 h-3 text-error-400 transition-transform', expandedSections.conflicts && 'rotate-90')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-xs font-medium text-error-400">Conflicts ({conflictFiles.length})</span>
      </button>
      {expandedSections.conflicts && (
        <div className="max-h-40 overflow-y-auto">
          {conflictFiles.map((conflict) => (
            <div
              key={conflict.file}
              className="group flex items-center gap-2 px-2 py-1.5 hover:bg-error-500/10 text-xs"
            >
              <span className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold text-error-400 bg-error-400/20">
                !
              </span>
              <span className="flex-1 text-surface-200 font-mono truncate">{conflict.file}</span>
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => onResolveOurs(conflict.file)}
                  className="px-1.5 py-0.5 text-[10px] bg-primary-500/20 hover:bg-primary-500/30 text-primary-400 rounded"
                  title="Accept our version"
                >
                  Ours
                </button>
                <button
                  onClick={() => onResolveTheirs(conflict.file)}
                  className="px-1.5 py-0.5 text-[10px] bg-success-500/20 hover:bg-success-500/30 text-success-400 rounded"
                  title="Accept their version"
                >
                  Theirs
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
