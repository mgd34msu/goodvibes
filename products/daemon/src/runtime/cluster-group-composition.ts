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
  acknowledgeRemoval,
  ClusterGroupRuntime,
  findTombstone,
  clusterElectionTiming,
  clusterSecretStoreFrom,
  createClusterGroupVerbs,
  createSystemClusterClock,
  normalizeDisplayName,
  readClusterSettings,
  rejoinGroup,
  resolveClusterGroupSettings,
  resolveNodeIdentity,
  stillOnRoster,
  UdpClusterTransport,
  type AuthorityRecordFile,
  type ClusterGroupVerbSurface,
  type ClusterClock,
  type ClusterSurfaceHolding,
  type GroupOperationsContext,
} from '@goodvibes/engine/platform/platform/cluster';
import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { SecretsManager } from '../config/secrets.js';
import type { ClusterTransport } from '@goodvibes/engine/platform/platform/cluster';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { ShellPathService } from './index.js';
import { createClusterComposition } from './cluster-composition.js';
import type { ClusterCoordinator } from '@goodvibes/engine/platform/platform/cluster';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { VERSION } from '../version.js';

export interface ClusterGroupComposition {
  readonly runtime: ClusterGroupRuntime;
  readonly verbs: ClusterGroupVerbSurface;
  /** The transport the leader election must use, so its traffic is group-signed. */
  readonly electionTransport: ClusterTransport;
  /** Ask the group for its record and current key generation again (identity-signed, rate-limited). */
  rejoin(generation?: number | null): void;
  /** Start the group layer. Safe to call more than once. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A label for THIS machine in the member list: `cluster.nodeName` when set.
 *
 * Deliberately NOT the hostname by default. The roster replicates to every
 * member and the group name reaches the network in a beacon, so defaulting to
 * a hostname would quietly publish "mikes-laptop" to anything listening. A
 * short slice of the node id is meaningless and safe.
 */
function nodeDisplayNameFor(configManager: ConfigManager, nodeId: string): string {
  return normalizeDisplayName(configManager.get('cluster.nodeName'), `machine ${nodeId.slice(0, 8)}`);
}

/** Gaps between further return announcements when nobody answered; then it waits for a restart. */
const REJOIN_RETRY_DELAYS_MS: readonly number[] = Object.freeze([30_000, 120_000, 600_000]);

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
  readonly secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete' | 'getWriteScopeEntry'> & Partial<Pick<SecretsManager, 'onDidChange' | 'resolveLocalSecretSync'>>;
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
  /** The authority record this home answers credentials from; carried to every member of the group. */
  readonly authorityRecord?: AuthorityRecordFile | undefined;
  /** Where authority.status learns which members' records differ from this one. */
  readonly setAuthorityPeers?: ((peers: { divergence(): { readonly behindOn: readonly string[]; readonly behind: boolean } } | null) => void) | undefined;
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
  const nodeDisplayName = nodeDisplayNameFor(options.configManager, nodeId);
  const clock = options.clock ?? createSystemClusterClock();

