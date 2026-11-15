import { WorkspaceCheckpointManager, checkpointEligibilityRefusal } from '@goodvibes-jev/engine/platform/platform/workspace';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { RuntimeEventBus, SessionSurface } from './index.js';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { readCheckpointGuardSettings, readCheckpointRegistrationSetting } from '../config/checkpoint-settings.js';
import { createWorkspaceRegistrationLiveChecker, type StoreShellPaths } from './trust/checkpoint-eligibility.js';

/**
 * The workspace checkpoint manager, gated on live registration.
 *
 * This daemon's checkpoint manager scopes the checkpoint git store to the
 * surface's own directory AND gates every automatic snapshot on the owner's
 * registered-workspaces-only ruling.
 *
 * The gate is a LIVE re-check rather than a construction-time decision: the
 * manager is always built with the runtime bus, and its
 * `automaticSnapshotsAllowed` option is read at each turn or agent-run event,
 * so registering the workspace mid-run takes effect at the next one. Explicit
 * creates are gated by the gateway surface below; the safety snapshot a
 * restore takes is never gated, so a restore always keeps its undo point.
 */

export interface WorkspaceCheckpointing {
  /** Stop host admission first; wait for eager init and already accepted git work. */
  readonly close: () => Promise<void>;
  /** The manager itself, automatic snapshots gated, explicit creates unrestricted. */
  readonly manager: WorkspaceCheckpointManager;
  /**
   * The narrower surface handed to the `checkpoints.*` gateway verbs: identical
   * except that an explicit create refuses, with an actionable message, when the
   * workspace is not checkpoint-eligible. Reads (list/diff/sessionChanges) and
   * restore stay unrestricted, they operate over checkpoints that may already
   * exist, including from a since-unregistered workspace.
   */
  readonly gatewayManager: Pick<WorkspaceCheckpointManager, 'list' | 'create' | 'diff' | 'restore' | 'sessionChanges' | 'workspaceRoot' | 'resolveRoot'>;
  /** Whether checkpoints are currently permitted for this workspace. Re-reads the store on every call. */
  readonly currentlyAllowed: () => boolean;
}

export function createWorkspaceCheckpointing(opts: {
  readonly workspaceRoot: string;
  /**
   * The declare-once storage handle. Passing it resolves the checkpoint git
   * store to `surface.checkpointsDir` instead of the unscoped
   * `<workspaceRoot>/.goodvibes/checkpoints` every product using this platform would
   * otherwise share. The platform migrates an existing legacy store into the scoped
   * location on first use.
   */
  readonly surface: SessionSurface;
  readonly runtimeBus: RuntimeEventBus;
  readonly configManager: ConfigManager;
  readonly shellPaths: StoreShellPaths;
  /** Stamps automatic snapshots with the live session id, so a checkpoint made this launch is found by the session-scoped restore lookup. */
  readonly resolveSessionId?: (ctx: { readonly turnId?: string | undefined; readonly agentId?: string | undefined }) => string | undefined;
}): WorkspaceCheckpointing {
  const registration = createWorkspaceRegistrationLiveChecker(opts.shellPaths, opts.workspaceRoot);
  const guarded = (): boolean => readCheckpointRegistrationSetting(opts.configManager) === 'guarded';
  const currentlyAllowed = (): boolean => {
    const eligibility = registration();
    return (eligibility.state === 'readable' && eligibility.resolution.status === 'covered') || guarded();
  };

  const manager = new WorkspaceCheckpointManager({
    workspaceRoot: opts.workspaceRoot,
    // Root and retention guards from the owner's `checkpoints.*` settings. These
    // are defense in depth UNDER the registration rule, not a replacement for
    // it: even a registered root can still be refused as too broad or too large.
    ...readCheckpointGuardSettings(opts.configManager),
    surface: opts.surface,
    runtimeBus: opts.runtimeBus,
    automaticSnapshotsAllowed: currentlyAllowed,
    ...(opts.resolveSessionId ? { resolveSessionId: opts.resolveSessionId } : {}),
  });

  // Eager initialization remains observable through checkpoint calls, which can
  // retry a failed init. close drains it before owned directories are released.
  void manager.init().catch((error: unknown) => {
    logger.warn('WorkspaceCheckpointManager.init failed', { error: error instanceof Error ? error.message : String(error) });
  });

  const gatewayManager: WorkspaceCheckpointing['gatewayManager'] = {
    // Read from the manager each time: init may move the root to the enclosing
    // repository's top level after this object is built.
    get workspaceRoot() { return manager.workspaceRoot; },
    resolveRoot: manager.resolveRoot.bind(manager),
    list: manager.list.bind(manager),
    diff: manager.diff.bind(manager),
    restore: manager.restore.bind(manager),
    sessionChanges: manager.sessionChanges.bind(manager),
    create: (createOpts) => {
      const eligibility = registration();
      if (!(eligibility.state === 'readable' && eligibility.resolution.status === 'covered') && !guarded()) {
        // Names the real state: not registered, declined, or a register that cannot be read.
        throw new Error(checkpointEligibilityRefusal(eligibility, opts.workspaceRoot));
      }
      // Default the session stamp from the live resolver when the caller omits
      // it, the resolveSessionId hook only auto-stamps automatic snapshots, so
      // without this an explicit checkpoint made this launch would be written
      // unstamped and excluded by the session-scoped restore lookup.
      const sessionId = createOpts.sessionId ?? opts.resolveSessionId?.({});
      return manager.create(sessionId ? { ...createOpts, sessionId } : createOpts);
    },
  };

  return { manager, gatewayManager, currentlyAllowed, close: () => manager.drain() };
}
