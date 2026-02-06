// ============================================================================
// TERMINAL COMPONENT SHARED TYPES
// ============================================================================

import type {
  GitFileChange,
  GitBranchInfo,
  GitCommitInfo,
  GitCommitDetail,
  GitTag,
  GitBlameLine,
  GitFileHistoryEntry,
  GitConflictFile,
  GitReflogEntry,
} from '../../../shared/types';

/**
 * Props for the TerminalHeader component
 */
export interface TerminalHeaderProps {
  showGitPanel: boolean;
  onToggleGitPanel: () => void;
  hasActiveSession: boolean | undefined;
}

/**
 * Props for the TerminalInstance component
 */
export interface TerminalInstanceProps {
  id: number;
  zoomLevel: number;
  isActive: boolean;
  isPlainTerminal?: boolean;
  cwd?: string;
}

/**
 * Props for the EmptyState component
 */
export interface EmptyStateProps {
  onNewSession: () => void;
  onNewTerminal: () => void;
}

/**
 * Props for the GitPanel component
 */
export interface GitPanelProps {
  cwd: string;
  position: 'left' | 'right';
}

/**
 * Git stash entry type
 */
export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

/**
 * State for the GitPanel component
 */
export interface GitPanelState {
  isRepo: boolean;
  isLoading: boolean;
  error: string | null;
  branch: string;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  hasUpstream: boolean;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  branches: Array<GitBranchInfo & { parentBranch?: string; commitsAhead?: number }>;
  commits: GitCommitInfo[];
  commitMessage: string;
  isCommitting: boolean;
  isPushing: boolean;
  isPulling: boolean;
  isFetching: boolean;
  isMerging: boolean;
  mergeInProgress: boolean;
  showBranchDropdown: boolean;
  showNewBranchInput: boolean;
  newBranchName: string;
  newBranchError: string | null;
  expandedSections: {
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    commits: boolean;
    stashes: boolean;
    tags: boolean;
    conflicts: boolean;
  };
  operationInProgress: string | null;
  // Commit detail view
  selectedCommit: GitCommitDetail | null;
  showCommitDetail: boolean;
  isLoadingCommit: boolean;
  // Diff view
  showDiffModal: boolean;
  diffFile: string | null;
  diffContent: string | null;
  diffIsStaged: boolean;
  diffCommit: string | null;
  isLoadingDiff: boolean;
  // Branch checkout confirmation modal
  showCheckoutConfirmModal: boolean;
  pendingCheckoutBranch: string | null;
  // Merge modal
  showMergeModal: boolean;
  mergeBranch: string | null;
  mergeOptions: { noFf: boolean; squash: boolean };
  // Stash
  stashes: GitStashEntry[];
  showStashModal: boolean;
  stashMessage: string;
  // Commit amend
  amendMode: boolean;
  // Cherry-pick
  cherryPickInProgress: boolean;
  // Rebase
  rebaseInProgress: boolean;
  showRebaseModal: boolean;
  rebaseBranch: string | null;
  // Tags
  tags: GitTag[];
  showTagModal: boolean;
  newTagName: string;
  newTagMessage: string;
  newTagCommit: string;
  // Conflict resolution
  conflictFiles: GitConflictFile[];
  // File history
  showFileHistoryModal: boolean;
  fileHistoryFile: string | null;
  fileHistoryCommits: GitFileHistoryEntry[];
  isLoadingFileHistory: boolean;
  // Git blame
  showBlameModal: boolean;
  blameFile: string | null;
  blameLines: GitBlameLine[];
  isLoadingBlame: boolean;
  // Reflog
  showReflogModal: boolean;
  reflogEntries: GitReflogEntry[];
  isLoadingReflog: boolean;
  // Branch deletion
  showDeleteBranchModal: boolean;
  branchToDelete: string | null;
  deleteBranchForce: boolean;
  // Conventional commits
  conventionalPrefixes: string[];
  showConventionalDropdown: boolean;
}

/**
 * Initial state for GitPanel
 */
export const initialGitPanelState: GitPanelState = {
  isRepo: false,
  isLoading: true,
  error: null,
  branch: '',
  ahead: 0,
  behind: 0,
  hasRemote: false,
  hasUpstream: false,
  staged: [],
  unstaged: [],
  untracked: [],
  branches: [],
  commits: [],
  commitMessage: '',
  isCommitting: false,
  isPushing: false,
  isPulling: false,
  isFetching: false,
  isMerging: false,
  mergeInProgress: false,
  showBranchDropdown: false,
  showNewBranchInput: false,
  newBranchName: '',
  newBranchError: null,
  expandedSections: {
    staged: true,
    unstaged: true,
    untracked: true,
    commits: true,
    stashes: false,
    tags: false,
    conflicts: true,
  },
  operationInProgress: null,
  selectedCommit: null,
  showCommitDetail: false,
  isLoadingCommit: false,
  showDiffModal: false,
  diffFile: null,
  diffContent: null,
  diffIsStaged: false,
  diffCommit: null,
  isLoadingDiff: false,
  showCheckoutConfirmModal: false,
  pendingCheckoutBranch: null,
  showMergeModal: false,
  mergeBranch: null,
  mergeOptions: { noFf: false, squash: false },
  stashes: [],
  showStashModal: false,
  stashMessage: '',
  amendMode: false,
  cherryPickInProgress: false,
  rebaseInProgress: false,
  showRebaseModal: false,
  rebaseBranch: null,
  tags: [],
  showTagModal: false,
  newTagName: '',
  newTagMessage: '',
  newTagCommit: '',
  conflictFiles: [],
  showFileHistoryModal: false,
  fileHistoryFile: null,
  fileHistoryCommits: [],
  isLoadingFileHistory: false,
  showBlameModal: false,
  blameFile: null,
  blameLines: [],
  isLoadingBlame: false,
  showReflogModal: false,
  reflogEntries: [],
  isLoadingReflog: false,
  showDeleteBranchModal: false,
  branchToDelete: null,
  deleteBranchForce: false,
  conventionalPrefixes: [],
  showConventionalDropdown: false,
};
