/**
 * group-runtime.ts, the live group: beacons, gossip, admissions, rotation.
 *
 * One instance per daemon. It owns the datagram socket, holds the keyring every
 * outbound datagram is signed with, and is the only thing in the system that
 * writes group key material.
 *
 * The operator-facing operations (create, join, key, nodes, forget, leave) live
 * next door in group-operations.ts and go through this object, so the CLI, the
 * TUI and the web UI are three renderings of one implementation, never three
 * implementations.
 *
 * ── enabling clustering without a group ────────────────────────────────────
 *
 * `cluster.enabled: true` with no group stored is NOT a state this runtime
 * pretends to run in. It starts in `no-group`: it listens, so `cluster join`
 * can show the operator what is on the network, and it sends nothing, signs
 * nothing and gates nothing. `cluster status` says so in one line, and names
 * the two commands that fix it. Half-starting, joining the multicast group and
 * broadcasting unsigned, is the outcome this explicitly avoids.
 */
import { ClusterIngressWork } from './ingress-work.js';
import { ConfigReplicationPrivacyError } from './config-replication-privacy.js';
import { GroupConfigChanges, GroupConfigChangeRetiredError } from './group-config-changes.js';
import { GroupStateOwner } from './group-state-owner.js';
import { ClusterMembershipOperationError, ClusterMembershipOperations, type ClusterMembershipOperation } from './membership-operation.js';
import { GroupAdmissionService, type AdmissionOutcome } from './group-admissions.js';
import { ClusterOwnedLifecycle, ClusterPeriodicTasks } from './owned-lifecycle.js';
import { digestSurfaceId, sealForMember, openSealedEnvelope } from './group-crypto.js';
import { GROUP_MESSAGE_TYPES } from './group-membership.js';
import {
  keyRotationGraceMs,
  keyRotationMs,
  type ClusterGroupSettings,
} from './group-settings.js';
import {
  DEFAULT_GROUP_DISPLAY_NAME,
  mergeGroupState,
  isCurrentMember,
  readGroupStateDocument,
  sweepGroupState,
  touchMember,
  withGroupSigningKey,
  type GroupStateDocument,
} from './group-state.js';
import {
  adoptGroupKeys,
  GroupKeyring,
  observeGroupKeyMaterial,
  loadGroupState,
  readKeyRecord,
  rotateGroupKeyMaterial,
  loadReplicaDocument,
  saveGroupKeyMaterial,
  clearGroupKeyMaterial,
  GROUP_STATE_FILENAME,
  GROUP_REPLICA_FILENAME,
  sweepKeyHistory,
  type ClusterSecretStore,
  type GroupKeyMaterial,
  type GroupKeyRecord,
} from './group-store.js';
import { GroupWireRouter } from './group-transport.js';
import {
  CONFIG_MESSAGE_TYPES,
  ConfigReplicationService,
  type ConfigReplicationStatus,
  type ReplicatedConfigStore,
  type ReplicatedSecretStore,
} from './config-replication.js';
import {
  createConfigReplicaDocument,
  readConfigReplicaDocument,
  type ConfigReplicaDocument,
} from './config-replica.js';
import { isReplicatedConfigPath } from './config-replication-policy.js';
import { encodeEnvelope, type ClusterEnvelope, type ClusterKeyring } from './protocol-envelope.js';
import type { ClusterClock, ClusterLogger, ClusterSurfaceHolding, ClusterTransport } from './types.js';

const REKEY_SEAL_CONTEXT = 'goodvibes-cluster-rekey-v1';

/** How often the housekeeping timer runs: rotation checks, sweeps, gossip. */
const HOUSEKEEPING_INTERVAL_MS = 30_000;

/** A group seen on the network that this node is not a member of. */
export interface DiscoveredGroup {
  readonly groupId: string;
  readonly displayName: string;
  readonly nodeCount: number;
  readonly version: string;
  readonly lastSeenAt: number;
}

/**
 * One surface this node consumes, and why.
 *
 * The per-surface election establishes this, so the shape is defined alongside
 * the rest of the election's types and re-exported here under the name the
 * group layer has always used for it.
 */
export type SurfaceHolding = ClusterSurfaceHolding;

export interface ClusterGroupRuntimeOptions {
  readonly settings: ClusterGroupSettings;
  readonly transport: ClusterTransport;
  readonly secrets: ClusterSecretStore;
  readonly stateDirectory: string;
  readonly nodeId: string;
  /** Label for THIS machine in the roster. Never defaulted to a hostname. */
  readonly nodeDisplayName: string;
  readonly version: string;
  readonly clock: ClusterClock;
  readonly logger: ClusterLogger;
  /**
   * Which surfaces this node currently consumes, and why.
   *
   * Supplied by the per-surface election layer, which owns that fact. Absent
   * means `cluster status` reports that the information is not available rather
   * than reporting an empty list as though the node held nothing.
   */
  readonly surfaceHoldings?: (() => readonly SurfaceHolding[]) | undefined;
  /**
   * Which machine issues config revisions.
   *
   * Supplied by the composition root as the leader election's own answer, so
   * there is one notion of "master" in the process rather than two that can
   * disagree. Absent means this machine never issues one, which is the safe
   * reading for an embedder with no election.
   */
  readonly isMaster?: (() => boolean) | undefined;
  /** The config this machine reads and writes. Absent disables replication. */
  readonly config?: ReplicatedConfigStore | undefined;
}

