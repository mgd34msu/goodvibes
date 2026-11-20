/**
 * group-runtime.ts, the live group: beacons, gossip, admissions, rotation.
 *
 * One instance per daemon. It owns the datagram socket, holds the keyring every
 * outbound datagram is signed with, and is the only thing in the system that
 * writes group key material.
 *
 * Who is in the group and which key generations exist are entries of the
 * authority record (authority-record.ts); this runtime writes them there and
 * reads them back, and the record's carriage (authority-sync.ts) takes them,
 * with each generation's secrets sealed to every current member, to the rest
 * of the group. A rotation, a removal, an admission and a rename are each one
 * record write. Which generations this machine accepts is computed from the
 * record and the keys it holds (`computeKeyAcceptance`), never stored.
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
import { join } from 'node:path';
import {
  deriveJoinVerifier,
  generateGroupKey,
  generateGroupSigningKeyPair,
  generateJoinKey,
  isValidGroupId,
  signWithIdentity,
  verifyWithIdentity,
} from './group-crypto.js';
import { tenantSigningBytes, type GroupTenant, type GroupTenantHost } from './group-tenants.js';
import { summarizeError } from '../utils/error-display.js';
import { GROUP_MESSAGE_TYPES, joinKeyFingerprint } from './group-membership.js';
import {
  keyRotationGraceMs,
  keyRotationMs,
  type ClusterGroupSettings,
} from './group-settings.js';
import {
  DEFAULT_GROUP_DISPLAY_NAME,
  findTombstone,
  groupStateFromRecord,
  isCurrentMember,
  isGroupEntry,
  keyEpochEntryId,
  originAdmission,
  originBindingHolds,
  keyEpochsFromRecord,
  MAX_GROUP_MEMBERS,
  memberEntryId,
  nextMembershipGeneration,
  normalizeDisplayName,
  type GroupStateDocument,
} from './group-state.js';
import {
  computeKeyAcceptance,
  GroupKeyring,
  keyCommitment,
  observeGroupKeyMaterial,
  loadReplicaDocument,
  loadHeldConfigChanges,
  saveGroupKeyMaterial,
  clearGroupKeyMaterial,
  readGroupKeyMaterial,
  withGroupKey,
  GROUP_MATERIAL_SECRET_KEY,
  GROUP_REPLICA_FILENAME,
  GROUP_HELD_CONFIG_FILENAME,
  GROUP_REMOVAL_FILENAME,
  loadGroupRemovalNote,
  sweepKeyHistory,
  type GroupRemovalNote,
  type ClusterSecretStore,
  type GroupKeyMaterial,
  type GroupKeyRecord,
  type GroupSigningMaterial,
  type KeyAcceptance,
  type KeyEpochFacts,
} from './group-store.js';
import { openAuthorityRecordFile, type AuthorityRecordFile, type AuthorityChange, type AuthorityDroppedReport } from './authority-record-file.js';
import { AuthoritySync, type EpochSecrets } from './authority-sync.js';
import { authorityKey, type AnyAuthorityEntry, type AuthorityDraft, type AuthorityHead, type AuthorityKey, type AuthorityView } from './authority-record.js';
import { GroupWireRouter } from './group-transport.js';
import {
  CONFIG_MESSAGE_TYPES,
  ConfigLocalDifferenceError,
  ConfigReplicationService,
  readHeldConfigChanges,
  type ConfigReplicationStatus,
  type HeldConfigChange,
  type ReplicatedConfigStore,
  type ReplicatedSecretStore,
} from './config-replication.js';
import {
  createConfigReplicaDocument,
  readConfigReplicaDocument,
  type ConfigReplicaDocument,
} from './config-replica.js';
import { isReplicatedConfigPath } from './config-replication-policy.js';
import { encodeEnvelope, isWireSurfaceId, type ClusterEnvelope, type ClusterKeyring } from './protocol-envelope.js';
import type { ClusterClock, ClusterElectionTiming, ClusterLogger, ClusterSurfaceHolding, ClusterTransport } from './types.js';

/** How often the housekeeping timer runs: rotation checks, sweeps, gossip. */
const HOUSEKEEPING_INTERVAL_MS = 30_000;

/** Foreign groups remembered at once. Beacons are unauthenticated, so the list must not grow with them. */
const MAX_DISCOVERED_GROUPS = 32;


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
   * The election timing in force on this machine, from the settings the
   * election runs with. Absent means `cluster status` reports it as not
   * available rather than showing the stored values as though they ran.
   */
  readonly electionTiming?: (() => ClusterElectionTiming) | undefined;
  /** The config this machine reads and writes. Absent disables replication. */
  readonly config?: ReplicatedConfigStore | undefined;
  /**
   * The authority record this daemon home answers credentials from. Group
   * membership and key generations are entries of it. Absent (an embedder
   * or a test that passes none): a record of the group layer's own, in the
   * cluster state directory.
   */
  readonly authorityRecord?: AuthorityRecordFile | undefined;
  /**
   * The record says the group removed this machine (another member wrote its
   * revocation). The composition root drops the membership and reports it;
   * called again on later passes until it has.
   */
  readonly onRemovedFromGroup?: (() => void) | undefined;
}

/** How a membership is put into the authority record when it is adopted. */
export type MembershipRecordStep =
  /** A group created here: its first entries, written by this machine. */
  | { readonly kind: 'issue'; readonly drafts: readonly AuthorityDraft[] }
  /** A group joined or re-entered: the entries a member granted, merged in. */
  | { readonly kind: 'absorb'; readonly entries: readonly AnyAuthorityEntry[] };

/** What one rotation produced. */
export interface RotationResult {
  readonly generation: number;
}

/**
 * A removal's replacement join key, minted before the removal is recorded, and
 * the fingerprint of the join key the removed machine still holds.
 */
export interface RevocationPlan {
  readonly join: { readonly joinKey: string; readonly joinVerifier: string };
  /** Recorded on the removal record: a join with this key never re-admits the removed machine. */
  readonly removedUnder: string;
}

/** Membership as `cluster status` reports it. */
export type GroupMembershipState = 'no-group' | 'member' | 'unreadable-key-material';

/**
 * A key material write was refused and the store still holds the previous
 * material, so this machine keeps using it. The write is tried again by the
 * work that wanted it (the next housekeeping pass, the next rotation check, a
 * resent announcement); the cause is logged once when the failures start.
 */
export class GroupKeyNotSavedError extends Error {
  override readonly name = 'GroupKeyNotSavedError';
  constructor(cause: string) {
    super(`the group key could not be saved (${cause}); this machine keeps using the key it already holds`);
  }
}

