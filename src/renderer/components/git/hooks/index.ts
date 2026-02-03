// ============================================================================
// GIT HOOKS - Public exports
// ============================================================================

// Main composed hook
export { useGitState, formatRelativeTime } from './useGitState';
export type { UseGitStateReturn } from './useGitState';

// Individual focused hooks
export { useGitStatus } from './useGitStatus';
export { useGitBranches } from './useGitBranches';
export { useGitCommits } from './useGitCommits';
export { useGitRemote } from './useGitRemote';
export { useGitViews } from './useGitViews';
export { useGitUI } from './useGitUI';

// Shared types
export type {
  GitHookBaseProps,
  UseGitStatusReturn,
  UseGitBranchesReturn,
  UseGitCommitsReturn,
  UseGitRemoteReturn,
  UseGitViewsReturn,
  UseGitUIReturn,
} from './types';