/** Membership as `cluster status` reports it. */
export type GroupMembershipState = 'no-group' | 'member' | 'unreadable-key-material';

export class ClusterGroupRuntime {
  private material: GroupKeyMaterial | null = null;
  private state: GroupStateDocument | null = null;
  private readonly router: GroupWireRouter;
  private keyringInstance: GroupKeyring | null = null;
  private readonly admissions: GroupAdmissionService;
  private readonly discovered = new Map<string, DiscoveredGroup>();
  private readonly lifecycle = new ClusterOwnedLifecycle((signal) => this.startOwned(signal), () => this.stopOwned());
  private readonly periodic: ClusterPeriodicTasks;
  private lastRotationCheckAt = 0;
  private unreadableMaterial = false;
  private housekeeping = false;
  private readonly membershipOperations = new ClusterMembershipOperations();
  private membershipRevision = 0;
  private materialQueue: Promise<void> = Promise.resolve();
  private readonly materialWork = new Set<Promise<void>>();
  private stopping: Promise<void> | null = null;
  private runtimeStopping = false;
  private networkStarted = false;
  private readonly stateOwner: GroupStateOwner;
  private readonly groupWork = new Set<Promise<void>>();
  private membershipTransition = false;
  private replication: ConfigReplicationService | null = null;
  private readonly configChanges: GroupConfigChanges;
  private readonly incoming: ClusterIngressWork;