export class ClusterGroupRuntime {
  private material: GroupKeyMaterial | null = null;
  /** The roster this machine's group entries describe, rebuilt on every record or membership change. */
  private state: GroupStateDocument | null = null;
  /** The group's key generations on the record, rebuilt with the roster. */
  private epochs: ReadonlyMap<number, KeyEpochFacts> = new Map();
  /** Which generations this machine signs with and accepts, rebuilt with the roster. */
  private acceptance: KeyAcceptance | null = null;
  private readonly record: AuthorityRecordFile;
  private readonly sync: AuthoritySync;
  /** Key generations being taken from the group, one at a time. */
  private installQueue: Promise<void> = Promise.resolve();
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
  /** Authority-record exchanges started from a datagram or a step; stop() resolves after the last one ends. */
  private readonly syncWork = new Set<Promise<void>>();
  private membershipTransition = false;
  private replication: ConfigReplicationService | null = null;
  private readonly configChanges: GroupConfigChanges;
  private readonly incoming: ClusterIngressWork;
  /**
   * When each member was last heard, by this process. Kept in memory: writing
   * it into the roster rewrote the roster file on every beacon.
   */
  private readonly lastHeard = new Map<string, number>();
  /** Group tenants by the message type they own (group-tenants.ts). */
  readonly #tenants = new Map<string, GroupTenant>();
  readonly #memberHeardListeners = new Set<(nodeId: string) => void>();
  /** When this process started listening to the group, or null before it has. */
  private listeningSince: number | null = null;
  /** A key material write is failing; its cause has been logged. */
  private materialWriteFailing = false;
  /** The group that removed this machine, while it is in no group; see GROUP_REMOVAL_FILENAME. */
  private removal: GroupRemovalNote | null = null;

