// ============================================================================
// GIT COMPONENTS - Main export file
// ============================================================================

// Main component
export { GitPanel } from './GitPanel';

// Sub-components
export { GitStatus } from './GitStatus';
export { GitBranches, DeleteBranchModal, CheckoutConfirmModal } from './GitBranches';
export { GitCommits } from './GitCommits';
export { GitRemote } from './GitRemote';
export { GitMerge } from './GitMerge';
export { GitStash } from './GitStash';
export { GitTags } from './GitTags';
export { GitDiff } from './GitDiff';
export { GitConflicts } from './GitConflicts';
export { GitRebase } from './GitRebase';
export { GitFileHistory, GitBlame } from './GitFileHistory';
export { GitCommitDetailModal } from './GitCommitDetail';

// Hooks
export { useGitState, formatRelativeTime } from './hooks/useGitState';

// Types
export * from './types';
