// ============================================================================
// GIT SERVICE - COMMIT OPERATIONS
// ============================================================================

import type { GitStatus, GitCommitInfo, GitCommitDetail, GitCommitFile } from '../../../shared/types/index.js';
import { runGitCommand, validateCommitHash, logger } from './core.js';
import type { GitFileHistoryEntry } from './types.js';

/**
 * Get recent commits with detailed info for the current branch
 *
 * Note: By default, git log shows all commits reachable from HEAD.
 * This is standard Git behavior - if branch B was created from branch A,
 * B will include A's history up to the point of divergence.
 */
export async function gitLogDetailed(cwd: string, limit: number = 20): Promise<{ success: boolean; commits: GitCommitInfo[]; error?: string }> {
  if (!cwd) {
    return { success: false, commits: [], error: 'No working directory specified' };
  }

  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit))));

  // First, get the current branch name for logging purposes
  const branchResult = await runGitCommand(cwd, ['branch', '--show-current']);
  const currentBranch = branchResult.success ? branchResult.output?.trim() : 'unknown';
  logger.debug(`Fetching commits for branch: ${currentBranch}`);

  // Format: hash|short_hash|author|email|date|subject
  // We use HEAD explicitly to ensure we're getting commits from current position
  const result = await runGitCommand(cwd, [
    'log',
    'HEAD',
    `--max-count=${safeLimit}`,
    '--format=%H|%h|%an|%ae|%aI|%s'
  ]);

  if (!result.success) {
    // Check if it's just an empty repo (handles both "does not have any commits" and "does not have any commits yet")
    if (result.error?.includes('does not have any commits') || result.stderr?.includes('does not have any commits')) {
      return { success: true, commits: [] };
    }
    return { success: false, commits: [], error: result.error };
  }

  const commits: GitCommitInfo[] = [];
  const lines = result.output?.split('\n').filter(Boolean) || [];

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length >= 6) {
      commits.push({
        hash: parts[0],
        shortHash: parts[1],
        author: parts[2],
        email: parts[3],
        date: parts[4],
        subject: parts.slice(5).join('|'), // Subject might contain |
      });
    }
  }

  return { success: true, commits };
}

/**
 * Get detailed information about a specific commit including files changed
 */
export async function gitShowCommit(cwd: string, hash: string): Promise<{ success: boolean; commit?: GitCommitDetail; error?: string }> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!hash) return { success: false, error: 'No commit hash specified' };

  const validation = validateCommitHash(hash);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Get commit info with body
  const commitResult = await runGitCommand(cwd, [
    'show',
    hash,
    '--format=%H|%h|%an|%ae|%aI|%s|%b',
    '--no-patch'
  ]);

  if (!commitResult.success || !commitResult.output) {
    return { success: false, error: commitResult.error || 'Failed to get commit info' };
  }

  // Parse commit info (first line is the format, rest might be body with newlines)
  const lines = commitResult.output.split('\n');
  const firstLine = lines[0];
  const parts = firstLine.split('|');

  if (parts.length < 6) {
    return { success: false, error: 'Failed to parse commit info' };
  }

  const [fullHash, shortHash, author, email, date, subject] = parts;
  // Body might contain pipes, so join remaining parts and include all lines after first
  const bodyFromParts = parts.slice(6).join('|');
  const bodyFromLines = lines.slice(1).join('\n');
  const body = (bodyFromParts + (bodyFromLines ? '\n' + bodyFromLines : '')).trim();

  // Get file stats for the commit
  const statsResult = await runGitCommand(cwd, [
    'show',
    hash,
    '--stat',
    '--format='
  ]);

  const files: GitCommitFile[] = [];
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  if (statsResult.success && statsResult.output) {
    const statLines = statsResult.output.trim().split('\n').filter(Boolean);

    for (const line of statLines) {
      // Last line is summary like "3 files changed, 10 insertions(+), 5 deletions(-)"
      const summaryMatch = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (summaryMatch) {
        filesChanged = parseInt(summaryMatch[1], 10) || 0;
        insertions = parseInt(summaryMatch[2], 10) || 0;
        deletions = parseInt(summaryMatch[3], 10) || 0;
        continue;
      }

      // File lines like " src/file.ts | 10 +++++-----"
      const fileMatch = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s*([+-]*)/);
      if (fileMatch) {
        const filePath = fileMatch[1].trim();
        const changes = parseInt(fileMatch[2], 10) || 0;
        const changeIndicator = fileMatch[3] || '';

        // Count + and - in the indicator to estimate insertions/deletions
        const adds = (changeIndicator.match(/\+/g) || []).length;
        const dels = (changeIndicator.match(/-/g) || []).length;
        const total = adds + dels || 1;

        const fileInsertions = Math.round(changes * (adds / total));
        const fileDeletions = changes - fileInsertions;

        files.push({
          file: filePath,
          status: 'modified', // Will be refined below
          insertions: fileInsertions,
          deletions: fileDeletions,
        });
      }
    }
  }

  // Get file statuses (added, modified, deleted, renamed)
  const nameStatusResult = await runGitCommand(cwd, [
    'show',
    hash,
    '--name-status',
    '--format='
  ]);

  if (nameStatusResult.success && nameStatusResult.output) {
    const statusLines = nameStatusResult.output.trim().split('\n').filter(Boolean);

    for (const line of statusLines) {
      const statusParts = line.split('\t');
      if (statusParts.length >= 2) {
        const statusCode = statusParts[0];
        const filePath = statusParts[statusParts.length - 1]; // Use last part for file path

        // Find matching file in our list and update status
        const fileEntry = files.find(f => f.file === filePath || f.file.includes(filePath));
        if (fileEntry) {
          if (statusCode.startsWith('R')) {
            fileEntry.status = 'renamed';
            fileEntry.oldPath = statusParts[1];
          } else if (statusCode.startsWith('C')) {
            fileEntry.status = 'copied';
            fileEntry.oldPath = statusParts[1];
          } else if (statusCode === 'A') {
            fileEntry.status = 'added';
          } else if (statusCode === 'D') {
            fileEntry.status = 'deleted';
          } else {
            fileEntry.status = 'modified';
          }
        }
      }
    }
  }

  return {
    success: true,
    commit: {
      hash: fullHash,
      shortHash,
      author,
      email,
      date,
      subject,
      body,
      files,
      stats: {
        filesChanged,
        insertions,
        deletions,
      },
    },
  };
}

