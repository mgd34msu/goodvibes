// ============================================================================
// GIT COMPONENT SHARED TYPES
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
 * Git stash entry type
 */
export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

/**
 * Extended branch info with parent tracking
 */
export interface ExtendedGitBranchInfo extends GitBranchInfo {
  parentBranch?: string;
  commitsAhead?: number;
}

/**
 * Merge options
 */
export interface MergeOptions {
  noFf: boolean;
  squash: boolean;
}

/**
 * Expanded sections state
 */
export interface ExpandedSections {
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  commits: boolean;
  stashes: boolean;
  tags: boolean;
  conflicts: boolean;
}

/**
 * Props for the GitPanel component
 */
export interface GitPanelProps {
  cwd: string;
  position: 'left' | 'right';
}

/**
 * State for the GitPanel component
 */
export interface GitPanelState {
  // Repository status
  isRepo: boolean;
  isLoading: boolean;
  error: string | null;
  branch: string;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  hasUpstream: boolean;

  // File changes
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];

  // Branches
  branches: ExtendedGitBranchInfo[];
  showBranchDropdown: boolean;
  showNewBranchInput: boolean;
  newBranchName: string;
  newBranchError: string | null;

  // Commits
  commits: GitCommitInfo[];
  commitMessage: string;
  isCommitting: boolean;
  amendMode: boolean;

  // Remote operations
  isPushing: boolean;
  isPulling: boolean;
  isFetching: boolean;

  // Merge
  isMerging: boolean;
  mergeInProgress: boolean;
  showMergeModal: boolean;
  mergeBranch: string | null;
  mergeOptions: MergeOptions;

  // UI state
  expandedSections: ExpandedSections;
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

  // Stash
  stashes: GitStashEntry[];
  showStashModal: boolean;
  stashMessage: string;

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

/**
 * Actions that can be dispatched to update GitPanel state
 */
export type GitPanelAction =
  | { type: 'SET_STATE'; payload: Partial<GitPanelState> }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'TOGGLE_SECTION'; payload: keyof ExpandedSections }
  | { type: 'RESET_MODAL'; payload: 'diff' | 'commit' | 'merge' | 'stash' | 'tag' | 'rebase' | 'reflog' | 'fileHistory' | 'blame' | 'deleteBranch' | 'checkout' };

/**
 * Props for git sub-components
 */
export interface GitStatusProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
}

export interface GitBranchesProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  localBranches: ExtendedGitBranchInfo[];
  branchDropdownRef: React.RefObject<HTMLDivElement>;
}

export interface GitCommitsProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  toggleSection: (section: keyof ExpandedSections) => void;
  formatRelativeTime: (dateStr: string) => string;
}

export interface GitRemoteProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
}

export interface GitMergeProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  localBranches: ExtendedGitBranchInfo[];
}

export interface GitStashProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  toggleSection: (section: keyof ExpandedSections) => void;
}

export interface GitTagsProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  toggleSection: (section: keyof ExpandedSections) => void;
}

export interface GitDiffProps {
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
}

export interface GitConflictsProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  toggleSection: (section: keyof ExpandedSections) => void;
}

export interface GitRebaseProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  localBranches: ExtendedGitBranchInfo[];
}

export interface GitFileHistoryProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  formatRelativeTime: (dateStr: string) => string;
  handleViewDiff: (file: string, isStaged: boolean, commit?: string) => void;
}

export interface GitCommitDetailProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  handleViewDiff: (file: string, isStaged: boolean, commit?: string) => void;
}

export interface GitFileChangesProps {
  cwd: string;
  state: GitPanelState;
  setState: React.Dispatch<React.SetStateAction<GitPanelState>>;
  fetchGitInfo: () => Promise<void>;
  toggleSection: (section: keyof ExpandedSections) => void;
  handleViewDiff: (file: string, isStaged: boolean, commit?: string) => void;
  handleViewBlame: (file: string) => void;
  handleViewFileHistory: (file: string) => void;
}

// Re-export shared types for convenience
export type {
  GitFileChange,
  GitBranchInfo,
  GitCommitInfo,
  GitCommitDetail,
  GitTag,
  GitBlameLine,
  GitFileHistoryEntry,
  GitConflictFile,
  GitReflogEntry,
};
