// ============================================================================
// ISSUE LIST COMPONENT
// ============================================================================

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import type { GitHubIssue } from '../../../shared/types/github';

interface IssueListProps {
  owner: string;
  repo: string;
  maxItems?: number;
  showCreateButton?: boolean;
  className?: string;
}

export default function IssueList({
  owner,
  repo,
  maxItems = 5,
  showCreateButton = true,
  className,
}: IssueListProps) {
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadIssues();
  }, [owner, repo]);

  const loadIssues = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await window.goodvibes.githubListIssues(owner, repo, {
        state: 'open',
        sort: 'updated',
        per_page: maxItems,
      });

      if (result.success && result.data) {
        setIssues(result.data);
      } else {
        setError(result.error || 'Failed to load issues');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issues');
    } finally {
      setLoading(false);
    }
  };

  const openIssue = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openNewIssue = () => {
    window.open(
      `https://github.com/${owner}/${repo}/issues/new`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const openAllIssues = () => {
    window.open(
      `https://github.com/${owner}/${repo}/issues`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  if (loading) {
    return (
      <div className={clsx('p-4', className)}>
        <div className="flex items-center gap-2 text-surface-400">
          <SpinnerIcon className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading issues...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={clsx('p-4', className)}>
        <p className="text-sm text-error-400">{error}</p>
        <button
          onClick={loadIssues}
          className="mt-2 text-xs text-primary-400 hover:text-primary-300"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={clsx('space-y-2', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-2">
        <h3 className="text-sm font-medium text-surface-300">
          Issues ({issues.length})
        </h3>
        <div className="flex items-center gap-2">
          {showCreateButton && (
            <button
              onClick={openNewIssue}
              className="text-xs text-primary-400 hover:text-primary-300"
            >
              + New Issue
            </button>
          )}
        </div>
      </div>

      {/* Issue List */}
      {issues.length === 0 ? (
        <p className="px-2 text-sm text-surface-500">No open issues</p>
      ) : (
        <div className="space-y-1">
          {issues.map((issue) => (
            <IssueItem
              key={issue.id}
              issue={issue}
              onClick={() => openIssue(issue.html_url)}
            />
          ))}
        </div>
      )}

      {/* View all link */}
      {issues.length > 0 && (
        <button
          onClick={openAllIssues}
          className="block w-full px-2 py-1 text-xs text-center text-surface-400 hover:text-surface-300"
        >
          View all issues on GitHub
        </button>
      )}
    </div>
  );
}

// ============================================================================
// ISSUE ITEM
// ============================================================================

interface IssueItemProps {
  issue: GitHubIssue;
  onClick?: () => void;
}

function IssueItem({ issue, onClick }: IssueItemProps) {
  const timeAgo = getTimeAgo(new Date(issue.updated_at));

  return (
    <button
      onClick={onClick}
      className="w-full p-2 rounded text-left hover:bg-surface-700/50 transition-colors"
    >
      <div className="flex items-start gap-2">
        {/* Issue Icon */}
        <IssueIcon className="w-4 h-4 mt-0.5 flex-shrink-0 text-success-400" />

        {/* Issue Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-surface-200 truncate">
              {issue.title}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-surface-500">
              #{issue.number}
            </span>
            <span className="text-xs text-surface-600">
              updated {timeAgo}
            </span>
            {issue.comments > 0 && (
              <span className="flex items-center gap-1 text-xs text-surface-500">
                <CommentIcon className="w-3 h-3" />
                {issue.comments}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Labels */}
      {issue.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5 ml-6">
          {issue.labels.slice(0, 3).map((label) => (
            <span
              key={label.id}
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: `#${label.color}20`,
                color: `#${label.color}`,
              }}
            >
              {label.name}
            </span>
          ))}
          {issue.labels.length > 3 && (
            <span className="text-xs text-surface-500">+{issue.labels.length - 3}</span>
          )}
        </div>
      )}
    </button>
  );
}

// ============================================================================
// UTILITIES
// ============================================================================

function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  return `${diffMonths}mo ago`;
}

// ============================================================================
// ICONS
// ============================================================================

function IssueIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
      <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
    </svg>
  );
}

function CommentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 2a6 6 0 00-6 6h1.5a4.5 4.5 0 014.5-4.5V2z" />
    </svg>
  );
}
