/**
 * cluster-group-composition.ts, this machine's membership of a LAN group.
 *
 * Leader election answers "which of us reads the inbox". This answers the
 * question underneath it: "which machines are US". Without a group, any daemon
 * that happened to be on the same network, a neighbour's, a colleague's, a
 * container someone left running, would join the same coordination and one of
 * you would silently stop receiving messages.
 *
 * The group layer owns the socket and the election rides on it: every
 * coordination datagram is wrapped in the group envelope and signed with the
 * current group key, so a datagram from outside the group never reaches the
 * election at all. That is why `createClusterComposition` is handed a transport
 * from here instead of opening one of its own.
 *
 * Key material lives ONLY in the encrypted secrets store. Never in config,
 * never in a log line, never in `/status`.
 */
import {
  ClusterGroupRuntime,
  createClusterGroupVerbs,
  createSystemClusterClock,
  readClusterSettings,
  rejoinGroup,
  resolveClusterGroupSettings,
  resolveNodeIdentity,
  stillOnRoster,
  UdpClusterTransport,
  type ClusterGroupVerbSurface,
  type ClusterClock,
  type ClusterSurfaceHolding,
  type GroupOperationsContext,
} from '@goodvibes-jev/engine/platform/platform/cluster';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { SecretsManager } from '../config/secrets.js';
import type { ClusterTransport } from '@goodvibes-jev/engine/platform/platform/cluster';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ShellPathService } from './index.js';
import { createClusterComposition } from './cluster-composition.js';
import type { ClusterCoordinator } from '@goodvibes-jev/engine/platform/platform/cluster';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { VERSION } from '../version.js';

export interface ClusterGroupComposition {
  readonly runtime: ClusterGroupRuntime;
  readonly verbs: ClusterGroupVerbSurface;
  /** The transport the leader election must use, so its traffic is group-signed. */
  readonly electionTransport: ClusterTransport;
  /** Ask the group to hand this machine its current key again, rate-limited. */
  rejoin(): void;
  /** Start the group layer. Safe to call more than once. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A label for THIS machine in the member list.
 *
 * Deliberately NOT the hostname. The roster replicates to every member and the
 * group name reaches the network in a beacon, so defaulting to a hostname would
 * quietly publish "mikes-laptop" to anything listening. A short slice of the
 * node id is meaningless and safe, and `cluster nodes` shows it plainly so an
 * operator who wants a real name can see there is one to set.
 */
function defaultNodeDisplayName(nodeId: string): string {
  return `machine ${nodeId.slice(0, 8)}`;
}

/** Gaps between further return announcements when nobody answered; then it waits for a restart. */
const REJOIN_RETRY_DELAYS_MS: readonly number[] = Object.freeze([30_000, 120_000, 600_000]);

/** Least gap between catch-ups prompted by a datagram showing the group's key moved on. */
const KEY_LOST_REJOIN_MIN_GAP_MS = 60_000;

/**
 * Build the group layer.
 *
 * Constructing it is inert: no socket is opened and no key material is read
 * until `start()`, so composing a runtime in a test never touches the network
 * or the secrets store.
 */
export function createClusterGroupComposition(options: {
  readonly configManager: ConfigManager;
  readonly shellPaths: ShellPathService;
  readonly secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete'> & Partial<Pick<SecretsManager, 'onDidChange' | 'resolveLocalSecretSync'>>;
  /** Optional host/test seams; defaults preserve the real UDP/system-clock path. */
  readonly transport?: ClusterTransport | undefined;
  readonly clock?: ClusterClock | undefined;
  /**
   * Waits between further return announcements when nobody answered the first.
   * A machine that starts before the rest of its group would otherwise never
   * ask again and stay on stale keys until the daemon is restarted.
   */
  readonly rejoinRetryDelaysMs?: readonly number[] | undefined;
  /**
   * Which surfaces this machine currently holds, and why.
   *
   * The per-surface election establishes this; the group layer only reports it,
   * in `cluster status` and in /status. Late-bound because the coordinator is
   * built from this composition's transport and does not exist yet when this
   * function runs. Absent means the group layer reports that the information is
   * unavailable rather than reporting an empty list as though this machine held
   * nothing, a distinction an operator diagnosing a silent inbox depends on.
   */
  readonly surfaceHoldings?: (() => readonly ClusterSurfaceHolding[]) | undefined;
}): ClusterGroupComposition {
  const { resolveLocalSecretSync } = options.secretsManager;
  const settings = readClusterSettings(options.configManager,
    resolveLocalSecretSync ? { resolveLocalSecretSync: (key: string) => resolveLocalSecretSync.call(options.secretsManager, key) } : undefined);
  const groupSettings = resolveClusterGroupSettings(
    (options.configManager as { getCategory?: (name: string) => unknown }).getCategory?.('cluster'),
  );
  // Surface-scoped, alongside the election's node identity and this surface's
  // other durable state.
  const stateDirectory = options.shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'cluster');
  const nodeId = resolveNodeIdentity({ stateDirectory, logger }).nodeId;
  const clock = options.clock ?? createSystemClusterClock();

