// ============================================================================
// GIT SERVICE - ADVANCED OPERATIONS
// (Rebase, Reflog, Submodules, Worktrees)
// ============================================================================

import type { GitStatus } from '../../../shared/types/index.js';
import { runGitCommand, validateBranchName, logger } from './core.js';
import type { GitReflogEntry, GitSubmodule, GitWorktree } from './types.js';

// ============================================================================
// REBASE SUPPORT
// ============================================================================

/**
 * Rebase current branch onto another branch
 */
export async function gitRebase(cwd: string, onto: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!onto) return { success: false, error: 'No target branch specified' };

  const validation = validateBranchName(onto);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  logger.info(`Rebasing onto: ${onto}`);
  return runGitCommand(cwd, ['rebase', onto]);
}

/**
 * Abort a rebase in progress
 */
export async function gitRebaseAbort(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['rebase', '--abort']);
}

/**
 * Continue a rebase after resolving conflicts
 */
export async function gitRebaseContinue(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['rebase', '--continue']);
}

/**
 * Skip the current commit during rebase
 */
export async function gitRebaseSkip(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['rebase', '--skip']);
}

/**
 * Check if a rebase is in progress
 */
export async function gitRebaseInProgress(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  // Check for rebase-merge or rebase-apply directories
  const mergeResult = await runGitCommand(cwd, ['rev-parse', '--git-path', 'rebase-merge']);

  if (mergeResult.success && mergeResult.output) {
    // If either directory exists as a real path (not just returned), rebase is in progress
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const gitDir = await runGitCommand(cwd, ['rev-parse', '--git-dir']);
    if (gitDir.success && gitDir.output) {
      const rebaseMerge = join(cwd, gitDir.output.trim(), 'rebase-merge');
      const rebaseApply = join(cwd, gitDir.output.trim(), 'rebase-apply');
      return existsSync(rebaseMerge) || existsSync(rebaseApply);
    }
  }

  return false;
}

// ============================================================================
// REFLOG
// ============================================================================

/**
 * Get reflog entries
 */
export async function gitReflog(
  cwd: string,
  limit: number = 50
): Promise<{ success: boolean; entries: GitReflogEntry[]; error?: string }> {
  if (!cwd) return { success: false, entries: [], error: 'No working directory specified' };

  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit))));

  const result = await runGitCommand(cwd, [
    'reflog',
    `--max-count=${safeLimit}`,
    '--format=%H|%h|%gD|%gs|%aI',
  ]);

  if (!result.success) {
    return { success: false, entries: [], error: result.error };
  }

  const entries: GitReflogEntry[] = [];
  const lines = (result.output || '').split('\n').filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const [hash, shortHash, _ref, message, date] = line.split('|');
    if (hash && shortHash) {
      // Extract action from message (e.g., "commit:", "checkout:", "rebase:")
      const actionMatch = message?.match(/^(\w+):/);
      entries.push({
        hash,
        shortHash,
        action: actionMatch?.[1] || 'unknown',
        message: message || '',
        date: date || '',
        index: i,
      });
    }
  }

  return { success: true, entries };
}

/**
 * Reset to a reflog entry
 */
export async function gitResetToReflog(
  cwd: string,
  index: number,
  options?: { hard?: boolean; soft?: boolean }
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args = ['reset'];
  if (options?.hard) args.push('--hard');
  else if (options?.soft) args.push('--soft');
  args.push(`HEAD@{${index}}`);

  logger.info(`Resetting to reflog entry HEAD@{${index}}`);
  return runGitCommand(cwd, args);
}

// ============================================================================
// SUBMODULE SUPPORT
// ============================================================================

/**
 * List all submodules
 */