  constructor(private readonly options: ClusterGroupRuntimeOptions) {
    this.incoming = new ClusterIngressWork(options.logger, () => options.clock.monotonicNow());
    // The record first: a record of the group layer's own (no daemon home
    // record passed) creates the state directory, which the owner below then
    // finds rather than seeing it appear behind its back.
    const recordPath = join(options.stateDirectory, 'authority-record.json');
    this.record = options.authorityRecord ?? openAuthorityRecordFile(recordPath, () => options.settings);
    this.stateOwner = new GroupStateOwner(options.stateDirectory, [GROUP_REPLICA_FILENAME, GROUP_HELD_CONFIG_FILENAME, GROUP_REMOVAL_FILENAME]);
    // Every change of the record (written here, merged from the group, or
    // written by another process of this home) rebuilds the roster and the
    // accepted generations before the next datagram is checked.
    this.record.onChange(() => this.refreshFromRecord());
    this.sync = new AuthoritySync({
      nodeId: options.nodeId,
      version: options.version,
      file: this.record,
      logger: options.logger,
      now: () => options.clock.now(),
      membership: () => (this.material ? { groupId: this.material.groupId, node: this.material.node } : null),
      roster: () => this.state,
      send: (raw) => this.sendOutOfBand(raw),
      nextSeq: () => this.router.nextSeq(),
      epochSecrets: (epochs) => this.epochSecrets(epochs),
      installEpochs: (secrets) => this.installEpochs(secrets),
      // Rule 7 per entry: an origin bound to a removed member writes nothing after its removal.
      mergeOptions: () => (this.material ? { admit: originAdmission(this.material.groupId) } : {}),
    });
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
      onOutOfBandMessage: (raw, type) => {
        // The authority record's carriage; everything else out of band is admission.
        if (type.startsWith('AUTH_')) {
          if (this.networkStarted && !this.runtimeStopping && !this.membershipTransition) {
            this.trackSync(this.sync.handle(raw, type), 'cluster: an authority record message was not taken');
          }
          return;
        }
        void this.admissions.handle(raw, type);
      },
      onForeignBeacon: (groupId, body, version) => this.recordDiscoveredGroup(groupId, body, version),
      // A signature that did not verify is only worth asking about when the
      // claimed sender is a member (another minter's key for a generation);
      // anything else on the network can produce one.
      onGenerationNotHeld: (_generation, fromNodeId, cause) => {
        if (cause === 'generation' || (fromNodeId !== null && this.state !== null && isCurrentMember(this.state, fromNodeId))) this.catchUp(fromNodeId);
      },
      membership: () => this.membership,
    });
    this.configChanges = new GroupConfigChanges({
      config: options.config, secrets: options.secrets, logger: options.logger,
      owner: () => {
        const member = this.state?.members.find(candidate => candidate.nodeId === options.nodeId);
        if (!this.networkStarted || this.runtimeStopping || this.membershipTransition || !this.membershipOperations.available
          || !this.material || !this.state || !member || !isCurrentMember(this.state, options.nodeId)) return null;
        // Seeding this machine's credentials waits until its copy holds the group's settings.
        return { revision: this.membershipRevision, generation: member.gen, master: this.replication?.inStep ?? false };
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
      groupState: () => this.state,
      answersFor: asker => this.designatedMember(options.clock.now(), asker) === options.nodeId,
      captureAuthority: envelope => this.captureConfigAuthority(envelope),
      nodeKeys: () => this.material?.node ?? null,
      config: () => observedConfig ?? null,
      secrets: () => this.replicatedSecrets(),
      send: (type, body) => this.sendGroupMessage(type, body, null, true),
      persist: (document) => this.persistReplica(document),
      persistHeld: (groupId, held) => this.persistHeldConfig(groupId, held),
    }, '');
    this.admissions = new GroupAdmissionService({
      nodeId: options.nodeId,
      version: options.version,
      nodeDisplayName: options.nodeDisplayName,
      clock: options.clock,
      logger: options.logger,
      material: () => this.material,
      state: () => this.state,
      send: (raw) => this.router.sendRaw(raw),
      nextSeq: () => this.router.nextSeq(),
      answersJoinFrom: joiner => this.designatedMember(options.clock.now(), joiner) === options.nodeId,
      currentGeneration: () => this.acceptance?.current ?? 0,
      recordAdmission: (input, mode) => this.recordAdmission(input, mode),
      grantContents: () => this.grantContents(),
      authorityOrigin: () => this.record.nodeId,
      onBehind: from => this.catchUp(from),
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
    this.replication?.retireSnapshotTransfers();
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
      await this.drainSyncWork();
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
    this.listeningSince = this.options.clock.now();
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
    // Also the cleanup of a start that failed after opening the network, which
    // runs without stop() and must not leave the group believed to be online.
    this.networkStarted = false;
    this.listeningSince = null;
    this.lastHeard.clear();
    this.incoming.close();
    await this.incoming.join();
    this.configChanges.stop();
    await this.configChanges.join();
    this.admissions.stop('the daemon shut down before the group answered');
    await this.admissions.join();
    await this.drainGroupWork();
    await this.drainSyncWork();
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

  /**
   * Ask the group to take this machine back and re-key it. `atLeast` is the
   * newest key generation this machine has seen the group use: a grant below
   * it is taken only when nothing better arrives before the deadline.
   */
  requestRejoin(timeoutMs: number, atLeast = 0): Promise<AdmissionOutcome> {
    return this.admissions.requestRejoin(timeoutMs, atLeast);
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

  /** When this process last heard `nodeId` over the group, or null if it has not since it started listening. */
  lastHeardFrom(nodeId: string): number | null {
    return this.lastHeard.get(nodeId) ?? null;
  }

  /** When this process started listening to the group, or null when it is not on the network. */
  get listeningStartedAt(): number | null {
    return this.listeningSince;
  }

  get wireCounters(): GroupWireRouter['counters'] {
    return this.router.counters;
  }

  groupsOnTheNetwork(): readonly DiscoveredGroup[] {
    return [...this.discovered.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  electionTiming(): ClusterElectionTiming | null {
    return this.options.electionTiming?.() ?? null;
  }

  surfaceHoldings(): readonly SurfaceHolding[] | null {
    const provider = this.options.surfaceHoldings;
    if (!provider) return null;
    return provider().map((holding) => {
      const captured = { ...holding };
      if (!isWireSurfaceId(captured.surfaceId)) throw new Error('Cluster holdings must use an already-derived surface ID');
      return captured;
    });
  }

  // ── material ──────────────────────────────────────────────────────────────

  /** Re-read key material and roster from their stores. */
  async reloadMaterial(signal?: AbortSignal, quiet = false): Promise<void> {
    if (this.membershipOperations.busy || this.materialWork.size > 0 || this.groupWork.size > 0 || this.incoming.status.active > 0) throw new ClusterMembershipOperationError('not-sent');
    this.stateOwner.assertCurrent();
    const revision = this.membershipRevision;
    const observation = await observeGroupKeyMaterial(this.options.secrets, quiet ? undefined : this.options.logger);
    signal?.throwIfAborted();
    this.stateOwner.assertCurrent();
    if (this.runtimeStopping || revision !== this.membershipRevision || this.membershipOperations.busy || this.materialWork.size > 0 || this.groupWork.size > 0 || this.incoming.status.active > 0) throw new ClusterMembershipOperationError('abandoned');
    const material = observation.material;
    const savedReplica = material ? loadReplicaDocument(this.options.stateDirectory, value => readConfigReplicaDocument(value, isReplicatedConfigPath), this.options.logger) : null;
    this.stateOwner.assertCurrent();
    signal?.throwIfAborted();
    if (this.runtimeStopping || revision !== this.membershipRevision || this.membershipOperations.busy || this.materialWork.size > 0 || this.groupWork.size > 0 || this.incoming.status.active > 0) throw new ClusterMembershipOperationError('abandoned');
    this.admissions.abandon('the stored membership was reloaded');
    this.unreadableMaterial = observation.unreadable;
    this.material = material; this.membershipRevision += 1;
    this.refreshFromRecord();
    this.removal = material ? null : loadGroupRemovalNote(this.options.stateDirectory);
    this.keyringInstance = material ? this.newKeyring() : null;
    if (observation.unreadable) this.membershipOperations.markUnknown();
    else {
      this.membershipOperations.reconciled();
      if (this.networkStarted) this.admissions.start();
    }
    // A previous membership's replica is not current-group authority. Keep its
    // original file intact; only a real current-group write replaces that slot.
    if (material && this.replication) this.replication.adopt(savedReplica?.groupId === material.groupId
      ? savedReplica : createConfigReplicaDocument(material.groupId),
      readHeldConfigChanges(loadHeldConfigChanges(this.options.stateDirectory, material.groupId, this.options.logger)));
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

  /** Keep an authority-record exchange where stop() can wait for it; its failure is only a debug line, as before. */
  private trackSync(work: Promise<unknown>, failure: string): void {
    const task = work.then(() => {}, (error: unknown) => this.options.logger.debug(failure, { error: summarizeError(error) }));
    this.syncWork.add(task);
    void task.then(() => { this.syncWork.delete(task); });
  }

  private async drainSyncWork(): Promise<void> {
    while (this.syncWork.size > 0) await Promise.allSettled([...this.syncWork]);
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
      if (!(error instanceof ClusterMembershipOperationError) && !(error instanceof GroupConfigChangeRetiredError)
        && !(error instanceof ConfigReplicationPrivacyError) && !(error instanceof GroupKeyNotSavedError)
        && !(error instanceof ConfigLocalDifferenceError)) {
        this.options.logger.warn('cluster: owned group work failed', { error: summarizeError(error) });
      }
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
    this.replication?.retireSnapshotTransfers();
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
    this.replication?.retireSnapshotTransfers();
    this.admissions.stop('group membership persistence could not be confirmed');
    this.material = null; this.keyringInstance = null;
    this.refreshFromRecord();
    this.unreadableMaterial = true;
    this.membershipRevision += 1;
    return new ClusterMembershipOperationError('persistence-unknown');
  }

  private requireMaterial(): GroupKeyMaterial {
    if (!this.material) throw new Error('cluster: this machine is not in a group');
    return this.material;
  }

  private newKeyring(): GroupKeyring {
    return new GroupKeyring(() => {
      const material = this.requireMaterial();
      if (!this.acceptance) this.refreshFromRecord();
      return { material, acceptance: this.acceptance! };
    }, () => this.options.clock.now());
  }

  /**
   * Rebuild the roster, the key generations and the accepted generations from
   * the record and the material held. Called on every change of either; a
   * datagram then costs no file read. When the record now says the group
   * removed this machine, the composition root is told.
   */
  private refreshFromRecord(): void {
    const material = this.material;
    if (!material) {
      this.state = null; this.epochs = new Map(); this.acceptance = null;
      return;
    }
    const view = this.record.view();
    // An unreadable record keeps the last roster read: it is the one this
    // machine checked members against, and nothing is written over the file.
    if (view) {
      this.state = groupStateFromRecord(view.record, material.groupId);
      this.epochs = keyEpochsFromRecord(view.record, material.groupId);
    } else if (!this.state || this.state.groupId !== material.groupId) {
      this.state = null; this.epochs = new Map();
    }
    this.acceptance = computeKeyAcceptance(material, this.epochs, keyRotationGraceMs(this.options.settings));
    if (this.state && findTombstone(this.state, this.options.nodeId)) this.options.onRemovedFromGroup?.();
  }

  /**
   * Install acknowledged material and put its membership into the record.
   *
   * The record first: entries of a group this machine then fails to save keys
   * for are inert (nothing reads a group's entries without its keys), while
   * keys saved for a group the record does not list would leave a member with
   * no roster.
   */
  adoptMembership(material: GroupKeyMaterial, step: MembershipRecordStep, owner?: ClusterMembershipOperation): Promise<void> {
    return this.membershipOperations.run(async (lease) => {
      try {
        await this.beginMembershipTransition(lease);
        const revision = this.membershipRevision, expected = this.material;
        await this.enqueueMaterialWrite(async () => {
          this.membershipOperations.assert(lease);
          if (revision !== this.membershipRevision || expected !== this.material) throw new ClusterMembershipOperationError('abandoned');
          try { this.stateOwner.ensure(); } catch { throw new ClusterMembershipOperationError('abandoned'); }
          await this.record.rescope({ groupId: material.groupId });
          if (step.kind === 'issue') {
            await this.record.write(() => ({ kind: 'issue', entries: step.drafts, value: null }));
            // A group created here: this record IS the group's, so its changes go out at once.
            await this.record.noteSynced(material.groupId);
          }
          else await this.record.absorb({ version: 1, scope: { groupId: material.groupId }, revision: 0, revocationFloor: 0, compacted: {}, entries: new Map(step.entries.map((entry) => [authorityKey(entry.kind, entry.id), entry])) }, { partial: true });
          this.membershipOperations.assert(lease);
          try {
            await saveGroupKeyMaterial(this.options.secrets, material);
            // Cancellation cannot abandon half of an acknowledged publication.
            // Stop still owns/drains this exact operation and its original store.
            this.membershipOperations.assert(lease, true);
            if (this.replication && this.replication.replica.groupId !== material.groupId) this.replication.adopt(createConfigReplicaDocument(material.groupId));
            this.material = material; this.unreadableMaterial = false;
            this.membershipRevision += 1;
            this.refreshFromRecord();
            this.keyringInstance = this.runtimeStopping ? null : this.newKeyring();
          } catch { throw this.persistenceUnknown(); }
          if (this.removal) this.recordRemoval(null);
        });
        // Joined: the grant carried the group's own entries, not its whole
        // record. Ask for that now, so this machine is in step with the group
        // (and its own changes go out) within a round trip, not on the next
        // housekeeping pass.
        if (step.kind === 'absorb') this.trackSync(this.sync.pullAll(), 'cluster: the group\'s record could not be asked for after joining');
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
    this.material = null; this.keyringInstance = null; this.unreadableMaterial = false;
    this.refreshFromRecord();
    this.lastHeard.clear();
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

  /** This daemon home's record id: the origin of every entry it writes, bound into its membership (rule 7). */
  get authorityOrigin(): string {
    return this.record.nodeId;
  }

  /** The authority record's carriage: which members' records differ from this one (authority.status reads it). */
  get authority(): AuthoritySync {
    return this.sync;
  }

  /** The authority record's head here and which members' records differ, for `cluster status`. */
  authorityStatus(): { readonly revision: number; readonly digest: string; readonly behind: boolean; readonly behindOn: readonly string[]; readonly userConflicts: readonly string[]; readonly droppedOnReturn: AuthorityDroppedReport | null } | null {
    const head = this.sync.head();
    if (!head) return null;
    // Owner decision D2: a username made separately on two machines is reported, never overwritten.
    const userConflicts = this.record.view()?.userConflicts().map((conflict) => conflict.username) ?? [];
    // What this machine dropped when it came back after longer than the retention.
    return { ...head, ...this.sync.divergence(), userConflicts, droppedOnReturn: this.record.droppedReport() };
  }

  /**
   * Ask the group for its record and the current key generation's secrets:
   * on start, after joining, and when a datagram showed this machine is
   * behind. Identity-signed, so it works however many generations behind.
   */
  catchUp(fromNodeId: string | null = null): void {
    if (!this.networkStarted || this.runtimeStopping || !this.material) return;
    this.trackSync(this.sync.catchUp(fromNodeId), 'cluster: a request for the group\'s record could not be sent');
  }

  /** Send an out-of-band datagram the caller built and signed (the authority carriage). */
  sendOutOfBand(raw: string): Promise<void> {
    if (!this.networkStarted || this.runtimeStopping) return Promise.resolve();
    return this.router.sendRaw(raw);
  }

  /** Next per-node sequence number, shared with every other sender on this socket. */
  nextSeq(): number {
    return this.router.nextSeq();
  }

  /** The group that removed this machine, while it is in no group. */
  get removedFrom(): GroupRemovalNote | null {
    return this.material ? null : this.removal;
  }

  /**
   * Record that a member told this machine the group removed it. Called after
   * the membership was dropped, so `cluster status` says why it is in no group.
   */
  noteRemovedFromGroup(note: GroupRemovalNote): void {
    this.recordRemoval(note);
    this.options.logger.error('cluster: this machine was removed from its group by another member and no longer holds its keys', {
      groupId: note.groupId,
      action: 'to put it back, run `cluster key` on a machine in the group, then `cluster join` here with that key',
    });
  }

  private recordRemoval(note: GroupRemovalNote | null): void {
    this.removal = note;
    try { this.stateOwner.write(GROUP_REMOVAL_FILENAME, `${JSON.stringify({ version: 1, removed: note }, null, 2)}\n`, false); }
    catch (error) { this.options.logger.warn('cluster: the record of this machine\'s removal could not be saved', { error: summarizeError(error) }); }
  }

  /**
   * One write of this group's entries in the record. The record's carriage
   * sends it to every member at once, and again until each has it.
   */
  private async writeGroupRecord<T>(change: (state: GroupStateDocument, groupId: string, view: AuthorityView) => AuthorityChange<T>): Promise<T> {
    const groupId = this.material?.groupId;
    if (!groupId || !this.membershipOperations.available || this.membershipTransition) throw new ClusterMembershipOperationError('abandoned');
    const result = await this.record.write((view) => change(groupStateFromRecord(view.record, groupId), groupId, view));
    if (this.material?.groupId !== groupId) throw new ClusterMembershipOperationError('abandoned');
    return result.value;
  }

  /**
   * Record an admission. A join is a new incarnation of the node at a
   * membership generation above every one held (a machine put back after a
   * removal included; its live older incarnation, if any, is retired in the
   * same write). A returning member whose agreement key or name changed is
   * updated in place: its incarnation, and so its membership, does not move.
   */
  recordAdmission(
    input: { readonly nodeId: string; readonly displayName: string; readonly identityKey: string; readonly agreementKey: string;
      readonly authorityOrigin?: string | undefined; readonly originProof?: string | undefined },
    mode: 'join' | 'refresh',
  ): Promise<{ readonly state: GroupStateDocument } | { readonly refused: 'group-is-full' | 'not-on-the-roster' }> {
    const now = this.options.clock.now();
    return this.writeGroupRecord<{ readonly refused: 'group-is-full' | 'not-on-the-roster' } | null>((state, groupId) => {
      const live = state.members.find((member) => member.nodeId === input.nodeId);
      const displayName = normalizeDisplayName(input.displayName, input.nodeId.slice(0, 8));
      if (mode === 'refresh') {
        if (!live) return { kind: 'none', value: { refused: 'not-on-the-roster' as const } };
        return { kind: 'update', key: authorityKey('member', memberEntryId(groupId, live.nodeId, live.gen)),
          patch: { agreementKey: input.agreementKey, displayName }, narrowsOrWidens: false, value: null };
      }
      if (!live && state.members.length >= MAX_GROUP_MEMBERS) return { kind: 'none', value: { refused: 'group-is-full' as const } };
      const gen = nextMembershipGeneration(state, input.nodeId);
      // The joiner's record id, bound by its own identity key: entries it
      // writes are then checked against its membership (rule 7).
      const bound = input.authorityOrigin && input.originProof
        && originBindingHolds(input.identityKey, groupId, input.nodeId, input.authorityOrigin, input.originProof)
        ? { authorityOrigin: input.authorityOrigin, originProof: input.originProof } : {};
      const changes: AuthorityChange<unknown>[] = [{ kind: 'issue', value: null, entries: [{
        kind: 'member', id: memberEntryId(groupId, input.nodeId, gen),
        public: { nodeId: input.nodeId, gen, displayName, identityKey: input.identityKey, agreementKey: input.agreementKey, admittedAt: Math.trunc(now), ...bound },
      }] }];
      if (live) changes.push({ kind: 'revoke', key: authorityKey('member', memberEntryId(groupId, live.nodeId, live.gen)), by: this.options.nodeId, reason: 'joined again with new keys', value: null });
      return { kind: 'many', changes, value: null };
    }).then((value) => value ?? { state: this.state! });
  }

  /** Rename the group everywhere: one write of the group's record entry. */
  async renameGroup(displayName: string): Promise<string> {
    const name = normalizeDisplayName(displayName, DEFAULT_GROUP_DISPLAY_NAME);
    await this.writeGroupRecord((_state, groupId) => ({ kind: 'issue', entries: [{ kind: 'group', id: groupId, public: { groupId, displayName: name } }], value: null }));
    return name;
  }

  /**
   * What a grant hands a machine besides the join key: the keys this machine
   * accepts right now, the group's entries of the record and its head. Null
   * when this machine has no roster to hand over.
   */
  grantContents(): { readonly keys: readonly GroupKeyRecord[]; readonly entries: readonly AnyAuthorityEntry[]; readonly head: AuthorityHead | null } | null {
    const material = this.material, acceptance = this.acceptance;
    const view = this.record.view();
    if (!material || !acceptance || !view) return null;
    const accepted = this.keyring().acceptedGenerations();
    const keys = material.keys.filter((record) => accepted.includes(record.generation));
    const entries = [...view.record.entries.values()].filter((entry) => isGroupEntry(entry, material.groupId)).map((entry) => ({ ...entry, private: null }) as AnyAuthorityEntry);
    return { keys, entries, head: view.head };
  }

  /**
   * The secrets of these key generations, for a current member: each only
   * when the key held here matches the record's commitment for it. The signing
   * key and the join key go with a generation when they are the ones the
   * record says were in force from it. With null, the catch-up set.
   */
  private epochSecrets(epochs: readonly number[] | null): readonly EpochSecrets[] {
    const material = this.material, acceptance = this.acceptance;
    if (!material || !acceptance) return [];
    const wanted = epochs ?? this.keyring().acceptedGenerations();
    const out: EpochSecrets[] = [];
    for (const epoch of wanted) {
      const facts = this.epochs.get(epoch);
      const held = material.keys.find((record) => record.generation === epoch);
      if (!facts || !held || keyCommitment(material.groupId, epoch, held.key) !== facts.keyCommitment) continue;
      const signing = material.groupSigning.generation === facts.signing.generation && material.groupSigning.publicKey === facts.signing.publicKey
        ? material.groupSigning : null;
      out.push({ epoch, groupKey: held.key, signing, joinKey: material.joinVerifier === facts.joinVerifier ? material.joinKey : null });
    }
    return out;
  }

  /**
   * Take key generations a current member sent. Each key is taken only when
   * it matches the record's commitment for its generation; a signing key only
   * when it is the pair the record names and it signs; a join key only when it
   * derives the verifier in force from the newest generation. Any generation
   * above the one held is taken directly: a machine that missed several
   * rotations catches up in one step. One at a time, so two copies of the
   * same answer derive and write once.
   */
  private installEpochs(secrets: readonly EpochSecrets[]): Promise<void> {
    const task = this.installQueue.then(() => this.installEpochsNow(secrets));
    this.installQueue = task.catch(() => {});
    return task.catch((error: unknown) => {
      if (error instanceof ClusterMembershipOperationError || error instanceof GroupKeyNotSavedError) return;
      this.options.logger.warn('cluster: a group key from another member could not be taken', { error: summarizeError(error) });
    });
  }

  private async installEpochsNow(secrets: readonly EpochSecrets[]): Promise<void> {
    const base = this.material;
    if (!base || this.runtimeStopping || this.membershipTransition) return;
    const now = this.options.clock.now();
    const epochs = this.epochs;
    let newestEpoch = -1;
    for (const facts of epochs.values()) newestEpoch = Math.max(newestEpoch, facts.epoch);
    const inForce = epochs.get(newestEpoch);
    let next = base;
    const taken: number[] = [];
    for (const secret of [...secrets].sort((a, b) => a.epoch - b.epoch)) {
      const facts = epochs.get(secret.epoch);
      if (!facts || keyCommitment(base.groupId, secret.epoch, secret.groupKey) !== facts.keyCommitment) continue;
      const held = next.keys.find((record) => record.generation === secret.epoch);
      if (held?.key !== secret.groupKey) {
        next = withGroupKey(next, { generation: secret.epoch, key: secret.groupKey, createdAt: facts.createdAt, mintedBy: facts.mintedBy, adoptedAt: Math.trunc(now) },
          Math.max(secret.epoch, this.acceptance?.current ?? 0), now);
        taken.push(secret.epoch);
      }
      const signing = secret.signing;
      // A newer signing generation, or the record's pair for the one held when
      // this machine minted its own for the same generation and lost (rule 3).
      const signingBehind = signing !== null && (signing.generation > next.groupSigning.generation
        || (signing.generation === next.groupSigning.generation && next.groupSigning.publicKey !== signing.publicKey));
      if (signing && signingBehind && signing.generation === facts.signing.generation
        && signing.publicKey === facts.signing.publicKey && signingPairMatches(signing)) next = { ...next, groupSigning: signing };
      if (secret.joinKey && inForce && facts.joinVerifier === inForce.joinVerifier && next.joinVerifier !== inForce.joinVerifier) {
        const derived = await deriveJoinVerifier(secret.joinKey, next.joinSalt).catch(() => null);
        if (derived === inForce.joinVerifier) next = { ...next, joinKey: secret.joinKey, joinVerifier: derived };
        else this.options.logger.warn('cluster: a member sent a join key that does not match the group\'s record; the join key was left unchanged');
      }
    }
    if (next === base) return;
    await this.commitMaterial(next, base);
    if (taken.length > 0) this.options.logger.info('cluster: adopted a replacement group key', { generation: Math.max(...taken) });
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

  /** Send this machine's value of a shared setting to the group (the owner's answer to a local difference). */
  async publishConfigValue(path: string): Promise<'published' | 'held'> {
    let outcome: 'published' | 'held' = 'published';
    await this.runGroupWork(async () => {
      if (this.replication) outcome = await this.replication.publishLocalValue(path);
    });
    return outcome;
  }

  /** Take the group's value of a shared setting here (the owner's other answer to a local difference). */
  async acceptGroupConfigValue(path: string): Promise<void> {
    await this.runGroupWork(() => this.replication?.acceptGroupValue(path));
  }

  /** Tell the group about a credential an operator just set on this machine. */
  async announceSecretChange(configPath: string): Promise<void> {
    await this.runGroupWork(() => this.replication?.announceLocalSecret(configPath));
  }

  /** Bind one replication operation to its original live membership. A shared
   * group-key envelope authenticates the group, not an independent per-node
   * signature; roster identity checks restrict the claimed sender accordingly.
   * Heartbeats/names are not membership generations and never invalidate it.
   * The check compares captured values only; the state files are checked by
   * their owner when they are written.
   */
  private captureConfigAuthority(envelope?: ClusterEnvelope): () => void {
    this.configChanges.assertStoresCurrent(this.options.config, this.options.secrets);
    const material = this.material, state = this.state, revision = this.membershipRevision;
    if (!material || !state || state.groupId !== material.groupId) throw new ClusterMembershipOperationError('abandoned');
    const groupId = material.groupId, node = material.node;
    const secrets = this.options.secrets, config = this.options.config;
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
        || this.options.secrets !== secrets || this.options.config !== config
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

  private persistHeldConfig(groupId: string, held: readonly HeldConfigChange[]): void {
    if (this.runtimeStopping || !this.membershipOperations.available || groupId !== this.material?.groupId) throw new ClusterMembershipOperationError('abandoned');
    this.stateOwner.write(GROUP_HELD_CONFIG_FILENAME, `${JSON.stringify({ version: 1, groupId, held }, null, 2)}\n`, false);
  }

  private persistReplica(document: ConfigReplicaDocument): void {
    if (this.runtimeStopping || !this.membershipOperations.available || document.groupId !== this.material?.groupId) throw new ClusterMembershipOperationError('abandoned');
    this.stateOwner.write(GROUP_REPLICA_FILENAME, `${JSON.stringify(document, null, 2)}\n`, false);
  }

  /**
   * Persist changed key material.
   *
   * `base` is the material the change was derived from. When it is given and
   * is no longer the current material (a rotation announced by another member
   * was adopted while this one was being prepared), the change is abandoned
   * instead of overwriting what was adopted.
   */
  async commitMaterial(material: GroupKeyMaterial, base?: GroupKeyMaterial): Promise<void> {
    if (base !== undefined && base !== this.material) throw new ClusterMembershipOperationError('abandoned');
    const expected = this.material, revision = this.membershipRevision;
    await this.enqueueMaterialWrite(async () => {
      if (!this.membershipOperations.available || this.membershipTransition || expected !== this.material || revision !== this.membershipRevision
        || material.groupId !== expected?.groupId) throw new ClusterMembershipOperationError('abandoned');
      try {
        await saveGroupKeyMaterial(this.options.secrets, material);
      } catch (error) {
        await this.settleRefusedMaterialWrite(error, material, expected);
        return;
      }
      if (this.materialWriteFailing) {
        this.materialWriteFailing = false;
        this.options.logger.info('cluster: the group key was saved again');
      }
      this.material = material;
      this.refreshFromRecord();
      if (this.runtimeStopping) this.keyringInstance = null;
    });
  }

  /**
   * A key material write was refused. The secrets store owns the fact of what
   * it holds, so ask it once: the new material means the write landed and is
   * adopted; the previous material means nothing changed, this machine keeps
   * its keys and the caller's next pass writes again. Only when the store
   * cannot be read, or holds something else, is the outcome unknown; then
   * housekeeping reads it again on every pass until it answers.
   */
  private async settleRefusedMaterialWrite(error: unknown, written: GroupKeyMaterial, previous: GroupKeyMaterial | null): Promise<void> {
    const cause = summarizeError(error);
    let stored: GroupKeyMaterial | null | 'unreadable';
    try {
      const raw = await this.options.secrets.get(GROUP_MATERIAL_SECRET_KEY);
      stored = raw === null ? null : readGroupKeyMaterial(JSON.parse(raw) as unknown) ?? 'unreadable';
    } catch { stored = 'unreadable'; }
    if (stored !== 'unreadable' && stored !== null && sameMaterial(stored, written)) {
      this.material = written; this.materialWriteFailing = false;
      this.refreshFromRecord();
      if (this.runtimeStopping) this.keyringInstance = null;
      this.options.logger.warn('cluster: a group key save reported a failure but the store holds the new key; continuing with it', { error: cause });
      return;
    }
    if (stored !== 'unreadable' && stored !== null && previous !== null && sameMaterial(stored, previous)) {
      if (!this.materialWriteFailing) {
        this.materialWriteFailing = true;
        this.options.logger.warn('cluster: the group key could not be saved; this machine keeps the key it holds and saves again on the next pass', {
          error: cause,
          action: 'if this repeats, check the secrets store and its keyfile',
        });
      }
      throw new GroupKeyNotSavedError(cause);
    }
    this.options.logger.error('cluster: a group key save failed and the store could not confirm what it holds; this machine is out of its group until it can', {
      error: cause,
      action: 'the store is read again every 30 seconds; check the secrets store and its keyfile',
    });
    throw this.persistenceUnknown();
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

  /**
   * Gossip this machine's settings and authority-record heads, signed with the
   * group key. A member whose copy differs exchanges with this one (a missed
   * change, a healed split). Membership is not in it: that is the record's.
   */
  private async sendRoster(): Promise<void> {
    if (!this.state) return;
    const authorityHead = this.sync.head();
    await this.sendGroupMessage(GROUP_MESSAGE_TYPES.roster, {
      configRevision: this.replication?.replica.revision ?? 0,
      ...(this.replication ? { configDigest: this.replication.digest } : {}),
      ...(authorityHead ? { authorityRevision: authorityHead.revision, authorityDigest: authorityHead.digest } : {}),
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
    const task = this.unreadableMaterial && this.networkStarted
      ? this.readMaterialAgain()
      // A refused key save was logged when it started and is retried by the
      // next pass; it is not a failure of the pass to report again.
      : this.runGroupWork(() => this.housekeepingPass()).catch((error: unknown) => {
        if (!(error instanceof GroupKeyNotSavedError)) throw error;
      });
    void task.then(() => { this.housekeeping = false; }, () => { this.housekeeping = false; });
    return task;
  }

  /**
   * The stored membership could not be confirmed. Read it again, exactly as
   * a restart would, so one failed read or write does not keep this machine
   * out of its group until somebody restarts the daemon.
   */
  private async readMaterialAgain(): Promise<void> {
    try { await this.reloadMaterial(undefined, true); }
    catch { return; }
    if (this.material) {
      this.options.logger.info('cluster: the stored group membership was read again; this machine is back in its group', { groupId: this.material.groupId });
    }
  }

  private async housekeepingPass(): Promise<void> {
    const now = this.options.clock.now();
    this.admissions.expire(now, 'no machine in that group answered in time');
    for (const [groupId, entry] of this.discovered) {
      if (now - entry.lastSeenAt > 10 * 60 * 1_000) this.discovered.delete(groupId);
    }
    if (!this.material) return;
    // One lstat: a change another process of this home wrote is taken in, and
    // the grace window of the previous generation is re-read against now.
    this.refreshFromRecord();
    if (!this.material || !this.state || !this.acceptance) return;
    for (const nodeId of this.lastHeard.keys()) if (!isCurrentMember(this.state, nodeId)) this.lastHeard.delete(nodeId);

    const keySweep = sweepKeyHistory(this.material.keys, this.acceptance.current, now);
    if (keySweep.dropped > 0) {
      await this.commitMaterial({ ...this.material, keys: keySweep.keys });
    }
    if (now - this.lastRotationCheckAt >= this.options.settings.rosterGossipSeconds * 1_000) {
      this.lastRotationCheckAt = now;
      await this.sendRoster();
    }
    await this.sync.housekeeping();
    await this.rotateIfDue(now);
    this.configChanges.refresh();
    await this.replication?.retryPendingEffects();
    this.replication?.sweep(now);
    await this.replication?.reconcileLocalConfig();
    // A machine that has joined but holds nothing yet keeps asking until a
    // member answers. Stops the instant anything arrives.
    if (this.replication?.needsSnapshot) await this.replication.requestSnapshot();
  }

  // ── rotation ──────────────────────────────────────────────────────────────

  /**
   * The member that acts for the group when one member should: it mints the
   * next rotation, answers a join, answers a settings request that names no
   * machine. `excluding` is the machine asking, which never answers itself.
   *
   * The smallest node id among members heard from recently. A pure function of
   * replicated state, so every member reaches the same answer without any
   * negotiation, and if that machine is off the next one takes over by itself.
   *
   * If two of them mint at once, which a partition can cause, the tie is
   * broken by `preferredKeyRecord`, not by whoever shouted first.
   */
  private designatedMember(now: number, excluding?: string): string | null {
    const state = this.state;
    // A machine whose roster is empty or does not list it (the roster file was
    // lost and no peer has gossiped yet) knows nothing about who is alive, and
    // would otherwise take itself for the minter and rotate the group's key
    // into a generation nobody else holds.
    if (!state || !state.members.some((member) => member.nodeId === this.options.nodeId)) return null;
    const aliveCutoff = now - Math.max(3 * this.options.settings.beaconSeconds * 1_000, 60_000);
    // Until this process has listened for a whole window it cannot know who is
    // silent, so it counts every member as alive rather than taking the role.
    const warmingUp = this.listeningSince === null || this.listeningSince > aliveCutoff;
    const candidates = state.members
      .filter((member) => member.nodeId !== excluding
        && (member.nodeId === this.options.nodeId || warmingUp || (this.lastHeard.get(member.nodeId) ?? -Infinity) >= aliveCutoff))
      .map((member) => member.nodeId)
      .sort();
    return candidates[0] ?? null;
  }

  private async rotateIfDue(now: number): Promise<void> {
    const material = this.material;
    if (!material || !this.acceptance) return;
    const generation = this.acceptance.current;
    const current = material.keys.find((entry) => entry.generation === generation);
    if (!current) return;
    if (now - current.createdAt < keyRotationMs(this.options.settings)) return;
    if (this.designatedMember(now) !== this.options.nodeId) return;
    await this.rotate('scheduled', 'the group key reached its rotation interval');
  }

  /**
   * Replace the group key: one record write and one key-material write.
   *
   * The new generation's secrets are saved here FIRST, then its public facts
   * (cause, minter, a commitment to the key, the signing public key and the
   * join verifier in force from it) are written to the record. The record's
   * carriage sends that entry at once with the secrets sealed to every current
   * member, and again until each member's record covers it. A member that
   * missed any number of rotations takes the newest from one answer, because
   * the carriage is signed with identity keys that never rotate.
   *
   * `revocation` differs in what is accepted, and it is the important part:
   * a revocation generation opens no window for the previous one, on this
   * machine or any other (the record carries the cause, and every machine
   * computes the same answer from it, a machine that joins later included).
   * It also replaces the group's SIGNING key and JOIN key: the removed or
   * leaked machine holds both. Their new private halves travel sealed to the
   * remaining members with the generation, never to a removed one.
   *
   * A removal (`removal`) is written in the SAME record write as the
   * generation that shuts the machine out: the group never holds the removal
   * without the new key, or the new key without the removal.
   */
  async rotate(
    cause: 'scheduled' | 'revocation',
    reason: string,
    plan?: RevocationPlan,
    removal?: { readonly nodeId: string },
  ): Promise<RotationResult> {
    const join = cause === 'revocation' ? (plan ?? await this.prepareRevocation()).join : undefined;
    // Read after the derivation, so a generation taken meanwhile is built on.
    const material = this.requireMaterial();
    if (!this.keyringInstance || !this.acceptance) throw new ClusterMembershipOperationError('abandoned');
    const now = Math.trunc(this.options.clock.now());
    let newestEpoch = this.acceptance.current;
    let newest: KeyEpochFacts | undefined;
    let signingGeneration = material.groupSigning.generation;
    for (const facts of this.epochs.values()) {
      if (facts.epoch >= newestEpoch) { newestEpoch = facts.epoch; newest = facts; }
      signingGeneration = Math.max(signingGeneration, facts.signing.generation);
    }
    const generation = newestEpoch + 1;
    const key = generateGroupKey();
    const signing: GroupSigningMaterial | null = cause === 'revocation' ? { ...generateGroupSigningKeyPair(), generation: signingGeneration + 1 } : null;
    const rotated: GroupKeyMaterial = {
      ...withGroupKey(material, { generation, key, createdAt: now, mintedBy: this.options.nodeId, adoptedAt: now }, generation, now),
      ...(join ? { joinKey: join.joinKey, joinVerifier: join.joinVerifier } : {}),
      ...(signing ? { groupSigning: signing } : {}),
    };
    const facts: KeyEpochFacts = {
      epoch: generation,
      cause,
      mintedBy: this.options.nodeId,
      createdAt: now,
      keyCommitment: keyCommitment(material.groupId, generation, key),
      // A scheduled generation keeps what the record says is in force, so a
      // machine behind on the signing or join key cannot move the group back.
      signing: signing
        ? { publicKey: signing.publicKey, generation: signing.generation }
        : newest?.signing ?? { publicKey: material.groupSigning.publicKey, generation: material.groupSigning.generation },
      joinVerifier: join ? join.joinVerifier : newest?.joinVerifier ?? material.joinVerifier,
    };
    // `material` is what this rotation was derived from: if a generation from
    // another member was taken meanwhile, this one is abandoned rather than laid over it.
    await this.commitMaterial(rotated, material);
    const removedUnder = plan?.removedUnder;
    const written = await this.writeGroupRecord<boolean>((state, groupId, view) => {
      // Another member's generation reached this record while the key was
      // being saved: this rotation is abandoned rather than laid over it.
      if (keyEpochsFromRecord(view.record, groupId).has(generation)) return { kind: 'none', value: false };
      const changes: AuthorityChange<unknown>[] = [];
      const member = removal ? state.members.find((entry) => entry.nodeId === removal.nodeId) : undefined;
      if (member) {
        const key: AuthorityKey = authorityKey('member', memberEntryId(groupId, member.nodeId, member.gen));
        // Rule 7: the newest write this record holds from the removed
        // machine's home is the last one that stands; anything it writes
        // after this is refused by every member.
        const origin = (view.entry('member', memberEntryId(groupId, member.nodeId, member.gen))?.public as { readonly authorityOrigin?: unknown } | undefined)?.authorityOrigin;
        let originCutoff = -1;
        if (typeof origin === 'string') {
          for (const entry of view.record.entries.values()) {
            if (entry.origin === origin) originCutoff = Math.max(originCutoff, entry.rev);
            if (entry.revoked?.origin === origin) originCutoff = Math.max(originCutoff, entry.revoked.rev);
          }
        }
        const patch = { ...(removedUnder ? { removedUnder } : {}), ...(typeof origin === 'string' ? { originCutoff } : {}) };
        if (Object.keys(patch).length > 0) changes.push({ kind: 'update', key, patch, narrowsOrWidens: false, value: null });
        changes.push({ kind: 'revoke', key, by: this.options.nodeId, reason: 'removed by the operator', value: null });
      }
      changes.push({ kind: 'issue', value: null, entries: [{ kind: 'key-epoch', id: keyEpochEntryId(groupId, generation), public: facts }] });
      // Generations below the previous one are never accepted again; revoked,
      // they are dropped from every copy once all members hold this change.
      for (const older of keyEpochsFromRecord(view.record, groupId).values()) {
        const olderKey: AuthorityKey = authorityKey('key-epoch', keyEpochEntryId(groupId, older.epoch));
        if (older.epoch < generation - 1 && !view.isRevoked(olderKey)) {
          changes.push({ kind: 'revoke', key: olderKey, by: this.options.nodeId, reason: 'replaced by a newer generation', value: null });
        }
      }
      return { kind: 'many', changes, value: true };
    });
    if (!written) throw new ClusterMembershipOperationError('abandoned');
    this.options.logger.info('cluster: the group key was replaced', {
      generation,
      cause,
      reason,
      members: this.state?.members.length ?? 0,
    });
    return { generation };
  }

  /**
   * Mint a removal's replacement join key. Done BEFORE the removal is
   * recorded, so the derivation's wait does not sit between telling the group
   * a machine is gone and taking its join key away.
   */
  async prepareRevocation(): Promise<RevocationPlan> {
    const material = this.requireMaterial();
    const joinKey = generateJoinKey();
    const joinVerifier = await deriveJoinVerifier(joinKey, material.joinSalt);
    return { join: { joinKey, joinVerifier }, removedUnder: joinKeyFingerprint(material.joinVerifier) };
  }

  // ── inbound: group-key-signed ─────────────────────────────────────────────

  private onGroupMessage(envelope: ClusterEnvelope): void {
    if (this.runtimeStopping || this.membershipTransition || !this.membershipOperations.available) return;
    // Every datagram that verified under the group key is proof of life.
    if (this.state && envelope.groupId === this.state.groupId && isCurrentMember(this.state, envelope.nodeId)) {
      const now = this.options.clock.now();
      const before = this.lastHeard.get(envelope.nodeId);
      this.lastHeard.set(envelope.nodeId, now);
      // Heard after silence (or for the first time): a tenant may want to ask it for its state.
      if (envelope.nodeId !== this.options.nodeId && (before === undefined || now - before > this.tenantSilenceMs())) {
        for (const listener of [...this.#memberHeardListeners]) {
          try { listener(envelope.nodeId); } catch { /* a tenant's listener never stops the group layer */ }
        }
      }
    }
    this.incoming.admit(() => this.runGroupWork(() => this.handleGroupMessage(envelope)));
  }

  private async handleGroupMessage(envelope: ClusterEnvelope): Promise<void> {
    if (envelope.groupId !== this.material?.groupId) return;
    switch (envelope.type) {
      case GROUP_MESSAGE_TYPES.beacon:
        // Liveness only, already noted in onGroupMessage; nothing is written.
        return;
      case GROUP_MESSAGE_TYPES.roster:
        await this.onRoster(envelope);
        return;
      case CONFIG_MESSAGE_TYPES.snapshotPart:
      case CONFIG_MESSAGE_TYPES.snapshot:
      case CONFIG_MESSAGE_TYPES.delta:
      case CONFIG_MESSAGE_TYPES.request:
        await this.replication?.handle(envelope);
        return;
      default: {
        const tenant = this.#tenants.get(envelope.type);
        if (tenant) {
          await this.deliverToTenant(tenant, envelope);
          return;
        }
        this.options.logger.debug('cluster: ignored an unrecognised group message', { type: envelope.type });
      }
    }
  }

  /**
   * A tenant message reaches its tenant only from a current member other than
   * this machine, addressed to everyone or to this machine, with an identity
   * signature that verifies against the key the group record holds for the
   * member it claims to be from.
   */
  private async deliverToTenant(tenant: GroupTenant, envelope: ClusterEnvelope): Promise<void> {
    const state = this.state;
    if (!state || envelope.nodeId === this.options.nodeId || !isCurrentMember(state, envelope.nodeId)) return;
    const to = envelope.body['to'];
    if (to !== undefined && to !== this.options.nodeId) return;
    const member = state.members.find((candidate) => candidate.nodeId === envelope.nodeId);
    const signature = envelope.body['idSig'];
    if (!member || typeof signature !== 'string'
      || !verifyWithIdentity(member.identityKey, tenantSigningBytes(envelope.groupId, envelope.type, envelope.nodeId, envelope.ts, envelope.seq, envelope.body), signature)) {
      this.options.logger.debug('cluster: dropped a group tenant message whose sender could not be verified', { type: envelope.type, nodeId: envelope.nodeId });
      return;
    }
    try {
      await tenant.handle(envelope, { nodeId: envelope.nodeId });
    } catch (error) {
      this.options.logger.warn('cluster: a group tenant could not handle a message', { type: envelope.type, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A member silent through three of its beacons or roster gossips reads as unreachable to tenants. */
  private tenantSilenceMs(): number {
    return Math.max(5_000, 3_000 * Math.max(this.options.settings.beaconSeconds, this.options.settings.rosterGossipSeconds));
  }

  /** The host group tenants use (group-tenants.ts): identity-signed messages on this group's channel. */
  tenantHost(): GroupTenantHost {
    return {
      selfNode: this.options.nodeId,
      silenceMs: this.tenantSilenceMs(),
      register: (tenant) => {
        for (const type of tenant.types) if (this.#tenants.has(type)) throw new Error(`cluster: ${type} already has a tenant`);
        const disown = this.router.ownTypes(tenant.types);
        for (const type of tenant.types) this.#tenants.set(type, tenant);
        return () => {
          disown();
          for (const type of tenant.types) if (this.#tenants.get(type) === tenant) this.#tenants.delete(type);
        };
      },
      send: async (type, body, to) => {
        const keyring = this.keyringInstance;
        const material = this.material;
        if (!keyring || !material || !this.#tenants.has(type)) return;
        const router = this.router;
        const seq = router.nextSeq();
        const ts = this.options.clock.now();
        const unsigned = { ...body, ...(to !== undefined ? { to } : {}) };
        const idSig = signWithIdentity(material.node.identity, tenantSigningBytes(material.groupId, type, this.options.nodeId, ts, seq, unsigned));
        await router.sendRaw(encodeEnvelope({ type, nodeId: this.options.nodeId, nodeVersion: this.options.version, seq, ts, surfaceId: null,
          body: { ...unsigned, idSig } }, keyring));
      },
      isCurrentMember: (nodeId) => this.state !== null && isCurrentMember(this.state, nodeId),
      lastHeardFrom: (nodeId) => this.lastHeardFrom(nodeId),
      onMemberHeard: (listener) => {
        this.#memberHeardListeners.add(listener);
        return () => { this.#memberHeardListeners.delete(listener); };
      },
    };
  }

  private async onRoster(envelope: ClusterEnvelope): Promise<void> {
    if (!this.state || !isCurrentMember(this.state, envelope.nodeId)) return;
    await this.replication?.notePeerReplica(envelope.nodeId, envelope.body['configRevision'], envelope.body['configDigest']);
    this.sync.notePeerHead(envelope.nodeId, envelope.body['authorityRevision'], envelope.body['authorityDigest']);
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
    // Anyone on the network can send a beacon, so a group id that is not the
    // established shape is dropped, and the list holds a bounded number of them.
    if (!isValidGroupId(groupId)) return;
    const displayName = normalizeDisplayName(body['displayName'], DEFAULT_GROUP_DISPLAY_NAME);
    const nodeCount = typeof body['nodeCount'] === 'number' && Number.isFinite(body['nodeCount'])
      ? Math.max(0, Math.trunc(body['nodeCount']))
      : 0;
    if (!this.discovered.has(groupId) && this.discovered.size >= MAX_DISCOVERED_GROUPS) {
      let oldest: DiscoveredGroup | undefined;
      for (const entry of this.discovered.values()) if (!oldest || entry.lastSeenAt < oldest.lastSeenAt) oldest = entry;
      if (oldest) this.discovered.delete(oldest.groupId);
    }
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

}

/** A signing key pair whose private half signs what its public half verifies. */
function signingPairMatches(pair: GroupSigningMaterial): boolean {
  try { return verifyWithIdentity(pair.publicKey, 'goodvibes-cluster-signing-check', signWithIdentity(pair, 'goodvibes-cluster-signing-check')); }
  catch { return false; }
}

/** Two copies of key material hold the same facts, compared in the store's own format. */
function sameMaterial(a: GroupKeyMaterial, b: GroupKeyMaterial): boolean {
  const canonical = (material: GroupKeyMaterial) => JSON.stringify(readGroupKeyMaterial(JSON.parse(JSON.stringify(material)) as unknown));
  return canonical(a) === canonical(b);
}