  let requestRejoin: () => void = () => {};
  const runtime = new ClusterGroupRuntime({
    onKeyGenerationLost: () => requestRejoin(),
    settings: groupSettings,
    transport: options.transport ?? new UdpClusterTransport({
      port: settings.port,
      multicastGroup: settings.multicastGroup,
      peers: settings.peers,
      logger,
    }),
    // Narrower than the SecretsManager itself: the group layer gets get/set/
    // delete on one key and nothing else.
    secrets: {
      get: (key) => options.secretsManager.get(key),
      set: (key, value) => options.secretsManager.set(key, value),
      delete: (key) => options.secretsManager.delete(key),
      ...(options.secretsManager.onDidChange ? { onDidChange: (listener: (key: string) => void) => options.secretsManager.onDidChange!(listener) } : {}),
    },
    stateDirectory,
    nodeId,
    nodeDisplayName: defaultNodeDisplayName(nodeId),
    version: VERSION,
    clock,
    logger,
    ...(options.surfaceHoldings ? { surfaceHoldings: options.surfaceHoldings } : {}),
    // Only daemon-owned, group-scoped keys ever reach this; the platform's
    // replication policy decides which, and refuses anything machine-specific.
    config: {
      get: (path) => (options.configManager as unknown as {
        get(key: string): unknown;
      }).get(path),
      set: (path, value) => (options.configManager as unknown as {
        set(key: string, value: unknown): void;
      }).set(path, value),
      ...(typeof options.configManager.reset === 'function' ? { reset: (path: string) => options.configManager.reset(path as ConfigKey) } : {}),
      ...(typeof options.configManager.subscribe === 'function' ? { subscribe: (path: string, listener: () => void) => options.configManager.subscribe(path as ConfigKey, listener) } : {}),
    },
  });

  const context: GroupOperationsContext = {
    runtime,
    secrets: {
      get: (key) => options.secretsManager.get(key),
      set: (key, value) => options.secretsManager.set(key, value),
      delete: (key) => options.secretsManager.delete(key),
    },
    settings: groupSettings,
    nodeId,
    nodeDisplayName: defaultNodeDisplayName(nodeId),
    version: VERSION,
    now: () => clock.now(),
  };

