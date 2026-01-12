// ============================================================================
// GIT SERVICE - TYPE DEFINITIONS
// ============================================================================

/**
 * Git blame line information
 */
export interface GitBlameLine {
  hash: string;
  author: string;
  authorTime: string;
  lineNumber: number;
  content: string;
}

/**
 * Git file history entry
 */
export interface GitFileHistoryEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

/**
 * Git conflict file information
 */
export interface GitConflictFile {
  file: string;
  ourStatus: string;
  theirStatus: string;
}

/**
 * Git reflog entry
 */
export interface GitReflogEntry {
  hash: string;
  shortHash: string;
  action: string;
  message: string;
  date: string;
  index: number;
}

/**
 * Git submodule information
 */
export interface GitSubmodule {
  path: string;
  url: string;
  branch?: string;
  hash: string;
  status: 'initialized' | 'uninitialized' | 'modified' | 'unknown';
}

/**
 * Git worktree information
 */
export interface GitWorktree {
  path: string;
  hash: string;
  branch?: string;
  isMain: boolean;
  isDetached: boolean;
}

/**
 * Rate limiter state for git operations
 */
export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  maxTokens: number;
  refillRate: number;
  tokensPerRequest: number;
}