export async function gitSubmodules(cwd: string): Promise<{ success: boolean; submodules: GitSubmodule[]; error?: string }> {
  if (!cwd) return { success: false, submodules: [], error: 'No working directory specified' };

  const result = await runGitCommand(cwd, ['submodule', 'status', '--recursive']);

  if (!result.success) {
    return { success: false, submodules: [], error: result.error };
  }

  const submodules: GitSubmodule[] = [];
  const lines = (result.output || '').split('\n').filter(Boolean);

  for (const line of lines) {
    // Format: [+-U ]hash path (branch)
    const match = line.match(/^([ +-U])([a-f0-9]+)\s+(.+?)(?:\s+\((.+)\))?$/);
    if (match) {
      const [, statusChar, hash, path, branch] = match;
      let status: GitSubmodule['status'] = 'unknown';

      switch (statusChar) {
        case ' ': status = 'initialized'; break;
        case '-': status = 'uninitialized'; break;
        case '+': status = 'modified'; break;
        case 'U': status = 'modified'; break;
      }

      submodules.push({
        path: path.trim(),
        url: '', // Will be filled from config
        branch: branch?.trim(),
        hash: hash.substring(0, 8),
        status,
      });
    }
  }

  // Get URLs from .gitmodules
  const configResult = await runGitCommand(cwd, ['config', '--file', '.gitmodules', '--get-regexp', 'url']);
  if (configResult.success && configResult.output) {
    const urlLines = configResult.output.split('\n').filter(Boolean);
    for (const urlLine of urlLines) {
      const urlMatch = urlLine.match(/^submodule\.(.+)\.url\s+(.+)$/);
      if (urlMatch) {
        const [, name, url] = urlMatch;
        const submodule = submodules.find(s => s.path === name || s.path.endsWith(`/${name}`));
        if (submodule) {
          submodule.url = url;
        }
      }
    }
  }

  return { success: true, submodules };
}

/**
 * Initialize submodules
 */
export async function gitSubmoduleInit(cwd: string, path?: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args = ['submodule', 'init'];
  if (path) args.push('--', path);

  logger.info(`Initializing submodules${path ? `: ${path}` : ''}`);
  return runGitCommand(cwd, args);
}

/**
 * Update submodules
 */
export async function gitSubmoduleUpdate(
  cwd: string,
  options?: { init?: boolean; recursive?: boolean; remote?: boolean; path?: string }
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args = ['submodule', 'update'];
  if (options?.init) args.push('--init');
  if (options?.recursive) args.push('--recursive');
  if (options?.remote) args.push('--remote');
  if (options?.path) args.push('--', options.path);

  logger.info(`Updating submodules`);
  return runGitCommand(cwd, args);
}

// ============================================================================
// WORKTREE SUPPORT
// ============================================================================

/**
 * List all worktrees
 */
export async function gitWorktrees(cwd: string): Promise<{ success: boolean; worktrees: GitWorktree[]; error?: string }> {
  if (!cwd) return { success: false, worktrees: [], error: 'No working directory specified' };

  const result = await runGitCommand(cwd, ['worktree', 'list', '--porcelain']);

  if (!result.success) {
    return { success: false, worktrees: [], error: result.error };
  }

  const worktrees: GitWorktree[] = [];
  const output = result.output || '';
  const blocks = output.split('\n\n').filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const worktree: Partial<GitWorktree> = { isMain: false, isDetached: false };

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktree.path = line.substring(9);
      } else if (line.startsWith('HEAD ')) {
        worktree.hash = line.substring(5, 13);
      } else if (line.startsWith('branch ')) {
        worktree.branch = line.substring(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        worktree.isMain = true;
      } else if (line === 'detached') {
        worktree.isDetached = true;
      }
    }

    if (worktree.path) {
      // First worktree is the main one
      if (worktrees.length === 0) {
        worktree.isMain = true;
      }
      worktrees.push(worktree as GitWorktree);
    }
  }

  return { success: true, worktrees };
}

/**
 * Add a new worktree
 */
export async function gitWorktreeAdd(
  cwd: string,
  path: string,
  branch?: string,
  options?: { newBranch?: boolean; detach?: boolean }
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!path) return { success: false, error: 'No path specified' };

  const args = ['worktree', 'add'];

  if (options?.detach) {
    args.push('--detach');
  } else if (branch && options?.newBranch) {
    args.push('-b', branch);
  }

  args.push(path);

  if (branch && !options?.newBranch && !options?.detach) {
    args.push(branch);
  }

  logger.info(`Adding worktree at ${path}`);
  return runGitCommand(cwd, args);
}

/**
 * Remove a worktree
 */
export async function gitWorktreeRemove(cwd: string, path: string, force?: boolean): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!path) return { success: false, error: 'No path specified' };

  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);

  logger.info(`Removing worktree at ${path}`);
  return runGitCommand(cwd, args);
}
