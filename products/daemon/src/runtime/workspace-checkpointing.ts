import { isAbsolute, resolve } from 'node:path';
import { WorkspaceCheckpointManager, checkpointEligibilityRefusal } from '@goodvibes-jev/engine/platform/platform/workspace';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { RuntimeEventBus, SessionSurface } from './index.js';
import { createSessionSurface } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
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
  historyTrimmed(): ReturnType<WorkspaceCheckpointManager['historyTrimmed']>;
  forSession?(sessionId: string): RoutedCheckpointGateway | undefined;
  forCheckpoint?(id: string): Promise<RoutedCheckpointGateway | undefined>;
};

/**
 * The verbs' surface over a hosted workspace's checkpointing. A store that
 * cannot be opened refuses with its workspace named, rather than letting the
 * verb fall through to another workspace's store and answer "no changes".
 */
function gatewayOf(checkpointing: WorkspaceCheckpointing, workspaceRoot?: string): RoutedCheckpointGateway {
  const base = checkpointing.gatewayManager;
  // `init` resolves at once after the first success; a failure is retried on the next call.
  const ready = async (): Promise<void> => {
    if (workspaceRoot === undefined) return;
    try {
      await checkpointing.manager.init();
    } catch (error) {
      throw new Error(hostedStoreUnavailable(workspaceRoot, error), { cause: error });
    }
  };
  return {
    // Read live: init may move the root to the enclosing repository's top level.
    get workspaceRoot() { return base.workspaceRoot; },
    resolveRoot: async () => { await ready(); return base.resolveRoot(); },
    list: async (filter) => { await ready(); return base.list(filter); },
    diff: async (a, b) => { await ready(); return base.diff(a, b); },
    restore: async (id, restoreOpts) => { await ready(); return base.restore(id, restoreOpts); },
    sessionChanges: async (sessionId) => { await ready(); return base.sessionChanges(sessionId); },
    create: async (createOpts) => { await ready(); return base.create(createOpts); },
    retentionFailure: () => checkpointing.manager.retentionFailure(),
    historyTrimmed: () => checkpointing.manager.historyTrimmed(),
  };
}

function hostedStoreUnavailable(workspaceRoot: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `The checkpoints of the hosted workspace ${workspaceRoot} could not be opened: ${reason}. Nothing was read from any other workspace. Make sure ${workspaceRoot} exists and is readable by the daemon, then retry.`;
}

/** What the daemon gives its registry to open a hosted workspace's checkpoints when no session there is running. */
export interface HostedCheckpointSources {
  readonly homeDirectory: string;
  readonly configManager: ConfigManager;
  readonly shellPaths: StoreShellPaths;
  /**
   * The workspace a hosted session works in, from the session's durable record,
   * so a session that ended, went idle or outlived a daemon restart still
   * reaches its own workspace's store. Undefined: not a hosted session.
   */
  readonly hostedWorkspaceOf: (sessionId: string) => string | undefined;
  /** Every workspace a recorded hosted session works in. */
  readonly hostedWorkspaces: () => readonly string[];
}

/**
 * The checkpoint managers of one daemon: its own workspace's, and one per
 * workspace a hosted session works in. Each snapshots only its own sessions'
 * turns (every session publishes on the daemon's one bus), and the
 * `checkpoints.*` and `sessions.changes.get` verbs reach the manager of the
 * session's workspace, or the store that holds the checkpoint they name.
 *
 * A hosted workspace's manager is opened when its first session starts, or
 * when a verb first names a session or checkpoint of it, and stays open until
 * the daemon stops: reviewing or rewinding a finished hosted session reads the
 * same store its turns wrote.
 */
