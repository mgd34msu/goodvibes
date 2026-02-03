// ============================================================================
// GIT TYPES - Git-related types
// ============================================================================

export interface GitStatus {
  success: boolean;
  output?: string;
  error?: string;
  stderr?: string;
}

export interface GitChange {
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'staged';
  file: string;
}

export interface GitFileChange {
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'ignored';
  file: string;
  staged: boolean;
  indexStatus: string;
  workTreeStatus: string;
  originalPath?: string; // For renamed files
}

export interface GitBranchInfo {
  name: string;
  hash: string;
  upstream?: string;
  isCurrent: boolean;
  isRemote: boolean;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: GitCommitFile[];
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

export interface GitCommitFile {
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  insertions: number;
  deletions: number;
  oldPath?: string; // For renamed files
}

export interface GitFileDiff {
  file: string;
  hunks: GitDiffHunk[];
  isBinary: boolean;
  oldPath?: string;
}

export interface GitDiffHunk {
  header: string;
  lines: GitDiffLine[];
}

export interface GitDiffLine {
  type: 'context' | 'addition' | 'deletion' | 'header';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface GitDetailedStatus {
  success: boolean;
  error?: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  branch: string;
  ahead: number;
  behind: number;
}

export interface GitAheadBehind {
  success: boolean;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  hasUpstream: boolean;
  error?: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

// ============================================================================
// Extended Git Types for New Features
// ============================================================================

export interface GitBlameLine {
  hash: string;
  author: string;
  authorTime: string;
  lineNumber: number;
  content: string;
}

export interface GitTag {
  name: string;
  hash: string;
  message?: string;
  tagger?: string;
  date?: string;
  isAnnotated: boolean;
}

export interface GitFileHistoryEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitConflictFile {
  file: string;
  ourStatus: string;
  theirStatus: string;
}

export interface GitReflogEntry {
  hash: string;
  shortHash: string;
  action: string;
  message: string;
  date: string;
  index: number;
}

export interface GitSubmodule {
  path: string;
  url: string;
  branch?: string;
  hash: string;
  status: 'initialized' | 'uninitialized' | 'modified' | 'unknown';
}

export interface GitWorktree {
  path: string;
  hash: string;
  branch?: string;
  isMain: boolean;
  isDetached: boolean;
}
