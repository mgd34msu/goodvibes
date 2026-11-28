import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { WorkspaceCheckpointManager, checkpointEligibilityRefusal, projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { RuntimeEventBus, SessionSurface } from './index.js';
import { createSessionSurface, formerCheckpointsDirs } from '@goodvibes/engine/platform/platform/runtime/operations';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { logger, outsideEveryCall } from '@goodvibes/engine/platform/platform/utils';
import { onConversationCleared } from '@goodvibes/engine/platform/platform/security';
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
  /**
   * The daemon's own folder, which is not a project: no checkpoint store is made there, nothing is snapshotted, the
   * verbs list none and refuse to make or restore one (a project's checkpoints are reached through its sessions).
   */
  readonly notAProject?: boolean;
}): WorkspaceCheckpointing {
  if (opts.notAProject === true) return noCheckpointsHere(opts.workspaceRoot);
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

/**
 * The daemon's own folder: not a project, so it has no checkpoints. The manager object exists for the graph's seams but
 * is never initialised (no store is made) and takes no snapshot; the verbs list none and refuse the rest in one sentence.
 */
function noCheckpointsHere(workspaceRoot: string): WorkspaceCheckpointing {
  const manager = new WorkspaceCheckpointManager({ workspaceRoot, automaticSnapshotsAllowed: () => false, autoRetention: false });
  const refuse = (): never => {
    throw new Error('The daemon\'s own folder is not a project, so it has no checkpoints: name the session (or the checkpoint) of the project whose checkpoints you want.');
  };
  const gatewayManager: WorkspaceCheckpointing['gatewayManager'] = {
    get workspaceRoot() { return workspaceRoot; },
    resolveRoot: async () => workspaceRoot,
    list: async () => [],
    diff: async () => refuse(),
    restore: async () => refuse(),
    create: async () => refuse(),
    sessionChanges: async (sessionId) => ({ sessionId, checkpointCount: 0, checkpointIds: [], from: 'EMPTY', to: 'EMPTY', files: [], unifiedDiff: '', stat: '' }),
  };
  return { manager, gatewayManager, currentlyAllowed: () => false, close: async () => {} };
}

/** The verbs' surface over one workspace's checkpointing, with the routes to the others. */
export type RoutedCheckpointGateway = WorkspaceCheckpointing['gatewayManager'] & {
  retentionFailure(): ReturnType<WorkspaceCheckpointManager['retentionFailure']>;
  historyTrimmed(): ReturnType<WorkspaceCheckpointManager['historyTrimmed']>;
  forSession?(sessionId: string): RoutedCheckpointGateway | undefined;
  forCheckpoint?(id: string): Promise<RoutedCheckpointGateway | undefined>;
  forProject?(folder: string): RoutedCheckpointGateway | undefined;
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
  /** A project's facilities hold the workspace's checkpointing open (one hold per `pin`, let go by `release`). */
  pin(workspaceRoot: string): void;
  /**
   * A project's facilities let the workspace's checkpointing go (project-turn-facilities.ts): once nothing holds it and no
   * live session is bound to it (a session whose review and rewind read it), it is closed. Opened again on its next use.
   * A session's binding ends when its record is deleted (security/conversation-exposure.ts `onConversationCleared`).
   */
  release(workspaceRoot: string): Promise<void>;
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
  // The holds of each workspace's checkpointing by its project's facilities (`pin`, let go by `release`).
  const pins = new Map<string, number>();
  const closing = new Set<Promise<void>>();
  /** Closes a workspace's checkpointing that nothing holds and no session is bound to: the events that end its use. */
  const closeIfUnused = async (root: string): Promise<void> => {
    const open = workspaces.get(root);
    if (!open || (pins.get(root) ?? 0) > 0 || [...sessions.values()].includes(root)) return;
    workspaces.delete(root);
    const draining = open.close().catch((error: unknown) => {
      logger.warn('a workspace\'s checkpoints did not close cleanly', { workspaceRoot: root, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { closing.delete(draining); });
    closing.add(draining);
    await draining;
  };
  // A conversation deleted (a web chat, a session: security/conversation-exposure.ts, cleared where each record is
  // deleted) is no longer bound to its workspace; a store only it kept open is closed.
  const stopClearedWatch = onConversationCleared((key) => {
    const sessionId = /^(?:companion-chat|session|conversation):(.+)$/.exec(key)?.[1];
    const root = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (root === undefined) return;
    sessions.delete(sessionId!);
    void closeIfUnused(root);
  });
  const acquire = (workspaceRoot: string): WorkspaceCheckpointing | null => {
    const root = resolve(workspaceRoot);
    if (isDaemonRoot(root)) return null;
    const open = workspaces.get(root);
    if (open) return open;
    if (!sources) throw new Error(`The daemon cannot open the checkpoints of ${root}: its checkpoint registry was not given the hosted workspaces. This is a daemon composition fault; restart the daemon.`);
    if (closed) throw new Error(`The daemon is stopping, so the checkpoints of ${root} were not opened. Retry once it has restarted.`);
    // Opened by whichever turn or call first needs it: its file-write record and its snapshots are the project's, made in
    // the process's own context (engine utils/outside-every-call.ts).
    const opening = sources;
    const checkpointing = outsideEveryCall(() => createWorkspaceCheckpointing({
      workspaceRoot: root,
      surface: createSessionSurface({ surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, workingDirectory: root, homeDirectory: opening.homeDirectory }),
      runtimeBus,
      configManager: opening.configManager,
      shellPaths: opening.shellPaths,
      ownsSession: registry.ownsSession(root),
    }));
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
    pin(workspaceRoot) {
      const root = resolve(workspaceRoot);
      pins.set(root, (pins.get(root) ?? 0) + 1);
    },
    async release(workspaceRoot) {
      const root = resolve(workspaceRoot);
      const left = (pins.get(root) ?? 1) - 1;
      if (left > 0) pins.set(root, left); else pins.delete(root);
      await closeIfUnused(root);
    },
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
        forProject(folder) {
          // The project a call names (a program's or the web UI's call context): its one store, which the terminal app,
          // the Agent and the daemon's runs in that project all keep their checkpoints in.
          if (!isAbsolute(folder)) return undefined;
          const project = projectIdentityOf(folder);
          if (isDaemonRoot(project)) return undefined;
          try {
            const opened = acquire(project);
            return opened ? gatewayOf(opened, project) : undefined;
          } catch (error) {
            return refusingGateway(project, new Error(hostedStoreUnavailable(project, error), { cause: error }));
          }
        },
        async forCheckpoint(id) {
          const holds = async (checkpointing: WorkspaceCheckpointing): Promise<boolean> =>
            (await checkpointing.manager.list()).some((checkpoint) => checkpoint.id === id);
          // Every hosted store that could not answer, open or unopened, is named
          // in the refusal below rather than read as "not there".
          const unreadable: string[] = [];
          // In-memory manifests of the open stores first: a lookup, not a store read.
          for (const [hostedRoot, hosted] of workspaces) {
            try {
              if (await holds(hosted)) return gatewayOf(hosted, hostedRoot);
            } catch (error) {
              unreadable.push(`${hostedRoot} (${error instanceof Error ? error.message : String(error)})`);
            }
          }
          if (await holds(daemon).catch(() => false)) return undefined;
          // Not in an open store: the workspaces of recorded hosted sessions not
          // opened since the daemon started. Each one's manifest file is read
          // directly (one small read, no git, no bus subscription), and only the
          // store that lists the id is opened, so a mistyped or stale id opens
          // nothing.
          for (const recorded of sources?.hostedWorkspaces() ?? []) {
            if (!isAbsolute(recorded)) continue;
            const hostedRoot = resolve(recorded);
            if (isDaemonRoot(hostedRoot) || workspaces.has(hostedRoot)) continue;
            try {
              if (!manifestLists(hostedRoot, sources!.homeDirectory, id)) continue;
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
      stopClearedWatch();
      const open = [...workspaces.values()];
      workspaces.clear();
      await Promise.all([
        ...open.map((checkpointing) => checkpointing.close().catch((error: unknown) => {
          logger.warn('hosted workspace checkpoints did not close cleanly', { workspaceRoot: checkpointing.manager.workspaceRoot, error: error instanceof Error ? error.message : String(error) });
        })),
        ...closing,
      ]);
    },
  };
  byBus.set(runtimeBus, registry);
  return registry;
}

/**
 * Whether the checkpoint manifest of a workspace not opened yet lists `id`,
 * read from the file without opening the store: the daemon-scoped store a
 * hosted workspace's manager uses, or the legacy in-workspace store it would
 * migrate on first use. False when neither manifest exists (no checkpoints);
 * throws when one exists but cannot be read, so the caller names it.
 */
function manifestLists(workspaceRoot: string, homeDirectory: string, id: string): boolean {
  const scoped = createSessionSurface({ surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT, workingDirectory: workspaceRoot, homeDirectory }).checkpointsDir;
  // The project's one store, and the stores each program kept before it (merged into it on first use).
  for (const dir of [scoped, ...formerCheckpointsDirs(workspaceRoot)]) {
    let text: string;
    try {
      text = readFileSync(join(dir, 'index.json'), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const checkpoints = (JSON.parse(text) as { readonly checkpoints?: unknown }).checkpoints;
    if (Array.isArray(checkpoints) && checkpoints.some((entry) => (entry as { readonly id?: unknown } | null)?.id === id)) return true;
  }
  return false;
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
