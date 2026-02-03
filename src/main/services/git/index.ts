// ============================================================================
// GIT SERVICE - MODULE EXPORTS
// ============================================================================

// Re-export types
export type {
  GitBlameLine,
  GitFileHistoryEntry,
  GitConflictFile,
  GitReflogEntry,
  GitSubmodule,
  GitWorktree,
  RateLimiterState,
  RateLimitConfig,
} from './types.js';

// Note: Core utilities (runGitCommand, validateBranchName, validateCommitHash,
// validateRemoteName, logger, GIT_TIMEOUT, GIT_MAX_BUFFER) are internal
// and should be imported directly from './core.js' if needed by other
// modules within this service. They are not part of the public API.

// Re-export basic operations
export {
  gitStatus,
  gitBranch,
  gitLog,
  gitDiff,
  gitAdd,
  gitCommit,
  gitPush,
  gitPull,
  gitIsRepo,
  gitRemote,
  gitStash,
  gitInit,
  gitReset,
  gitFetch,
  gitDetailedStatus,
  gitStage,
  gitUnstage,
  gitDiscardChanges,
  gitCleanFile,
  gitAheadBehind,
  gitRemotes,
  gitRemoteAdd,
  gitRemoteRemove,
} from './operations.js';

// Re-export branch operations
export {
  gitBranches,
  gitCheckout,
  gitCreateBranch,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitBranchesWithHierarchy,
  gitMerge,
  gitMergeAbort,
  gitMergeInProgress,
} from './branches.js';

// Re-export commit operations
export {
  gitLogDetailed,
  gitShowCommit,
  gitCommitAmend,
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
  gitCherryPickInProgress,
  gitFileHistory,
  gitShowFile,
  gitCommitTemplate,
  gitConventionalPrefixes,
} from './commits.js';

// Re-export stash operations
export {
  gitStashList,
  gitStashPush,
  gitStashPop,
  gitStashApply,
  gitStashDrop,
} from './stash.js';

// Re-export tag operations
export {
  gitTags,
  gitCreateTag,
  gitDeleteTag,
  gitPushTag,
  gitPushAllTags,
  gitDeleteRemoteTag,
} from './tags.js';

// Re-export diff and patch operations
export {
  gitFileDiff,
  gitDiffRaw,
  gitDiffForStaging,
  gitApplyPatch,
  gitBlame,
} from './diff.js';

// Re-export conflict resolution
export {
  gitConflictFiles,
  gitResolveOurs,
  gitResolveTheirs,
  gitMarkResolved,
} from './conflicts.js';

// Re-export advanced operations
export {
  gitRebase,
  gitRebaseAbort,
  gitRebaseContinue,
  gitRebaseSkip,
  gitRebaseInProgress,
  gitReflog,
  gitResetToReflog,
  gitSubmodules,
  gitSubmoduleInit,
  gitSubmoduleUpdate,
  gitWorktrees,
  gitWorktreeAdd,
  gitWorktreeRemove,
} from './advanced.js';
