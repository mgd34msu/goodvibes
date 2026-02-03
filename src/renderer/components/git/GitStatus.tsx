// ============================================================================
// GIT STATUS COMPONENT - Repository status display
// ============================================================================

import { memo } from 'react';
import { clsx } from 'clsx';
import type { GitFileChange, ExpandedSections } from './types';

interface GitStatusProps {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  expandedSections: {
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
  };
  toggleSection: (section: keyof ExpandedSections) => void;
  onStage: (files: string[]) => Promise<void>;
  onUnstage: (files: string[]) => Promise<void>;
  onStageAll: () => Promise<void>;
  onUnstageAll: () => Promise<void>;
  onDiscard: (file: string, isUntracked: boolean) => Promise<void>;
  onViewDiff: (file: string, isStaged: boolean) => void;
  onViewBlame: (file: string) => void;
  onViewFileHistory: (file: string) => void;
}

/**
 * Status mapping for file changes
 * Defined as a module-level constant to prevent recreation on every render
 */
const STATUS_MAP: Record<string, { icon: string; color: string; label: string }> = {
  modified: { icon: 'M', color: 'text-primary-400 bg-primary-400/20', label: 'Modified' },
  added: { icon: 'A', color: 'text-success-400 bg-success-400/20', label: 'Added' },
  deleted: { icon: 'D', color: 'text-error-400 bg-error-400/20', label: 'Deleted' },
  renamed: { icon: 'R', color: 'text-accent-400 bg-accent-400/20', label: 'Renamed' },
  copied: { icon: 'C', color: 'text-info-400 bg-info-400/20', label: 'Copied' },
  untracked: { icon: 'U', color: 'text-warning-400 bg-warning-400/20', label: 'Untracked' },
  ignored: { icon: '!', color: 'text-surface-500 bg-surface-500/20', label: 'Ignored' },
} as const;

/**
 * Get status icon and color for a file
 */
function getStatusDisplay(change: GitFileChange) {
  return STATUS_MAP[change.status] || { icon: '?', color: 'text-surface-400 bg-surface-400/20', label: 'Unknown' };
}

interface FileChangeRowProps {
  change: GitFileChange;
  showStageButton: boolean;
  showUnstageButton: boolean;
  showDiscardButton: boolean;
  onStage: (files: string[]) => Promise<void>;
  onUnstage: (files: string[]) => Promise<void>;
  onDiscard: (file: string, isUntracked: boolean) => Promise<void>;
  onViewDiff: (file: string, isStaged: boolean) => void;
  onViewBlame: (file: string) => void;
  onViewFileHistory: (file: string) => void;
}

