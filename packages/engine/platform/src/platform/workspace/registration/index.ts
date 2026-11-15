/**
 * workspace/registration/index.ts
 *
 * Public barrel for the shared registered-workspace registry: the user-scoped
 * store (injectable I/O), the pure path→coverage resolver, and the
 * worktree→main-repo link probe.
 */

export {
  WorkspaceRegistrationStore,
  withWorkspaceRegistrationWriteLockSync,
  readWorkspaceRegisterSync,
  type WorkspaceRegisterRead,
  type WorkspaceRegistrationStoreOptions,
  type RegisterWorkspaceResult,
} from './store.js';
// The store's refusal rule for roots that are too broad, for callers that ask
// before offering a registration.
export { broadRootReason } from '../checkpoint/root-guard.js';
export {
  resolveWorkspaceRegistration,
  normalizeWorkspaceRoot,
  pathCovers,
} from './resolution.js';
export { probeWorktreeLink, probeWorktreeLinkAsync, type GitRunner, type AsyncGitRunner } from './worktree-link.js';
export {
  WorkspaceRegistrationError,
  NativeWorkspaceScopeError,
  type NativeWorkspaceScope,
  type RegisteredWorkspaceRecord,
  type DeclinedWorkspaceRecord,
  type WorkspaceRegistrySnapshot,
  type WorkspaceCoverageStatus,
  type WorkspaceGitMetadata,
  type ResolveWorkspaceInput,
  type WorkspaceResolution,
} from './types.js';
