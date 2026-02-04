// ============================================================================
// GIT IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as git from '../../services/git/index.js';
import { getGitWatcher } from '../../services/gitWatcher.js';
import {
  gitCwdSchema,
  gitDiffSchema,
  gitAddSchema,
  gitCommitSchema,
  gitStashSchema,
  gitResetSchema,
  gitCheckoutSchema,
  gitCreateBranchSchema,
  gitStageSchema,
  gitLogDetailedSchema,
  gitDiscardChangesSchema,
  gitCleanFileSchema,
  gitShowCommitSchema,
  gitFileDiffSchema,
  gitMergeSchema,
  gitRemoteAddSchema,
  gitRemoteRemoveSchema,
  gitStashPushSchema,
  gitStashOperationSchema,
  gitDeleteBranchSchema,
  gitDeleteRemoteBranchSchema,
  gitCommitAmendSchema,
  gitCherryPickSchema,
  gitRebaseSchema,
  gitApplyPatchSchema,
  gitDiffForStagingSchema,
  gitBlameSchema,
  gitCreateTagSchema,
  gitDeleteTagSchema,
  gitPushTagSchema,
  gitPushAllTagsSchema,
  gitFileHistorySchema,
  gitShowFileSchema,
  gitResolveFileSchema,
  gitMarkResolvedSchema,
  gitReflogSchema,
  gitResetToReflogSchema,
  gitSubmoduleInitSchema,
  gitSubmoduleUpdateSchema,
  gitWorktreeAddSchema,
  gitWorktreeRemoveSchema,
  validateInput,
} from '../schemas/index.js';

const logger = new Logger('IPC:Git');

/**
 * Custom error class for IPC validation failures.
 * Provides a structured way to handle validation errors in Git IPC handlers.
 * @param message - Error message describing the validation failure
 * @param code - Optional error code for categorizing the failure (default: 'VALIDATION_ERROR')
 */
class IPCValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'VALIDATION_ERROR'
  ) {
    super(message);
    this.name = 'IPCValidationError';
  }
}

/**
 * Registers all Git-related IPC handlers.
 * Handles comprehensive Git operations including status, diff, branch management,
 * commits, stashing, merging, rebasing, tags, worktrees, submodules, and more.
 * All handlers validate input using Zod schemas before executing Git commands.
 */
