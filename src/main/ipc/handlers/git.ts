// ============================================================================
// GIT IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as git from '../../services/git/index.js';
import { getGitWatcher } from '../../services/gitWatcher.js';

const logger = new Logger('IPC:Git');

export function registerGitHandlers(): void {
  // ============================================================================
  // BASIC GIT OPERATIONS
  // ============================================================================

  ipcMain.handle('git-status', withContext('git-status', async (_, cwd: string) => git.gitStatus(cwd)));
  ipcMain.handle('git-branch', withContext('git-branch', async (_, cwd: string) => git.gitBranch(cwd)));
  ipcMain.handle('git-log', withContext('git-log', async (_, cwd: string) => git.gitLog(cwd)));
  ipcMain.handle('git-diff', withContext('git-diff', async (_, { cwd, staged }: { cwd: string; staged?: boolean }) => git.gitDiff(cwd, staged)));
  ipcMain.handle('git-add', withContext('git-add', async (_, { cwd, files }: { cwd: string; files?: string }) => git.gitAdd(cwd, files)));
  ipcMain.handle('git-commit', withContext('git-commit', async (_, { cwd, message }: { cwd: string; message: string }) => git.gitCommit(cwd, message)));
  ipcMain.handle('git-push', withContext('git-push', async (_, cwd: string) => git.gitPush(cwd)));
  ipcMain.handle('git-pull', withContext('git-pull', async (_, cwd: string) => git.gitPull(cwd)));
  ipcMain.handle('git-is-repo', withContext('git-is-repo', async (_, cwd: string) => git.gitIsRepo(cwd)));
  ipcMain.handle('git-stash', withContext('git-stash', async (_, { cwd, action }: { cwd: string; action?: 'pop' | 'list' }) => git.gitStash(cwd, action)));
  ipcMain.handle('git-init', withContext('git-init', async (_, cwd: string) => git.gitInit(cwd)));
  ipcMain.handle('git-reset', withContext('git-reset', async (_, { cwd, files }: { cwd: string; files?: string[] }) => git.gitReset(cwd, files)));
  ipcMain.handle('git-fetch', withContext('git-fetch', async (_, cwd: string) => git.gitFetch(cwd)));

  // ============================================================================
  // ENHANCED GIT OPERATIONS
  // ============================================================================

  ipcMain.handle('git-detailed-status', withContext('git-detailed-status', async (_, cwd: string) => git.gitDetailedStatus(cwd)));
  ipcMain.handle('git-branches', withContext('git-branches', async (_, cwd: string) => git.gitBranches(cwd)));
  ipcMain.handle('git-checkout', withContext('git-checkout', async (_, { cwd, branch }: { cwd: string; branch: string }) => git.gitCheckout(cwd, branch)));
  ipcMain.handle('git-create-branch', withContext('git-create-branch', async (_, { cwd, name, checkout }: { cwd: string; name: string; checkout?: boolean }) => git.gitCreateBranch(cwd, name, checkout)));
  ipcMain.handle('git-stage', withContext('git-stage', async (_, { cwd, files }: { cwd: string; files: string[] }) => git.gitStage(cwd, files)));
  ipcMain.handle('git-unstage', withContext('git-unstage', async (_, { cwd, files }: { cwd: string; files: string[] }) => git.gitUnstage(cwd, files)));
  ipcMain.handle('git-log-detailed', withContext('git-log-detailed', async (_, { cwd, limit }: { cwd: string; limit?: number }) => git.gitLogDetailed(cwd, limit)));
  ipcMain.handle('git-ahead-behind', withContext('git-ahead-behind', async (_, cwd: string) => git.gitAheadBehind(cwd)));
  ipcMain.handle('git-discard-changes', withContext('git-discard-changes', async (_, { cwd, files }: { cwd: string; files: string[] }) => git.gitDiscardChanges(cwd, files)));
  ipcMain.handle('git-clean-file', withContext('git-clean-file', async (_, { cwd, file }: { cwd: string; file: string }) => git.gitCleanFile(cwd, file)));
  ipcMain.handle('git-show-commit', withContext('git-show-commit', async (_, { cwd, hash }: { cwd: string; hash: string }) => git.gitShowCommit(cwd, hash)));
  ipcMain.handle('git-file-diff', withContext('git-file-diff', async (_, { cwd, file, options }: { cwd: string; file?: string; options?: { staged?: boolean; commit?: string } }) => git.gitFileDiff(cwd, file, options)));
  ipcMain.handle('git-diff-raw', withContext('git-diff-raw', async (_, { cwd, options }: { cwd: string; options?: { staged?: boolean; file?: string; commit?: string } }) => git.gitDiffRaw(cwd, options)));
  ipcMain.handle('git-branches-with-hierarchy', withContext('git-branches-with-hierarchy', async (_, cwd: string) => git.gitBranchesWithHierarchy(cwd)));

  // ============================================================================
  // MERGE OPERATIONS
  // ============================================================================

  ipcMain.handle('git-merge', withContext('git-merge', async (_, { cwd, branch, options }: { cwd: string; branch: string; options?: { noFf?: boolean; squash?: boolean } }) => git.gitMerge(cwd, branch, options)));
  ipcMain.handle('git-merge-abort', withContext('git-merge-abort', async (_, cwd: string) => git.gitMergeAbort(cwd)));
  ipcMain.handle('git-merge-in-progress', withContext('git-merge-in-progress', async (_, cwd: string) => git.gitMergeInProgress(cwd)));

  // ============================================================================
  // REMOTE OPERATIONS
  // ============================================================================

  ipcMain.handle('git-remotes', withContext('git-remotes', async (_, cwd: string) => git.gitRemotes(cwd)));
  ipcMain.handle('git-remote-add', withContext('git-remote-add', async (_, { cwd, name, url }: { cwd: string; name: string; url: string }) => git.gitRemoteAdd(cwd, name, url)));
  ipcMain.handle('git-remote-remove', withContext('git-remote-remove', async (_, { cwd, name }: { cwd: string; name: string }) => git.gitRemoteRemove(cwd, name)));

  // ============================================================================
  // STASH OPERATIONS
  // ============================================================================

  ipcMain.handle('git-stash-list', withContext('git-stash-list', async (_, cwd: string) => git.gitStashList(cwd)));
  ipcMain.handle('git-stash-push', withContext('git-stash-push', async (_, { cwd, message }: { cwd: string; message?: string }) => git.gitStashPush(cwd, message)));
  ipcMain.handle('git-stash-pop', withContext('git-stash-pop', async (_, { cwd, index }: { cwd: string; index?: number }) => git.gitStashPop(cwd, index)));
  ipcMain.handle('git-stash-apply', withContext('git-stash-apply', async (_, { cwd, index }: { cwd: string; index?: number }) => git.gitStashApply(cwd, index)));
  ipcMain.handle('git-stash-drop', withContext('git-stash-drop', async (_, { cwd, index }: { cwd: string; index?: number }) => git.gitStashDrop(cwd, index)));

  // ============================================================================
  // BRANCH DELETION
  // ============================================================================

  ipcMain.handle('git-delete-branch', withContext('git-delete-branch', async (_, { cwd, branch, options }: { cwd: string; branch: string; options?: { force?: boolean } }) => git.gitDeleteBranch(cwd, branch, options)));
  ipcMain.handle('git-delete-remote-branch', withContext('git-delete-remote-branch', async (_, { cwd, remote, branch }: { cwd: string; remote: string; branch: string }) => git.gitDeleteRemoteBranch(cwd, remote, branch)));

  // ============================================================================
  // COMMIT AMEND
  // ============================================================================

  ipcMain.handle('git-commit-amend', withContext('git-commit-amend', async (_, { cwd, options }: { cwd: string; options?: { message?: string; noEdit?: boolean } }) => git.gitCommitAmend(cwd, options)));

  // ============================================================================
  // CHERRY-PICK
  // ============================================================================

  ipcMain.handle('git-cherry-pick', withContext('git-cherry-pick', async (_, { cwd, commit }: { cwd: string; commit: string }) => git.gitCherryPick(cwd, commit)));
  ipcMain.handle('git-cherry-pick-abort', withContext('git-cherry-pick-abort', async (_, cwd: string) => git.gitCherryPickAbort(cwd)));
  ipcMain.handle('git-cherry-pick-continue', withContext('git-cherry-pick-continue', async (_, cwd: string) => git.gitCherryPickContinue(cwd)));
  ipcMain.handle('git-cherry-pick-in-progress', withContext('git-cherry-pick-in-progress', async (_, cwd: string) => git.gitCherryPickInProgress(cwd)));

  // ============================================================================
  // HUNK/LINE STAGING
  // ============================================================================

  ipcMain.handle('git-apply-patch', withContext('git-apply-patch', async (_, { cwd, patch, options }: { cwd: string; patch: string; options?: { cached?: boolean; reverse?: boolean } }) => git.gitApplyPatch(cwd, patch, options)));
  ipcMain.handle('git-diff-for-staging', withContext('git-diff-for-staging', async (_, { cwd, file, staged }: { cwd: string; file: string; staged?: boolean }) => git.gitDiffForStaging(cwd, file, staged)));

  // ============================================================================
  // GIT BLAME
  // ============================================================================

  ipcMain.handle('git-blame', withContext('git-blame', async (_, { cwd, file, options }: { cwd: string; file: string; options?: { startLine?: number; endLine?: number } }) => git.gitBlame(cwd, file, options)));

  // ============================================================================
  // TAG MANAGEMENT
  // ============================================================================

  ipcMain.handle('git-tags', withContext('git-tags', async (_, cwd: string) => git.gitTags(cwd)));
  ipcMain.handle('git-create-tag', withContext('git-create-tag', async (_, { cwd, name, options }: { cwd: string; name: string; options?: { message?: string; commit?: string } }) => git.gitCreateTag(cwd, name, options)));
  ipcMain.handle('git-delete-tag', withContext('git-delete-tag', async (_, { cwd, name }: { cwd: string; name: string }) => git.gitDeleteTag(cwd, name)));
  ipcMain.handle('git-push-tag', withContext('git-push-tag', async (_, { cwd, name, remote }: { cwd: string; name: string; remote?: string }) => git.gitPushTag(cwd, name, remote)));
  ipcMain.handle('git-push-all-tags', withContext('git-push-all-tags', async (_, { cwd, remote }: { cwd: string; remote?: string }) => git.gitPushAllTags(cwd, remote)));
  ipcMain.handle('git-delete-remote-tag', withContext('git-delete-remote-tag', async (_, { cwd, name, remote }: { cwd: string; name: string; remote?: string }) => git.gitDeleteRemoteTag(cwd, name, remote)));

  // ============================================================================
  // FILE HISTORY
  // ============================================================================

  ipcMain.handle('git-file-history', withContext('git-file-history', async (_, { cwd, file, limit }: { cwd: string; file: string; limit?: number }) => git.gitFileHistory(cwd, file, limit)));
  ipcMain.handle('git-show-file', withContext('git-show-file', async (_, { cwd, file, commit }: { cwd: string; file: string; commit: string }) => git.gitShowFile(cwd, file, commit)));

  // ============================================================================
  // CONFLICT RESOLUTION
  // ============================================================================

  ipcMain.handle('git-conflict-files', withContext('git-conflict-files', async (_, cwd: string) => git.gitConflictFiles(cwd)));
  ipcMain.handle('git-resolve-ours', withContext('git-resolve-ours', async (_, { cwd, file }: { cwd: string; file: string }) => git.gitResolveOurs(cwd, file)));
  ipcMain.handle('git-resolve-theirs', withContext('git-resolve-theirs', async (_, { cwd, file }: { cwd: string; file: string }) => git.gitResolveTheirs(cwd, file)));
  ipcMain.handle('git-mark-resolved', withContext('git-mark-resolved', async (_, { cwd, files }: { cwd: string; files: string[] }) => git.gitMarkResolved(cwd, files)));

  // ============================================================================
  // REBASE
  // ============================================================================

  ipcMain.handle('git-rebase', withContext('git-rebase', async (_, { cwd, onto }: { cwd: string; onto: string }) => git.gitRebase(cwd, onto)));
  ipcMain.handle('git-rebase-abort', withContext('git-rebase-abort', async (_, cwd: string) => git.gitRebaseAbort(cwd)));
  ipcMain.handle('git-rebase-continue', withContext('git-rebase-continue', async (_, cwd: string) => git.gitRebaseContinue(cwd)));
  ipcMain.handle('git-rebase-skip', withContext('git-rebase-skip', async (_, cwd: string) => git.gitRebaseSkip(cwd)));
  ipcMain.handle('git-rebase-in-progress', withContext('git-rebase-in-progress', async (_, cwd: string) => git.gitRebaseInProgress(cwd)));

  // ============================================================================
  // REFLOG
  // ============================================================================

  ipcMain.handle('git-reflog', withContext('git-reflog', async (_, { cwd, limit }: { cwd: string; limit?: number }) => git.gitReflog(cwd, limit)));
  ipcMain.handle('git-reset-to-reflog', withContext('git-reset-to-reflog', async (_, { cwd, index, options }: { cwd: string; index: number; options?: { hard?: boolean; soft?: boolean } }) => git.gitResetToReflog(cwd, index, options)));

  // ============================================================================
  // SUBMODULES
  // ============================================================================

  ipcMain.handle('git-submodules', withContext('git-submodules', async (_, cwd: string) => git.gitSubmodules(cwd)));
  ipcMain.handle('git-submodule-init', withContext('git-submodule-init', async (_, { cwd, path }: { cwd: string; path?: string }) => git.gitSubmoduleInit(cwd, path)));
  ipcMain.handle('git-submodule-update', withContext('git-submodule-update', async (_, { cwd, options }: { cwd: string; options?: { init?: boolean; recursive?: boolean; remote?: boolean; path?: string } }) => git.gitSubmoduleUpdate(cwd, options)));

  // ============================================================================
  // WORKTREES
  // ============================================================================

  ipcMain.handle('git-worktrees', withContext('git-worktrees', async (_, cwd: string) => git.gitWorktrees(cwd)));
  ipcMain.handle('git-worktree-add', withContext('git-worktree-add', async (_, { cwd, path, branch, options }: { cwd: string; path: string; branch?: string; options?: { newBranch?: boolean; detach?: boolean } }) => git.gitWorktreeAdd(cwd, path, branch, options)));
  ipcMain.handle('git-worktree-remove', withContext('git-worktree-remove', async (_, { cwd, path, force }: { cwd: string; path: string; force?: boolean }) => git.gitWorktreeRemove(cwd, path, force)));

  // ============================================================================
  // COMMIT TEMPLATES
  // ============================================================================

  ipcMain.handle('git-commit-template', withContext('git-commit-template', async (_, cwd: string) => git.gitCommitTemplate(cwd)));
  ipcMain.handle('git-conventional-prefixes', withContext('git-conventional-prefixes', async (_, cwd: string) => git.gitConventionalPrefixes(cwd)));

  // ============================================================================
  // GIT WATCHER
  // ============================================================================

  ipcMain.handle('git-watch', withContext('git-watch', async (_, cwd: string) => {
    return getGitWatcher().watchRepo(cwd);
  }));

  ipcMain.handle('git-unwatch', withContext('git-unwatch', async (_, cwd: string) => {
    getGitWatcher().unwatchRepo(cwd);
    return true;
  }));

  logger.info('Git handlers registered');
}
