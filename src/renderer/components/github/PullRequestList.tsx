// ============================================================================
// PULL REQUEST LIST COMPONENT
// ============================================================================

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import type { GitHubPullRequest, GitHubCheckRun, GitHubCheckConclusion } from '../../../shared/types/github';
import CIStatusBadge from './CIStatusBadge';

interface PullRequestListProps {
  owner: string;
  repo: string;
  currentBranch?: string;
  onCreatePR?: () => void;
  className?: string;
}

export default function PullRequestList({
  owner,
  repo,
  currentBranch,
  onCreatePR,
  className,
}: PullRequestListProps) {
  const [pullRequests, setPullRequests] = useState<GitHubPullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ciStatuses, setCIStatuses] = useState<Record<number, GitHubCheckRun[]>>({});

  useEffect(() => {
    loadPullRequests();
  }, [owner, repo]);

  const loadPullRequests = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await window.goodvibes.githubListPRs(owner, repo, { state: 'open' });

      if (result.success && result.data) {
        setPullRequests(result.data);
        // Load CI status for each PR
        loadCIStatuses(result.data);
      } else {
        setError(result.error || 'Failed to load pull requests');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pull requests');
    } finally {
      setLoading(false);
    }
  };

  const loadCIStatuses = async (prs: GitHubPullRequest[]) => {
    const statuses: Record<number, GitHubCheckRun[]> = {};

    for (const pr of prs) {
      try {
        const result = await window.goodvibes.githubGetChecks(owner, repo, pr.head.sha);
        if (result.success && result.data) {
          statuses[pr.number] = result.data;
        }
      } catch {
        // Ignore errors for individual CI status fetches
      }
    }

    setCIStatuses(statuses);
  };

  const openPR = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Check if current branch has an open PR
  const currentBranchPR = currentBranch
    ? pullRequests.find((pr) => pr.head.ref === currentBranch)
    : null;

  if (loading) {
    return (
      <div className={clsx('p-4', className)}>
        <div className="flex items-center gap-2 text-surface-400">
          <SpinnerIcon className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading pull requests...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={clsx('p-4', className)}>
        <p className="text-sm text-error-400">{error}</p>
        <button
          onClick={loadPullRequests}
          className="mt-2 text-xs text-primary-400 hover:text-primary-300"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={clsx('space-y-2', className)}>
      {/* Header with create button */}
      <div className="flex items-center justify-between px-2">
        <h3 className="text-sm font-medium text-surface-300">
          Pull Requests ({pullRequests.length})
        </h3>
        {currentBranch && !currentBranchPR && onCreatePR && (
          <button
            onClick={onCreatePR}
            className="text-xs text-primary-400 hover:text-primary-300"
          >
            + Create PR
          </button>
        )}
      </div>

      {/* Current branch PR notice */}
      {currentBranch && currentBranchPR && (
        <div className="mx-2 p-2 bg-primary-900/20 rounded border border-primary-800/50">
          <p className="text-xs text-primary-300">
            This branch has an open PR: #{currentBranchPR.number}
          </p>
        </div>
      )}

      {/* PR List */}
      {pullRequests.length === 0 ? (
        <p className="px-2 text-sm text-surface-500">No open pull requests</p>
      ) : (
        <div className="space-y-1">
          {pullRequests.map((pr) => (
            <PullRequestItem
              key={pr.id}
              pr={pr}
              checks={ciStatuses[pr.number]}
              isCurrentBranch={pr.head.ref === currentBranch}
              onClick={() => openPR(pr.html_url)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// PULL REQUEST ITEM
// ============================================================================

interface PullRequestItemProps {
  pr: GitHubPullRequest;
  checks?: GitHubCheckRun[];
  isCurrentBranch?: boolean;
  onClick?: () => void;
}

function PullRequestItem({ pr, checks, isCurrentBranch, onClick }: PullRequestItemProps) {
  // Calculate overall CI status
  const getCIStatus = (): { status: 'queued' | 'in_progress' | 'completed'; conclusion: GitHubCheckConclusion | null } => {
    if (!checks || checks.length === 0) {
      return { status: 'completed', conclusion: null };
    }

    const hasInProgress = checks.some((c) => c.status === 'in_progress');
    const hasQueued = checks.some((c) => c.status === 'queued');
    const hasFailed = checks.some((c) => c.conclusion === 'failure');
    const allSuccess = checks.every(
      (c) => c.status === 'completed' && (c.conclusion === 'success' || c.conclusion === 'skipped')
    );

    if (hasInProgress || hasQueued) {
      return { status: 'in_progress', conclusion: null }; // null indicates in-progress
    }
    if (hasFailed) {
      return { status: 'completed', conclusion: 'failure' };
    }
    if (allSuccess) {
      return { status: 'completed', conclusion: 'success' };
    }
    return { status: 'completed', conclusion: null };
  };

  const ciStatus = getCIStatus();

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full p-2 rounded text-left hover:bg-surface-700/50 transition-colors',
        isCurrentBranch && 'bg-primary-900/20 border border-primary-800/50'
      )}
    >
      <div className="flex items-start gap-2">
        {/* PR Icon */}
        <PRIcon
          className={clsx(
            'w-4 h-4 mt-0.5 flex-shrink-0',
            pr.draft ? 'text-surface-500' : 'text-success-400'
          )}
        />

        {/* PR Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-surface-200 truncate">
              {pr.title}
            </span>
            {pr.draft && (
              <span className="text-xs px-1.5 py-0.5 bg-surface-700 rounded text-surface-400">
                Draft
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-surface-500">
              #{pr.number} by {pr.user.login}
            </span>
            <span className="text-xs text-surface-600">
              {pr.head.ref} &rarr; {pr.base.ref}
            </span>
          </div>
        </div>

        {/* CI Status */}
        {ciStatus.conclusion && (
          <CIStatusBadge
            status={ciStatus.status}
            conclusion={ciStatus.conclusion}
            showLabel={false}
          />
        )}
      </div>

      {/* Labels */}
      {pr.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5 ml-6">
          {pr.labels.slice(0, 3).map((label) => (
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
          {pr.labels.length > 3 && (
            <span className="text-xs text-surface-500">+{pr.labels.length - 3}</span>
          )}
        </div>
      )}
    </button>
  );
}

// ============================================================================
// ICONS
// ============================================================================

function PRIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
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