export interface DaemonWorkspaceCheckpoints {
  /** How to open a hosted workspace's store and find a hosted session's workspace. Set once by the daemon graph. */
  configure(sources: HostedCheckpointSources): void;
  /** A hosted session works in `workspaceRoot` (told at create and at rebuild). */
  bindSession(sessionId: string, workspaceRoot: string): void;
  /** Which sessions a workspace's manager snapshots: its hosted sessions, plus every unhosted one for the daemon's own. */
  ownsSession(workspaceRoot: string, options?: { readonly daemonOwn?: boolean }): (sessionId: string | undefined) => boolean;
  /** The open checkpointing of a hosted workspace, opened on first use; null for the daemon's own workspace (its manager covers it). */
  acquire(workspaceRoot: string): WorkspaceCheckpointing | null;
  /** Whether `workspaceRoot` is the daemon's own (its manager already covers it). */
  isDaemonWorkspace(workspaceRoot: string): boolean;
  /** The gateway surface for the verbs: the daemon's own, routed by session and by checkpoint id. */
  gateway(daemon: WorkspaceCheckpointing, daemonRoot: string): RoutedCheckpointGateway;
  /** Close every hosted workspace's checkpointing (daemon shutdown). */
  close(): Promise<void>;
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
  let sources: HostedCheckpointSources | undefined;
  let daemonRoot: string | undefined;
  let closed = false;
  const workspaceOf = (sessionId: string | undefined): string | undefined => {
    if (sessionId === undefined) return undefined;
    const bound = sessions.get(sessionId);
    if (bound !== undefined) return bound;
    const recorded = sources?.hostedWorkspaceOf(sessionId);
    return recorded === undefined || !isAbsolute(recorded) ? undefined : resolve(recorded);
  };
  const isDaemonRoot = (root: string): boolean => daemonRoot !== undefined && root === daemonRoot;
  const acquire = (workspaceRoot: string): WorkspaceCheckpointing | null => {
    const root = resolve(workspaceRoot);
    if (isDaemonRoot(root)) return null;
    const open = workspaces.get(root);
    if (open) return open;
    if (!sources) throw new Error(`The daemon cannot open the checkpoints of ${root}: its checkpoint registry was not given the hosted workspaces. This is a daemon composition fault; restart the daemon.`);
    if (closed) throw new Error(`The daemon is stopping, so the checkpoints of ${root} were not opened. Retry once it has restarted.`);
    const checkpointing = createWorkspaceCheckpointing({
      workspaceRoot: root,
      surface: createSessionSurface({ surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, workingDirectory: root, homeDirectory: sources.homeDirectory }),
      runtimeBus,
      configManager: sources.configManager,
      shellPaths: sources.shellPaths,
      ownsSession: registry.ownsSession(root),
    });
    workspaces.set(root, checkpointing);
    return checkpointing;
  };
  const registry: DaemonWorkspaceCheckpoints = {
    configure(next) {
      // A graph composed again on the same bus opens stores again.
      sources = next;
      closed = false;
    },
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
    acquire,
    isDaemonWorkspace(workspaceRoot) {
      return isDaemonRoot(resolve(workspaceRoot));
    },
    gateway(daemon, root) {
      daemonRoot = resolve(root);
      return {
        ...gatewayOf(daemon),
        get workspaceRoot() { return daemon.gatewayManager.workspaceRoot; },
        forSession(sessionId) {
          const bound = workspaceOf(sessionId);
          if (bound === undefined || isDaemonRoot(bound)) return undefined;
          let hosted: WorkspaceCheckpointing | null;
          try {
            hosted = acquire(bound);
          } catch (error) {
            // Refused through the verb, never answered from the daemon's own store.
            const failure = new Error(hostedStoreUnavailable(bound, error), { cause: error });
            return refusingGateway(bound, failure);
          }
          return hosted ? gatewayOf(hosted, bound) : undefined;
        },
        async forCheckpoint(id) {
          const holds = async (checkpointing: WorkspaceCheckpointing): Promise<boolean> =>
            (await checkpointing.manager.list()).some((checkpoint) => checkpoint.id === id);
          // In-memory manifests of the open stores first: a lookup, not a store read.
          for (const [hostedRoot, hosted] of workspaces) {
            if (await holds(hosted).catch(() => false)) return gatewayOf(hosted, hostedRoot);
          }
          if (await holds(daemon).catch(() => false)) return undefined;
          // Not in an open store: the workspaces of recorded hosted sessions not opened since the daemon started.
          const unreadable: string[] = [];
          for (const recorded of sources?.hostedWorkspaces() ?? []) {
            if (!isAbsolute(recorded)) continue;
            const hostedRoot = resolve(recorded);
            if (isDaemonRoot(hostedRoot) || workspaces.has(hostedRoot)) continue;
            try {
              const hosted = acquire(hostedRoot);
              if (hosted && await holds(hosted)) return gatewayOf(hosted, hostedRoot);
            } catch (error) {
              unreadable.push(`${hostedRoot} (${error instanceof Error ? error.message : String(error)})`);
            }
          }
          if (unreadable.length > 0) {
            throw new Error(`Checkpoint ${id} is not in this daemon's workspace or any hosted workspace it could read. These hosted workspaces' checkpoints could not be opened, so it may be in one of them: ${unreadable.join('; ')}. Make them readable by the daemon, then retry.`);
          }
          // The daemon's own answers an unknown id with its 404.
          return undefined;
        },
      };
    },
    async close() {
      closed = true;
      const open = [...workspaces.values()];
      workspaces.clear();
      await Promise.all(open.map((checkpointing) => checkpointing.close().catch((error: unknown) => {
        logger.warn('hosted workspace checkpoints did not close cleanly', { workspaceRoot: checkpointing.manager.workspaceRoot, error: error instanceof Error ? error.message : String(error) });
      })));
    },
  };
  byBus.set(runtimeBus, registry);
  return registry;
}

/** A gateway whose every call refuses with `failure`: a known hosted session whose store cannot be opened. */
function refusingGateway(workspaceRoot: string, failure: Error): RoutedCheckpointGateway {
  const refuse = async (): Promise<never> => { throw failure; };
  return {
    workspaceRoot,
    resolveRoot: refuse,
    list: refuse,
    diff: refuse,
    restore: refuse,
    sessionChanges: refuse,
    create: refuse,
    retentionFailure: () => null,
    historyTrimmed: () => null,
  };
}