  const secrets = clusterSecretStoreFrom(options.secretsManager);
  let removedFromGroup: () => void = () => {};
  const runtime = new ClusterGroupRuntime({
    // The record says the group removed this machine: drop the membership and
    // report it. Called on every refresh until done; deferred, because it is
    // called from inside the record's change notice.
    onRemovedFromGroup: () => removedFromGroup(),
    ...(options.authorityRecord ? { authorityRecord: options.authorityRecord } : {}),
    settings: groupSettings,
    transport: options.transport ?? new UdpClusterTransport({
      port: settings.port,
      multicastGroup: settings.multicastGroup,
      peers: settings.peers,
      logger,
    }),
    // Narrower than the SecretsManager itself: the group layer gets get/set/
    // delete on its own keys and nothing else, and an unreadable store is an
    // error to it, never an empty one.
    secrets,
    stateDirectory,
    nodeId,
    nodeDisplayName,
    version: VERSION,
    clock,
    logger,
    ...(options.surfaceHoldings ? { surfaceHoldings: options.surfaceHoldings } : {}),
    // The settings the election runs with, read once here as the coordinator reads them.
    electionTiming: () => clusterElectionTiming(settings),
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

  // The authority record rides this group (membership and key generations
  // included): identity-signed, so a member that is any number of key
  // generations behind still takes it. authority.status reads its divergence.
  options.setAuthorityPeers?.(runtime.authority);

  const context: GroupOperationsContext = {
    runtime,
    secrets: { get: secrets.get, set: secrets.set, delete: secrets.delete },
    settings: groupSettings,
    nodeId,
    nodeDisplayName,
    version: VERSION,
    now: () => clock.now(),
    electionSecret: () => settings.secret.state,
    authorityRecord: options.authorityRecord,
  };
  let acknowledging = false;
  removedFromGroup = () => {
    if (acknowledging || !started || stopping) return;
    acknowledging = true;
    void Promise.resolve().then(() => acknowledgeRemoval(context)).then((result) => {
      if (result.ok) logger.info('cluster: this machine was removed from its group by another member', { group: result.data.groupId });
    }, () => {}).finally(() => { acknowledging = false; });
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
  // Bounded: each unanswered return announcement (made only by a machine
  // whose record no longer lists it) schedules the next on the group layer's
  // own clock, and stopping cancels the one pending.
  const scheduleRejoin = (attempt: number): void => {
    if (stopping || attempt >= retryDelays.length) return;
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
    }, retryDelays[attempt]!);
  };
  return {
    runtime,
    verbs: createClusterGroupVerbs(context),
    electionTransport: runtime.electionTransport(),
    rejoin: () => runtime.catchUp(),
    start: () => {
      if (stopping) return Promise.reject(new Error('Cluster composition is stopping'));
      if (starting) return starting;
      if (started) return Promise.resolve();
      starting = Promise.resolve().then(async () => {
        if (stopping) throw new Error('Cluster composition startup cancelled by stop');
        await runtime.start();
        if (stopping) throw new Error('Cluster composition startup cancelled by stop');
        started = true;
        const outcome = await announceReturn(runtime, context, nodeId);
        if (stopping) throw new Error('Cluster composition startup cancelled by stop');
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
  readonly secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete' | 'getWriteScopeEntry'> & Partial<Pick<SecretsManager, 'onDidChange' | 'resolveLocalSecretSync'>>;
  readonly authorityRecord?: AuthorityRecordFile | undefined;
  readonly setAuthorityPeers?: ((peers: { divergence(): { readonly behindOn: readonly string[]; readonly behind: boolean } } | null) => void) | undefined;
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
 * Come back to the group, on start.
 *
 * This is the zero-touch return. A machine that has been switched off for
 * months, through many group-key rotations and possibly a join-key change,
 * comes up holding stale keys and asks every member for the group's record,
 * signed with its identity key, which never rotates. Each member that still
 * lists it answers with the record and the current generation's secrets
 * sealed to it; one that lists it as removed answers with its removal. The
 * operator does nothing.
 *
 * A machine whose own record no longer lists it (the record was lost) says
 * "it is still me" instead (REJOIN), and is re-keyed by whichever member
 * answers if the group's roster still has it.
 */
async function announceReturn(
  runtime: ClusterGroupRuntime,
  context: GroupOperationsContext,
  nodeId: string,
): Promise<'settled' | 'retry'> {
  if (runtime.membership !== 'member') return 'settled';
  if (runtime.groupState && findTombstone(runtime.groupState, nodeId)) {
    // The record carries this machine's removal: it was forgotten by another
    // member. It drops the membership and says so, rather than signing with
    // keys the group no longer accepts.
    await acknowledgeRemoval(context);
    return 'settled';
  }
  if (stillOnRoster(runtime.groupState, nodeId)) {
    runtime.catchUp();
    return 'settled';
  }
  const result = await rejoinGroup(context);
  if (result.ok) {
    logger.info('cluster: rejoined the group and took the current group key', {
      group: result.data.groupName,
      members: result.data.memberCount,
    });
    return 'settled';
  }
  // The group told this machine it was removed; the operation dropped the
  // membership and logged it with the command that puts it back.
  if (result.failure === 'removed') return 'settled';
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