  constructor(private readonly options: ClusterGroupRuntimeOptions) {
    this.incoming = new ClusterIngressWork(options.logger, () => options.clock.monotonicNow());
    this.stateOwner = new GroupStateOwner(options.stateDirectory, [GROUP_STATE_FILENAME, GROUP_REPLICA_FILENAME]);
    this.periodic = new ClusterPeriodicTasks(options.clock, options.logger);
    // Built here, not in start(), because the composition root needs
    // `electionTransport()` while it is still WIRING, the coordinator is
    // constructed with it before anything is started. Constructing the router
    // opens no socket and writes nothing; `ensureStarted` does that, and both
    // tenants may call it.
    const runtime = this;
    this.router = new GroupWireRouter({
      inner: options.transport,
      // Delegating rather than the instance itself: joining a group REPLACES
      // the keyring, and a router holding the one from construction time would
      // keep signing with the empty group's nothing.
      keyring: {
        get groupId() { return runtime.keyring().groupId; },
        get currentGeneration() { return runtime.keyring().currentGeneration; },
        keyForGeneration: (generation) => this.keyring().keyForGeneration(generation),
        acceptedGenerations: () => this.keyring().acceptedGenerations(),
      },
      logger: options.logger,
      now: () => options.clock.now(),
      onGroupMessage: (envelope) => this.onGroupMessage(envelope),
      onOutOfBandMessage: (raw, type) => void this.admissions.handle(raw, type),
      onForeignBeacon: (groupId, body, version) => this.recordDiscoveredGroup(groupId, body, version),
    });
    this.configChanges = new GroupConfigChanges({
      config: options.config, secrets: options.secrets, logger: options.logger,
      owner: () => {
        const member = this.state?.members.find(candidate => candidate.nodeId === options.nodeId);
        if (!this.networkStarted || this.runtimeStopping || this.membershipTransition || !this.membershipOperations.available
          || !this.material || !this.state || !member || !isCurrentMember(this.state, options.nodeId)) return null;
        return { revision: this.membershipRevision, generation: member.gen, master: options.isMaster?.() ?? false };
      },
      capture: () => this.captureConfigAuthority(),
      retireLocal: path => this.replication?.observeLocalChange(path),
      apply: change => this.runGroupWork(() => change.kind === 'secret'
        ? this.replication?.announceLocalSecret(change.path, change.assertCurrent, change.seed)
        : this.replication?.announceLocalChange(change.path, change.assertCurrent)),
    });
    const observedConfig = this.configChanges.configStore();
    this.replication = new ConfigReplicationService({
      nodeId: options.nodeId,
      logger: options.logger,
      now: () => options.clock.now(),
      isMaster: () => options.isMaster?.() ?? false,
      groupState: () => this.state,
      captureAuthority: envelope => this.captureConfigAuthority(envelope),
      nodeKeys: () => this.material?.node ?? null,
      config: () => observedConfig ?? null,
      secrets: () => this.replicatedSecrets(),
      send: (type, body) => this.sendGroupMessage(type, body, null, true),
      persist: (document) => this.persistReplica(document),
    }, '');
    this.admissions = new GroupAdmissionService({
      nodeId: options.nodeId,
      version: options.version,
      nodeDisplayName: options.nodeDisplayName,
      clock: options.clock,
      logger: options.logger,
      material: () => this.material,
      state: () => this.state,
      commitState: (state, gossip) => this.commitState(state, gossip),
      send: (raw) => this.router.sendRaw(raw),
      nextSeq: () => this.router.nextSeq(),
    });
    this.admissions.stop('the group runtime has not started');
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new ClusterMembershipOperationError('abandoned'));
    return this.lifecycle.start();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.runtimeStopping = true;
    this.incoming.close();
    this.configChanges.stop();
    this.networkStarted = false;
    this.membershipOperations.stop();
    this.keyringInstance = null;
    this.admissions.stop('the daemon shut down before the group answered');
    this.stopping = Promise.resolve().then(async () => {
      await this.lifecycle.stop();
      // A source/embedder may start membership work before opening transport.
      // Its owned persistence must drain even when lifecycle had no socket.
      await this.membershipOperations.join();
      await this.drainGroupWork();
      await this.drainMaterialWrites();
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async startOwned(signal: AbortSignal): Promise<void> {
    this.runtimeStopping = false;
    this.membershipOperations.start();
    await this.reloadMaterial(signal);
    signal.throwIfAborted();
    if (!this.options.settings.enabled) {
      // Switched off. Read the stored membership so `cluster status`, `key` and
      // `nodes` can still answer honestly about a group this machine belongs to
      //, and open nothing: no socket, no beacon, no timers. Joining the
      // multicast group while the operator has the feature off would be exactly
      // the half-started behaviour this design refuses.
      this.options.logger.debug('cluster: sharing is switched off; the group layer is not on the network');
      return;
    }
    await this.router.ensureStarted();
    signal.throwIfAborted();
    this.incoming.open();
    this.networkStarted = true;
    this.configChanges.start();
    this.admissions.start();
    this.periodic.schedule(this.options.settings.beaconSeconds * 1_000, () => this.sendBeacon());
    this.periodic.schedule(HOUSEKEEPING_INTERVAL_MS, () => this.runHousekeeping());
    if (!this.material) {
      this.options.logger.info(
        'cluster: sharing is switched on but this machine is not in a group; it is listening only',
        { action: 'create one with `cluster create`, or join one with `cluster join`' },
      );
    }
  }

  private async stopOwned(): Promise<void> {
    this.incoming.close();
    await this.incoming.join();
    this.configChanges.stop();
    await this.configChanges.join();
    this.admissions.stop('the daemon shut down before the group answered');
    await this.admissions.join();
    await this.drainGroupWork();
    await this.membershipOperations.join();
    await this.drainMaterialWrites();
    await this.periodic.stop();
    await this.router.stop();
  }

  /** Ask the group to admit this machine with a join key. */
  requestJoin(input: {
    readonly groupId: string;
    readonly joinKey: string;
    readonly joinSalt: string;
    readonly timeoutMs: number;
  }): Promise<AdmissionOutcome> {
    return this.admissions.requestJoin(input);
  }

  /** Ask the group to take this machine back and re-key it. */
  requestRejoin(timeoutMs: number): Promise<AdmissionOutcome> {
    return this.admissions.requestRejoin(timeoutMs);
  }

  /** The transport to hand `ClusterCoordinator`. Election traffic rides the group key. */
  electionTransport(): ClusterTransport {
    return this.router.electionTransport(this.options.version);
  }

  /**
   * The keyring every datagram is signed and checked against.
   *
   * With no membership this is a keyring for the empty group: it holds nothing,
   * accepts nothing and signs nothing, so a node with no group cannot emit a
   * datagram anybody would act on even if something tried to make it.
   */
  keyring(): ClusterKeyring {
    if (this.keyringInstance) return this.keyringInstance;
    return {
      groupId: '',
      currentGeneration: 0,
      keyForGeneration: () => null,
      acceptedGenerations: () => [],
    };
  }

  get membership(): GroupMembershipState {
    if (this.material) return 'member';
    return this.unreadableMaterial ? 'unreadable-key-material' : 'no-group';
  }

  get groupState(): GroupStateDocument | null {
    return this.state;
  }

  get keyMaterial(): GroupKeyMaterial | null {
    return this.material;
  }

  get wireCounters(): GroupWireRouter['counters'] {
    return this.router.counters;
  }

  groupsOnTheNetwork(): readonly DiscoveredGroup[] {
    return [...this.discovered.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  surfaceHoldings(): readonly SurfaceHolding[] | null {
    const provider = this.options.surfaceHoldings;
    if (!provider) return null;
    return provider().map((holding) => ({
      ...holding,
      surfaceId: digestSurfaceId(holding.surfaceId, this.keyring().groupId),
    }));
  }

  // ── material ──────────────────────────────────────────────────────────────

  /** Re-read key material and roster from their stores. */
  async reloadMaterial(signal?: AbortSignal): Promise<void> {
    if (this.membershipOperations.busy || this.materialWork.size > 0 || this.groupWork.size > 0 || this.incoming.status.active > 0) throw new ClusterMembershipOperationError('not-sent');
    this.stateOwner.assertCurrent();
    const revision = this.membershipRevision;
    const observation = await observeGroupKeyMaterial(this.options.secrets, this.options.logger);
    signal?.throwIfAborted();
    this.stateOwner.assertCurrent();
    if (this.runtimeStopping || revision !== this.membershipRevision || this.membershipOperations.busy || this.materialWork.size > 0 || this.groupWork.size > 0 || this.incoming.status.active > 0) throw new ClusterMembershipOperationError('abandoned');
    const material = observation.material;
    const state = material ? loadGroupState(this.options.stateDirectory, material.groupId, this.options.clock.now(), this.options.logger) : null;
    const savedReplica = material ? loadReplicaDocument(this.options.stateDirectory, value => readConfigReplicaDocument(value, isReplicatedConfigPath), this.options.logger) : null;
    this.stateOwner.assertCurrent();
    signal?.throwIfAborted();
    if (this.runtimeStopping || revision !== this.membershipRevision || this.membershipOperations.busy || this.materialWork.size > 0 || this.groupWork.size > 0 || this.incoming.status.active > 0) throw new ClusterMembershipOperationError('abandoned');
    this.admissions.abandon('the stored membership was reloaded');
    this.unreadableMaterial = observation.unreadable;
    this.material = material; this.state = state; this.membershipRevision += 1;
    this.keyringInstance = material ? new GroupKeyring(() => this.requireMaterial(), () => this.options.clock.now()) : null;
    if (observation.unreadable) this.membershipOperations.markUnknown();
    else {
      this.membershipOperations.reconciled();
      if (this.networkStarted) this.admissions.start();
    }
    // A previous membership's replica is not current-group authority. Keep its
    // original file intact; only a real current-group write replaces that slot.
    if (material && this.replication) this.replication.adopt(savedReplica?.groupId === material.groupId
      ? savedReplica : createConfigReplicaDocument(material.groupId));
    if (this.networkStarted && !this.runtimeStopping && this.membershipOperations.available && !this.membershipTransition) { this.incoming.open(); this.configChanges.resume(); }
  }

  /** Operator work reserves one cancellable owner before its first await. */
  withMembershipOperation<T>(work: (owner: ClusterMembershipOperation) => Promise<T>): Promise<T> {
    return this.membershipOperations.run(async owner => {
      try { this.stateOwner.assertCurrent(); } catch { throw new ClusterMembershipOperationError('abandoned'); }
      return work(owner);
    });
  }

  assertMembershipOperation(owner: ClusterMembershipOperation): void { this.membershipOperations.assert(owner); }

  private enqueueMaterialWrite(work: () => Promise<void>): Promise<void> {
    const task = this.materialQueue.then(work);
    this.materialQueue = task.catch(() => {});
    this.materialWork.add(task);
    void task.then(() => { this.materialWork.delete(task); }, () => { this.materialWork.delete(task); });
    return task;
  }

  private async drainMaterialWrites(): Promise<void> {
    while (this.materialWork.size > 0) await Promise.allSettled([...this.materialWork]);
  }

  private runGroupWork(work: () => Promise<void> | undefined): Promise<void> {
    if (this.runtimeStopping || this.membershipTransition || !this.membershipOperations.available) return Promise.reject(new ClusterMembershipOperationError('abandoned'));
    const revision = this.membershipRevision;
    const task = Promise.resolve().then(async () => {
      if (this.runtimeStopping || this.membershipTransition || revision !== this.membershipRevision) throw new ClusterMembershipOperationError('abandoned');
      await work();
    });
    this.groupWork.add(task);
    void task.then(() => { this.groupWork.delete(task); }, error => {
      this.groupWork.delete(task);
      if (!(error instanceof ClusterMembershipOperationError) && !(error instanceof GroupConfigChangeRetiredError) && !(error instanceof ConfigReplicationPrivacyError)) this.options.logger.warn('cluster: owned group work failed');
    });
    return task;
  }

  private async drainGroupWork(): Promise<void> {
    while (this.groupWork.size > 0) await Promise.allSettled([...this.groupWork]);
  }

  private async beginMembershipTransition(owner: ClusterMembershipOperation): Promise<void> {
    this.membershipOperations.assert(owner);
    this.membershipTransition = true;
    this.incoming.close();
    this.configChanges.suspend();
    this.admissions.stop('this machine is changing its group membership');
    // Drain BEFORE entering the material queue: an old handler may itself be
    // waiting for a queued material write. Holding the queue here would deadlock.
    await Promise.all([this.admissions.join(), this.incoming.join(), this.configChanges.join(), this.drainGroupWork(), this.periodic.join()]);
    this.membershipOperations.assert(owner);
  }

  private endMembershipTransition(): void {
    this.membershipTransition = false;
    if (this.networkStarted && this.membershipOperations.available && !this.runtimeStopping) { this.incoming.open(); this.admissions.start(); this.configChanges.resume(); }
  }

  private persistenceUnknown(): ClusterMembershipOperationError {
    // An entered async set/delete may have taken effect before rejecting. Do
    // not assert rollback, retry it, erase evidence, or keep signing old keys.
    this.membershipOperations.markUnknown();
    this.configChanges.suspend();
    this.admissions.stop('group membership persistence could not be confirmed');
    this.material = null; this.state = null; this.keyringInstance = null;
    this.unreadableMaterial = true;
    this.membershipRevision += 1;
    return new ClusterMembershipOperationError('persistence-unknown');
  }

  private requireMaterial(): GroupKeyMaterial {
    if (!this.material) throw new Error('cluster: this machine is not in a group');
    return this.material;
  }

  /** Install acknowledged material and its matching durable roster. */
  adoptMembership(material: GroupKeyMaterial, state: GroupStateDocument, owner?: ClusterMembershipOperation): Promise<void> {
    return this.membershipOperations.run(async (lease) => {
      try {
        await this.beginMembershipTransition(lease);
        const revision = this.membershipRevision, expected = this.material;
        if (material.groupId !== state.groupId || (expected?.groupId === material.groupId && material.currentGeneration < expected.currentGeneration)) throw new ClusterMembershipOperationError('abandoned');
        await this.enqueueMaterialWrite(async () => {
          this.membershipOperations.assert(lease);
          if (revision !== this.membershipRevision || expected !== this.material) throw new ClusterMembershipOperationError('abandoned');
          try { this.stateOwner.ensure(); } catch { throw new ClusterMembershipOperationError('abandoned'); }
          try {
            await saveGroupKeyMaterial(this.options.secrets, material);
            // Cancellation cannot abandon half of an acknowledged publication.
            // Stop still owns/drains this exact operation and its original store.
            this.membershipOperations.assert(lease, true);
            this.stateOwner.write(GROUP_STATE_FILENAME, `${JSON.stringify(state, null, 2)}\n`, true);
            if (this.replication && this.replication.replica.groupId !== material.groupId) this.replication.adopt(createConfigReplicaDocument(material.groupId));
            this.material = material; this.state = state; this.unreadableMaterial = false;
            this.membershipRevision += 1;
            this.keyringInstance = this.runtimeStopping ? null : new GroupKeyring(() => this.requireMaterial(), () => this.options.clock.now());
          } catch { throw this.persistenceUnknown(); }
        });
      } finally { this.endMembershipTransition(); }
    }, owner);
  }

  /** Clear only the in-memory half, preserving the existing public semantics.
   * The explicit leave path below owns deletion through this runtime's store.
   */
  forgetMembership(owner?: ClusterMembershipOperation): Promise<void> {
    return this.membershipOperations.run(async lease => {
      try {
        await this.beginMembershipTransition(lease);
        await this.enqueueMaterialWrite(async () => { this.membershipOperations.assert(lease); this.clearLiveMembership(); });
      } finally { this.endMembershipTransition(); }
    }, owner);
  }

  private clearLiveMembership(): void {
    this.admissions.abandon('this machine left its group');
    this.replication?.adopt(createConfigReplicaDocument(''));
    this.material = null; this.keyringInstance = null; this.state = null; this.unreadableMaterial = false;
    this.membershipRevision += 1;
  }

  /** Delete from the same actual encrypted store that owns this membership. */
  leaveMembership(owner?: ClusterMembershipOperation): Promise<void> {
    return this.membershipOperations.run(async lease => {
      try {
        await this.beginMembershipTransition(lease);
        const revision = this.membershipRevision;
        await this.enqueueMaterialWrite(async () => {
          this.membershipOperations.assert(lease);
          if (revision !== this.membershipRevision) throw new ClusterMembershipOperationError('abandoned');
          this.keyringInstance = null;
          try {
            await clearGroupKeyMaterial(this.options.secrets);
            this.membershipOperations.assert(lease, true);
            this.clearLiveMembership();
          } catch { throw this.persistenceUnknown(); }
        });
      } finally { this.endMembershipTransition(); }
    }, owner);
  }

  /** Persist a changed roster and gossip it. */
  async commitState(state: GroupStateDocument, gossip = true): Promise<void> {
    if (!this.membershipOperations.available || this.membershipTransition || state.groupId !== this.material?.groupId) throw new ClusterMembershipOperationError('abandoned');
    this.stateOwner.write(GROUP_STATE_FILENAME, `${JSON.stringify(state, null, 2)}\n`, false);
    this.state = state;
    if (gossip) await this.sendRoster();
  }

  /** The replicated settings document, for `cluster status`. */
  replicationStatus(): ConfigReplicationStatus | null {
    return this.material ? (this.replication?.status() ?? null) : null;
  }

  /** The replicated settings document, for tests and for a snapshot on demand. */
  replicaDocument(): ConfigReplicaDocument | null {
    return this.replication?.replica ?? null;
  }

  /** Delete a setting across the group. */
  async announceConfigDelete(path: string, secret = false): Promise<void> {
    await this.runGroupWork(() => this.replication?.announceLocalDelete(path, secret));
  }

  /** Ask the group for the settings this machine should be running. */
  async requestConfigSnapshot(): Promise<void> {
    await this.runGroupWork(() => this.replication?.requestSnapshot());
  }

  /** Tell the group about a setting an operator just changed on this machine. */
  async announceConfigChange(path: string): Promise<void> {
    if (!isReplicatedConfigPath(path)) return;
    await this.runGroupWork(() => this.replication?.announceLocalChange(path));
  }

  /** Tell the group about a credential an operator just set on this machine. */
  async announceSecretChange(configPath: string): Promise<void> {
    await this.runGroupWork(() => this.replication?.announceLocalSecret(configPath));
  }

  /** Bind one replication operation to its original live membership. A shared
   * group-key envelope authenticates the group, not an independent per-node
   * signature; roster identity checks restrict the claimed sender accordingly.
   * Heartbeats/names are not membership generations and never invalidate it.
   */
  private captureConfigAuthority(envelope?: ClusterEnvelope): () => void {
    this.configChanges.assertStoresCurrent(this.options.config, this.options.secrets);
    const material = this.material, state = this.state, revision = this.membershipRevision;
    if (!material || !state || state.groupId !== material.groupId) throw new ClusterMembershipOperationError('abandoned');
    const groupId = material.groupId, node = material.node;
    const secrets = this.options.secrets, config = this.options.config;
    const master = this.options.isMaster?.() ?? false;
    const sender = envelope?.nodeId ?? this.options.nodeId, generation = envelope?.keyGen;
    const selectedKey = generation === undefined ? null : this.keyring().keyForGeneration(generation);
    const originalMembers = [...new Set([this.options.nodeId, sender])].map(nodeId => {
      const member = state.members.find(candidate => candidate.nodeId === nodeId);
      if (!member || !isCurrentMember(state, nodeId)) throw new ClusterMembershipOperationError('abandoned');
      return { nodeId, gen: member.gen, admittedAt: member.admittedAt,
        identityKey: member.identityKey, agreementKey: member.agreementKey };
    });
    const assertCurrent = () => {
      this.configChanges.assertStoresCurrent(this.options.config, this.options.secrets);
      if (this.runtimeStopping || this.membershipTransition || !this.membershipOperations.available
        || this.membershipRevision !== revision || this.material?.groupId !== groupId || this.material.node !== node
        || this.options.secrets !== secrets || this.options.config !== config || (this.options.isMaster?.() ?? false) !== master
        || this.state?.groupId !== groupId || (envelope && envelope.groupId !== groupId)) throw new ClusterMembershipOperationError('abandoned');
      if (generation !== undefined && (selectedKey === null || !this.keyring().acceptedGenerations().includes(generation)
        || this.keyring().keyForGeneration(generation) !== selectedKey)) throw new ClusterMembershipOperationError('abandoned');
      const current = this.state;
      for (const original of originalMembers) {
        const member = current.members.find(candidate => candidate.nodeId === original.nodeId);
        if (!member || !isCurrentMember(current, original.nodeId) || member.gen !== original.gen
          || member.admittedAt !== original.admittedAt || member.identityKey !== original.identityKey
          || member.agreementKey !== original.agreementKey
          || current.tombstones.some(tombstone => tombstone.nodeId === original.nodeId && tombstone.gen >= original.gen)) throw new ClusterMembershipOperationError('abandoned');
      }
      this.stateOwner.assertCurrent();
    };
    assertCurrent(); return assertCurrent;
  }

  /**
   * The secret store the replication layer may touch.
   *
   * Narrowed to the group's own store so a replicated credential is written
   * through this machine's SecretsManager, encrypted under this machine's own
   * keyfile, rather than stored as somebody else's ciphertext.
   */
  private replicatedSecrets(): ReplicatedSecretStore | null {
    return this.configChanges.secretStore();
  }

  private persistReplica(document: ConfigReplicaDocument): void {
    if (this.runtimeStopping || !this.membershipOperations.available || document.groupId !== this.material?.groupId) throw new ClusterMembershipOperationError('abandoned');
    this.stateOwner.write(GROUP_REPLICA_FILENAME, `${JSON.stringify(document, null, 2)}\n`, false);
  }

  /** Persist changed key material. */
  async commitMaterial(material: GroupKeyMaterial): Promise<void> {
    const expected = this.material, revision = this.membershipRevision;
    await this.enqueueMaterialWrite(async () => {
      if (!this.membershipOperations.available || this.membershipTransition || expected !== this.material || revision !== this.membershipRevision
        || material.groupId !== expected?.groupId) throw new ClusterMembershipOperationError('abandoned');
      try {
        await saveGroupKeyMaterial(this.options.secrets, material);
        this.material = material;
        if (this.runtimeStopping) this.keyringInstance = null;
      } catch { throw this.persistenceUnknown(); }
    });
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  private async sendGroupMessage(
    type: string,
    body: Record<string, unknown>,
    surfaceId: string | null = null,
    propagateFailure = false,
  ): Promise<void> {
    const router = this.router;
    if (!this.keyringInstance) return;
    try {
      await router.sendRaw(encodeEnvelope(
        {
          type,
          nodeId: this.options.nodeId,
          nodeVersion: this.options.version,
          seq: router.nextSeq(),
          ts: this.options.clock.now(),
          surfaceId,
          body,
        },
        this.keyringInstance,
      ));
    } catch (error) {
      this.options.logger.warn('cluster: a group message could not be sent', {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
      if (propagateFailure) throw error;
    }
  }

  /**
   * Advertise this group.
   *
   * Carries the group id, the group's name, how many machines are in it, and
   * this node's build, and NOTHING else. No surfaces, no configuration, no
   * hostname, no username, no key. It is readable by anything on the network,
   * which is exactly why the group name defaults to something neutral and its
   * setting says plainly that it is visible.
   *
   * A joining machine needs the scrypt salt too, and does NOT get it from here:
   * it derives it from the group id, which the beacon already carries. One
   * fewer thing on the wire for the same result.
   */
  private async sendBeacon(): Promise<void> {
    if (this.runtimeStopping || this.membershipTransition) return;
    const state = this.state;
    if (!this.material || !state) return;
    await this.sendGroupMessage(GROUP_MESSAGE_TYPES.beacon, {
      displayName: state.displayName,
      nodeCount: state.members.length,
    });
  }

  private async sendRoster(): Promise<void> {
    if (!this.state) return;
    // The replica revision rides along so a machine that missed a settings
    // change while it was unreachable notices it is behind and asks.
    await this.sendGroupMessage(GROUP_MESSAGE_TYPES.roster, {
      state: this.state,
      configRevision: this.replication?.replica.revision ?? 0,
    });
  }

  /**
   * Sweep bounded state, expire a pending admission, gossip, and rotate when
   * this node is the one that should.
   *
   * Everything periodic is here rather than on its own timer so there is one
   * place to look when something is or is not happening on a schedule.
   */
  runHousekeeping(): Promise<void> {
    if (this.runtimeStopping || this.membershipTransition || this.housekeeping) return Promise.resolve();
    this.housekeeping = true;
    const task = this.runGroupWork(() => this.housekeepingPass());
    void task.then(() => { this.housekeeping = false; }, () => { this.housekeeping = false; });
    return task;
  }

  private async housekeepingPass(): Promise<void> {
    const now = this.options.clock.now();
    this.admissions.expire(now, 'no machine in that group answered in time');
    for (const [groupId, entry] of this.discovered) {
      if (now - entry.lastSeenAt > 10 * 60 * 1_000) this.discovered.delete(groupId);
    }
    if (!this.material || !this.state) return;

    const swept = sweepGroupState(this.state, now);
    if (swept.droppedTombstones > 0) {
      this.options.logger.debug('cluster: expired old removal records', { dropped: swept.droppedTombstones });
      await this.commitState(swept.state, false);
    }
    const keySweep = sweepKeyHistory(this.material.keys, this.material.currentGeneration, now);
    if (keySweep.dropped > 0) {
      await this.commitMaterial({ ...this.material, keys: keySweep.keys });
    }
    if (now - this.lastRotationCheckAt >= this.options.settings.rosterGossipSeconds * 1_000) {
      this.lastRotationCheckAt = now;
      await this.sendRoster();
    }
    await this.rotateIfDue(now);
    this.configChanges.refresh();
    await this.replication?.retryPendingEffects();
    this.replication?.sweep(now);
    await this.replication?.reconcileLocalConfig();
    // A machine that has joined but holds nothing yet keeps asking until the
    // master answers. Stops the instant anything arrives.
    if (this.replication?.needsSnapshot) await this.replication.requestSnapshot();
  }

  // ── rotation ──────────────────────────────────────────────────────────────

  /**
   * Which member mints the next rotation.
   *
   * The smallest node id among members heard from recently. A pure function of
   * replicated state, so every member reaches the same answer without any
   * negotiation, and if that machine is off the next one takes over by itself.
   *
   * If two of them mint at once, which a partition can cause, the tie is
   * broken by `preferredKeyRecord`, not by whoever shouted first.
   */
  private isRotationMinter(now: number): boolean {
    const state = this.state;
    if (!state || state.members.length === 0) return true;
    const aliveCutoff = now - Math.max(3 * this.options.settings.beaconSeconds * 1_000, 60_000);
    const candidates = state.members
      .filter((member) => member.lastSeenAt >= aliveCutoff || member.nodeId === this.options.nodeId)
      .map((member) => member.nodeId)
      .sort();
    return candidates[0] === this.options.nodeId;
  }

  private async rotateIfDue(now: number): Promise<void> {
    const material = this.material;
    if (!material) return;
    const current = material.keys.find((entry) => entry.generation === material.currentGeneration);
    if (!current) return;
    if (now - current.createdAt < keyRotationMs(this.options.settings)) return;
    if (!this.isRotationMinter(now)) return;
    await this.rotate('scheduled', 'the group key reached its rotation interval');
  }

  /**
   * Replace the group key.
   *
   * The announcement is signed with the OUTGOING generation, because that is
   * the only key the recipients currently accept, announcing under the new key
   * would be a message nobody could read. Only after it is on the wire does
   * this node move itself forward.
   *
   * `revocation` differs in exactly one way, and it is the important one: the
   * acceptance window is not opened, on this node or on any node that adopts
   * the announcement. The machine that was just removed still holds the old
   * key, and the whole point of rotating on removal is that holding it stops
   * being enough.
   */
  async rotate(cause: 'scheduled' | 'revocation', reason: string): Promise<GroupKeyMaterial> {
    const material = this.requireMaterial();
    const now = this.options.clock.now();
    const graceMs = cause === 'scheduled' ? keyRotationGraceMs(this.options.settings) : 0;
    const rotated = rotateGroupKeyMaterial(material, cause, this.options.nodeId, now, graceMs);
    const record = rotated.keys.find((entry) => entry.generation === rotated.currentGeneration);
    if (!record) throw new Error('cluster: the rotation produced no key');

    const wraps: Record<string, unknown> = {};
    for (const member of this.state?.members ?? []) {
      if (member.nodeId === this.options.nodeId) continue;
      wraps[member.nodeId] = sealForMember(
        member.agreementKey,
        JSON.stringify({ key: record.key }),
        REKEY_SEAL_CONTEXT,
      );
    }
    await this.sendGroupMessage(GROUP_MESSAGE_TYPES.rekey, {
      cause,
      generation: record.generation,
      createdAt: record.createdAt,
      mintedBy: record.mintedBy,
      wraps,
    });

    await this.commitMaterial(rotated);
    // A removal also replaced the key the group signs with; publish its public
    // half so every remaining member, and every member that joins later, can
    // check a reply that claims to come from the group.
    if (cause === 'revocation' && this.state) {
      await this.commitState(withGroupSigningKey(this.state, {
        publicKey: rotated.groupSigning.publicKey,
        generation: rotated.groupSigning.generation,
      }), true);
    }
    this.options.logger.info('cluster: the group key was replaced', {
      generation: record.generation,
      cause,
      reason,
      members: this.state?.members.length ?? 0,
    });
    return rotated;
  }

  // ── inbound: group-key-signed ─────────────────────────────────────────────

  private onGroupMessage(envelope: ClusterEnvelope): void {
    if (this.runtimeStopping || this.membershipTransition || !this.membershipOperations.available) return;
    this.incoming.admit(() => this.runGroupWork(() => this.handleGroupMessage(envelope)));
  }

  private async handleGroupMessage(envelope: ClusterEnvelope): Promise<void> {
    if (envelope.groupId !== this.material?.groupId) return;
    switch (envelope.type) {
      case GROUP_MESSAGE_TYPES.beacon:
        await this.onBeacon(envelope);
        return;
      case GROUP_MESSAGE_TYPES.roster:
        await this.onRoster(envelope);
        return;
      case GROUP_MESSAGE_TYPES.rekey:
        await this.onRekey(envelope);
        return;
      case CONFIG_MESSAGE_TYPES.snapshot:
      case CONFIG_MESSAGE_TYPES.delta:
      case CONFIG_MESSAGE_TYPES.propose:
      case CONFIG_MESSAGE_TYPES.request:
        await this.replication?.handle(envelope);
        return;
      default:
        this.options.logger.debug('cluster: ignored an unrecognised group message', { type: envelope.type });
    }
  }

  private async onBeacon(envelope: ClusterEnvelope): Promise<void> {
    if (!this.state) return;
    const touched = touchMember(this.state, envelope.nodeId, this.options.clock.now());
    if (touched !== this.state) await this.commitState(touched, false);
  }

  private async onRoster(envelope: ClusterEnvelope): Promise<void> {
    const local = this.state;
    if (!local) return;
    const remote = readGroupStateDocument(envelope.body['state']);
    if (!remote) {
      this.options.logger.debug('cluster: a roster message did not parse and was ignored');
      return;
    }
    const peerRevision = envelope.body['configRevision'];
    if (typeof peerRevision === 'number') await this.replication?.notePeerRevision(peerRevision);
    const merged = touchMember(mergeGroupState(local, remote), envelope.nodeId, this.options.clock.now());
    if (JSON.stringify(merged) === JSON.stringify(local)) return;
    await this.commitState(merged, false);
  }

  /**
   * Adopt a rotation announced by another member.
   *
   * The envelope already verified under a group key this node holds, so the
   * sender is a member. What is still checked here: that a wrap addressed to
   * THIS node is present and opens. A rotation with no wrap for this node is a
   * rotation this node was not included in, which is what a removed machine
   * sees, and it is right that it cannot follow.
   */
  private async onRekey(envelope: ClusterEnvelope): Promise<void> {
    const material = this.material;
    if (!material) return;
    // Our own announcement, arriving back through loopback. It deliberately
    // carries no wrap for this machine, we already hold the key we minted,
    // so without this the minting node warns that it was left out of its own
    // rotation, which is both wrong and alarming.
    if (envelope.nodeId === this.options.nodeId) return;
    const wraps = envelope.body['wraps'];
    if (typeof wraps !== 'object' || wraps === null) return;
    const wrap = (wraps as Record<string, unknown>)[this.options.nodeId];
    if (!wrap) {
      this.options.logger.warn('cluster: a group key rotation did not include this machine', {
        generation: envelope.body['generation'],
        action: 'this machine may have been removed from the group; check `cluster status`',
      });
      return;
    }
    const opened = openSealedEnvelope(
      material.node.agreement,
      wrap as Parameters<typeof openSealedEnvelope>[1],
      REKEY_SEAL_CONTEXT,
    );
    if (!opened) {
      this.options.logger.warn('cluster: a group key rotation could not be opened by this machine');
      return;
    }
    let key: unknown;
    try {
      key = (JSON.parse(opened) as Record<string, unknown>)['key'];
    } catch {
      return;
    }
    const record = readKeyRecord({
      generation: envelope.body['generation'],
      createdAt: envelope.body['createdAt'],
      mintedBy: envelope.body['mintedBy'],
      key,
    });
    if (!record) return;
    const cause = envelope.body['cause'] === 'revocation' ? 'revocation' : 'scheduled';
    const graceMs = cause === 'scheduled' ? keyRotationGraceMs(this.options.settings) : 0;
    await this.commitMaterial(adoptGroupKeys(
      material,
      [record],
      record.generation,
      this.options.clock.now(),
      graceMs,
    ));
    this.options.logger.info('cluster: adopted a replacement group key', {
      generation: record.generation,
      cause,
    });
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  /**
   * Note a group seen on the network.
   *
   * The salt is kept alongside because a machine cannot even attempt a join
   * until it can derive the verifier, and the salt is public by construction.
   * Nothing here is authenticated and nothing here causes this node to act, it
   * populates a list the operator chooses from and that is all.
   */
  private recordDiscoveredGroup(groupId: string, body: Record<string, unknown>, version: string): void {
    const displayName = typeof body['displayName'] === 'string' ? body['displayName'] : DEFAULT_GROUP_DISPLAY_NAME;
    const nodeCount = typeof body['nodeCount'] === 'number' && Number.isFinite(body['nodeCount'])
      ? Math.max(0, Math.trunc(body['nodeCount']))
      : 0;
    this.discovered.set(groupId, {
      groupId,
      displayName,
      nodeCount,
      version,
      lastSeenAt: this.options.clock.now(),
    });
  }

  /** Every key generation this node holds, for the status report. */
  heldGenerations(): readonly number[] {
    return (this.material?.keys ?? []).map((entry) => entry.generation).sort((a, b) => b - a);
  }

  /** The keys this node would hand a joiner, swept to the current bounds. */
  grantableKeys(now: number): readonly GroupKeyRecord[] {
    const material = this.material;
    if (!material) return [];
    return sweepKeyHistory(material.keys, material.currentGeneration, now).keys;
  }
}