/**
 * Amend the last commit
 * @param message If provided, change the commit message; otherwise keep the existing message
 */
export async function gitCommitAmend(
  cwd: string,
  options?: { message?: string; noEdit?: boolean }
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args = ['commit', '--amend'];

  if (options?.message) {
    args.push('-m', options.message);
  } else if (options?.noEdit) {
    args.push('--no-edit');
  }

  logger.info('Amending last commit');
  return runGitCommand(cwd, args);
}

/**
 * Cherry-pick a commit
 */
export async function gitCherryPick(cwd: string, commit: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!commit) return { success: false, error: 'No commit specified' };

  const validation = validateCommitHash(commit);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  logger.info(`Cherry-picking commit: ${commit}`);
  return runGitCommand(cwd, ['cherry-pick', commit]);
}

/**
 * Abort a cherry-pick in progress
 */
export async function gitCherryPickAbort(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['cherry-pick', '--abort']);
}

/**
 * Continue a cherry-pick after resolving conflicts
 */
export async function gitCherryPickContinue(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['cherry-pick', '--continue']);
}

/**
 * Check if a cherry-pick is in progress
 */
export async function gitCherryPickInProgress(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  // Check for CHERRY_PICK_HEAD file which indicates a cherry-pick in progress
  const result = await runGitCommand(cwd, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']);
  return result.success;
}

/**
 * Get commit history for a specific file
 */
export async function gitFileHistory(
  cwd: string,
  file: string,
  limit: number = 50
): Promise<{ success: boolean; commits: GitFileHistoryEntry[]; error?: string }> {
  if (!cwd) return { success: false, commits: [], error: 'No working directory specified' };
  if (!file) return { success: false, commits: [], error: 'No file specified' };

  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit))));

  const result = await runGitCommand(cwd, [
    'log',
    `--max-count=${safeLimit}`,
    '--format=%H|%h|%an|%aI|%s',
    '--follow',
    '--',
    file,
  ]);

  if (!result.success) {
    return { success: false, commits: [], error: result.error };
  }

  const commits: GitFileHistoryEntry[] = [];
  const lines = (result.output || '').split('\n').filter(Boolean);

  for (const line of lines) {
    const [hash, shortHash, author, date, ...subjectParts] = line.split('|');
    if (hash && shortHash) {
      commits.push({
        hash,
        shortHash,
        author,
        date,
        subject: subjectParts.join('|'),
      });
    }
  }

  return { success: true, commits };
}

/**
 * Get file content at a specific commit
 */
export async function gitShowFile(cwd: string, file: string, commit: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!file) return { success: false, error: 'No file specified' };
  if (!commit) return { success: false, error: 'No commit specified' };

  const validation = validateCommitHash(commit);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return runGitCommand(cwd, ['show', `${commit}:${file}`]);
}

/**
 * Get commit template from .gitmessage or git config
 */
export async function gitCommitTemplate(cwd: string): Promise<{ success: boolean; template?: string; error?: string }> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  // First check git config for commit.template
  const configResult = await runGitCommand(cwd, ['config', 'commit.template']);

  if (configResult.success && configResult.output?.trim()) {
    const templatePath = configResult.output.trim();
    // Read the template file
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      // Handle relative paths
      const fullPath = path.isAbsolute(templatePath)
        ? templatePath
        : path.join(cwd, templatePath);

      const template = await fs.readFile(fullPath, 'utf-8');
      return { success: true, template };
    } catch {
      return { success: false, error: `Could not read template file: ${templatePath}` };
    }
  }

  // Check for .gitmessage in project root
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const gitmessagePath = path.join(cwd, '.gitmessage');
    const template = await fs.readFile(gitmessagePath, 'utf-8');
    return { success: true, template };
  } catch {
    // No template found, which is fine
    return { success: true, template: undefined };
  }
}

/**
 * Get conventional commit prefixes based on recent commits
 */
export async function gitConventionalPrefixes(cwd: string): Promise<{ success: boolean; prefixes: string[]; error?: string }> {
  if (!cwd) return { success: false, prefixes: [], error: 'No working directory specified' };

  // Standard conventional commit prefixes
  const standardPrefixes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];

  // Get recent commit prefixes from the repo
  const result = await runGitCommand(cwd, ['log', '--oneline', '-100', '--format=%s']);

  if (!result.success) {
    return { success: true, prefixes: standardPrefixes };
  }

  const usedPrefixes = new Set<string>();
  const lines = (result.output || '').split('\n').filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(\w+)(?:\([^)]+\))?:/);
    if (match) {
      usedPrefixes.add(match[1].toLowerCase());
    }
  }

  // Combine standard prefixes with any found in the repo, prioritizing used ones
  const allPrefixes = [...usedPrefixes, ...standardPrefixes.filter(p => !usedPrefixes.has(p))];

  return { success: true, prefixes: allPrefixes };
}
