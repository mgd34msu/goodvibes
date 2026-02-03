// ============================================================================
// GIT SERVICE - BASIC OPERATIONS
// ============================================================================

import type { GitStatus, GitDetailedStatus, GitFileChange } from '../../../shared/types/index.js';
import { runGitCommand } from './core.js';

// ============================================================================
// BASIC GIT OPERATIONS
// ============================================================================

export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['status', '--porcelain', '-b']);
}

export async function gitBranch(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['branch', '--show-current']);
}

export async function gitLog(cwd: string, limit: number = 10): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  // Validate limit is a positive integer to prevent injection via numeric args
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit))));
  return runGitCommand(cwd, ['log', '--oneline', '-n', String(safeLimit)]);
}

export async function gitDiff(cwd: string, staged: boolean = false): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  const args = staged ? ['diff', '--staged', '--stat'] : ['diff', '--stat'];
  return runGitCommand(cwd, args);
}

export async function gitAdd(cwd: string, files?: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  // Split files by whitespace if provided, otherwise add all
  const fileList = files ? files.split(/\s+/).filter(Boolean) : ['.'];
  return runGitCommand(cwd, ['add', ...fileList]);
}

export async function gitCommit(cwd: string, message: string): Promise<GitStatus> {
  if (!cwd || !message) return { success: false, error: 'Missing cwd or commit message' };
  // No escaping needed - execFile passes arguments safely without shell interpretation
  return runGitCommand(cwd, ['commit', '-m', message]);
}

export async function gitPush(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['push']);
}

export async function gitPull(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['pull']);
}

export async function gitIsRepo(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  const result = await runGitCommand(cwd, ['rev-parse', '--git-dir']);
  return result.success;
}

export async function gitRemote(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['remote', '-v']);
}

export async function gitStash(cwd: string, action?: 'pop' | 'list'): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  const args = action === 'pop' ? ['stash', 'pop'] : action === 'list' ? ['stash', 'list'] : ['stash'];
  return runGitCommand(cwd, args);
}

export async function gitInit(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['init']);
}

export async function gitReset(cwd: string, files?: string[]): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  // Files are passed as individual arguments, preventing injection
  const args = files && files.length > 0 ? ['reset', 'HEAD', ...files] : ['reset', 'HEAD'];
  return runGitCommand(cwd, args);
}

export async function gitFetch(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['fetch']);
}

// ============================================================================
// STATUS PARSING
// ============================================================================

/**
 * Parse git status porcelain output into structured file changes
 */
function parseStatusLine(line: string): GitFileChange | null {
  if (!line || line.length < 3) return null;

  const indexStatus = line.charAt(0);
  const workTreeStatus = line.charAt(1);
  let filePath = line.substring(3);
  let originalPath: string | undefined;

  // Handle renamed files (format: "R  old -> new")
  if (filePath.includes(' -> ')) {
    const parts = filePath.split(' -> ');
    originalPath = parts[0];
    filePath = parts[1];
  }

  // Determine status category
  let status: GitFileChange['status'];
  let staged = false;

  if (indexStatus === '?' && workTreeStatus === '?') {
    status = 'untracked';
  } else if (indexStatus === '!' && workTreeStatus === '!') {
    status = 'ignored';
  } else if (indexStatus !== ' ' && indexStatus !== '?') {
    // Has staged changes
    staged = true;
    if (indexStatus === 'A') status = 'added';
    else if (indexStatus === 'D') status = 'deleted';
    else if (indexStatus === 'M') status = 'modified';
    else if (indexStatus === 'R') status = 'renamed';
    else if (indexStatus === 'C') status = 'copied';
    else status = 'modified';
  } else if (workTreeStatus !== ' ') {
    // Has unstaged changes
    if (workTreeStatus === 'D') status = 'deleted';
    else if (workTreeStatus === 'M') status = 'modified';
    else status = 'modified';
  } else {
    return null;
  }

  return {
    status,
    file: filePath,
    staged,
    indexStatus,
    workTreeStatus,
    originalPath,
  };
}

