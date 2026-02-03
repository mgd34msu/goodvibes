// ============================================================================
// GIT SERVICE - STASH OPERATIONS
// ============================================================================

import type { GitStatus } from '../../../shared/types/index.js';
import { runGitCommand, logger } from './core.js';

/**
 * List stashes
 */
export async function gitStashList(cwd: string): Promise<{
  success: boolean;
  stashes: Array<{ index: number; message: string; branch: string }>;
  error?: string;
}> {
  if (!cwd) {
    return { success: false, stashes: [], error: 'No working directory specified' };
  }

  const result = await runGitCommand(cwd, ['stash', 'list']);

  if (!result.success) {
    return { success: false, stashes: [], error: result.error };
  }

  const stashes: Array<{ index: number; message: string; branch: string }> = [];

  if (result.output) {
    const lines = result.output.split('\n').filter(Boolean);
    for (const line of lines) {
      // Format: "stash@{0}: On main: message" or "stash@{0}: WIP on main: hash message"
      const match = line.match(/^stash@\{(\d+)\}:\s*(?:(?:On|WIP on)\s+(\S+):\s*)?(.*)$/);
      if (match) {
        const [, indexStr, branch, message] = match;
        stashes.push({
          index: parseInt(indexStr, 10),
          branch: branch || '',
          message: message.trim(),
        });
      }
    }
  }

  return { success: true, stashes };
}

/**
 * Push changes to stash with optional message
 */
export async function gitStashPush(cwd: string, message?: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args = ['stash', 'push'];
  if (message) {
    args.push('-m', message);
  }

  logger.info(`Stashing changes${message ? `: ${message}` : ''}`);
  return runGitCommand(cwd, args);
}

/**
 * Pop a stash (apply and remove)
 */
export async function gitStashPop(cwd: string, index?: number): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args = ['stash', 'pop'];
  if (index !== undefined) {
    args.push(`stash@{${index}}`);
  }

  logger.info(`Popping stash${index !== undefined ? ` at index ${index}` : ''}`);
  return runGitCommand(cwd, args);
}

/**
 * Apply a stash without removing it
 */
export async function gitStashApply(cwd: string, index?: number): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args = ['stash', 'apply'];
  if (index !== undefined) {
    args.push(`stash@{${index}}`);
  }

  logger.info(`Applying stash${index !== undefined ? ` at index ${index}` : ''}`);
  return runGitCommand(cwd, args);
}

/**
 * Drop a stash
 */
export async function gitStashDrop(cwd: string, index?: number): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args = ['stash', 'drop'];
  if (index !== undefined) {
    args.push(`stash@{${index}}`);
  }

  logger.info(`Dropping stash${index !== undefined ? ` at index ${index}` : ''}`);
  return runGitCommand(cwd, args);
}
