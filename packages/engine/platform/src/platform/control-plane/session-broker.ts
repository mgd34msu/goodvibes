import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { readNativeConversationTurnPermit, revalidateNativeConversationTurnPermit, type NativeConversationTurnPermit } from '../workflow/work-ledger/native-intake-client.js';
import { logger } from '../utils/logger.js';
import { withChannelExecutionMode } from '../channel-profiles/install-inbound-intake.js';
import type { GatePresetName } from '../gate/presets.js';
import { summarizeError } from '../utils/error-display.js';
import { sessionsActive } from '../runtime/metrics.js';
import type { PersistentStore } from '../state/persistent-store.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { RouteBindingManager } from '../channels/index.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { ConversationGateConfigReader } from '../agents/conversation-gate.js';
import type {
  SharedSessionCompletion,
  SharedSessionContinuationRunner,
  SharedSessionInputIntent,
  SharedSessionInputRecord,
  SharedSessionSurfaceReplyBinder,
  SharedSessionSurfaceReplyBinding,
} from './session-intents.js';
import type {
  CreateSharedSessionInput,
  EnsureSharedSessionInput,
  FindSharedSessionOptions,
  ListSharedSessionsOptions,
  ParticipantRouteAttachInput,
  RegisterSharedSessionInput,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionRegisterResult,
  SharedSessionSubmission,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from './session-types.js';
import {
  type SharedSessionAgentStatusProvider,
  type SharedSessionEventPublisher,
  type SharedSessionMessageSender,
  type SharedSessionStoreSnapshot,
} from './session-broker-helpers.js';
import {
  reconcileSessionBrokerBoot,
  sortSessions,
} from './session-broker-state.js';
import {
  SessionBrokerFileStorage,
  SessionBrokerSnapshotStorage,
  reportSetAsideSessionEntries,
  withLoggedFacts,
  type SessionBrokerStateView,
  type SessionBrokerStorage,
  type SetAsideSessionEntry,
} from './session-broker-store.js';
import {
  recordSharedSessionInput,
  applySurfaceInputDelivery,
  assertSurfaceInputClaimable,
  cancelQueuedSessionInputs,
  claimNextQueuedSessionInput,
  moveSharedSessionInput,
  moveSharedSessionInputOrKeep,
  filterSessionInputsSince,
  finalizeAgentSessionInputs,
  retireAbandonedSurfaceInputs,
  refreshPendingInputCount,
  touchSharedSession,
  updateSharedSessionInput,
} from './session-broker-inputs.js';
import {
  appendSharedSessionMessage,
  buildSharedSessionContinuationTask,
  listSharedSessionMessages,
  shouldStoreAgentCompletion,
  type AppendSharedSessionMessageInput,
} from './session-broker-messages.js';
import {
  SESSION_SURFACE_MANAGED_METADATA_KEY,
  SURFACE_ROUTE_FRESHNESS_MS,
  attachSharedSessionParticipantAndRoute,
  bindSharedSessionAgent,
  closeSharedSessionRecord,
  createSharedSessionRecord,
  detachSharedSessionParticipant,
  participantToAttachInput,
  registerSharedSession,
  reopenSharedSessionRecord,
} from './session-broker-sessions.js';
import { applyBootOrphanSweep, sweepSharedSessions } from './session-broker-gc.js';
import { SharedSessionRuntimeBusBridge } from './session-broker-runtime-bus.js';
import { handleSharedSessionIntent, PROVIDER_MESSAGE_KEY_FIELD, type ProviderMessageClaim } from './session-broker-intent.js';
import { isDelegatedSessionInput } from './session-intents.js';
import { submitDelegatedSessionMessage, type DelegatedSessionInputBinding, type DelegatedSessionSubmission } from './session-broker-delegated.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';

/** Closed sessions are history, so the stored transcript is never trimmed. */
const MAX_PERSISTED_MESSAGES = Infinity;
/** How long a closed session's history stays in memory after it was last needed. */
const CLOSED_HISTORY_IDLE_MS = 10 * 60 * 1000;
/** Most recent messages put into one continuation prompt; the stored transcript is untouched. */
const MAX_CONTINUATION_MESSAGES = 100;
/**
 * Default retention for CLOSED sessions (HISTORY): `POSITIVE_INFINITY` = retain
 * indefinitely, so the GC sweep NEVER deletes a closed session. A finite value
 * (constructor `deletionRetentionMs`) is the opt-in deletion authority. Memory
 * is separate: a closed session's messages and inputs leave memory once it has
 * been idle (on a store that keeps one log per session) and load again when asked for.
 */
const SESSION_DELETION_RETENTION_MS = Number.POSITIVE_INFINITY;

/** What an attach can change that a client shows: who takes part, through which routes, under which title. Seen-times are left out. */
function attachedFacts(session: SharedSessionRecord): string {
  return JSON.stringify([
    session.title,
    session.routeIds,
    session.participants.map(({ lastSeenAt: _seen, ...participant }) => participant),
  ]);
}

/** How long a started-but-unbound agent holds back a session's other messages if nothing ends the claim. */
const SPAWN_IN_FLIGHT_MS = 30_000;
/** Input metadata marking a message that waits for a free agent; it survives a restart with the row. */
const WAITING_FOR_CAPACITY_KEY = 'waitingForCapacitySince';

/**
 * Every session, message and input change replaces a map entry (records are
 * rebuilt, buckets set back after a push), so counting set, delete and clear
 * counts every change, and the key says which session the next write covers.
 */
class TrackedMap<V> extends Map<string, V> {
  constructor(private readonly changed: (sessionId: string | null) => void) { super(); }
  override set(key: string, value: V): this { this.changed(key); return super.set(key, value); }
  override delete(key: string): boolean { const removed = super.delete(key); if (removed) this.changed(key); return removed; }
  override clear(): void { if (this.size > 0) this.changed(null); super.clear(); }
  /** Change the entry without counting it as a change (loading or unloading history). */
  quietSet(key: string, value: V): void { Map.prototype.set.call(this, key, value); }
  quietDelete(key: string): void { Map.prototype.delete.call(this, key); }
  /** The entry if it is in memory, without loading it. */
  peek(key: string): V | undefined { return Map.prototype.get.call(this, key) as V | undefined; }
}

/** A session's messages or inputs: read through `get`/`has`, a deferred session's history loads first. */
class SessionBucketMap<V> extends TrackedMap<V> {
  constructor(changed: (sessionId: string | null) => void, private readonly miss: (sessionId: string) => void) { super(changed); }
  override get(key: string): V | undefined { if (!super.has(key)) this.miss(key); return super.get(key); }
  override has(key: string): boolean { if (!super.has(key)) this.miss(key); return super.has(key); }
}

export class SharedSessionBroker {
  private readonly storage: SessionBrokerStorage;
  /** The file this broker serves from, or null for an injected store. Boot folds/sweeps must NAME it, never re-derive it, see daemon/daemon-session-store-boot.ts. */
  readonly storePath: string | null;
  private readonly routeBindings: RouteBindingManager;
  private readonly agentStatusProvider: SharedSessionAgentStatusProvider;
  private readonly messageSender: SharedSessionMessageSender;
  private readonly conversationGateConfig: ConversationGateConfigReader | undefined;
  #revision = 0;
  readonly #revisionSource = revisionSource('shared sessions', () => this.#revision);
  /** Sessions whose record, messages or inputs changed since the last write. */
  private readonly changed = new Set<string>();
  private readonly noteChange = (sessionId: string | null): void => {
    this.#revision++;
    if (sessionId !== null) this.changed.add(sessionId);
  };
  private readonly sessions = new TrackedMap<SharedSessionRecord>(this.noteChange);
  private readonly messages = new SessionBucketMap<SharedSessionMessage[]>(this.noteChange, (id) => this.loadDeferredHistory(id));
  private readonly inputs = new SessionBucketMap<SharedSessionInputRecord[]>(this.noteChange, (id) => this.loadDeferredHistory(id));
  /** Sessions whose messages and inputs are on disk only; they load on first use. */
  private readonly deferred = new Set<string>();
  /** When each closed session's loaded history was last asked for. */
  private readonly historyTouchedAt = new Map<string, number>();
  private setAside: readonly SetAsideSessionEntry[] = [];
  /** The boot orphan sweep waits one heartbeat window, so surfaces that outlived a restart re-register first. */
  private bootSweepDone = false;
  private readonly runtimeBusBridge = new SharedSessionRuntimeBusBridge();
  private readonly changeListeners = new Set<() => void>();
  private intakeHold: (() => boolean) | null = null;
  /** provider message key -> the input that holds it; built from the persisted rows on first use. */
  private providerMessageIndex: Map<string, { sessionId: string; inputId: string }> | null = null;
  private eventPublisher: SharedSessionEventPublisher | null = null;
  private continuationRunner: SharedSessionContinuationRunner | null = null;
  private surfaceReplyBinder: SharedSessionSurfaceReplyBinder | null = null;
  private surfaceNoticeSender: ((routeId: string, text: string) => void) | null = null;
  private loaded = false;
  /** One load at a time: a second early caller must not clear maps the first already filled. */
  private loading: Promise<void> | null = null;
  /** Follow-ups a continuation run is already handling, so a second completion does not start another. */
  private readonly followUpsRunning = new Set<string>();
  /** Sessions with an agent being started: session id to the time the claim lapses if nothing ends it. */
  private readonly spawnsInFlight = new Map<string, number>();
  /**
   * Messages accepted while every agent slot was taken, oldest first: input id
   * to session id. Each row stays `queued` and is started, in this order, when
   * an agent ends; the transport that delivered it has already been answered.
   */
  private readonly capacityWaiting = new Map<string, string>();
  private capacityDrain: Promise<void> | null = null;
  private capacityDrainAgain = false;
  /** Tail of the work queued per route or session key; see `serialized`. */
  private readonly serialChains = new Map<string, Promise<void>>();
  private _gcInterval: ReturnType<typeof setInterval> | null = null;
  private loadedAt = 0;
  private externalLivenessProbe: ((session: SharedSessionRecord) => boolean) | null = null; // see setExternalLivenessProbe

  /** Default idle threshold for zero-message sessions (ms). */
  private readonly _idleEmptyMs: number;
  /** Default idle threshold for sessions with content (ms). */
  private readonly _idleLongMs: number;
  /** Retention window (ms since closedAt) for CLOSED sessions; Infinity = retain forever. */
  private readonly _deletionRetentionMs: number;

  /** @param config idleEmptyMs (empty-session idle, default 10m), idleLongMs (default
   * 24h), deletionRetentionMs (closed-session delete age, default Infinity = retain). */
  constructor(config: {
    readonly store?: PersistentStore<SharedSessionStoreSnapshot> | undefined;
    readonly storePath?: string | undefined;
    readonly routeBindings: RouteBindingManager;
    readonly agentStatusProvider: SharedSessionAgentStatusProvider;
    readonly messageSender: SharedSessionMessageSender;
    readonly idleEmptyMs?: number | undefined;
    readonly idleLongMs?: number | undefined;
    readonly deletionRetentionMs?: number | undefined;
    /** Reads `conversationGate.*` so an inbound channel message is not handed to a running agent behind the gate's back; absent falls back to the gate's defaults, which gate every channel surface. */
    readonly conversationGateConfig?: ConversationGateConfigReader | undefined;
  }) {
    if (!config.store && !config.storePath) throw new Error('SharedSessionBroker requires an explicit store or storePath.');
    this.storage = config.store
      ? new SessionBrokerSnapshotStorage(config.store)
      : new SessionBrokerFileStorage(config.storePath as string);
    this.storePath = this.storage.path; // null for an injected store: it has no file, and nothing may guess one for it
    this.routeBindings = config.routeBindings;
    this.agentStatusProvider = config.agentStatusProvider;
    this.messageSender = config.messageSender;
    this._idleEmptyMs = config.idleEmptyMs ?? 10 * 60 * 1000;  // 10 min
    this._idleLongMs  = config.idleLongMs  ?? 24 * 60 * 60 * 1000; // 24 h
    this._deletionRetentionMs = config.deletionRetentionMs ?? SESSION_DELETION_RETENTION_MS;
    this.conversationGateConfig = config.conversationGateConfig;
  }

  /** Liveness for turns running outside this broker (see session-broker-gc.ts's isExternallyLive). Set post-construction: the answering subsystem takes this broker as its spine. */
  /** Sessions, their messages and inputs as a revision source. This broker is the only writer of its store. */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  setExternalLivenessProbe(probe: ((session: SharedSessionRecord) => boolean) | null): void {
    this.externalLivenessProbe = probe;
  }

  setEventPublisher(publisher: SharedSessionEventPublisher | null): void {
    this.eventPublisher = publisher;
  }

  /**
   * While the hold answers true, new turns are refused with a retryable
   * WORKSPACE_BUSY (409) instead of being recorded against stores that are
   * moving to another working directory. Set post-construction by the host
   * that owns the workspace swap.
   */
  setIntakeHold(hold: (() => boolean) | null): void {
    this.intakeHold = hold;
  }

  private assertIntakeOpen(): void {
    if (this.intakeHold?.() !== true) return;
    throw Object.assign(
      new Error('A workspace swap is in progress, so this message was not recorded. Retry in a moment, once the swap has finished.'),
      { code: 'WORKSPACE_BUSY', status: 409, retryAfterMs: 1000 },
    );
  }

  /**
   * Returns the number of sessions that currently have a pending input
   * (i.e. pendingInputCount > 0). Used by WorkspaceSwapManager to determine
   * whether the daemon is busy before allowing a workspace swap.
   */
  countBusySessions(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.pendingInputCount > 0) count++;
    }
    return count;
  }

  /**
   * Gracefully stop the broker by clearing the GC interval, tearing down bus
   * subscriptions, and persisting state. Call from DaemonServer.stop().
   */
  async stop(): Promise<void> {
    if (this._gcInterval) {
      clearInterval(this._gcInterval);
      this._gcInterval = null;
    }
    this.runtimeBusBridge.stopAll();
    await this.persist();
    this.storage.close();
  }

  /**
   * Wire the broker to a RuntimeEventBus so agent terminal events automatically
   * reconcile session inputs and task state.
   *
   * Call once after both the broker and the bus are constructed. Returns an
   * unsubscribe function that tears down the subscriptions.
   *
   * @param bus - The active RuntimeEventBus.
   * @param sessionResolver - Maps agentId → sessionId for the active session.
   *   Return `null` when the agent is not associated with a shared session.
   */
  attachRuntimeBus(
    bus: RuntimeEventBus,
    sessionResolver: (agentId: string) => string | null,
  ): () => void {
    return this.runtimeBusBridge.attach(
      bus,
      sessionResolver,
      (sessionId, agentId, body, metadata) => this.completeAgent(sessionId, agentId, body, metadata),
      () => this.scheduleCapacityDrain(),
    );
  }

  setContinuationRunner(runner: SharedSessionContinuationRunner | null): void {
    this.continuationRunner = runner === null ? null
      : input => withChannelExecutionMode(this, input.sessionId, () => runner(input));
    // Messages a previous run accepted while the fleet was full start now.
    if (runner !== null) this.scheduleCapacityDrain();
  }

  /**
   * Keep a message that could not start because every agent slot is taken.
   * The row stays `queued` (marked, so the mark survives a restart) and is
   * started when an agent ends, in arrival order. Returns `held` the first
   * time, `already` when it was waiting, null when the row is not a queued
   * input of this session.
   */
  async holdForCapacity(sessionId: string, inputId: string): Promise<'held' | 'already' | null> {
    await this.start();
    const row = this.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
    if (!row || row.state !== 'queued') return null;
    if (this.capacityWaiting.has(inputId)) return 'already';
    this.capacityWaiting.set(inputId, sessionId);
    if (typeof row.metadata[WAITING_FOR_CAPACITY_KEY] !== 'number') {
      updateSharedSessionInput(this.sessionInputStore(), sessionId, inputId, (current) => ({
        ...current, metadata: { ...current.metadata, [WAITING_FOR_CAPACITY_KEY]: Date.now() },
      }));
      await this.persist();
    }
    logger.info('A message is waiting for a free agent', { sessionId, inputId, waiting: this.capacityWaiting.size });
    return 'held';
  }

  /** An agent ended: start waiting messages once the manager has released its slot. */
  private scheduleCapacityDrain(): void {
    if (this.capacityWaiting.size === 0) return;
    const timer = setTimeout(() => {
      void this.drainCapacityWaiting().catch((error: unknown) => {
        logger.warn('Messages waiting for a free agent could not be started', { error: summarizeError(error) });
      });
    }, 0);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private drainCapacityWaiting(): Promise<void> {
    if (this.capacityDrain) { this.capacityDrainAgain = true; return this.capacityDrain; }
    this.capacityDrain = (async () => {
      try {
        do {
          this.capacityDrainAgain = false;
          await this.startWaitingForCapacity();
        } while (this.capacityDrainAgain);
      } finally {
        this.capacityDrain = null;
      }
    })();
    return this.capacityDrain;
  }

  private async startWaitingForCapacity(): Promise<void> {
    await this.start();
    for (const [inputId, sessionId] of [...this.capacityWaiting]) {
      const row = this.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
      const session = this.sessions.get(sessionId);
      if (!row || row.state !== 'queued' || !session || session.status !== 'active') {
        this.capacityWaiting.delete(inputId);
        continue;
      }
      // A session busy with another agent takes this message when that agent ends.
      if (session.activeAgentId || this.hasSpawnInFlight(sessionId) || this.followUpsRunning.has(inputId)) continue;
      this.followUpsRunning.add(inputId);
      try {
        await this.runFollowUp(sessionId, row);
      } finally {
        this.followUpsRunning.delete(inputId);
      }
      const after = this.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
      // Still queued: the fleet is still full; the next agent to end tries again.
      if (after?.state === 'queued') return;
      this.capacityWaiting.delete(inputId);
    }
  }

  /** Host composition binds a channel default once, after trusted profile resolution. */
  async bindChannelExecutionMode(sessionId: string, mode: GatePresetName): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') throw new Error('Channel execution session is not active');
    if (session.channelPermissionMode !== undefined && session.channelPermissionMode !== mode) {
      throw new Error('Channel execution mode is already bound');
    }
    const bound = { ...session, channelPermissionMode: mode, channelPermissionModeRevision: 1 };
    this.sessions.set(sessionId, bound);
    try { await this.persist(true); }
    catch (error) {
      if (this.sessions.get(sessionId) === bound) this.sessions.set(sessionId, session);
      throw error;
    }
  }

  /** The authenticated session-mode endpoint updates the existing host-owned binding. */
  async setChannelExecutionMode(sessionId: string, mode: GatePresetName): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active' || session.channelPermissionMode === undefined) {
      throw new Error('Channel execution session is not active');
    }
    if (session.channelPermissionMode === mode) return;
    const updated = { ...session, channelPermissionMode: mode,
      channelPermissionModeRevision: (session.channelPermissionModeRevision ?? 0) + 1 };
    this.sessions.set(sessionId, updated);
    try { await this.persist(true); }
    catch (error) {
      // Retain the advanced revision when restoring the previous mode so an ABA
      // transition can never revive an admission captured before this attempt.
      if (this.sessions.get(sessionId) === updated) this.sessions.set(sessionId, {
        ...session, channelPermissionModeRevision: updated.channelPermissionModeRevision + 1,
      });
      throw error;
    }
    this.publishUpdate('session-permission-mode-changed', { sessionId, mode,
      previousMode: session.channelPermissionMode });
  }

  /**
   * Install the hook that routes an agent's answer back to the channel the
   * message arrived on. See SharedSessionSurfaceReplyBinder, the broker
   * announces every (agent, surface-originated input) pairing through it, so a
   * host wires the reply path once instead of per adapter.
   */
  setSurfaceReplyBinder(binder: SharedSessionSurfaceReplyBinder | null): void {
    this.surfaceReplyBinder = binder;
  }

  /**
   * Install the path for a one-line unsolicited message to a route's channel,
   * distinct from the reply binder above, which pairs an AGENT's answer with a
   * conversation. Today's only caller is the route-binding healing in
   * session-broker-intent.ts, telling a chat its conversation moved.
   */
  setSurfaceNoticeSender(sender: ((routeId: string, text: string) => void) | null): void {
    this.surfaceNoticeSender = sender;
  }

  private announceSurfaceReply(binding: SharedSessionSurfaceReplyBinding): void {
    if (!this.surfaceReplyBinder) return;
    // A local surface (a terminal the operator is sitting at) has no route
    // binding and needs no delivery; only announce something a channel could
    // actually carry.
    if (!binding.routeId && !binding.surfaceKind) return;
    try {
      this.surfaceReplyBinder(binding);
    } catch (error) {
      logger.error('Surface reply binding failed, an answer may not reach its conversation', {
        sessionId: binding.sessionId,
        agentId: binding.agentId,
        bindingId: binding.routeId ?? null,
        surface: binding.surfaceKind ?? null,
        reason: binding.reason,
        error: summarizeError(error),
      });
    }
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = null;
      throw error;
    });
    await this.loading;
  }

  private async load(): Promise<void> {
    await this.routeBindings.start();
    const loaded = await this.storage.load();
    this.sessions.clear();
    this.messages.clear();
    this.inputs.clear();
    this.deferred.clear();
    this.historyTouchedAt.clear();
    for (const session of loaded.sessions.values()) this.sessions.quietSet(session.id, session);
    for (const [sessionId, bucket] of loaded.messages.entries()) this.messages.quietSet(sessionId, bucket);
    for (const [sessionId, bucket] of loaded.inputs.entries()) this.inputs.quietSet(sessionId, bucket);
    for (const sessionId of loaded.deferred) this.deferred.add(sessionId);
    this.setAside = loaded.setAside;
    reportSetAsideSessionEntries(this.storePath, loaded.setAside);
    this.changed.clear();
    this.providerMessageIndex = null;
    this.bootSweepDone = false;
    this.loadedAt = Date.now();
    // Boot reconciliation: cancel stuck spawned/delivered inputs, clear stale activeAgentId.
    for (const sessionId of reconcileSessionBrokerBoot(this.sessions, this.inputs)) {
      this.refreshPendingInputCount(sessionId);
    }
    // Messages accepted while the fleet was full are still owed an agent.
    this.capacityWaiting.clear();
    const waiting = [...this.inputs.entries()].flatMap(([sessionId, bucket]) => bucket
      .filter((entry) => entry.state === 'queued' && typeof entry.metadata[WAITING_FOR_CAPACITY_KEY] === 'number')
      .map((entry) => ({ sessionId, entry })));
    waiting.sort((a, b) => (a.entry.metadata[WAITING_FOR_CAPACITY_KEY] as number) - (b.entry.metadata[WAITING_FOR_CAPACITY_KEY] as number));
    for (const { sessionId, entry } of waiting) this.capacityWaiting.set(entry.id, sessionId);
    // Sessions a dead process left active are closed by the first sweep one
    // heartbeat window after this load (gcSweep): heartbeats are not written
    // to disk, so the stored times cannot tell a live surface from a dead one.
    this.updateActiveSessionsGauge();
    // The sweep timer is installed before the first write so a store that fails
    // it cannot leave a broker that later reports loaded but never reaps.
    if (!this._gcInterval) {
      // .unref() so the GC interval does not keep the process alive past shutdown.
      const iv = setInterval(() => { this.gcSweep(); }, 60_000);
      (iv as unknown as { unref?: () => void }).unref?.();
      this._gcInterval = iv;
    }
    await this.persist();
    // Loaded only once the load fully succeeded: a failed first write is retried by the next start().
    this.loaded = true;
    if (this.continuationRunner) this.scheduleCapacityDrain();
  }

  /** Run `work` after everything already queued under `key`; a different key never waits. */
  private async serialized<T>(key: string | null, work: () => Promise<T>): Promise<T> {
    if (key === null) return work();
    const previous = this.serialChains.get(key) ?? Promise.resolve();
    const current = previous.then(work);
    const tail = current.then(() => undefined, () => undefined);
    this.serialChains.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.serialChains.get(key) === tail) this.serialChains.delete(key);
    }
  }

  private updateActiveSessionsGauge(): void {
    let active = 0;
    for (const session of this.sessions.values()) if (session.status === 'active') active += 1;
    sessionsActive.set(active);
  }

  /** The session whose active agent this is, for routing that agent's events: one pass, no sort or copy. */
  findSessionForAgent(agentId: string): string | null {
    for (const session of this.sessions.values()) if (session.activeAgentId === agentId) return session.id;
    return null;
  }

  listSessions(limit = 100, options: ListSharedSessionsOptions = {}): SharedSessionRecord[] {
    const sorted = sortSessions(this.sessions.values());
    const filtered = sorted.filter((session) => {
      if (options.project !== undefined && session.project !== options.project) return false;
      if (options.kind !== undefined && session.kind !== options.kind) return false;
      if (options.includeClosed === false && session.status === 'closed') return false;
      return true;
    });
    return filtered.slice(0, Math.max(1, limit));
  }

  getSession(sessionId: string): SharedSessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async findPreferredSession(options: FindSharedSessionOptions = {}): Promise<SharedSessionRecord | null> {
    await this.start();
    const candidates = this.listSessions(500).filter((session) => {
      if (!options.includeClosed && session.status === 'closed') return false;
      if (options.routeId && !session.routeIds.includes(options.routeId)) return false;
      if (options.surfaceKind && !session.surfaceKinds.includes(options.surfaceKind)) return false;
      if (options.project !== undefined && session.project !== options.project) return false;
      return true;
    });
    return candidates[0] ?? null;
  }

  async ensureSession(input: EnsureSharedSessionInput = {}): Promise<SharedSessionRecord> {
    return this.serialized(input.sessionId ? `session:${input.sessionId}` : null, () => this.ensureSessionUnlocked(input));
  }

  private async ensureSessionUnlocked(input: EnsureSharedSessionInput): Promise<SharedSessionRecord> {
    await this.start();
    const existing = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
    if (existing) {
      const active = existing.status === 'closed'
        ? (await this.reopenSession(existing.id)) ?? existing
        : existing;
      // Adopt: record the participant + advance lastSeenAt (register heartbeat).
      return input.participant
        ? this.attachParticipantAndRoute(active, participantToAttachInput(input.participant, input.title))
        : active;
    }
    return this.createSession({
      id: input.sessionId,
      kind: input.kind,
      project: input.project,
      title: input.title,
      metadata: input.metadata,
      routeBinding: input.routeBinding,
      participant: input.participant,
    });
  }

  /** Idempotent register/heartbeat; a brand-new session is born ALREADY
   * surface-managed (avoids a create-then-patch race where a concurrent steer
   * sees active-but-not-yet-managed and hits the executor path). */
  async register(input: RegisterSharedSessionInput): Promise<SharedSessionRegisterResult> {
    await this.start();
    // Two heartbeats for one new id would otherwise both see "absent" across the create's awaits.
    return this.serialized(`session:${input.sessionId}`, async () => {
      const createManaged = (i: CreateSharedSessionInput) =>
        this.createSession({ ...i, metadata: { ...i.metadata, [SESSION_SURFACE_MANAGED_METADATA_KEY]: true } });
      const result = await registerSharedSession({
        getSession: (id) => this.sessions.get(id) ?? null,
        createSession: createManaged,
        reopenSession: (id) => this.reopenSession(id),
        attachParticipant: (s, a) => this.attachParticipantAndRoute(s, a),
      }, input);
      const marked = await this.markSurfaceManaged(result.record.id); // backstop; no-op if already set
      return marked ? { ...result, record: marked } : result;
    });
  }

  private async markSurfaceManaged(sessionId: string): Promise<SharedSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.metadata?.[SESSION_SURFACE_MANAGED_METADATA_KEY] === true) return session;
    const updated: SharedSessionRecord = {
      ...session,
      metadata: { ...session.metadata, [SESSION_SURFACE_MANAGED_METADATA_KEY]: true },
      updatedAt: Date.now(),
    };
    this.sessions.set(updated.id, updated);
    await this.persist();
    return updated;
  }

  getMessages(sessionId: string, limit = 100, offset = 0): SharedSessionMessage[] {
    return listSharedSessionMessages(this.messageStore(), sessionId, limit, offset);
  }

  getInputs(sessionId: string, limit = 100): SharedSessionInputRecord[] {
    const bucket = this.inputs.get(sessionId) ?? [];
    return bucket.slice(-Math.max(1, limit));
  }

  async createSession(input: CreateSharedSessionInput = {}): Promise<SharedSessionRecord> {
    await this.start();
    const session = createSharedSessionRecord(input);
    // A caller-chosen id that is already taken names that session: replacing it would reset its counts and status.
    const taken = input.id ? this.sessions.get(session.id) : undefined;
    if (taken) return taken;
    this.sessions.set(session.id, session);
    if (input.routeBinding?.id) {
      await this.routeBindings.patchBinding(input.routeBinding.id, { sessionId: session.id });
    }
    await this.persist();
    this.updateActiveSessionsGauge();
    this.publishUpdate('session-created', session);
    return session;
  }

  async closeSession(sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.touch(sessionId);
    const touched = this.sessions.get(sessionId)!; // re-fetch after touch
    const closed = closeSharedSessionRecord(touched);
    const updated = touched.channelPermissionMode === undefined || touched.status === 'closed' ? closed : {
      ...closed, channelPermissionModeRevision: (touched.channelPermissionModeRevision ?? 0) + 1,
    };
    this.sessions.set(sessionId, updated);
    // A deliberate close ends what was waiting to start in it; left queued, the
    // rows keep the daemon "busy" and a later completion would start them.
    const cancelled = cancelQueuedSessionInputs(this.sessionInputStore(), sessionId, 'session closed');
    await this.persist();
    this.updateActiveSessionsGauge();
    this.publishUpdate('session-closed', this.sessions.get(sessionId) ?? updated);
    for (const input of cancelled) this.publishInputLifecycleEvent('session-input-cancelled', input);
    return this.sessions.get(sessionId) ?? updated;
  }

  async reopenSession(sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const reopened = reopenSharedSessionRecord(session);
    const updated = session.channelPermissionMode === undefined || session.status === 'active' ? reopened : {
      ...reopened, channelPermissionModeRevision: (session.channelPermissionModeRevision ?? 0) + 1,
    };
    this.sessions.set(sessionId, updated);
    await this.persist();
    this.updateActiveSessionsGauge();
    this.publishUpdate('session-reopened', updated);
    return updated;
  }

  /**
   * Permanently remove a shared session record and its queued messages/inputs
   * from the home-scoped store (see CHANGELOG 1.0.0: a real hard-delete verb, distinct from
   * `closeSession`, closed sessions are HISTORY and are never touched by this
   * path unless explicitly asked). Requires the session to already be closed:
   * deleting a still-active session returns `'active'` so the caller can
   * surface an honest 409 (close it, then delete) rather than yanking a
   * record out from under a live participant/agent. An unknown OR
   * already-deleted id returns `'not-found'`, delete is not a 200-noop; a
   * second delete of the same id is an honest 404 at the route layer.
   *
   * Emits `session-deleted` on the same `session-update` wire channel as
   * close/reopen/detach so subscribers drop the row live.
   */
  async deleteSession(sessionId: string): Promise<'deleted' | 'not-found' | 'active'> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return 'not-found';
    if (session.status !== 'closed') return 'active';
    // A hosted loop the engine still vouches for would register itself again as an empty active record.
    if (this.externalLivenessProbe?.(session) === true) return 'active';
    this.sessions.delete(sessionId);
    this.messages.quietDelete(sessionId);
    this.inputs.quietDelete(sessionId);
    this.deferred.delete(sessionId);
    this.historyTouchedAt.delete(sessionId);
    await this.persist();
    this.updateActiveSessionsGauge();
    this.publishUpdate('session-deleted', { sessionId });
    return 'deleted';
  }

  /**
   * Detach a surface's participant + route binding without closing or killing the
   * session ("detach != close != kill"). Emits `session-detached`. Idempotent:
   * unknown session -> null (404); closed session or no matching participant ->
   * returned unchanged (a closed session emits no updates, so "stop receiving
   * updates" is already satisfied). See the module helper `detachSharedSessionParticipant`.
   */
  async detachParticipant(sessionId: string, surfaceId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.status === 'closed') return session;
    const { session: updated, changed } = detachSharedSessionParticipant(session, surfaceId);
    if (!changed) return session;
    this.sessions.set(sessionId, updated);
    // A surface that detached will not collect what was queued for it. Only
    // rows nobody else is heartbeating for are failed; others stay for them.
    const retired = retireAbandonedSurfaceInputs(this.sessionInputStore(), Date.now(), { minAgeMs: 0, sessionId });
    await this.persist();
    this.publishUpdate('session-detached', {
      sessionId: updated.id,
      surfaceId,
      participants: updated.participants.length,
    });
    for (const input of retired) this.publishInputLifecycleEvent('session-input-failed', input);
    return this.sessions.get(sessionId) ?? updated;
  }

  /**
   * Record that an agent is about to be started for this session, so a message
   * that arrives before it is bound queues behind it instead of starting a
   * second agent. Returns the release for a start that ends without an agent;
   * `bindAgent` ends the claim itself, and a claim nothing ends lapses.
   */
  beginSpawn(sessionId: string): () => void {
    const claim = Date.now() + SPAWN_IN_FLIGHT_MS;
    this.spawnsInFlight.set(sessionId, claim);
    return () => {
      if (this.spawnsInFlight.get(sessionId) !== claim) return;
      this.spawnsInFlight.delete(sessionId);
      // Nothing was started, so what queued behind the claim must not wait for an agent that never comes.
      void this.runQueuedFollowUp(sessionId).catch((error: unknown) => {
        logger.warn('A message queued behind a spawn that did not start could not be run', { sessionId, error: summarizeError(error) });
      });
    };
  }

  private hasSpawnInFlight(sessionId: string): boolean {
    const claim = this.spawnsInFlight.get(sessionId);
    if (claim === undefined) return false;
    if (claim > Date.now()) return true;
    this.spawnsInFlight.delete(sessionId);
    return false;
  }

  /**
   * Make `agentId` the session's active agent and claim the input it was
   * started for: exactly `inputId` when given, else the oldest queued input. A
   * closed session is returned unchanged, it takes no new agent.
   */
  async bindAgent(sessionId: string, agentId: string, inputId?: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.status !== 'active') {
      logger.warn('An agent was not bound to a closed session', { sessionId, agentId });
      return session;
    }
    const updated = bindSharedSessionAgent(session, agentId);
    this.sessions.set(sessionId, updated);
    this.spawnsInFlight.delete(sessionId);
    const claimed = claimNextQueuedSessionInput(this.sessionInputStore(), sessionId, agentId, inputId);
    await this.persist();
    this.publishUpdate('session-agent-bound', updated);
    if (claimed) {
      this.publishInputLifecycleEvent('session-input-spawned', claimed, {
        agentId,
      });
      // The claimed input is the message this agent was started for. When it
      // arrived over a channel, that channel is where the answer belongs.
      this.announceSurfaceReply({
        sessionId,
        agentId,
        ...(claimed.routeId ? { routeId: claimed.routeId } : {}),
        ...(claimed.surfaceKind ? { surfaceKind: claimed.surfaceKind } : {}),
        task: claimed.body,
        reason: 'spawn-claimed-input',
      });
    }
    return updated;
  }

  async submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('submit', input, true);
  }

  /** Host-private, synchronous original-source binding before message publication.
   * Supply a safe placeholder body only; original text belongs to the source owner. */
  async submitDelegatedMessage(input: SubmitSharedSessionMessageInput,
    onQueued: (input: SharedSessionInputRecord) => DelegatedSessionInputBinding): Promise<DelegatedSessionSubmission> {
    return submitDelegatedSessionMessage({
      submit: (message, bind) => this.handleIntent('submit', message, false, bind),
      read: (sessionId, inputId) => this.inputs.get(sessionId)?.find(entry => entry.id === inputId) ?? null,
      complete: async (sessionId, inputId) => {
        const before = this.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
        const moved = moveSharedSessionInput(this.sessionInputStore(), sessionId, inputId, 'completed');
        if (!moved || !before) throw new Error('Delegated input is no longer held by its session');
        // Already completed: report the row as it is, without announcing a second completion.
        if (!moved.ok) {
          if (moved.input.state === 'completed') return moved.input;
          throw new Error(`Delegated input could not be completed from state ${moved.input.state}: ${moved.reason}`);
        }
        try {
          await this.persist(true);
        } catch (error) {
          // Not durable, so not completed: put the row back so the host can retry the same completion.
          updateSharedSessionInput(this.sessionInputStore(), sessionId, inputId, () => before);
          throw error;
        }
        this.publishInputLifecycleEvent('session-input-completed', moved.input);
        return moved.input;
      },
    }, input, onQueued);
  }

  async steerMessage(input: SteerSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('steer', input, input.allowSpawnFallback === true);
  }

  async followUpMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('follow-up', input, true);
  }

  async appendSystemMessage(sessionId: string, body: string, metadata: Record<string, unknown> = {}): Promise<SharedSessionMessage | null> {
    if (!body.trim()) return null;
    // A message for an id the broker does not hold would be stored forever in a bucket no session owns.
    await this.start();
    if (!this.sessions.has(sessionId)) return null;
    return this.appendMessage(sessionId, {
      role: 'system',
      body,
      metadata,
    });
  }

  /**
   * Persist a companion follow-up message to the shared session message log
   * without spawning an agent. Called by the companion main-chat send path
   * (kind='message') so that GET /api/sessions/:id/messages surfaces the message
   * and TUI subscribers can render it.
   */
  async appendCompanionMessage(
    sessionId: string,
    input: {
      readonly messageId: string;
      readonly body: string;
      readonly timestamp: number;
      readonly source: string;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ): Promise<SharedSessionMessage | null> {
    if (!input.body.trim()) return null;
    await this.start();
    if (!this.sessions.has(sessionId)) return null;
    return this.appendMessage(sessionId, {
      role: 'user',
      body: input.body,
      metadata: {
        ...(input.metadata ?? {}),
        source: input.source,
        messageId: input.messageId,
        timestamp: input.timestamp,
      },
    });
  }

  async completeAgent(sessionId: string, agentId: string, body: string, metadata: Record<string, unknown> = {}): Promise<SharedSessionCompletion | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // One completion per agent. A second reporter of the same end (the reply
    // poll after the agent's own terminal event, a surface's retried report)
    // finds the answer stored, the session released and no row left to settle:
    // nothing is written and no event is published again.
    const role = metadata.status === 'failed' || metadata.status === 'cancelled' ? 'system' : 'assistant';
    if (shouldStoreAgentCompletion(this.messageStore(), sessionId, agentId)) {
      await this.appendMessage(sessionId, { role, body, agentId, metadata });
    } else if (session.activeAgentId !== agentId && !(this.inputs.get(sessionId) ?? []).some((entry) => !isDelegatedSessionInput(entry)
      && entry.activeAgentId === agentId && (entry.state === 'delivered' || entry.state === 'spawned'))) {
      return { session };
    }
    // The session can be deleted while the message above is being written; do not bring it back.
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const now = Date.now();
    const updated: SharedSessionRecord = {
      ...current,
      activeAgentId: current.activeAgentId === agentId ? undefined : current.activeAgentId,
      lastAgentId: agentId,
      updatedAt: now,
      lastActivityAt: now,
      // A later successful run clears the previous failure; a cancel leaves it as it was.
      ...(metadata.status === 'failed' ? { lastError: body } : metadata.status === 'cancelled' ? {} : { lastError: undefined }),
    };
    this.sessions.set(sessionId, updated);
    const finalizedInputs = finalizeAgentSessionInputs(
      this.sessionInputStore(),
      sessionId,
      agentId,
      metadata.status === 'failed' ? 'failed' : metadata.status === 'cancelled' ? 'cancelled' : 'completed',
      metadata.status === 'failed' ? body : undefined,
    );
    await this.persist();
    this.publishUpdate('session-agent-completed', {
      sessionId,
      agentId,
      status: metadata.status ?? 'completed',
    });
    for (const finalized of finalizedInputs) {
      this.publishInputLifecycleEvent(`session-input-${finalized.state}`, finalized, { agentId });
    }
    const continuation = await this.runQueuedFollowUp(sessionId);
    // This session is free now: a message of its own that waited for an agent can start.
    this.scheduleCapacityDrain();
    return {
      session: this.sessions.get(sessionId)!,
      ...(continuation?.input ? { continuedInput: continuation.input } : {}),
      ...(continuation?.agentId ? { continuedAgentId: continuation.agentId } : {}),
    };
  }

  /**
   * Cancel a queued input. Any other row is returned unchanged and no event is
   * published, so subscribers never see a cancel that did not happen; the
   * route answers that case with 409 and the row's actual state.
   */
  async cancelInput(sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null> {
    await this.start();
    const current = this.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
    if (!current) return null;
    if (current.state !== 'queued') return current;
    const moved = moveSharedSessionInput(this.sessionInputStore(), sessionId, inputId, 'cancelled');
    if (!moved?.ok) return current;
    await this.persist();
    this.publishInputLifecycleEvent('session-input-cancelled', moved.input);
    return moved.input;
  }

  async rebindRoute(bindingId: string, sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const binding = await this.routeBindings.patchBinding(bindingId, { sessionId });
    if (!binding) return null;
    return this.attachParticipantAndRoute(session, {
      surfaceKind: binding.surfaceKind,
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.threadId,
      userId: typeof binding.metadata.userId === 'string' ? binding.metadata.userId : undefined,
      displayName: typeof binding.metadata.userName === 'string' ? binding.metadata.userName : undefined,
      body: '',
    }, binding);
  }

  private async appendMessage(
    sessionId: string,
    input: Omit<AppendSharedSessionMessageInput, 'sessionId'>,
  ): Promise<SharedSessionMessage> {
    await this.start();
    const message = appendSharedSessionMessage(this.messageStore(), {
      sessionId,
      ...input,
    }, MAX_PERSISTED_MESSAGES);
    await this.persist();
    this.publishUpdate('session-message-appended', {
      sessionId,
      message,
    });
    return message;
  }

  private async attachParticipantAndRoute(
    session: SharedSessionRecord,
    input: ParticipantRouteAttachInput,
    binding?: AutomationRouteBinding,
  ): Promise<SharedSessionRecord> {
    this.touch(session.id);
    const existing = this.sessions.get(session.id) ?? session;
    const updated = attachSharedSessionParticipantAndRoute({ session: existing, message: input, binding });
    this.sessions.set(updated.id, updated);
    if (binding?.id) {
      await this.routeBindings.patchBinding(binding.id, { sessionId: updated.id });
    }
    await this.persist();
    // A heartbeat from a known participant only moves times: no client has anything to redraw.
    if (attachedFacts(existing) !== attachedFacts(updated)) {
      this.publishUpdate('session-route-attached', {
        sessionId: updated.id,
        routeId: binding?.id,
      });
    }
    return updated;
  }

  private resolveActiveAgentId(session: SharedSessionRecord): string | undefined {
    if (!session.activeAgentId) return undefined;
    const agent = this.agentStatusProvider.getStatus(session.activeAgentId);
    if (!agent) return undefined;
    return agent.status === 'pending' || agent.status === 'running' ? agent.id : undefined;
  }

  private async resolveBinding(input: SubmitSharedSessionMessageInput): Promise<AutomationRouteBinding | null> {
    if (input.routeId) {
      return this.routeBindings.getBinding(input.routeId) ?? null;
    }
    if (!input.externalId) return null;
    return this.routeBindings.resolve(input.surfaceKind, input.externalId, input.threadId) ?? null;
  }

  private providerMessageIndexed(): Map<string, { sessionId: string; inputId: string }> {
    if (this.providerMessageIndex) return this.providerMessageIndex;
    const index = new Map<string, { sessionId: string; inputId: string }>();
    for (const [sessionId, rows] of this.inputs) {
      for (const row of rows) {
        const key = row.metadata[PROVIDER_MESSAGE_KEY_FIELD];
        if (typeof key === 'string') index.set(key, { sessionId, inputId: row.id });
      }
    }
    this.providerMessageIndex = index;
    return index;
  }

  /**
   * What an earlier delivery of this provider message already did, rebuilt
   * from the stored rows so it holds across a restart. The broker owns the
   * claim from the first submit: a row in any state but `failed` is that
   * message, answered or on its way (`held`). A failed row, or a spawn row
   * left queued past the start window (its start never came), is retried with
   * the user message already stored, so the transcript never holds it twice.
   */
  private findProviderMessage(key: string): ProviderMessageClaim | null {
    const index = this.providerMessageIndexed();
    const held = index.get(key);
    if (!held) return null;
    const session = this.sessions.get(held.sessionId);
    const row = this.inputs.get(held.sessionId)?.find((entry) => entry.id === held.inputId);
    if (!session || !row) { index.delete(key); return null; }
    const stored = this.messages.get(held.sessionId)?.find((entry) => entry.id === row.causationId);
    // A message waiting for a free agent is held, not stalled: a redelivery must not start it twice.
    const stalled = row.state === 'queued' && row.intent === 'submit' && !isDelegatedSessionInput(row)
      && Date.now() - row.updatedAt >= SPAWN_IN_FLIGHT_MS && !this.hasSpawnInFlight(held.sessionId)
      && !this.capacityWaiting.has(row.id);
    if ((row.state === 'failed' || stalled) && stored && session.status === 'active') {
      return { kind: 'retry', sessionId: held.sessionId, userMessage: stored, ...(stalled ? { input: row } : {}) };
    }
    if (row.state === 'failed') return null;
    const userMessage: SharedSessionMessage = stored ?? {
      id: row.causationId ?? row.id,
      sessionId: held.sessionId,
      role: 'user',
      body: row.body,
      createdAt: row.createdAt,
      metadata: {},
    };
    return {
      kind: 'held',
      submission: {
        session,
        userMessage,
        ...(row.routeId ? { routeBinding: this.routeBindings.getBinding(row.routeId) } : {}),
        input: row,
        intent: row.intent,
        mode: 'continued-live',
        state: row.state,
        ...(row.activeAgentId ? { activeAgentId: row.activeAgentId } : {}),
        created: false,
        duplicate: true,
      },
    };
  }

  private buildContinuationTask(sessionId: string): string {
    return buildSharedSessionContinuationTask({
      session: this.sessions.get(sessionId) ?? null,
      messages: this.getMessages(sessionId, MAX_CONTINUATION_MESSAGES),
      fallbackSessionId: sessionId,
    });
  }

  /**
   * Write what changed since the last write: on the daemon's store an appended
   * line per message or input change and an index rewrite only when a listed
   * field moved; a heartbeat writes nothing. Resolves once it is on disk.
   */
  private async persist(durable = false): Promise<void> {
    await this.storage.write(this.stateView(), this.changed, durable);
    this.notifyChanged();
  }

  private stateView(): SessionBrokerStateView {
    return {
      sessions: this.sessions,
      peekMessages: (sessionId) => this.messages.peek(sessionId),
      peekInputs: (sessionId) => this.inputs.peek(sessionId),
      messages: this.messages,
      inputs: this.inputs,
    };
  }

  /** Bring a deferred session's messages and inputs into memory (first use after start or after it left memory). */
  private loadDeferredHistory(sessionId: string): void {
    if (!this.deferred.delete(sessionId)) return;
    const record = this.sessions.peek(sessionId);
    if (!record) return;
    const history = this.storage.loadSession(sessionId);
    if (history.messages.length > 0) this.messages.quietSet(sessionId, history.messages);
    if (history.inputs.length > 0) this.inputs.quietSet(sessionId, history.inputs);
    this.sessions.quietSet(sessionId, withLoggedFacts(record, history.messages, history.inputs));
    this.historyTouchedAt.set(sessionId, Date.now());
    if (this.providerMessageIndex) {
      for (const row of history.inputs) {
        const key = row.metadata[PROVIDER_MESSAGE_KEY_FIELD];
        if (typeof key === 'string') this.providerMessageIndex.set(key, { sessionId, inputId: row.id });
      }
    }
  }

  /**
   * Let closed sessions' history leave memory once nothing has asked for it
   * for a while (or at once under memory pressure). It stays on disk and
   * loads again on the next read. Only on a store with one log per session.
   */
  private releaseClosedHistory(idleMs: number): number {
    if (!this.storage.defersSessions) return 0;
    const now = Date.now();
    let released = 0;
    for (const [sessionId, session] of this.sessions) {
      if (session.status !== 'closed' || session.pendingInputCount > 0 || this.changed.has(sessionId)) continue;
      if (this.deferred.has(sessionId)) continue;
      if (now - (this.historyTouchedAt.get(sessionId) ?? session.updatedAt) < idleMs) continue;
      this.messages.quietDelete(sessionId);
      this.inputs.quietDelete(sessionId);
      this.storage.unload(sessionId);
      this.deferred.add(sessionId);
      this.historyTouchedAt.delete(sessionId);
      released += 1;
    }
    return released;
  }

  /** Stored entries this build could not read at the last start, by id and why; they stay on disk untouched. */
  unreadableEntries(): readonly SetAsideSessionEntry[] {
    return this.setAside;
  }

  /**
   * Be told after sessions, messages or inputs change (every published update
   * and every persisted write), so a read model can refresh instead of polling.
   * The listener carries no payload: read the sessions again. Returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private notifyChanged(): void {
    for (const listener of [...this.changeListeners]) {
      try { listener(); } catch (error) {
        logger.warn('[session-broker] change listener failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private publishUpdate(event: string, payload: unknown): void {
    this.eventPublisher?.('session-update', { event, payload, createdAt: Date.now() });
    this.notifyChanged();
  }

  private publishInputLifecycleEvent(event: string, input: SharedSessionInputRecord, extra: Record<string, unknown> = {}): void {
    this.publishUpdate(event, {
      sessionId: input.sessionId,
      inputId: input.id,
      intent: input.intent,
      state: input.state,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      ...(input.activeAgentId ? { activeAgentId: input.activeAgentId } : {}),
      ...extra,
    });
  }

  private async handleIntent(
    intent: SharedSessionInputIntent,
    input: SubmitSharedSessionMessageInput,
    allowSpawnFallback: boolean,
    onQueued?: (input: SharedSessionInputRecord) => void,
  ): Promise<SharedSessionSubmission> {
    this.assertIntakeOpen();
    // Concurrent webhook deliveries for one conversation must not both see "no session yet" and each create one.
    const routeKey = input.routeId
      ? `route:${input.routeId}`
      : input.externalId ? `route:${input.surfaceKind ?? ''}|${input.externalId}|${input.threadId ?? ''}` : null;
    return this.serialized(routeKey, () => this.handleIntentUnlocked(intent, input, allowSpawnFallback, onQueued));
  }

  private async handleIntentUnlocked(
    intent: SharedSessionInputIntent,
    input: SubmitSharedSessionMessageInput,
    allowSpawnFallback: boolean,
    onQueued?: (input: SharedSessionInputRecord) => void,
  ): Promise<SharedSessionSubmission> {
    return handleSharedSessionIntent(
      {
        sessions: this.sessions,
        messageSender: this.messageSender,
        start: () => this.start(),
        resolveBinding: (i) => this.resolveBinding(i),
        createSession: (i) => this.createSession(i),
        reopenSession: (sessionId) => this.reopenSession(sessionId),
        attachParticipantAndRoute: (session, i, binding) => this.attachParticipantAndRoute(session, i, binding),
        appendMessage: (sessionId, i) => this.appendMessage(sessionId, i),
        appendUnpublishedMessage: (sessionId, i) => appendSharedSessionMessage(this.messageStore(), { sessionId, ...i }, MAX_PERSISTED_MESSAGES),
        sessionInputStore: () => this.sessionInputStore(),
        publishInputLifecycleEvent: (event, i, extra) => this.publishInputLifecycleEvent(event, i, extra),
        resolveActiveAgentId: (session) => this.resolveActiveAgentId(session),
        hasSpawnInFlight: (sessionId) => this.hasSpawnInFlight(sessionId),
        persist: (durable) => this.persist(durable),
        publishUpdate: (event, payload) => this.publishUpdate(event, payload),
        announceSurfaceReply: (binding) => this.announceSurfaceReply(binding),
        ...(this.surfaceNoticeSender ? { sendSurfaceNotice: this.surfaceNoticeSender } : {}),
        buildContinuationTask: (sessionId) => this.buildContinuationTask(sessionId),
        findProviderMessage: (key) => this.findProviderMessage(key),
        noteProviderMessage: (key, sessionId, inputId) => { this.providerMessageIndexed().set(key, { sessionId, inputId }); },
        ...(this.conversationGateConfig ? { conversationGateConfig: this.conversationGateConfig } : {}),
      },
      intent,
      input,
      allowSpawnFallback,
      onQueued,
    );
  }

  /** Host-private native reservation. Never queues into the legacy retry/spawn path. */
  async reserveNativeTurnInput(sessionId: string, permit: NativeConversationTurnPermit): Promise<SharedSessionInputRecord> {
    this.assertIntakeOpen();
    const source = readNativeConversationTurnPermit(permit);
    await revalidateNativeConversationTurnPermit(permit);
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session || session.kind !== 'hosted' || session.status !== 'active') throw new Error('Native hosted session is unavailable');
    const entry = recordSharedSessionInput(this.sessionInputStore(), {
      sessionId, intent: 'submit', maxPersistedInputs: 500,
      message: { sessionId, surfaceKind: 'service', surfaceId: 'daemon:native-conversation', body: source.text,
        metadata: { nativeConversation: { projectId: source.projectId, requestId: source.requestId, sourceRef: { ...source.sourceRef } } } },
    });
    const reserved = moveSharedSessionInputOrKeep(this.sessionInputStore(), sessionId, entry.id, 'delivered')!;
    // The exact canonical id and body must be durable before any native turn.
    try { await this.storage.write(this.stateView(), this.changed, true); }
    catch (error) {
      // No caller received this reservation, so no turn can have started. A
      // monotonic failed observation clears local busy ownership without ever
      // rolling back possibly published reservation bytes or granting replay.
      moveSharedSessionInputOrKeep(this.sessionInputStore(), sessionId, reserved.id, 'failed', { error: 'Native reservation durability failed' });
      await this.storage.write(this.stateView(), this.changed, true).catch(() => {});
      throw error;
    }
    return structuredClone(reserved);
  }

  /** Settle only the exact native reservation after its actual owned lifetime drains. */
  async settleNativeTurnInput(sessionId: string, inputId: string, permit: NativeConversationTurnPermit,
    state: 'completed' | 'cancelled' | 'failed'): Promise<SharedSessionInputRecord> {
    if (!['completed', 'cancelled', 'failed'].includes(state)) throw new Error('Invalid native broker terminal state');
    const source = readNativeConversationTurnPermit(permit);
    const current = this.inputs.get(sessionId)?.find(item => item.id === inputId);
    if (!current || current.body !== source.text || current.correlationId !== `session-input:${inputId}`
      || JSON.stringify(current.metadata['nativeConversation']) !== JSON.stringify({ projectId: source.projectId, requestId: source.requestId, sourceRef: source.sourceRef })
      || (current.state !== 'delivered' && current.state !== state)) throw new Error('Native hosted broker settlement mismatch');
    // Settling the same outcome again is the identity; any other move goes through the lifecycle.
    const updated = current.state === state ? current : moveSharedSessionInputOrKeep(this.sessionInputStore(), sessionId, inputId, state)!;
    await this.storage.write(this.stateView(), this.changed, true);
    this.publishInputLifecycleEvent(`session-input-${state}`, updated);
    return structuredClone(updated);
  }

  /** Collection read for a live surface (see the module helper `filterSessionInputsSince`). */
  getInputsSince(
    sessionId: string,
    options: { readonly state?: SharedSessionInputRecord['state'] | undefined; readonly since?: number | undefined; readonly limit?: number | undefined } = {},
  ): SharedSessionInputRecord[] {
    return filterSessionInputsSince(this.inputs.get(sessionId) ?? [], options);
  }

  /** A live surface reports a collected input delivered (`consumed:false`) or
   * consumed/completed (`consumed:true`), optionally naming the agent answering it.
   * Lifecycle, the agent pairing and the events live in `applySurfaceInputDelivery`. */
  async markInputDelivered(
    sessionId: string,
    inputId: string,
    options: { readonly consumed?: boolean | undefined; readonly agentId?: string | undefined; readonly claim?: boolean | undefined; readonly beforeApply?: (() => void) | undefined } = {},
  ): Promise<SharedSessionInputRecord | null> {
    await this.start();
    // The async startup boundary must not turn a stale source into a claim.
    assertSynchronousJudgmentGuard(() => options.beforeApply?.(), () => new Error('Session delivery authority checks must be synchronous'));
    if (options.claim === true && options.consumed !== true) assertSurfaceInputClaimable(this.sessionInputStore(), sessionId, inputId, Date.now());
    const applied = applySurfaceInputDelivery(this.sessionInputStore(), sessionId, inputId, options, {
      publish: (event, payload) => this.publishUpdate(event, payload),
      publishInput: (event, input, extra) => this.publishInputLifecycleEvent(event, input, extra),
      announce: (binding) => this.announceSurfaceReply(binding),
    });
    if (!applied) return null;
    await this.persist();
    return applied;
  }

  /**
   * A surface reports a collected input it could not act on.
   *
   * The counterpart to `markInputDelivered(consumed: true)`, and the reason
   * that call is not the only terminal one: a surface that collected an input
   * and then failed to hand it to its loop used to mark it completed anyway,
   * which is a record saying the owner's message was answered when nothing
   * received it. This moves it to `failed` with the reason attached, so the
   * lifecycle event says what happened and the record can be read afterwards.
   */
  async failInput(sessionId: string, inputId: string, error: string): Promise<SharedSessionInputRecord | null> {
    await this.start();
    const current = this.inputs.get(sessionId)?.find((entry) => entry.id === inputId);
    if (!current || (current.state !== 'queued' && current.state !== 'delivered')) return null;
    const updated = moveSharedSessionInputOrKeep(this.sessionInputStore(), sessionId, inputId, 'failed', { error });
    if (!updated || updated.state !== 'failed') return null;
    this.refreshPendingInputCount(sessionId);
    await this.persist();
    this.publishInputLifecycleEvent('session-input-failed', updated);
    return updated;
  }

  private async runQueuedFollowUp(sessionId: string): Promise<{ input: SharedSessionInputRecord; agentId: string } | null> {
    if (this.sessions.get(sessionId)?.status !== 'active') return null;
    const bucket = this.inputs.get(sessionId) ?? [];
    const next = bucket.find((entry) => entry.intent === 'follow-up' && entry.state === 'queued' && !isDelegatedSessionInput(entry));
    // Follow-ups run one at a time, in order: a second completion while this
    // one is being started leaves it to the run already handling it.
    if (!next || this.followUpsRunning.has(next.id)) return null;
    this.followUpsRunning.add(next.id);
    try {
      return await this.runFollowUp(sessionId, next);
    } finally {
      this.followUpsRunning.delete(next.id);
    }
  }

  private async runFollowUp(sessionId: string, next: SharedSessionInputRecord): Promise<{ input: SharedSessionInputRecord; agentId: string } | null> {
    if (!this.continuationRunner) {
      // A queued follow-up with nobody to run it is a message that will never
      // be answered. Harmless for a local caller that polls its own inputs;
      // for one that arrived over a channel it is silence, so say so.
      if (next.routeId ?? next.surfaceKind) {
        logger.error('A channel follow-up is queued but no continuation runner is installed, it will not be answered', {
          sessionId,
          inputId: next.id,
          bindingId: next.routeId ?? null,
          surface: next.surfaceKind ?? null,
        });
      }
      return null;
    }
    const routeBinding = next.routeId ? this.routeBindings.getBinding(next.routeId) : undefined;
    const task = this.buildContinuationTask(sessionId);
    let spawned: Awaited<ReturnType<SharedSessionContinuationRunner>>;
    try {
      spawned = await this.continuationRunner({
        sessionId,
        input: next,
        task,
        routeBinding,
      });
    } catch (error) {
      // A refused start (fleet full, spawn policy) will not retry by itself: a row left queued reads as busy forever.
      logger.warn('A queued follow-up could not be started', { sessionId, inputId: next.id, error: summarizeError(error) });
      await this.failInput(sessionId, next.id, `The follow-up was not started: ${summarizeError(error)}. Send it again to retry.`);
      return null;
    }
    if (spawned?.disposition === 'capacity') {
      // Not a refusal: the message waits, queued, for the next agent to end.
      await this.holdForCapacity(sessionId, next.id);
      return null;
    }
    if (spawned?.disposition === 'transferred') {
      if (spawned.requestId.trim() && !spawned.inputConsumed) await this.markInputDelivered(sessionId, next.id, { consumed: true });
      return null;
    }
    if (!spawned?.agentId) {
      // Nothing will retry this follow-up: say so on the row instead of leaving
      // it queued, which reads as "busy" forever and never gets an answer.
      const reason = spawned?.disposition === 'held' || spawned?.disposition === 'unknown'
        ? `The follow-up was not started: ${spawned.reason}`
        : 'The follow-up was not started: no agent could be run for it. Send it again to retry.';
      await this.failInput(sessionId, next.id, reason);
      return null;
    }
    await this.bindAgent(sessionId, spawned.agentId, next.id);
    const claimed = this.inputs.get(sessionId)?.find((entry) => entry.activeAgentId === spawned.agentId && entry.state === 'spawned') ?? null;
    if (claimed) {
      this.publishInputLifecycleEvent('session-follow-up-spawned', claimed, {
        agentId: spawned.agentId,
      });
    }
    await this.persist();
    return claimed ? { input: claimed, agentId: spawned.agentId } : null;
  }

  private sessionInputStore(): {
    sessions: Map<string, SharedSessionRecord>;
    inputs: Map<string, SharedSessionInputRecord[]>;
  } {
    return { sessions: this.sessions, inputs: this.inputs };
  }

  private messageStore(): {
    sessions: Map<string, SharedSessionRecord>;
    messages: Map<string, SharedSessionMessage[]>;
  } {
    return { sessions: this.sessions, messages: this.messages };
  }

  private touch(sessionId: string): void {
    touchSharedSession(this.sessionInputStore(), sessionId);
  }

  private refreshPendingInputCount(sessionId: string): void {
    refreshPendingInputCount(this.sessionInputStore(), sessionId);
  }

  /** Periodic sweep: idle-close active sessions and (only under a finite retention
   * window) delete closed ones. Full policy lives in the module helper `sweepSharedSessions`. */
  /** Retained in-memory record count (sessions + message/input bucket entries), for MemoryGovernor visibility. */
  retainedRecordCount(): number {
    let total = this.sessions.size;
    for (const bucket of this.messages.values()) total += bucket.length;
    for (const bucket of this.inputs.values()) total += bucket.length;
    return total;
  }

  /**
   * Under memory pressure: closed sessions' history leaves memory (it stays
   * on disk and loads again when asked for). `floor` releases what has been
   * idle for the usual window, `flush` all of it. Nothing durable is deleted.
   */
  trimRetained(level: 'floor' | 'flush'): void {
    this.releaseClosedHistory(level === 'flush' ? 0 : CLOSED_HISTORY_IDLE_MS);
  }

  /**
   * Fail inputs queued for a surface once no surface is left heartbeating the
   * session. Surfaces re-register after a daemon restart, so nothing is judged
   * until one freshness window has passed since this broker loaded.
   */
  async retireAbandonedSurfaceInputs(now: number = Date.now()): Promise<SharedSessionInputRecord[]> {
    await this.start();
    if (now - this.loadedAt < SURFACE_ROUTE_FRESHNESS_MS) return [];
    const retired = retireAbandonedSurfaceInputs(this.sessionInputStore(), now);
    if (retired.length === 0) return retired;
    await this.persist();
    for (const input of retired) this.publishInputLifecycleEvent('session-input-failed', input);
    return retired;
  }

  private gcSweep(): void {
    void this.retireAbandonedSurfaceInputs().catch((error: unknown) => {
      logger.warn('[session-broker] retiring inputs no surface collected failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.releaseClosedHistory(CLOSED_HISTORY_IDLE_MS);
    // Surfaces that outlived a restart re-register within one heartbeat window;
    // only after it can the stored times say which sessions a dead process left.
    if (Date.now() - this.loadedAt < SURFACE_ROUTE_FRESHNESS_MS) return;
    let orphaned = 0;
    if (!this.bootSweepDone) {
      this.bootSweepDone = true;
      // Close (with the reason, never silently) sessions a dead process left active; see applyBootOrphanSweep for why "active at boot" alone is not the test.
      orphaned = applyBootOrphanSweep(this.sessions, {
        idleEmptyMs: this._idleEmptyMs, idleLongMs: this._idleLongMs,
        isExternallyLive: (session) => this.externalLivenessProbe?.(session) === true,
      }, (event, payload) => this.publishUpdate(event, payload)).length;
    }
    const swept = sweepSharedSessions(
      { sessions: this.sessions, messages: this.messages, inputs: this.inputs },
      {
        idleEmptyMs: this._idleEmptyMs,
        idleLongMs: this._idleLongMs,
        deletionRetentionMs: this._deletionRetentionMs,
        publishUpdate: (event, payload) => this.publishUpdate(event, payload),
        isExternallyLive: (session) => this.externalLivenessProbe?.(session) === true,
      },
    );
    if (swept || orphaned > 0) {
      this.updateActiveSessionsGauge();
      void this.persist().catch((error: unknown) => {
        logger.warn('[session-broker] GC persistence failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}
