// ============================================================================
// GIT SERVICE - BRANCH MANAGEMENT
// ============================================================================

import type { GitStatus, GitBranchInfo } from '../../../shared/types/index.js';
import { runGitCommand, validateBranchName, logger } from './core.js';

/**
 * Get list of all branches (local and remote)
 *
 * SIMPLE APPROACH: Use plain `git branch` output which always works,
 * including in repos without commits. Format:
 *   first-branch
 * * current-branch
 *   main
 *
 * Where * marks the current branch.
 */
export async function gitBranches(cwd: string): Promise<{ success: boolean; branches: GitBranchInfo[]; error?: string }> {
  if (!cwd) {
    return { success: false, branches: [], error: 'No working directory specified' };
  }

  const branches: GitBranchInfo[] = [];

  // Use plain `git branch` - this ALWAYS works, even in repos without commits
  // Output format: "  branch-name" or "* current-branch" (one per line)
  const localResult = await runGitCommand(cwd, ['branch']);

  logger.debug(`gitBranches: git branch command result - success: ${localResult.success}, output: "${localResult.output}", error: "${localResult.error}"`);

  if (localResult.success && localResult.output) {
    // Split on newlines, handling both Unix (\n) and Windows (\r\n) line endings
    const lines = localResult.output.split(/\r?\n/);
    logger.debug(`gitBranches: parsing ${lines.length} lines from output: "${localResult.output.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`);

    for (const line of lines) {
      // Skip empty lines
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Parse line: "* current-branch" or "  other-branch"
      // The asterisk indicates the current branch
      const isCurrent = trimmedLine.startsWith('*');

      // Remove the leading "* " or "  " and any extra whitespace
      // Handle cases like "* main" or "  feature-branch"
      const branchName = trimmedLine.replace(/^\*?\s*/, '').trim();

      logger.debug(`gitBranches: parsed line "${trimmedLine}" -> branch: "${branchName}", isCurrent: ${isCurrent}`);

      if (!branchName) continue;

      branches.push({
        name: branchName,
        hash: '',
        upstream: undefined,
        isCurrent,
        isRemote: false,
      });
    }
  } else if (!localResult.success) {
    logger.warn(`gitBranches: git branch failed - ${localResult.error}`);
  } else {
    logger.debug(`gitBranches: git branch returned empty output`);
  }

  logger.debug(`gitBranches: found ${branches.length} local branches`);

  // Get remote branches separately (optional enhancement, may fail in new repos)
  const remoteResult = await runGitCommand(cwd, ['branch', '-r']);

  if (remoteResult.success && remoteResult.output) {
    // Split on newlines, handling both Unix (\n) and Windows (\r\n) line endings
    const lines = remoteResult.output.split(/\r?\n/);
    for (const line of lines) {
      const branchName = line.trim();
      if (!branchName) continue;

      // Skip HEAD references like origin/HEAD -> origin/main
      if (branchName.includes('HEAD')) continue;

      branches.push({
        name: branchName,
        hash: '',
        upstream: undefined,
        isCurrent: false,
        isRemote: true,
      });
    }
  }

  logger.debug(`gitBranches: returning ${branches.length} total branches`);

  return { success: true, branches };
}

/**
 * Checkout a branch
 */
export async function gitCheckout(cwd: string, branch: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!branch) return { success: false, error: 'No branch specified' };

  const validation = validateBranchName(branch);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  logger.info(`Checking out branch: ${branch}`);
  const result = await runGitCommand(cwd, ['checkout', branch]);

  if (result.success) {
    logger.info(`Successfully checked out branch: ${branch}`);
  } else {
    logger.error(`Failed to checkout branch ${branch}: ${result.error}`);
  }

  return result;
}

/**
 * Create a new branch
 */
export async function gitCreateBranch(cwd: string, name: string, checkout: boolean = true): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!name) return { success: false, error: 'No branch name specified' };

  const validation = validateBranchName(name);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  logger.info(`Creating branch: ${name} (checkout: ${checkout})`);

  if (checkout) {
    return runGitCommand(cwd, ['checkout', '-b', name]);
  } else {
    return runGitCommand(cwd, ['branch', name]);
  }
}

/**
 * Delete a local branch
 * @param force If true, use -D (force delete even if not merged)
 */
export async function gitDeleteBranch(
  cwd: string,
  branch: string,
  options?: { force?: boolean }
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!branch) return { success: false, error: 'No branch specified' };

  const validation = validateBranchName(branch);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Cannot delete current branch
  const currentBranch = await runGitCommand(cwd, ['branch', '--show-current']);
  if (currentBranch.success && currentBranch.output?.trim() === branch) {
    return { success: false, error: 'Cannot delete the currently checked out branch' };
  }

  const flag = options?.force ? '-D' : '-d';
  logger.info(`Deleting branch: ${branch} (force: ${options?.force ?? false})`);

  return runGitCommand(cwd, ['branch', flag, branch]);
}

/**
 * Delete a remote branch
 */
export async function gitDeleteRemoteBranch(
  cwd: string,
  remote: string,
  branch: string
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!remote) return { success: false, error: 'No remote specified' };
  if (!branch) return { success: false, error: 'No branch specified' };

  // Sanitize inputs
  if (!/^[\w-]+$/.test(remote)) {
    return { success: false, error: 'Invalid remote name' };
  }

  const validation = validateBranchName(branch);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  logger.info(`Deleting remote branch: ${remote}/${branch}`);
  return runGitCommand(cwd, ['push', remote, '--delete', branch]);
}