  let started = false;
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  const retryDelays = options.rejoinRetryDelaysMs ?? REJOIN_RETRY_DELAYS_MS;
  let cancelRejoin: (() => void) | undefined;
  const clearRejoin = (): void => {
    const cancel = cancelRejoin;
    cancelRejoin = undefined;
    cancel?.();
  };
  // Bounded: each unanswered announcement schedules the next on the group
  // layer's own clock, and stopping cancels the one pending.
  const scheduleRejoin = (attempt: number, delayMs?: number): void => {
    if (stopping || (delayMs === undefined && attempt >= retryDelays.length)) return;
    cancelRejoin = clock.setTimer(() => {
      cancelRejoin = undefined;
      if (stopping || !started) return;
      void announceReturn(runtime, context, nodeId).then(
        (outcome) => { if (outcome === 'retry') scheduleRejoin(attempt + 1); },
        (error: unknown) => {
          if (stopping) return;
          logger.warn('cluster: a repeated return announcement failed', { error: summarizeError(error) });
          scheduleRejoin(attempt + 1);
        },
      );
    }, delayMs ?? retryDelays[attempt]!);
  };
  // The group's key moved on while this machine was running. The datagram that
  // showed it is unauthenticated, so this only asks the group again (a member
  // verifies the answer), at most once a minute and never alongside a pending one.
  let lastKeyLostRejoinAt = Number.NEGATIVE_INFINITY;
  requestRejoin = () => {
    if (stopping || !started || cancelRejoin) return;
    const now = clock.now();
    if (now - lastKeyLostRejoinAt < KEY_LOST_REJOIN_MIN_GAP_MS) return;
    lastKeyLostRejoinAt = now;
    scheduleRejoin(0, 0);
  };
  return {
    runtime,
    verbs: createClusterGroupVerbs(context),
    electionTransport: runtime.electionTransport(),
    rejoin: () => requestRejoin(),
    start: () => {
      if (stopping) return Promise.reject(new Error('Cluster composition is stopping'));
      if (starting) return starting;
      if (started) return Promise.resolve();
      starting = Promise.resolve().then(async () => {
        if (stopping) throw new Error('Cluster composition startup cancelled by stop');
        await runtime.start();
        if (stopping) throw new Error('Cluster composition startup cancelled by stop');
        const outcome = await announceReturn(runtime, context, nodeId);
        if (stopping) throw new Error('Cluster composition startup cancelled by stop');
        started = true;
        if (outcome === 'retry') scheduleRejoin(0);
      }).catch(async (error: unknown) => {
        try { await runtime.stop(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Cluster composition startup and cleanup failed'); }
        throw error;
      }).finally(() => { starting = null; });
      return starting;
    },
    stop: () => {
      if (stopping) return stopping;
      started = false;
      clearRejoin();
      const pending = starting;
      stopping = Promise.resolve().then(async () => {
        // Cancel the runtime FIRST: a pending return announcement needs its
        // admission abandoned before the composition's startup can settle.
        const closing = runtime.stop();
        const [, result] = await Promise.allSettled([pending, closing]);
        if (result.status === 'rejected') throw result.reason;
      }).finally(() => { stopping = null; });
      return stopping;
    },
  };
}

/**
 * Build both halves of the LAN cluster, wired to each other.
 *
 * They are mutually dependent and the dependency runs both ways, which is why
 * this exists rather than two calls at the composition root: the election
 * coordinates over the GROUP's transport, and the group's status reports the
 * ELECTION's surface holdings. Holdings are read through a closure because the
 * coordinator does not exist yet when the group layer is constructed. Config
 * replication needs no master: every member issues its own changes.
 *
 * Constructing either is inert, no socket, no key material read, until
 * `startCluster` runs.
 */
export function createClusterServices(options: {
  readonly configManager: ConfigManager;
  readonly shellPaths: ShellPathService;
  readonly secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete'> & Partial<Pick<SecretsManager, 'onDidChange' | 'resolveLocalSecretSync'>>;
  /** Optional host/test seams; defaults preserve the real UDP/system-clock path. */
  readonly transport?: ClusterTransport | undefined;
  readonly clock?: ClusterClock | undefined;
}): { readonly clusterGroup: ClusterGroupComposition; readonly clusterCoordinator: ClusterCoordinator } {
  let coordinator: ClusterCoordinator | null = null;
  const clusterGroup = createClusterGroupComposition({
    ...options,
    // The elections actually running are the only honest source for this, so
    // the group layer reads them rather than keeping a second tally that could
    // disagree. Before the coordinator exists there is nothing to report, and
    // an empty list is the truthful answer at that point: no election has been
    // held, so this machine holds nothing.
    surfaceHoldings: () => coordinator?.surfaceHoldings() ?? [],
  });
  const { resolveLocalSecretSync } = options.secretsManager;
  coordinator = createClusterComposition({
    configManager: options.configManager,
    ...(resolveLocalSecretSync ? { secrets: { resolveLocalSecretSync: (key: string) => resolveLocalSecretSync.call(options.secretsManager, key) } } : {}),
    shellPaths: options.shellPaths,
    transport: clusterGroup.electionTransport,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { clusterGroup, clusterCoordinator: coordinator };
}

/**
 * Start the LAN cluster, in the order it has to be started in.
 *
 * The group layer FIRST: it owns the socket the leader election coordinates
 * over, and starting the election against a transport whose group is not yet
 * loaded would sign its first datagrams with nothing. Both calls are
 * idempotent, so a composition root that reaches this twice is fine.
 */
export async function startClusterServices(services: {
  readonly clusterGroup: Pick<ClusterGroupComposition, 'start'>;
  readonly clusterCoordinator: { start(): Promise<void> };
}): Promise<void> {
  await services.clusterGroup.start();
  await services.clusterCoordinator.start();
}

/**
 * Ask the group to take this machine back, on start.
 *
 * This is the zero-touch return. A machine that has been switched off for
 * months, through many group-key rotations and possibly a join-key change,
 * comes up holding stale keys, says "it is still me" with a key that never
 * rotates, and is re-keyed to the current generation by whichever member
 * answers. The operator does nothing.
 *
 * It runs only when this machine still believes it is on the roster. A machine
 * that was REMOVED asks for nothing: it would be refused, and asking anyway
 * would put a pointless refusal in everyone's logs every time it started.
 */
async function announceReturn(
  runtime: ClusterGroupRuntime,
  context: GroupOperationsContext,
  nodeId: string,
): Promise<'settled' | 'retry'> {
  if (runtime.membership !== 'member') return 'settled';
  if (!stillOnRoster(runtime.groupState, nodeId)) return 'settled';
  const result = await rejoinGroup(context);
  if (result.ok) {
    logger.info('cluster: rejoined the group and took the current group key', {
      group: result.data.groupName,
      members: result.data.memberCount,
    });
    return 'settled';
  }
  if (result.terminal) {
    // A member refused this machine and proved it was a member when it did.
    // Retrying will never succeed, so this is not a quiet debug line: without
    // it the operator sees a healthy daemon that is simply never given any
    // work, with nothing anywhere saying why. Stated at ERROR with the command
    // that fixes it, the same standard a surface this node cannot serve is
    // held to.
    logger.error('cluster: this machine is no longer in its group and will not be given work', {
      reason: result.error,
      action: result.fix,
    });
    return 'settled';
  }
  if (result.failure === 'unverifiable-replies') {
    // Something answered and none of it could be authenticated. This machine
    // cannot tell a removal it slept through from a stranger making noise, so
    // it says exactly that and does not assert either. WARN rather than ERROR
    // for the same reason: anything on the network can produce this, and a
    // machine that shouted "you were removed" on cue would be worse than one
    // that stayed quiet.
    logger.warn('cluster: replies to this machine\'s return could not be authenticated', {
      reason: result.error,
      action: result.fix,
    });
    return 'retry';
  }
  // Not an error. A machine that starts first, or is alone on the network, has
  // nobody to answer it and carries on with the keys it already holds, but a
  // member that comes up before the others would otherwise never ask again.
  logger.debug('cluster: no other machine answered the return announcement', { reason: result.error });
  return 'retry';
}