const FileChangeRow = memo(function FileChangeRow({
  change,
  showStageButton,
  showUnstageButton,
  showDiscardButton,
  onStage,
  onUnstage,
  onDiscard,
  onViewDiff,
  onViewBlame,
  onViewFileHistory,
}: FileChangeRowProps) {
  const { icon, color, label } = getStatusDisplay(change);
  const fileName = change.file.split('/').pop() || change.file;
  const filePath = change.file.includes('/') ? change.file.substring(0, change.file.lastIndexOf('/')) : '';
  const canViewDiff = change.status !== 'untracked' && change.status !== 'deleted';

  return (
    <div
      className="group flex items-center gap-1.5 px-2 py-1 hover:bg-surface-700/50 rounded text-xs"
      title={`${label}: ${change.file}${change.originalPath ? ` (from ${change.originalPath})` : ''}`}
    >
      <span className={clsx('w-4 h-4 flex items-center justify-center rounded text-[10px] font-bold flex-shrink-0', color)}>
        {icon}
      </span>
      <button
        className="flex-1 min-w-0 flex flex-col text-left hover:text-primary-400 transition-colors"
        onClick={() => canViewDiff && onViewDiff(change.file, change.staged || false)}
        disabled={!canViewDiff}
        title={canViewDiff ? 'Click to view diff' : undefined}
      >
        <span className="truncate text-surface-200 font-mono group-hover:text-inherit">{fileName}</span>
        {filePath && <span className="truncate text-surface-500 text-[10px]">{filePath}</span>}
      </button>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {canViewDiff && (
          <button
            onClick={() => onViewDiff(change.file, change.staged || false)}
            className="p-1 rounded hover:bg-primary-500/20 text-primary-400"
            title="View Diff"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </button>
        )}
        {change.status !== 'untracked' && (
          <>
            <button
              onClick={() => onViewBlame(change.file)}
              className="p-1 rounded hover:bg-info-500/20 text-info-400"
              title="Blame"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </button>
            <button
              onClick={() => onViewFileHistory(change.file)}
              className="p-1 rounded hover:bg-accent-500/20 text-accent-400"
              title="History"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </>
        )}
        {showStageButton && (
          <button
            onClick={() => onStage([change.file])}
            className="p-1 rounded hover:bg-success-500/20 text-success-400"
            title="Stage"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        )}
        {showUnstageButton && (
          <button
            onClick={() => onUnstage([change.file])}
            className="p-1 rounded hover:bg-warning-500/20 text-warning-400"
            title="Unstage"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
        )}
        {showDiscardButton && (
          <button
            onClick={() => onDiscard(change.file, change.status === 'untracked')}
            className="p-1 rounded hover:bg-error-500/20 text-error-400"
            title="Discard"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});

export function GitStatus({
  staged,
  unstaged,
  untracked,
  expandedSections,
  toggleSection,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onDiscard,
  onViewDiff,
  onViewBlame,
  onViewFileHistory,
}: GitStatusProps) {
  const totalChanges = staged.length + unstaged.length + untracked.length;

  if (totalChanges === 0) {
    return (
      <div className="text-center py-4 text-xs text-surface-500">
        <svg className="w-8 h-8 mx-auto mb-2 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
        </svg>
        Working tree clean
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Staged Changes */}
      {staged.length > 0 && (
        <div className="border border-surface-700 rounded overflow-hidden">
          <div
            role="button"
            tabIndex={0}
            onClick={() => toggleSection('staged')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('staged'); } }}
            className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <svg
                className={clsx('w-3 h-3 text-surface-400 transition-transform', expandedSections.staged && 'rotate-90')}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="text-xs font-medium text-success-400">Staged Changes</span>
              <span className="text-xs text-surface-500">({staged.length})</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onUnstageAll(); }}
              className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
              title="Unstage all"
            >
              - All
            </button>
          </div>
          {expandedSections.staged && (
            <div className="max-h-40 overflow-y-auto">
              {staged.map((change) => (
                <FileChangeRow
                  key={change.file}
                  change={change}
                  showStageButton={false}
                  showUnstageButton={true}
                  showDiscardButton={false}
                  onStage={onStage}
                  onUnstage={onUnstage}
                  onDiscard={onDiscard}
                  onViewDiff={onViewDiff}
                  onViewBlame={onViewBlame}
                  onViewFileHistory={onViewFileHistory}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Unstaged Changes */}
      {unstaged.length > 0 && (
        <div className="border border-surface-700 rounded overflow-hidden">
          <div
            role="button"
            tabIndex={0}
            onClick={() => toggleSection('unstaged')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('unstaged'); } }}
            className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <svg
                className={clsx('w-3 h-3 text-surface-400 transition-transform', expandedSections.unstaged && 'rotate-90')}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="text-xs font-medium text-primary-400">Changes</span>
              <span className="text-xs text-surface-500">({unstaged.length})</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onStageAll(); }}
              className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
              title="Stage all"
            >
              + All
            </button>
          </div>
          {expandedSections.unstaged && (
            <div className="max-h-40 overflow-y-auto">
              {unstaged.map((change) => (
                <FileChangeRow
                  key={change.file}
                  change={change}
                  showStageButton={true}
                  showUnstageButton={false}
                  showDiscardButton={true}
                  onStage={onStage}
                  onUnstage={onUnstage}
                  onDiscard={onDiscard}
                  onViewDiff={onViewDiff}
                  onViewBlame={onViewBlame}
                  onViewFileHistory={onViewFileHistory}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Untracked Files */}
      {untracked.length > 0 && (
        <div className="border border-surface-700 rounded overflow-hidden">
          <div
            role="button"
            tabIndex={0}
            onClick={() => toggleSection('untracked')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection('untracked'); } }}
            className="w-full flex items-center justify-between px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <svg
                className={clsx('w-3 h-3 text-surface-400 transition-transform', expandedSections.untracked && 'rotate-90')}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="text-xs font-medium text-warning-400">Untracked</span>
              <span className="text-xs text-surface-500">({untracked.length})</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onStage(untracked.map(f => f.file)); }}
              className="px-1.5 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
              title="Stage all untracked"
            >
              + All
            </button>
          </div>
          {expandedSections.untracked && (
            <div className="max-h-40 overflow-y-auto">
              {untracked.map((change) => (
                <FileChangeRow
                  key={change.file}
                  change={change}
                  showStageButton={true}
                  showUnstageButton={false}
                  showDiscardButton={true}
                  onStage={onStage}
                  onUnstage={onUnstage}
                  onDiscard={onDiscard}
                  onViewDiff={onViewDiff}
                  onViewBlame={onViewBlame}
                  onViewFileHistory={onViewFileHistory}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