export function registerGitHandlers(): void {
  // ============================================================================
  // BASIC GIT OPERATIONS
  // ============================================================================

  ipcMain.handle('git-status', withContext('git-status', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-status validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitStatus(validation.data);
  }));

  ipcMain.handle('git-branch', withContext('git-branch', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-branch validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitBranch(validation.data);
  }));

  ipcMain.handle('git-log', withContext('git-log', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-log validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitLog(validation.data);
  }));

  ipcMain.handle('git-diff', withContext('git-diff', async (_, data: unknown) => {
    const validation = validateInput(gitDiffSchema, data);
    if (!validation.success) {
      logger.warn('git-diff validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitDiff(validation.data.cwd, validation.data.staged);
  }));

  ipcMain.handle('git-add', withContext('git-add', async (_, data: unknown) => {
    const validation = validateInput(gitAddSchema, data);
    if (!validation.success) {
      logger.warn('git-add validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitAdd(validation.data.cwd, validation.data.files);
  }));

  ipcMain.handle('git-commit', withContext('git-commit', async (_, data: unknown) => {
    const validation = validateInput(gitCommitSchema, data);
    if (!validation.success) {
      logger.warn('git-commit validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitCommit(validation.data.cwd, validation.data.message);
  }));

  ipcMain.handle('git-push', withContext('git-push', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-push validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitPush(validation.data);
  }));

  ipcMain.handle('git-pull', withContext('git-pull', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-pull validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitPull(validation.data);
  }));

  ipcMain.handle('git-is-repo', withContext('git-is-repo', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-is-repo validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitIsRepo(validation.data);
  }));

  ipcMain.handle('git-stash', withContext('git-stash', async (_, data: unknown) => {
    const validation = validateInput(gitStashSchema, data);
    if (!validation.success) {
      logger.warn('git-stash validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitStash(validation.data.cwd, validation.data.action);
  }));

  ipcMain.handle('git-init', withContext('git-init', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-init validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitInit(validation.data);
  }));

  ipcMain.handle('git-reset', withContext('git-reset', async (_, data: unknown) => {
    const validation = validateInput(gitResetSchema, data);
    if (!validation.success) {
      logger.warn('git-reset validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitReset(validation.data.cwd, validation.data.files);
  }));

  ipcMain.handle('git-fetch', withContext('git-fetch', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-fetch validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitFetch(validation.data);
  }));

  // ============================================================================
  // ENHANCED GIT OPERATIONS
  // ============================================================================

  ipcMain.handle('git-detailed-status', withContext('git-detailed-status', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-detailed-status validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitDetailedStatus(validation.data);
  }));

  ipcMain.handle('git-branches', withContext('git-branches', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-branches validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitBranches(validation.data);
  }));

  ipcMain.handle('git-checkout', withContext('git-checkout', async (_, data: unknown) => {
    const validation = validateInput(gitCheckoutSchema, data);
    if (!validation.success) {
      logger.warn('git-checkout validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitCheckout(validation.data.cwd, validation.data.branch);
  }));

  ipcMain.handle('git-create-branch', withContext('git-create-branch', async (_, data: unknown) => {
    const validation = validateInput(gitCreateBranchSchema, data);
    if (!validation.success) {
      logger.warn('git-create-branch validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitCreateBranch(validation.data.cwd, validation.data.name, validation.data.checkout);
  }));

  ipcMain.handle('git-stage', withContext('git-stage', async (_, data: unknown) => {
    const validation = validateInput(gitStageSchema, data);
    if (!validation.success) {
      logger.warn('git-stage validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitStage(validation.data.cwd, validation.data.files);
  }));

  ipcMain.handle('git-unstage', withContext('git-unstage', async (_, data: unknown) => {
    const validation = validateInput(gitStageSchema, data);
    if (!validation.success) {
      logger.warn('git-unstage validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitUnstage(validation.data.cwd, validation.data.files);
  }));

  ipcMain.handle('git-log-detailed', withContext('git-log-detailed', async (_, data: unknown) => {
    const validation = validateInput(gitLogDetailedSchema, data);
    if (!validation.success) {
      logger.warn('git-log-detailed validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitLogDetailed(validation.data.cwd, validation.data.limit);
  }));

  ipcMain.handle('git-ahead-behind', withContext('git-ahead-behind', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-ahead-behind validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitAheadBehind(validation.data);
  }));

  ipcMain.handle('git-discard-changes', withContext('git-discard-changes', async (_, data: unknown) => {
    const validation = validateInput(gitDiscardChangesSchema, data);
    if (!validation.success) {
      logger.warn('git-discard-changes validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitDiscardChanges(validation.data.cwd, validation.data.files);
  }));

  ipcMain.handle('git-clean-file', withContext('git-clean-file', async (_, data: unknown) => {
    const validation = validateInput(gitCleanFileSchema, data);
    if (!validation.success) {
      logger.warn('git-clean-file validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitCleanFile(validation.data.cwd, validation.data.file);
  }));

  ipcMain.handle('git-show-commit', withContext('git-show-commit', async (_, data: unknown) => {
    const validation = validateInput(gitShowCommitSchema, data);
    if (!validation.success) {
      logger.warn('git-show-commit validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitShowCommit(validation.data.cwd, validation.data.hash);
  }));

  ipcMain.handle('git-file-diff', withContext('git-file-diff', async (_, data: unknown) => {
    const validation = validateInput(gitFileDiffSchema, data);
    if (!validation.success) {
      logger.warn('git-file-diff validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitFileDiff(validation.data.cwd, validation.data.file, validation.data.options);
  }));

  ipcMain.handle('git-diff-raw', withContext('git-diff-raw', async (_, data: unknown) => {
    const validation = validateInput(gitFileDiffSchema, data);
    if (!validation.success) {
      logger.warn('git-diff-raw validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitDiffRaw(validation.data.cwd, validation.data.options);
  }));

  ipcMain.handle('git-branches-with-hierarchy', withContext('git-branches-with-hierarchy', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-branches-with-hierarchy validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitBranchesWithHierarchy(validation.data);
  }));

  // ============================================================================
  // MERGE OPERATIONS
  // ============================================================================

  ipcMain.handle('git-merge', withContext('git-merge', async (_, data: unknown) => {
    const validation = validateInput(gitMergeSchema, data);
    if (!validation.success) {
      logger.warn('git-merge validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitMerge(validation.data.cwd, validation.data.branch, validation.data.options);
  }));

  ipcMain.handle('git-merge-abort', withContext('git-merge-abort', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-merge-abort validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitMergeAbort(validation.data);
  }));

  ipcMain.handle('git-merge-in-progress', withContext('git-merge-in-progress', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-merge-in-progress validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitMergeInProgress(validation.data);
  }));

  // ============================================================================
  // REMOTE OPERATIONS
  // ============================================================================

  ipcMain.handle('git-remotes', withContext('git-remotes', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-remotes validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitRemotes(validation.data);
  }));

  ipcMain.handle('git-remote-add', withContext('git-remote-add', async (_, data: unknown) => {
    const validation = validateInput(gitRemoteAddSchema, data);
    if (!validation.success) {
      logger.warn('git-remote-add validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitRemoteAdd(validation.data.cwd, validation.data.name, validation.data.url);
  }));

  ipcMain.handle('git-remote-remove', withContext('git-remote-remove', async (_, data: unknown) => {
    const validation = validateInput(gitRemoteRemoveSchema, data);
    if (!validation.success) {
      logger.warn('git-remote-remove validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitRemoteRemove(validation.data.cwd, validation.data.name);
  }));

  // ============================================================================
  // STASH OPERATIONS
  // ============================================================================

  ipcMain.handle('git-stash-list', withContext('git-stash-list', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-stash-list validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitStashList(validation.data);
  }));

  ipcMain.handle('git-stash-push', withContext('git-stash-push', async (_, data: unknown) => {
    const validation = validateInput(gitStashPushSchema, data);
    if (!validation.success) {
      logger.warn('git-stash-push validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitStashPush(validation.data.cwd, validation.data.message);
  }));

  ipcMain.handle('git-stash-pop', withContext('git-stash-pop', async (_, data: unknown) => {
    const validation = validateInput(gitStashOperationSchema, data);
    if (!validation.success) {
      logger.warn('git-stash-pop validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitStashPop(validation.data.cwd, validation.data.index);
  }));

  ipcMain.handle('git-stash-apply', withContext('git-stash-apply', async (_, data: unknown) => {
    const validation = validateInput(gitStashOperationSchema, data);
    if (!validation.success) {
      logger.warn('git-stash-apply validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitStashApply(validation.data.cwd, validation.data.index);
  }));

  ipcMain.handle('git-stash-drop', withContext('git-stash-drop', async (_, data: unknown) => {
    const validation = validateInput(gitStashOperationSchema, data);
    if (!validation.success) {
      logger.warn('git-stash-drop validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitStashDrop(validation.data.cwd, validation.data.index);
  }));

  // ============================================================================
  // BRANCH DELETION
  // ============================================================================

  ipcMain.handle('git-delete-branch', withContext('git-delete-branch', async (_, data: unknown) => {
    const validation = validateInput(gitDeleteBranchSchema, data);
    if (!validation.success) {
      logger.warn('git-delete-branch validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitDeleteBranch(validation.data.cwd, validation.data.branch, validation.data.options);
  }));

  ipcMain.handle('git-delete-remote-branch', withContext('git-delete-remote-branch', async (_, data: unknown) => {
    const validation = validateInput(gitDeleteRemoteBranchSchema, data);
    if (!validation.success) {
      logger.warn('git-delete-remote-branch validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitDeleteRemoteBranch(validation.data.cwd, validation.data.remote, validation.data.branch);
  }));

  // ============================================================================
  // COMMIT AMEND
  // ============================================================================

  ipcMain.handle('git-commit-amend', withContext('git-commit-amend', async (_, data: unknown) => {
    const validation = validateInput(gitCommitAmendSchema, data);
    if (!validation.success) {
      logger.warn('git-commit-amend validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitCommitAmend(validation.data.cwd, validation.data.options);
  }));

  // ============================================================================
  // CHERRY-PICK
  // ============================================================================

  ipcMain.handle('git-cherry-pick', withContext('git-cherry-pick', async (_, data: unknown) => {
    const validation = validateInput(gitCherryPickSchema, data);
    if (!validation.success) {
      logger.warn('git-cherry-pick validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitCherryPick(validation.data.cwd, validation.data.commit);
  }));

  ipcMain.handle('git-cherry-pick-abort', withContext('git-cherry-pick-abort', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-cherry-pick-abort validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitCherryPickAbort(validation.data);
  }));

  ipcMain.handle('git-cherry-pick-continue', withContext('git-cherry-pick-continue', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-cherry-pick-continue validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitCherryPickContinue(validation.data);
  }));

  ipcMain.handle('git-cherry-pick-in-progress', withContext('git-cherry-pick-in-progress', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-cherry-pick-in-progress validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitCherryPickInProgress(validation.data);
  }));

  // ============================================================================
  // HUNK/LINE STAGING
  // ============================================================================

  ipcMain.handle('git-apply-patch', withContext('git-apply-patch', async (_, data: unknown) => {
    const validation = validateInput(gitApplyPatchSchema, data);
    if (!validation.success) {
      logger.warn('git-apply-patch validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitApplyPatch(validation.data.cwd, validation.data.patch, validation.data.options);
  }));

  ipcMain.handle('git-diff-for-staging', withContext('git-diff-for-staging', async (_, data: unknown) => {
    const validation = validateInput(gitDiffForStagingSchema, data);
    if (!validation.success) {
      logger.warn('git-diff-for-staging validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitDiffForStaging(validation.data.cwd, validation.data.file, validation.data.staged);
  }));

  // ============================================================================
  // GIT BLAME
  // ============================================================================

  ipcMain.handle('git-blame', withContext('git-blame', async (_, data: unknown) => {
    const validation = validateInput(gitBlameSchema, data);
    if (!validation.success) {
      logger.warn('git-blame validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitBlame(validation.data.cwd, validation.data.file, validation.data.options);
  }));

  // ============================================================================
  // TAG MANAGEMENT
  // ============================================================================

  ipcMain.handle('git-tags', withContext('git-tags', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-tags validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitTags(validation.data);
  }));

  ipcMain.handle('git-create-tag', withContext('git-create-tag', async (_, data: unknown) => {
    const validation = validateInput(gitCreateTagSchema, data);
    if (!validation.success) {
      logger.warn('git-create-tag validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitCreateTag(validation.data.cwd, validation.data.name, validation.data.options);
  }));

  ipcMain.handle('git-delete-tag', withContext('git-delete-tag', async (_, data: unknown) => {
    const validation = validateInput(gitDeleteTagSchema, data);
    if (!validation.success) {
      logger.warn('git-delete-tag validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitDeleteTag(validation.data.cwd, validation.data.name);
  }));

  ipcMain.handle('git-push-tag', withContext('git-push-tag', async (_, data: unknown) => {
    const validation = validateInput(gitPushTagSchema, data);
    if (!validation.success) {
      logger.warn('git-push-tag validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitPushTag(validation.data.cwd, validation.data.name, validation.data.remote);
  }));

  ipcMain.handle('git-push-all-tags', withContext('git-push-all-tags', async (_, data: unknown) => {
    const validation = validateInput(gitPushAllTagsSchema, data);
    if (!validation.success) {
      logger.warn('git-push-all-tags validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitPushAllTags(validation.data.cwd, validation.data.remote);
  }));

  ipcMain.handle('git-delete-remote-tag', withContext('git-delete-remote-tag', async (_, data: unknown) => {
    const validation = validateInput(gitPushTagSchema, data);
    if (!validation.success) {
      logger.warn('git-delete-remote-tag validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitDeleteRemoteTag(validation.data.cwd, validation.data.name, validation.data.remote);
  }));

  // ============================================================================
  // FILE HISTORY
  // ============================================================================

  ipcMain.handle('git-file-history', withContext('git-file-history', async (_, data: unknown) => {
    const validation = validateInput(gitFileHistorySchema, data);
    if (!validation.success) {
      logger.warn('git-file-history validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitFileHistory(validation.data.cwd, validation.data.file, validation.data.limit);
  }));

  ipcMain.handle('git-show-file', withContext('git-show-file', async (_, data: unknown) => {
    const validation = validateInput(gitShowFileSchema, data);
    if (!validation.success) {
      logger.warn('git-show-file validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitShowFile(validation.data.cwd, validation.data.file, validation.data.commit);
  }));

  // ============================================================================
  // CONFLICT RESOLUTION
  // ============================================================================

  ipcMain.handle('git-conflict-files', withContext('git-conflict-files', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-conflict-files validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitConflictFiles(validation.data);
  }));

  ipcMain.handle('git-resolve-ours', withContext('git-resolve-ours', async (_, data: unknown) => {
    const validation = validateInput(gitResolveFileSchema, data);
    if (!validation.success) {
      logger.warn('git-resolve-ours validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitResolveOurs(validation.data.cwd, validation.data.file);
  }));

  ipcMain.handle('git-resolve-theirs', withContext('git-resolve-theirs', async (_, data: unknown) => {
    const validation = validateInput(gitResolveFileSchema, data);
    if (!validation.success) {
      logger.warn('git-resolve-theirs validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitResolveTheirs(validation.data.cwd, validation.data.file);
  }));

  ipcMain.handle('git-mark-resolved', withContext('git-mark-resolved', async (_, data: unknown) => {
    const validation = validateInput(gitMarkResolvedSchema, data);
    if (!validation.success) {
      logger.warn('git-mark-resolved validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitMarkResolved(validation.data.cwd, validation.data.files);
  }));

  // ============================================================================
  // REBASE
  // ============================================================================

  ipcMain.handle('git-rebase', withContext('git-rebase', async (_, data: unknown) => {
    const validation = validateInput(gitRebaseSchema, data);
    if (!validation.success) {
      logger.warn('git-rebase validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitRebase(validation.data.cwd, validation.data.onto);
  }));

  ipcMain.handle('git-rebase-abort', withContext('git-rebase-abort', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-rebase-abort validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitRebaseAbort(validation.data);
  }));

  ipcMain.handle('git-rebase-continue', withContext('git-rebase-continue', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-rebase-continue validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitRebaseContinue(validation.data);
  }));

  ipcMain.handle('git-rebase-skip', withContext('git-rebase-skip', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-rebase-skip validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitRebaseSkip(validation.data);
  }));

  ipcMain.handle('git-rebase-in-progress', withContext('git-rebase-in-progress', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-rebase-in-progress validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitRebaseInProgress(validation.data);
  }));

  // ============================================================================
  // REFLOG
  // ============================================================================

  ipcMain.handle('git-reflog', withContext('git-reflog', async (_, data: unknown) => {
    const validation = validateInput(gitReflogSchema, data);
    if (!validation.success) {
      logger.warn('git-reflog validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitReflog(validation.data.cwd, validation.data.limit);
  }));

  ipcMain.handle('git-reset-to-reflog', withContext('git-reset-to-reflog', async (_, data: unknown) => {
    const validation = validateInput(gitResetToReflogSchema, data);
    if (!validation.success) {
      logger.warn('git-reset-to-reflog validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitResetToReflog(validation.data.cwd, validation.data.index, validation.data.options);
  }));

  // ============================================================================
  // SUBMODULES
  // ============================================================================

  ipcMain.handle('git-submodules', withContext('git-submodules', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-submodules validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitSubmodules(validation.data);
  }));

  ipcMain.handle('git-submodule-init', withContext('git-submodule-init', async (_, data: unknown) => {
    const validation = validateInput(gitSubmoduleInitSchema, data);
    if (!validation.success) {
      logger.warn('git-submodule-init validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitSubmoduleInit(validation.data.cwd, validation.data.path);
  }));

  ipcMain.handle('git-submodule-update', withContext('git-submodule-update', async (_, data: unknown) => {
    const validation = validateInput(gitSubmoduleUpdateSchema, data);
    if (!validation.success) {
      logger.warn('git-submodule-update validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitSubmoduleUpdate(validation.data.cwd, validation.data.options);
  }));

  // ============================================================================
  // WORKTREES
  // ============================================================================

  ipcMain.handle('git-worktrees', withContext('git-worktrees', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-worktrees validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitWorktrees(validation.data);
  }));

  ipcMain.handle('git-worktree-add', withContext('git-worktree-add', async (_, data: unknown) => {
    const validation = validateInput(gitWorktreeAddSchema, data);
    if (!validation.success) {
      logger.warn('git-worktree-add validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitWorktreeAdd(validation.data.cwd, validation.data.path, validation.data.branch, validation.data.options);
  }));

  ipcMain.handle('git-worktree-remove', withContext('git-worktree-remove', async (_, data: unknown) => {
    const validation = validateInput(gitWorktreeRemoveSchema, data);
    if (!validation.success) {
      logger.warn('git-worktree-remove validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid input: ${validation.error}`);
    }
    return git.gitWorktreeRemove(validation.data.cwd, validation.data.path, validation.data.force);
  }));

  // ============================================================================
  // COMMIT TEMPLATES
  // ============================================================================

  ipcMain.handle('git-commit-template', withContext('git-commit-template', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-commit-template validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitCommitTemplate(validation.data);
  }));

  ipcMain.handle('git-conventional-prefixes', withContext('git-conventional-prefixes', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-conventional-prefixes validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return git.gitConventionalPrefixes(validation.data);
  }));

  // ============================================================================
  // GIT WATCHER
  // ============================================================================

  ipcMain.handle('git-watch', withContext('git-watch', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-watch validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    return await getGitWatcher().watchRepo(validation.data);
  }));

  ipcMain.handle('git-unwatch', withContext('git-unwatch', async (_, cwd: unknown) => {
    const validation = validateInput(gitCwdSchema, cwd);
    if (!validation.success) {
      logger.warn('git-unwatch validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid cwd: ${validation.error}`);
    }
    getGitWatcher().unwatchRepo(validation.data);
    return true;
  }));

  logger.info('Git handlers registered');
}