/**
 * Get branches with hierarchy information.
 * For each branch, determine its likely parent branch based on merge-base analysis.
 * This helps visualize branch relationships in the UI.
 *
 * Algorithm: For each branch, find the CLOSEST parent by checking which other branch's
 * tip is closest to (or at) the merge-base point. The parent is the branch whose HEAD
 * has the fewest commits from the merge-base to its tip.
 */
export async function gitBranchesWithHierarchy(cwd: string): Promise<{
  success: boolean;
  branches: Array<GitBranchInfo & { parentBranch?: string; commitsAhead?: number }>;
  error?: string;
}> {
  if (!cwd) {
    return { success: false, branches: [], error: 'No working directory specified' };
  }

  // First get all branches
  const branchesResult = await gitBranches(cwd);
  if (!branchesResult.success) {
    return { success: false, branches: [], error: branchesResult.error };
  }

  const localBranches = branchesResult.branches.filter(b => !b.isRemote);

  // If only one branch or no branches, no hierarchy to compute
  if (localBranches.length <= 1) {
    return { success: true, branches: branchesResult.branches };
  }

  // Determine the main/default branch (usually main or master)
  const mainBranch = localBranches.find(b => b.name === 'main')
    || localBranches.find(b => b.name === 'master')
    || localBranches[0];

  // Get the commit hash for each branch (needed for comparison)
  const branchCommits = new Map<string, string>();
  for (const branch of localBranches) {
    const result = await runGitCommand(cwd, ['rev-parse', branch.name]);
    if (result.success && result.output) {
      branchCommits.set(branch.name, result.output.trim());
    }
  }

  const branchesWithHierarchy: Array<GitBranchInfo & { parentBranch?: string; commitsAhead?: number }> = [];

  for (const branch of branchesResult.branches) {
    if (branch.isRemote) {
      branchesWithHierarchy.push(branch);
      continue;
    }

    // For the main branch, it has no parent
    if (branch.name === mainBranch?.name) {
      branchesWithHierarchy.push({ ...branch, parentBranch: undefined });
      continue;
    }

    // For other branches, find the CLOSEST parent
    // The closest parent is the one where:
    // 1. The merge-base exists
    // 2. The distance from merge-base to the other branch's tip is SMALLEST
    //    (ideally 0, meaning the other branch's tip IS the merge-base)
    let closestParent: string | undefined;
    let smallestDistanceToParentTip = Infinity;
    let commitsAhead = 0;

    for (const otherBranch of localBranches) {
      if (otherBranch.name === branch.name) continue;

      // Find the merge-base between this branch and the potential parent
      const mergeBaseResult = await runGitCommand(cwd, ['merge-base', otherBranch.name, branch.name]);
      if (!mergeBaseResult.success || !mergeBaseResult.output) continue;

      const mergeBase = mergeBaseResult.output.trim();
      const otherBranchTip = branchCommits.get(otherBranch.name);

      // Calculate distance from merge-base to the other branch's tip
      // If this is 0, the other branch's tip IS the merge-base (ideal parent)
      let distanceToParentTip = Infinity;

      if (otherBranchTip === mergeBase) {
        // The other branch's tip is exactly at the merge-base
        // This means our branch was created from the tip of that branch
        distanceToParentTip = 0;
      } else {
        // Count commits from merge-base to the other branch's tip
        const distResult = await runGitCommand(cwd, [
          'rev-list', '--count',
          `${mergeBase}..${otherBranch.name}`
        ]);
        if (distResult.success && distResult.output) {
          distanceToParentTip = parseInt(distResult.output.trim(), 10) || Infinity;
        }
      }

      // Also count how many commits our branch is ahead of the merge-base
      const aheadResult = await runGitCommand(cwd, [
        'rev-list', '--count',
        `${mergeBase}..${branch.name}`
      ]);
      const branchCommitsAhead = aheadResult.success && aheadResult.output
        ? parseInt(aheadResult.output.trim(), 10) || 0
        : 0;

      // Choose this branch as parent if it's closer to the merge-base
      if (distanceToParentTip < smallestDistanceToParentTip) {
        smallestDistanceToParentTip = distanceToParentTip;
        closestParent = otherBranch.name;
        commitsAhead = branchCommitsAhead;
      }
    }

    branchesWithHierarchy.push({
      ...branch,
      parentBranch: closestParent,
      commitsAhead,
    });
  }

  return { success: true, branches: branchesWithHierarchy };
}

/**
 * Merge a branch into the current branch
 */
export async function gitMerge(cwd: string, branch: string, options?: { noFf?: boolean; squash?: boolean }): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!branch) return { success: false, error: 'No branch specified' };

  const validation = validateBranchName(branch);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const args = ['merge'];

  if (options?.noFf) {
    args.push('--no-ff');
  }

  if (options?.squash) {
    args.push('--squash');
  }

  args.push(branch);

  logger.info(`Merging branch: ${branch} with options: ${JSON.stringify(options)}`);
  const result = await runGitCommand(cwd, args);

  if (result.success) {
    logger.info(`Successfully merged branch: ${branch}`);
  } else {
    logger.error(`Failed to merge branch ${branch}: ${result.error}`);
  }

  return result;
}

/**
 * Abort a merge in progress
 */
export async function gitMergeAbort(cwd: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  return runGitCommand(cwd, ['merge', '--abort']);
}

/**
 * Check if there's a merge in progress
 */
export async function gitMergeInProgress(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  // Check for MERGE_HEAD file which indicates a merge in progress
  const result = await runGitCommand(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  return result.success;
}
