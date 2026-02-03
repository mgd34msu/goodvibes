// ============================================================================
// GIT HOOKS SHARED TYPES
// ============================================================================

import type { Dispatch, SetStateAction, RefObject } from 'react';
import type {
  GitPanelState,
  ExpandedSections,
  ExtendedGitBranchInfo,
} from '../types';

/**
 * Common props for all git sub-hooks
 */
export interface GitHookBaseProps {
  cwd: string;
  state: GitPanelState;
  setState: Dispatch<SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  fetchLocalGitInfo: () => Promise<void>;
  fetchRemoteGitInfo: () => Promise<void>;
}

/**
 * Return type for useGitStatus hook
 */
export interface UseGitStatusReturn {
  handleStage: (files: string[]) => Promise<void>;
  handleUnstage: (files: string[]) => Promise<void>;
  handleStageAll: () => Promise<void>;
  handleUnstageAll: () => Promise<void>;
  handleDiscard: (file: string, isUntracked: boolean) => Promise<void>;
}

/**
 * Return type for useGitBranches hook
 */
export interface UseGitBranchesReturn {
  localBranches: ExtendedGitBranchInfo[];
  handleCheckout: (branch: string) => Promise<void>;
  performCheckout: (branch: string) => Promise<void>;
  handleDiscardAndCheckout: () => Promise<void>;
  handleCancelCheckout: () => void;
  handleCreateBranch: () => Promise<void>;
  handleCancelNewBranch: () => void;
  handleDeleteBranch: () => Promise<void>;
}

/**
 * Return type for useGitCommits hook
 */
export interface UseGitCommitsReturn {
  handleCommit: () => Promise<void>;
  handleCommitWithAmend: () => Promise<void>;
  handleViewCommit: (hash: string) => Promise<void>;
  handleCloseCommitDetail: () => void;
  handleConventionalPrefix: (prefix: string) => void;
}

/**
 * Return type for useGitRemote hook
 */
export interface UseGitRemoteReturn {
  handlePush: () => Promise<void>;
  handlePull: () => Promise<void>;
  handleFetch: () => Promise<void>;
}

/**
 * Return type for useGitViews hook
 */
export interface UseGitViewsReturn {
  handleViewDiff: (file: string, isStaged?: boolean, commit?: string) => Promise<void>;
  handleCloseDiffModal: () => void;
  handleViewFileHistory: (file: string) => Promise<void>;
  handleViewBlame: (file: string) => Promise<void>;
  handleViewReflog: () => Promise<void>;
}

/**
 * Return type for useGitUI hook
 */
export interface UseGitUIReturn {
  branchDropdownRef: RefObject<HTMLDivElement | null>;
  toggleSection: (section: keyof ExpandedSections) => void;
  totalChanges: number;
}

/**
 * Format a date string to relative time
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
