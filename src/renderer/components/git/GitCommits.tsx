// ============================================================================
// GIT COMMITS COMPONENT - Commit list, creation, and conventional commits
// ============================================================================

import { clsx } from 'clsx';
import type { GitCommitInfo, ExpandedSections } from './types';

interface GitCommitsProps {
  commits: GitCommitInfo[];
  commitMessage: string;
  amendMode: boolean;
  isCommitting: boolean;
  stagedCount: number;
  expandedSections: { commits: boolean };
  conventionalPrefixes: string[];
  showConventionalDropdown: boolean;
  toggleSection: (section: keyof ExpandedSections) => void;
  onCommitMessageChange: (message: string) => void;
  onAmendModeChange: (amend: boolean) => void;
  onCommit: () => void;
  onViewCommit: (hash: string) => void;
  onCherryPick: (hash: string) => void;
  onConventionalPrefix: (prefix: string) => void;
  onToggleConventionalDropdown: () => void;
  formatRelativeTime: (dateStr: string) => string;
}

export function GitCommits({
  commits,
  commitMessage,
  amendMode,
  isCommitting,
  stagedCount,
  expandedSections,
  conventionalPrefixes,
  showConventionalDropdown,
  toggleSection,
  onCommitMessageChange,
  onAmendModeChange,
  onCommit,
  onViewCommit,
  onCherryPick,
  onConventionalPrefix,
  onToggleConventionalDropdown,
  formatRelativeTime,
}: GitCommitsProps) {
  const canCommit = (commitMessage.trim() || amendMode) && (stagedCount > 0 || amendMode);

  return (
    <div className="space-y-2">
      {/* Commit Section */}
      {(stagedCount > 0 || commitMessage || amendMode) && (
        <div className="border border-surface-700 rounded p-2 space-y-2">
          {/* Conventional commit dropdown */}
          <div className="relative">
            <div className="flex gap-1">
              <button
                onClick={onToggleConventionalDropdown}
                className="px-2 py-1 text-[10px] bg-surface-800 hover:bg-surface-700 text-surface-400 rounded border border-surface-600"
                title="Insert conventional commit prefix"
              >
                type:
              </button>
              <textarea
                value={commitMessage}
                onChange={(e) => onCommitMessageChange(e.target.value)}
                placeholder={amendMode ? "New commit message (leave empty to keep)" : "Commit message..."}
                className="flex-1 px-2 py-1.5 text-xs bg-surface-800 border border-surface-700 rounded text-surface-100 placeholder-surface-500 focus:outline-none focus:border-primary-500 resize-none"
                rows={2}
              />
            </div>
            {showConventionalDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-surface-800 border border-surface-700 rounded shadow-lg z-[9959] max-h-40 overflow-y-auto">
                {conventionalPrefixes.map(prefix => (
                  <button
                    key={prefix}
                    onClick={() => onConventionalPrefix(prefix)}
                    className="w-full px-3 py-1.5 text-xs text-left text-surface-300 hover:bg-surface-700"
                  >
                    {prefix}:
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[10px] text-surface-400 cursor-pointer">
              <input
                type="checkbox"
                checked={amendMode}
                onChange={(e) => onAmendModeChange(e.target.checked)}
                className="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500 w-3 h-3"
              />
              Amend last commit
            </label>
          </div>
          <div className="flex gap-1">
            <button
              onClick={onCommit}
              disabled={!canCommit || isCommitting}
              className="flex-1 px-2 py-1.5 text-xs bg-primary-500 hover:bg-primary-600 disabled:bg-surface-700 disabled:text-surface-500 text-white rounded transition-colors"
            >
              {isCommitting ? (amendMode ? 'Amending...' : 'Committing...') : (amendMode ? 'Amend' : `Commit (${stagedCount})`)}
            </button>
          </div>
        </div>
      )}

      {/* Recent Commits */}
      <div className="border border-surface-700 rounded overflow-hidden">
        <button
          onClick={() => toggleSection('commits')}
          className="w-full flex items-center gap-2 px-2 py-1.5 bg-surface-800 hover:bg-surface-750 transition-colors"
        >
          <svg
            className={clsx('w-3 h-3 text-surface-400 transition-transform', expandedSections.commits && 'rotate-90')}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-xs font-medium text-surface-300">Commits</span>
        </button>
        {expandedSections.commits && (
          <div className="max-h-48 overflow-y-auto">
            {commits.length === 0 ? (
              <div className="px-2 py-3 text-xs text-surface-500 text-center italic">
                No commits yet
              </div>
            ) : (
              commits.map((commit) => (
                <div
                  key={commit.hash}
                  className="group flex items-start gap-2 px-2 py-1.5 hover:bg-surface-700/50 transition-colors"
                >
                  <span className="text-primary-400 font-mono text-[10px] flex-shrink-0 mt-0.5">
                    {commit.shortHash}
                  </span>
                  <button
                    onClick={() => onViewCommit(commit.hash)}
                    className="flex-1 min-w-0 text-left"
                    title={`Click to view commit details\n${commit.hash}\n${commit.author} <${commit.email}>\n${commit.date}`}
                  >
                    <div className="text-xs text-surface-200 truncate">{commit.subject}</div>
                    <div className="text-[10px] text-surface-500">
                      {commit.author} - {formatRelativeTime(commit.date)}
                    </div>
                  </button>
                  <button
                    onClick={() => onCherryPick(commit.hash)}
                    className="p-1 rounded hover:bg-accent-500/20 text-accent-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Cherry-pick this commit"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </button>
                  <svg className="w-3 h-3 text-surface-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