/**
 * Get detailed git status with parsed file changes
 */
export async function gitDetailedStatus(cwd: string): Promise<GitDetailedStatus> {
  if (!cwd) {
    return {
      success: false,
      error: 'No working directory specified',
      staged: [],
      unstaged: [],
      untracked: [],
      branch: '',
      ahead: 0,
      behind: 0,
    };
  }

  const result = await runGitCommand(cwd, ['status', '--porcelain=v1', '-b', '-u']);

  if (!result.success || !result.output) {
    return {
      success: result.success,
      error: result.error,
      staged: [],
      unstaged: [],
      untracked: [],
      branch: '',
      ahead: 0,
      behind: 0,
    };
  }

  const lines = result.output.split('\n');
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  let branch = '';
  let ahead = 0;
  let behind = 0;

  for (const line of lines) {
    if (line.startsWith('##')) {
      // Parse branch line: ## branch...origin/branch [ahead N, behind M]
      const branchMatch = line.match(/^## ([^.]+)/);
      if (branchMatch) {
        branch = branchMatch[1].replace('No commits yet on ', '');
      }

      const aheadMatch = line.match(/ahead (\d+)/);
      const behindMatch = line.match(/behind (\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);
      continue;
    }

    const change = parseStatusLine(line);
    if (!change) continue;

    if (change.status === 'untracked') {
      untracked.push(change);
    } else if (change.staged) {
      staged.push(change);
      // File might also have unstaged changes
      if (change.workTreeStatus !== ' ') {
        unstaged.push({
          ...change,
          staged: false,
        });
      }
    } else {
      unstaged.push(change);
    }
  }

  return {
    success: true,
    staged,
    unstaged,
    untracked,
    branch,
    ahead,
    behind,
  };
}

/**
 * Stage specific files
 */
export async function gitStage(cwd: string, files: string[]): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };

  return runGitCommand(cwd, ['add', '--', ...files]);
}

/**
 * Unstage specific files
 */
export async function gitUnstage(cwd: string, files: string[]): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };

  return runGitCommand(cwd, ['reset', 'HEAD', '--', ...files]);
}

/**
 * Discard changes to a file (restore to HEAD)
 */
export async function gitDiscardChanges(cwd: string, files: string[]): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };

  return runGitCommand(cwd, ['checkout', 'HEAD', '--', ...files]);
}

/**
 * Delete untracked files
 */
export async function gitCleanFile(cwd: string, file: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!file) return { success: false, error: 'No file specified' };

  return runGitCommand(cwd, ['clean', '-f', '--', file]);
}

/**
 * Get ahead/behind counts for current branch relative to remote
 *
 * This function handles multiple scenarios:
 * 1. Branch has upstream configured - use rev-list with @{upstream}
 * 2. No upstream but remote exists - compare with origin/<branch>
 * 3. No remote at all - return 0/0 with hasRemote: false
 */
