// ============================================================================
// GIT SERVICE - CONFLICT RESOLUTION
// ============================================================================

import type { GitStatus } from '../../../shared/types/index.js';
import { runGitCommand, logger } from './core.js';
import type { GitConflictFile } from './types.js';

/**
 * Get list of files with merge conflicts
 */
export async function gitConflictFiles(cwd: string): Promise<{ success: boolean; files: GitConflictFile[]; error?: string }> {
  if (!cwd) return { success: false, files: [], error: 'No working directory specified' };

  // Get unmerged files
  const result = await runGitCommand(cwd, ['diff', '--name-only', '--diff-filter=U']);

  if (!result.success) {
    return { success: false, files: [], error: result.error };
  }

  const files: GitConflictFile[] = [];
  const lines = (result.output || '').split('\n').filter(Boolean);

  for (const file of lines) {
    files.push({
      file,
      ourStatus: 'modified',
      theirStatus: 'modified',
    });
  }

  return { success: true, files };
}

/**
 * Accept "ours" version for a conflicted file
 */
export async function gitResolveOurs(cwd: string, file: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!file) return { success: false, error: 'No file specified' };

  logger.info(`Resolving conflict for ${file} with "ours"`);
  const checkoutResult = await runGitCommand(cwd, ['checkout', '--ours', '--', file]);
  if (!checkoutResult.success) return checkoutResult;

  return runGitCommand(cwd, ['add', '--', file]);
}

/**
 * Accept "theirs" version for a conflicted file
 */
export async function gitResolveTheirs(cwd: string, file: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!file) return { success: false, error: 'No file specified' };

  logger.info(`Resolving conflict for ${file} with "theirs"`);
  const checkoutResult = await runGitCommand(cwd, ['checkout', '--theirs', '--', file]);
  if (!checkoutResult.success) return checkoutResult;

  return runGitCommand(cwd, ['add', '--', file]);
}

/**
 * Mark a file as resolved (after manual conflict resolution)
 */
export async function gitMarkResolved(cwd: string, files: string[]): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };

  logger.info(`Marking ${files.length} file(s) as resolved`);
  return runGitCommand(cwd, ['add', '--', ...files]);
}
