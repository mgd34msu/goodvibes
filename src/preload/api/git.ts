// ============================================================================
// GIT PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const gitApi = {
  // ============================================================================
  // BASIC GIT OPERATIONS
  // ============================================================================
  gitStatus: (cwd: string) =>
    ipcRenderer.invoke('git-status', cwd),
  gitBranch: (cwd: string) =>
    ipcRenderer.invoke('git-branch', cwd),
  gitLog: (cwd: string) =>
    ipcRenderer.invoke('git-log', cwd),
  gitDiff: (cwd: string, staged?: boolean) =>
    ipcRenderer.invoke('git-diff', { cwd, staged }),
  gitAdd: (cwd: string, files?: string) =>
    ipcRenderer.invoke('git-add', { cwd, files }),
  gitCommit: (cwd: string, message: string) =>
    ipcRenderer.invoke('git-commit', { cwd, message }),
  gitPush: (cwd: string) =>
    ipcRenderer.invoke('git-push', cwd),
  gitPull: (cwd: string) =>
    ipcRenderer.invoke('git-pull', cwd),
  gitIsRepo: (cwd: string) =>
    ipcRenderer.invoke('git-is-repo', cwd),
  gitStash: (cwd: string, action?: string) =>
    ipcRenderer.invoke('git-stash', { cwd, action }),
  gitInit: (cwd: string) =>
    ipcRenderer.invoke('git-init', cwd),
  gitReset: (cwd: string, files?: string[]) =>
    ipcRenderer.invoke('git-reset', { cwd, files }),
  gitFetch: (cwd: string) =>
    ipcRenderer.invoke('git-fetch', cwd),

  // ============================================================================
  // ENHANCED GIT OPERATIONS
  // ============================================================================
  gitDetailedStatus: (cwd: string) =>
    ipcRenderer.invoke('git-detailed-status', cwd),
  gitBranches: (cwd: string) =>
    ipcRenderer.invoke('git-branches', cwd),
  gitCheckout: (cwd: string, branch: string) =>
    ipcRenderer.invoke('git-checkout', { cwd, branch }),
  gitCreateBranch: (cwd: string, name: string, checkout?: boolean) =>
    ipcRenderer.invoke('git-create-branch', { cwd, name, checkout }),
  gitStage: (cwd: string, files: string[]) =>
    ipcRenderer.invoke('git-stage', { cwd, files }),
  gitUnstage: (cwd: string, files: string[]) =>
    ipcRenderer.invoke('git-unstage', { cwd, files }),
  gitLogDetailed: (cwd: string, limit?: number) =>
    ipcRenderer.invoke('git-log-detailed', { cwd, limit }),
  gitAheadBehind: (cwd: string) =>
    ipcRenderer.invoke('git-ahead-behind', cwd),
  gitDiscardChanges: (cwd: string, files: string[]) =>
    ipcRenderer.invoke('git-discard-changes', { cwd, files }),
  gitCleanFile: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-clean-file', { cwd, file }),
  gitShowCommit: (cwd: string, hash: string) =>
    ipcRenderer.invoke('git-show-commit', { cwd, hash }),
  gitFileDiff: (cwd: string, file?: string, options?: { staged?: boolean; commit?: string }) =>
    ipcRenderer.invoke('git-file-diff', { cwd, file, options }),
  gitDiffRaw: (cwd: string, options?: { staged?: boolean; file?: string; commit?: string }) =>
    ipcRenderer.invoke('git-diff-raw', { cwd, options }),
  gitBranchesWithHierarchy: (cwd: string) =>
    ipcRenderer.invoke('git-branches-with-hierarchy', cwd),

  // ============================================================================
  // MERGE OPERATIONS
  // ============================================================================
  gitMerge: (cwd: string, branch: string, options?: { noFf?: boolean; squash?: boolean }) =>
    ipcRenderer.invoke('git-merge', { cwd, branch, options }),
  gitMergeAbort: (cwd: string) =>
    ipcRenderer.invoke('git-merge-abort', cwd),
  gitMergeInProgress: (cwd: string) =>
    ipcRenderer.invoke('git-merge-in-progress', cwd),

  // ============================================================================
  // REMOTE OPERATIONS
  // ============================================================================
  gitRemotes: (cwd: string) =>
    ipcRenderer.invoke('git-remotes', cwd),
  gitRemoteAdd: (cwd: string, name: string, url: string) =>
    ipcRenderer.invoke('git-remote-add', { cwd, name, url }),
  gitRemoteRemove: (cwd: string, name: string) =>
    ipcRenderer.invoke('git-remote-remove', { cwd, name }),

  // ============================================================================
  // STASH OPERATIONS
  // ============================================================================
  gitStashList: (cwd: string) =>
    ipcRenderer.invoke('git-stash-list', cwd),
  gitStashPush: (cwd: string, message?: string) =>
    ipcRenderer.invoke('git-stash-push', { cwd, message }),
  gitStashPop: (cwd: string, index?: number) =>
    ipcRenderer.invoke('git-stash-pop', { cwd, index }),
  gitStashApply: (cwd: string, index?: number) =>
    ipcRenderer.invoke('git-stash-apply', { cwd, index }),
  gitStashDrop: (cwd: string, index?: number) =>
    ipcRenderer.invoke('git-stash-drop', { cwd, index }),

  // ============================================================================
  // BRANCH DELETION
  // ============================================================================
  gitDeleteBranch: (cwd: string, branch: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke('git-delete-branch', { cwd, branch, options }),
  gitDeleteRemoteBranch: (cwd: string, remote: string, branch: string) =>
    ipcRenderer.invoke('git-delete-remote-branch', { cwd, remote, branch }),

  // ============================================================================
  // COMMIT AMEND
  // ============================================================================
  gitCommitAmend: (cwd: string, options?: { message?: string; noEdit?: boolean }) =>
    ipcRenderer.invoke('git-commit-amend', { cwd, options }),

  // ============================================================================
  // CHERRY-PICK
  // ============================================================================
  gitCherryPick: (cwd: string, commit: string) =>
    ipcRenderer.invoke('git-cherry-pick', { cwd, commit }),
  gitCherryPickAbort: (cwd: string) =>
    ipcRenderer.invoke('git-cherry-pick-abort', cwd),
  gitCherryPickContinue: (cwd: string) =>
    ipcRenderer.invoke('git-cherry-pick-continue', cwd),
  gitCherryPickInProgress: (cwd: string) =>
    ipcRenderer.invoke('git-cherry-pick-in-progress', cwd),

  // ============================================================================
  // HUNK/LINE STAGING
  // ============================================================================
  gitApplyPatch: (cwd: string, patch: string, options?: { cached?: boolean; reverse?: boolean }) =>
    ipcRenderer.invoke('git-apply-patch', { cwd, patch, options }),
  gitDiffForStaging: (cwd: string, file: string, staged?: boolean) =>
    ipcRenderer.invoke('git-diff-for-staging', { cwd, file, staged }),

  // ============================================================================
  // GIT BLAME
  // ============================================================================
  gitBlame: (cwd: string, file: string, options?: { startLine?: number; endLine?: number }) =>
    ipcRenderer.invoke('git-blame', { cwd, file, options }),

  // ============================================================================
  // TAG MANAGEMENT
  // ============================================================================
  gitTags: (cwd: string) =>
    ipcRenderer.invoke('git-tags', cwd),
  gitCreateTag: (cwd: string, name: string, options?: { message?: string; commit?: string }) =>
    ipcRenderer.invoke('git-create-tag', { cwd, name, options }),
  gitDeleteTag: (cwd: string, name: string) =>
    ipcRenderer.invoke('git-delete-tag', { cwd, name }),
  gitPushTag: (cwd: string, name: string, remote?: string) =>
    ipcRenderer.invoke('git-push-tag', { cwd, name, remote }),
  gitPushAllTags: (cwd: string, remote?: string) =>
    ipcRenderer.invoke('git-push-all-tags', { cwd, remote }),
  gitDeleteRemoteTag: (cwd: string, name: string, remote?: string) =>
    ipcRenderer.invoke('git-delete-remote-tag', { cwd, name, remote }),

  // ============================================================================
  // FILE HISTORY
  // ============================================================================
  gitFileHistory: (cwd: string, file: string, limit?: number) =>
    ipcRenderer.invoke('git-file-history', { cwd, file, limit }),
  gitShowFile: (cwd: string, file: string, commit: string) =>
    ipcRenderer.invoke('git-show-file', { cwd, file, commit }),

  // ============================================================================
  // CONFLICT RESOLUTION
  // ============================================================================
  gitConflictFiles: (cwd: string) =>
    ipcRenderer.invoke('git-conflict-files', cwd),
  gitResolveOurs: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-resolve-ours', { cwd, file }),
  gitResolveTheirs: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-resolve-theirs', { cwd, file }),
  gitMarkResolved: (cwd: string, files: string[]) =>
    ipcRenderer.invoke('git-mark-resolved', { cwd, files }),

  // ============================================================================
  // REBASE
  // ============================================================================
  gitRebase: (cwd: string, onto: string) =>
    ipcRenderer.invoke('git-rebase', { cwd, onto }),
  gitRebaseAbort: (cwd: string) =>
    ipcRenderer.invoke('git-rebase-abort', cwd),
  gitRebaseContinue: (cwd: string) =>
    ipcRenderer.invoke('git-rebase-continue', cwd),
  gitRebaseSkip: (cwd: string) =>
    ipcRenderer.invoke('git-rebase-skip', cwd),
  gitRebaseInProgress: (cwd: string) =>
    ipcRenderer.invoke('git-rebase-in-progress', cwd),

  // ============================================================================
  // REFLOG
  // ============================================================================
  gitReflog: (cwd: string, limit?: number) =>
    ipcRenderer.invoke('git-reflog', { cwd, limit }),
  gitResetToReflog: (cwd: string, index: number, options?: { hard?: boolean; soft?: boolean }) =>
    ipcRenderer.invoke('git-reset-to-reflog', { cwd, index, options }),

  // ============================================================================
  // SUBMODULES
  // ============================================================================
  gitSubmodules: (cwd: string) =>
    ipcRenderer.invoke('git-submodules', cwd),
  gitSubmoduleInit: (cwd: string, path?: string) =>
    ipcRenderer.invoke('git-submodule-init', { cwd, path }),
  gitSubmoduleUpdate: (cwd: string, options?: { init?: boolean; recursive?: boolean; remote?: boolean; path?: string }) =>
    ipcRenderer.invoke('git-submodule-update', { cwd, options }),

  // ============================================================================
  // WORKTREES
  // ============================================================================
  gitWorktrees: (cwd: string) =>
    ipcRenderer.invoke('git-worktrees', cwd),
  gitWorktreeAdd: (cwd: string, path: string, branch?: string, options?: { newBranch?: boolean; detach?: boolean }) =>
    ipcRenderer.invoke('git-worktree-add', { cwd, path, branch, options }),
  gitWorktreeRemove: (cwd: string, path: string, force?: boolean) =>
    ipcRenderer.invoke('git-worktree-remove', { cwd, path, force }),

  // ============================================================================
  // COMMIT TEMPLATES
  // ============================================================================
  gitCommitTemplate: (cwd: string) =>
    ipcRenderer.invoke('git-commit-template', cwd),
  gitConventionalPrefixes: (cwd: string) =>
    ipcRenderer.invoke('git-conventional-prefixes', cwd),
};
