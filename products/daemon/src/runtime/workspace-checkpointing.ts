import { resolve } from 'node:path';
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
  /** Which sessions' turns this workspace snapshots, when the bus carries several workspaces' sessions. */
  readonly ownsSession?: (sessionId: string | undefined) => boolean;
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
    ...(opts.ownsSession ? { ownsSession: opts.ownsSession } : {}),
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

/** The verbs' surface over one workspace's checkpointing, with the routes to the others. */
export type RoutedCheckpointGateway = WorkspaceCheckpointing['gatewayManager'] & {
  retentionFailure(): ReturnType<WorkspaceCheckpointManager['retentionFailure']>;
  forSession?(sessionId: string): RoutedCheckpointGateway | undefined;
  forCheckpoint?(id: string): Promise<RoutedCheckpointGateway | undefined>;
};

function gatewayOf(checkpointing: WorkspaceCheckpointing): RoutedCheckpointGateway {
  const base = checkpointing.gatewayManager;
  return {
    // Read live: init may move the root to the enclosing repository's top level.
    get workspaceRoot() { return base.workspaceRoot; },
    resolveRoot: () => base.resolveRoot(),
    list: (filter) => base.list(filter),
    diff: (a, b) => base.diff(a, b),
    restore: (id, restoreOpts) => base.restore(id, restoreOpts),
    sessionChanges: (sessionId) => base.sessionChanges(sessionId),
    create: (createOpts) => base.create(createOpts),
    retentionFailure: () => checkpointing.manager.retentionFailure(),
  };
}

/**
 * The checkpoint managers of one daemon: its own workspace's, and one per
 * workspace a hosted session works in. Each snapshots only its own sessions'
 * turns (every session publishes on the daemon's one bus), and the
 * `checkpoints.*` and `sessions.changes.get` verbs reach the manager of the
 * session's workspace, or the store that holds the checkpoint they name.
 */
export interface DaemonWorkspaceCheckpoints {
  /** A hosted session works in `workspaceRoot` (told at create and at rebuild). */
  bindSession(sessionId: string, workspaceRoot: string): void;
  /** Which sessions a workspace's manager snapshots: its hosted sessions, plus every unhosted one for the daemon's own. */
  ownsSession(workspaceRoot: string, options?: { readonly daemonOwn?: boolean }): (sessionId: string | undefined) => boolean;
  /** Add a hosted workspace's checkpointing; returns its removal. */
  addWorkspace(workspaceRoot: string, checkpointing: WorkspaceCheckpointing): () => void;
  /** Whether `workspaceRoot` is the daemon's own (its manager already covers it). */
  isDaemonWorkspace(workspaceRoot: string): boolean;
  /** The gateway surface for the verbs: the daemon's own, routed by session and by checkpoint id. */
  gateway(daemon: WorkspaceCheckpointing, daemonRoot: string): RoutedCheckpointGateway;
}

/** Sessions remembered per daemon; the oldest binding goes first past this bound. */
const MAX_BOUND_SESSIONS = 4096;
const byBus = new WeakMap<object, DaemonWorkspaceCheckpoints>();

/** The daemon's checkpoint managers, one registry per runtime bus (the daemon's own). */
export function daemonWorkspaceCheckpoints(runtimeBus: RuntimeEventBus): DaemonWorkspaceCheckpoints {
  const existing = byBus.get(runtimeBus);
  if (existing) return existing;
  const sessions = new Map<string, string>();
  const workspaces = new Map<string, WorkspaceCheckpointing>();
  let daemonRoot: string | undefined;
  const workspaceOf = (sessionId: string | undefined): string | undefined => (sessionId === undefined ? undefined : sessions.get(sessionId));
  const registry: DaemonWorkspaceCheckpoints = {
    bindSession(sessionId, workspaceRoot) {
      sessions.delete(sessionId);
      sessions.set(sessionId, resolve(workspaceRoot));
      if (sessions.size > MAX_BOUND_SESSIONS) sessions.delete(sessions.keys().next().value!);
    },
    ownsSession(workspaceRoot, options) {
      const root = resolve(workspaceRoot);
      return (sessionId) => {
        const bound = workspaceOf(sessionId);
        return bound === undefined ? options?.daemonOwn === true : bound === root;
      };
    },
    addWorkspace(workspaceRoot, checkpointing) {
      const root = resolve(workspaceRoot);
      workspaces.set(root, checkpointing);
      return () => { if (workspaces.get(root) === checkpointing) workspaces.delete(root); };
    },
    isDaemonWorkspace(workspaceRoot) {
      return daemonRoot !== undefined && resolve(workspaceRoot) === daemonRoot;
    },
    gateway(daemon, root) {
      daemonRoot = resolve(root);
      return {
        ...gatewayOf(daemon),
        get workspaceRoot() { return daemon.gatewayManager.workspaceRoot; },
        forSession(sessionId) {
          const bound = workspaceOf(sessionId);
          const hosted = bound === undefined ? undefined : workspaces.get(bound);
          return hosted ? gatewayOf(hosted) : undefined;
        },
        async forCheckpoint(id) {
          // In-memory manifests: a lookup, not a store read. The daemon's own answers an unknown id.
          for (const hosted of workspaces.values()) {
            if ((await hosted.manager.list()).some((checkpoint) => checkpoint.id === id)) return gatewayOf(hosted);
          }
          return undefined;
        },
      };
    },
  };
  byBus.set(runtimeBus, registry);
  return registry;
}
