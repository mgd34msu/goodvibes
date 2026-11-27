export * from './daemon-home.js';
// Which project a folder belongs to: the one answer every per-project record is keyed by.
export { projectIdentityOf, registeredWorkspaceRoots } from './project-identity.js';
// The one check of a project a caller names (never the root, the home folder, or the GoodVibes or daemon home).
export { checkCallerProject, type CallerProjectFacts, type CallerProjectVerdict, type ProjectNamer } from './caller-project.js';
export { whyNeverAProject } from './caller-project.js';
export * from './registration/index.js';
export {
  WorkspaceCheckpointManager,
  type CreateCheckpointOptions,
  type RestoreOptions,
  type ListCheckpointsFilter,
  type WorkspaceCheckpointManagerOptions,
  type WorkspaceCheckpoint,
  type CheckpointKind,
  type CheckpointDiff,
  type RestoreResult,
  // Promoted from the checkpoint engine's deep (non-public) subpath: both the
  // TUI and the agent needed the resolver's exact shape to type a locally
  // structurally-mirrored callback (`resolveSessionId`) because only this
  // top-level `platform/workspace` barrel is a published exports-map entry,
  // `platform/workspace/checkpoint` is not. Publishing the real type here lets
  // a consumer's resolver be checked against the manager's actual option
  // instead of a hand-copied structural twin that can silently drift.
  type CheckpointSessionResolveContext,
  type CheckpointSessionResolver,
} from './checkpoint/index.js';
export type { CheckpointPruneResult } from './checkpoint/pruner.js';
export { othersUndoneLines, type OtherSessionChanges, type TakenBackNotice } from './checkpoint/taken-back.js';
export {
  SHARED_TIER_DIRECTORY,
  WORKSPACE_REGISTER_FILE,
  sharedWorkspaceRegisterPath,
} from './registration/shared-register-path.js';
// The named-path lock for product build/preparation operations and stores: the
// kernel releases it when its holder's process exits.
export { acquireCrossProcessLock, CrossProcessLockBusyError, type CrossProcessLockOptions } from './checkpoint/cross-process-lock.js';