export async function gitAheadBehind(cwd: string): Promise<{
  success: boolean;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  hasUpstream: boolean;
  error?: string;
}> {
  if (!cwd) {
    return { success: false, ahead: 0, behind: 0, hasRemote: false, hasUpstream: false, error: 'No working directory specified' };
  }

  // First, check if any remote exists
  const remoteResult = await runGitCommand(cwd, ['remote']);
  const hasRemote = remoteResult.success && !!remoteResult.output?.trim();

  if (!hasRemote) {
    // No remotes configured - push/pull won't work regardless
    return { success: true, ahead: 0, behind: 0, hasRemote: false, hasUpstream: false };
  }

  // Get current branch name
  const branchResult = await runGitCommand(cwd, ['branch', '--show-current']);
  if (!branchResult.success || !branchResult.output?.trim()) {
    // Detached HEAD or other issue
    return { success: true, ahead: 0, behind: 0, hasRemote: true, hasUpstream: false };
  }
  const currentBranch = branchResult.output.trim();

  // Try to use the configured upstream first
  const upstreamResult = await runGitCommand(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);

  if (upstreamResult.success && upstreamResult.output) {
    const parts = upstreamResult.output.trim().split(/\s+/) || [];
    const behind = parseInt(parts[0], 10) || 0;
    const ahead = parseInt(parts[1], 10) || 0;
    return { success: true, ahead, behind, hasRemote: true, hasUpstream: true };
  }

  // No upstream set - try to compare with origin/<branch> if it exists
  const remoteBranchResult = await runGitCommand(cwd, ['rev-parse', '--verify', `origin/${currentBranch}`]);

  if (remoteBranchResult.success) {
    // Remote branch exists, compare with it
    const compareResult = await runGitCommand(cwd, ['rev-list', '--left-right', '--count', `origin/${currentBranch}...HEAD`]);

    if (compareResult.success && compareResult.output) {
      const parts = compareResult.output.trim().split(/\s+/) || [];
      const behind = parseInt(parts[0], 10) || 0;
      const ahead = parseInt(parts[1], 10) || 0;
      return { success: true, ahead, behind, hasRemote: true, hasUpstream: false };
    }
  }

  // Remote exists but this branch hasn't been pushed yet
  // Count all commits from the branch as "ahead"
  const countResult = await runGitCommand(cwd, ['rev-list', '--count', 'HEAD']);
  if (countResult.success && countResult.output) {
    const ahead = parseInt(countResult.output.trim(), 10) || 0;
    // New branch not on remote - user can push to create it
    return { success: true, ahead, behind: 0, hasRemote: true, hasUpstream: false };
  }

  return { success: true, ahead: 0, behind: 0, hasRemote: true, hasUpstream: false };
}

// ============================================================================
// REMOTE MANAGEMENT
// ============================================================================

/**
 * Get list of configured remotes with their URLs
 */
export async function gitRemotes(cwd: string): Promise<{
  success: boolean;
  remotes: Array<{ name: string; fetchUrl: string; pushUrl: string }>;
  error?: string;
}> {
  if (!cwd) {
    return { success: false, remotes: [], error: 'No working directory specified' };
  }

  const result = await runGitCommand(cwd, ['remote', '-v']);

  if (!result.success) {
    return { success: false, remotes: [], error: result.error };
  }

  const remotes = new Map<string, { name: string; fetchUrl: string; pushUrl: string }>();

  if (result.output) {
    const lines = result.output.split('\n').filter(Boolean);
    for (const line of lines) {
      // Format: "origin  https://github.com/user/repo.git (fetch)" or "(push)"
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (match) {
        const [, name, url, type] = match;
        if (!remotes.has(name)) {
          remotes.set(name, { name, fetchUrl: '', pushUrl: '' });
        }
        const remote = remotes.get(name);
        if (remote) {
          if (type === 'fetch') {
            remote.fetchUrl = url;
          } else {
            remote.pushUrl = url;
          }
        }
      }
    }
  }

  return { success: true, remotes: Array.from(remotes.values()) };
}

/**
 * Add a new remote
 */
export async function gitRemoteAdd(cwd: string, name: string, url: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!name) return { success: false, error: 'No remote name specified' };
  if (!url) return { success: false, error: 'No URL specified' };

  // Sanitize remote name
  if (!/^[\w-]+$/.test(name)) {
    return { success: false, error: 'Invalid remote name' };
  }

  return runGitCommand(cwd, ['remote', 'add', name, url]);
}

/**
 * Remove a remote
 */
export async function gitRemoteRemove(cwd: string, name: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!name) return { success: false, error: 'No remote name specified' };

  // Sanitize remote name
  if (!/^[\w-]+$/.test(name)) {
    return { success: false, error: 'Invalid remote name' };
  }

  return runGitCommand(cwd, ['remote', 'remove', name]);
}
