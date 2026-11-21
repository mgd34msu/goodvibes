import type { GatePresetName } from '../gate/presets.js';
import { allowedRootFor, outsideAllowedRootsMessage } from './workspace-roots.js';
import type { FailureReadOptions } from '@goodvibes/engine/errors';
import { createHash } from 'node:crypto';
import { captureNativeConversationContinuation, canonicalNativeConversationContinuation, createNativeContinuationSnapshotOwner, type NativeConversationContinuation } from '../workflow/work-ledger/native-continuation-context.js';
import { isDeepStrictEqual } from 'node:util';
import { isValidatedNativeConversationCapture, validatedNativeCaptureContinuation, type NativeConversationCapture } from '../workflow/work-ledger/native-intake-types.js';
import type { NativeSelectedDiffContext } from '../workflow/work-ledger/native-diff-context.js';
const nativeContinuationApply = Reflect.apply, NativeContinuationOwnerMap = WeakMap;
const nativeContinuationGet = WeakMap.prototype.get, nativeContinuationSet = WeakMap.prototype.set;
import { readNativeConversationTurnPermit, type NativeConversationTurnPermit } from '../workflow/work-ledger/native-intake-client.js';
/**
 * manager.ts, the hosted-session engine: lifecycle, policy, durability.
 *
 * ── What a hosted session is ───────────────────────────────────────────────
 *
 * The same conversation loop a terminal runs, composed inside the daemon: the
 * real Orchestrator, the real tool registry rooted at a workspace, the product's
 * own permission manager with its trust gate. session-runtime.ts builds one;
 * workspace-floor.ts shares what a workspace's sessions have in common; this
 * file owns their lives.
 *
 * ── Detach is a policy, and its default preserves what people expect ───────
 *
 * When the last attached client goes away, the effective policy decides: `kill`
 * (the default, and what every surface has always done) terminates the session
 * with the reason `detached`; `survive` leaves it idle and reattachable. The
 * default is the SETTING `hostedSessions.detachPolicy`, and a session may carry
 * its own override chosen at creation. The capability lands; the familiar
 * behavior stays the default.
 *
 * ── Streaming ──────────────────────────────────────────────────────────────
 *
 * Token deltas, tool calls and turn transitions do NOT need a new channel. The
 * Orchestrator already emits them on the runtime bus, stamped with this
 * session's id, and the control-plane SSE stream already forwards every runtime
 * domain a client subscribed to. A client attached to a hosted session watches
 * `turn` and `tools` exactly as it would locally, and filters on the session id
 * it was handed.
 * Native sessions retain those original envelopes in the gateway's existing
 * bounded replay ring even before the first client learns their session id.
 *
 * What was genuinely missing is LIFECYCLE: which hosted sessions exist, when
 * one was created, attached, detached or terminated, and why. That is this
 * engine's own channel (`hosted-session-update`, domain `session`).
 *
 * ── Restart ────────────────────────────────────────────────────────────────
 *
 * A daemon restart is reconciled honestly, never silently. Every restored
 * session is either resumable, restored idle, with a system line in its
 * transcript saying its turn was interrupted, or it is terminated with a named
 * reason. Nothing comes back pretending it never stopped, and nothing
 * disappears without a record.
 */

import { logger } from '../utils/logger.js';
import { forgetVerificationJournal } from '../core/verification/store.js';
import { summarizeError } from '../utils/error-display.js';
import type { AnyRuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope, TurnEvent } from '../runtime/events/index.js';
import type { SessionLiveTurnControls } from '../control-plane/routes/session-runtime.js';
import { resolveHostedModelDefinition } from './model-route.js';
import { createHostedSessionRuntime, newHostedSessionId, type HostedSessionContractSink, type HostedSessionRuntime } from './session-runtime.js';
import type { HostedContractRunners } from '../contract/operator-service.js';
import { HostedWorkspaceFloors, type HostedWorkspaceFloor, type HostedWorkspaceFloorFactory, type HostedWorkspaceFloorLease } from './workspace-floor.js';
import type { HostedDaemonRequestPath, HostedSurfaceTurn, HostedSurfaceTurns } from './surface-turn.js';
import { hostedLifecycleCallbacks } from './lifecycle-callbacks.js';
import { HostedSessionStore, type HostedSessionLoadReport } from './store.js';
import { HostedSessionSpineIntake, type HostedSessionSpine } from './spine-intake.js';
import {
  HOSTED_ATTACHMENT_DEFAULT_LEASE_MS,
  HostedSessionAttachments,
  attachmentSweepIntervalFor,
  clampAttachmentLease,
} from './attachments.js';
export type { HostedSessionSpine } from './spine-intake.js';
import { HostedSessionArgumentError, HostedSessionClientOwnerError, HostedSessionLimitError, HostedSessionNotFoundError, HostedSessionNotReadyError, HostedSessionTerminatedError, HostedSessionUnavailableError } from './errors.js';
export { HostedSessionArgumentError, HostedSessionClientOwnerError, HostedSessionLimitError, HostedSessionNotFoundError, HostedSessionNotReadyError, HostedSessionTerminatedError, HostedSessionUnavailableError } from './errors.js';
import type { HostedContractWorkAdapter } from './contract-work-adapter.js';
import { isTerminalContractStatus } from '../contract/types.js';
import type {
  CreateHostedSessionInput,
  HostedDetachPolicy,
  HostedSessionHistoryMessage,
  HostedSessionLifecycleEvent,
  HostedSessionRecord,
  HostedSessionTerminationReason,
  HostedSessionUpdatePayload,
} from './types.js';

/** The wire event every hosted-session lifecycle notice is published on. */
export const HOSTED_SESSION_WIRE_EVENT = 'hosted-session-update';

/** The subset of the control-plane gateway this engine publishes through. */
export interface HostedSessionEventPublisher {
  publishEvent(event: string, payload: unknown, filter?: { clientId?: string }): void;
  /** Retention only: native turn frames can precede the first attached reader. */
  retainRuntimeEvent?(domain: 'turn' | 'tools', envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): void;
  /**
   * Live control-plane clients, when the publisher is the gateway. Read as the
   * second renewal signal for an attachment lease, see ./attachments.ts.
   */
  listClients?(): readonly { readonly id: string }[];
  /**
   * Whether this client's control-plane connection is open right now. Preferred
   * over `listClients`, which also lists clients that disconnected recently.
   */
  isClientConnected?(clientId: string): boolean;
  /**
   * Told which sessions a principal owns, when the publisher is the gateway:
   * a client holding `read:own-sessions` receives those sessions' frames only.
   */
  setSessionOwnership?(ownedBy: ((sessionId: string, principalId: string) => boolean) | null): void;
}

/** The live settings this engine reads. Read on every use, never cached. */
export interface HostedSessionSettings {
  /** `hostedSessions.detachPolicy`, the default when a session carries no override. */
  detachPolicy(): HostedDetachPolicy;
  /** `hostedSessions.maxSessions`, the cap on LIVE (non-terminated) sessions. */
  maxSessions(): number;
  /** `hostedSessions.attachmentTtlMs`, how long an attachment stands unrenewed. */
  attachmentTtlMs?(): number;
}

/**
 * What the host is told about each session's live conversation, so it can
 * rewind that conversation in place and keep the turn boundaries a rewind cuts at.
 */
export interface HostedSessionConversations {
  /** The session's loop was built (create or rebuild). `save` writes the transcript after a change made outside a turn, such as a rewind. */
  opened(sessionId: string, conversation: HostedSessionRuntime['conversation'], save: () => Promise<void>): void;
  /** One of the session's turns completed; the conversation is as that turn left it. */
  turnCompleted(sessionId: string, turnId: string): void;
  /** The session's loop was taken apart; `ended` when the session was terminated and will not be built again. */
  closed(sessionId: string, ended: boolean): void;
}

/** Per-session live-turn registration, so the session verbs can reach a hosted turn. */
export interface HostedLiveTurnRegistry {
  bindSession(sessionId: string, controls: SessionLiveTurnControls): void;
  unbindSession(sessionId: string, controls: SessionLiveTurnControls): void;
}

export interface HostedSessionManagerOptions {
  readonly failureReading?: FailureReadOptions | undefined;
  readonly floorFactory: HostedWorkspaceFloorFactory;
  /** Fences and drains native dispatch ownership before runtime teardown. */
  readonly closeNativeTurns?: (() => Promise<void>) | undefined;
  readonly store: HostedSessionStore;
  readonly settings: HostedSessionSettings;
  /** The runtime bus turn events are observed on, the daemon's own. */
  readonly runtimeBus: RuntimeEventBus;
  /** The base system prompt for a hosted turn, per session. */
  readonly systemPrompt: (input: { readonly sessionId: string; readonly workspaceRoot: string }) => string;
  /**
   * The product turns this host offers by origin surface (surface-turn.ts): a
   * session created for one of them runs with that surface's tools and prompt,
   * on create and on every rebuild. Omitted, or no entry for the surface ⇒ the
   * platform tools and `systemPrompt`.
   */
  readonly surfaceTurns?: HostedSurfaceTurns | undefined;
  /** Registers each hosted session's live-turn controls; omitted ⇒ the session verbs cannot reach hosted turns. */
  readonly liveTurns?: HostedLiveTurnRegistry | undefined;
  /** Told of each session's live conversation; omitted ⇒ the host cannot rewind a hosted conversation. */
  readonly conversations?: HostedSessionConversations | undefined;
  /** The shared session broker, so hosted sessions appear in `sessions.list`. */
  readonly spine?: HostedSessionSpine | undefined;
  /** The daemon's bearer token, read live, handed to each session's tools for the Cloudflare status. */
  readonly cloudflareAuthToken?: (() => string | null) | undefined;
  /**
   * The owner inbox, handed to each session for its `query` tool. A session that
   * ends settles its questions here: open ones are withdrawn and answers still
   * waiting for it are marked not deliverable, since it cannot be opened again.
   */
  readonly ownerQuestions?: import('./session-runtime.js').HostedSessionRuntimeOptions['ownerQuestions'];
  /** The daemon's trigger supervisor, for each hosted session's `trigger` tool. */
  readonly triggers?: import('./session-runtime.js').HostedSessionRuntimeOptions['triggers'];
  /** The daemon's project work plan, for each hosted session's `work_plan` tool. */
  readonly workPlan?: import('./session-runtime.js').HostedSessionRuntimeOptions['workPlan'];
  /** Whether a workspace root is acceptable. Omitted ⇒ any absolute path. */
  readonly isWorkspaceUsable?: ((workspaceRoot: string) => boolean) | undefined;
  /**
   * The folders work may run in (see workspace-roots.ts), read at each create.
   * A workspaceRoot outside all of them is refused with them named. Omitted ⇒
   * no folder restriction (narrow compositions and tests).
   */
  readonly allowedWorkspaceRoots?: (() => readonly string[]) | undefined;
  /**
   * How often queued inputs are collected and each live session's participant
   * heartbeat is refreshed. Default 750ms, the same order as every other
   * inbound-dispatch client here, and the reason a steer reaches a hosted turn
   * in well under a second rather than on some slower sweep.
   */
  readonly intakeIntervalMs?: number | undefined;
  /** Clock seam for tests. */
  readonly now?: (() => number) | undefined;
  /** How often lapsed attachments are swept. Omitted ⇒ see attachmentSweepIntervalFor. */
  readonly attachmentSweepIntervalMs?: number | undefined;
}

/** What `attach` hands back: the record plus the history a client renders. */
export interface HostedSessionAttachment {
  readonly session: HostedSessionRecord;
  readonly history: readonly HostedSessionHistoryMessage[];
  /**
   * The daemon clock (ms) when `history` was read, present only while no turn
   * is running. Every frame the daemon replays to a new event stream that is
   * stamped at or before this is already in `history`; a running turn's frames
   * may not be, so none is promised then and a client keeps every replayed frame.
   */
  readonly historyAsOf?: number | undefined;
}

interface NativeCheckpointWrite {
  readonly context: NativeConversationContinuation;
  readonly done: Promise<void>;
  /** The conversation revision the saved transcript was taken at. */
  readonly revision: number;
}

interface LiveSession {
  record: HostedSessionRecord;
  /** Composed on demand: a restored session has none until it is attached or driven. */
  runtime: HostedSessionRuntime | null;
  lease: HostedWorkspaceFloorLease | null;
  /** Restored conversation payload, replayed when the runtime is composed. */
  restoredConversation: unknown;
  readonly attached: HostedSessionAttachments;
  /** Admitted setup must settle before its final termination write. */
  initialization: Promise<void> | null;
  composition: Promise<void> | null;
  parking: Promise<void> | null;
  termination: Promise<HostedSessionRecord> | null;
  /** The final transcript is on disk and no longer held in memory; nothing may persist this session again. */
  released?: true;
  /** The session's mode was chosen for it (by its creator or since), not copied from the saved setting. */
  modeChosen?: true;
}

/** How long a native host waiting for its session rechecks without a wake, for a wake that was missed. */
const NATIVE_AVAILABILITY_FALLBACK_MS = 1_000;
const RESTART_NOTICE ='This session was interrupted by a daemon restart. The turn that was running did not finish.';

export class HostedSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly floors: HostedWorkspaceFloors;
  private readonly now: () => number;
  private publisher: HostedSessionEventPublisher | null = null;
  private alerter: ((text: string) => void) | null = null;
  private requestPath: HostedDaemonRequestPath | null = null;
  private busUnsubscribers: (() => void)[] = [];
  /** Waiters for a session's next turn start or end (waitForNativeAvailability). */
  private readonly turnWaiters = new Map<string, Set<() => void>>();
  private disposed = false;
  private disposal: Promise<void> | null = null;
  /** Initial registration and persistence must settle before shutdown saves. */
  private readonly creations = new Set<Promise<HostedSessionRecord>>();
  private lastLoadReport: HostedSessionLoadReport | null = null;
  /** The spine half: registration, heartbeats, and collecting queued inputs. */
  private readonly spine: HostedSessionSpineIntake;
  /** Sweeps attachments whose lease ran out, see ./attachments.ts. */
  private attachmentTimer: ReturnType<typeof setInterval> | null = null;
  private contractWorkAdapter: HostedContractWorkAdapter | null = null;

  constructor(private readonly options: HostedSessionManagerOptions) {
    // A contract a hosted turn starts reads the owner's reads from the live
    // conversation, not from the saved transcript, which trails it by a turn.
    this.floors = new HostedWorkspaceFloors(options.floorFactory,
      (sessionId) => this.sessions.get(sessionId)?.runtime?.conversation.readMessagesInPlace());
    this.now = options.now ?? ((): number => Date.now());
    this.spine = new HostedSessionSpineIntake({
      failureReading: options.failureReading,
      ...(options.spine === undefined ? {} : { spine: options.spine }),
      ...(options.intakeIntervalMs === undefined ? {} : { intervalMs: options.intakeIntervalMs }),
      liveSessions: () => this.list(),
      withLifecycle: (sessionId, callback) => {
        const live = this.sessions.get(sessionId);
        return hostedLifecycleCallbacks.run(this, () => live
          ? hostedLifecycleCallbacks.run(live, callback)
          : callback());
      },
      deliver: (sessionId, text, correlationId, delivery) => this.deliver(sessionId, text, correlationId, delivery),
      now: () => this.now(),
      alertOwner: (text) => this.alerter?.(text),
    });
  }

  /** The product turn a session created for `originSurface` runs as, spread into its runtime options. */
  private surfaceTurnFor(originSurface: string | undefined): { readonly surfaceTurn?: HostedSurfaceTurn; readonly daemonRequests?: HostedDaemonRequestPath } {
    const turn = originSurface ? this.options.surfaceTurns?.[originSurface] : undefined;
    if (!turn) return {};
    return this.requestPath ? { surfaceTurn: turn, daemonRequests: this.requestPath } : { surfaceTurn: turn };
  }

  /** Where an incident nobody is attached to see goes. Wired by the daemon. */
  setOwnerAlerter(alerter: ((text: string) => void) | null): void {
    this.alerter = alerter;
  }

  /** The daemon's own request path, handed to a surface turn's tools. Wired by the daemon before sessions are restored. */
  setRequestPath(path: HostedDaemonRequestPath | null): void {
    this.requestPath = path;
  }

  /** The configured attachment lease, clamped. Read live, never cached. */
  private attachmentLeaseMs(): number {
    return clampAttachmentLease(this.options.settings.attachmentTtlMs?.(), HOSTED_ATTACHMENT_DEFAULT_LEASE_MS);
  }

  /** Where lifecycle notices go. Wired by the composition that owns the gateway. */
  setEventPublisher(publisher: HostedSessionEventPublisher | null): void {
    this.publisher?.setSessionOwnership?.(null);
    this.publisher = publisher;
    publisher?.setSessionOwnership?.((sessionId, principalId) => this.isOwnedBy(sessionId, principalId));
  }

  /**
   * Restore from disk and reconcile. Returns the load report so the caller can
   * state what happened rather than leaving it in a log line.
   */
  async init(): Promise<HostedSessionLoadReport> {
    const report = await this.options.store.load(this.now());
    this.lastLoadReport = report;
    for (const persisted of report.restored) {
      const restored = this.reconcileRestored(persisted.record);
      this.sessions.set(restored.record.id, {
        record: restored.record,
        runtime: null,
        lease: null,
        restoredConversation: persisted.conversation,
        attached: new HostedSessionAttachments(persisted.owners ?? []),
        initialization: null, composition: null, parking: null, termination: null,
        ...(persisted.permissionModeChosen === true ? { modeChosen: true as const } : {}),
      });
      if (restored.terminated) {
        // Persist the reconciliation so the next restart does not repeat it.
        await this.persist(restored.record);
        this.settleOwnerQuestions(restored.record);
      }
      const restoredLive = this.sessions.get(restored.record.id);
      if (restoredLive && restored.record.status === 'terminated') this.releaseTranscript(restoredLive);
      this.publish(restored.terminated ? 'hosted-session-terminated' : 'hosted-session-restored', restored.record, {
        detail: restored.detail,
      });
    }
    for (const record of report.evictedLive ?? []) {
      this.publish('hosted-session-terminated', record, {
        detail: 'more sessions were stored than hostedSessions.maxSessions allows, and this was the least recently used',
      });
    }
    this.observeTurnEvents();
    this.spine.start();
    this.startAttachmentSweep();
    if (report.rejected.length > 0 || report.swept.length > 0 || report.evicted.length > 0) {
      logger.info('[hosted-sessions] restored persisted sessions', {
        restored: report.restored.length,
        rejected: report.rejected.length,
        swept: report.swept.length,
        evicted: report.evicted.length,
        rejectedFiles: report.rejected.map((entry) => `${entry.file}: ${entry.reason}`),
      });
    }
    return report;
  }

  /** A session that ended cannot be opened again: what it asked the owner is settled, saying why. */
  private settleOwnerQuestions(record: HostedSessionRecord): void {
    try {
      this.options.ownerQuestions?.settleSession(record.id, `hosted session ${record.id} was ended (${record.terminatedReason ?? 'terminated'})`);
    } catch (error) {
      logger.warn('[hosted-sessions] the owner inbox could not settle an ended session\'s questions; they read as waiting', {
        sessionId: record.id,
        error: summarizeError(error),
      });
    }
  }

  /** The last load report, for status surfaces. Null before `init`. */
  loadReport(): HostedSessionLoadReport | null {
    return this.lastLoadReport;
  }

  /**
   * Decide what a record restored from disk becomes.
   *
   * A session that was alive when the process stopped is resumable only when
   * its effective policy says it should have survived. Anything else is
   * terminated with the reason that actually applies.
   */
  private reconcileRestored(record: HostedSessionRecord): {
    record: HostedSessionRecord;
    terminated: boolean;
    detail: string;
  } {
    const at = this.now();
    if (record.status === 'terminated') {
      return { record: { ...record, restoredFromDisk: true }, terminated: false, detail: 'already terminated' };
    }
    const effective = this.effectivePolicy(record.detachPolicy);
    if (effective === 'kill') {
      return {
        record: {
          ...record,
          status: 'terminated',
          terminatedAt: at,
          terminatedReason: 'daemon-shutdown',
          attachedClients: [],
          effectiveDetachPolicy: effective,
          updatedAt: at,
          restoredFromDisk: true,
        },
        terminated: true,
        detail: 'the daemon restarted and this session\'s detach policy is kill',
      };
    }
    return {
      record: {
        ...record,
        status: 'idle',
        attachedClients: [],
        effectiveDetachPolicy: effective,
        updatedAt: at,
        restoredFromDisk: true,
      },
      terminated: false,
      detail: record.status === 'running' ? 'restored idle; its in-flight turn did not survive the restart' : 'restored idle',
    };
  }

  /** The policy that applies to a session right now. */
  private effectivePolicy(override: HostedDetachPolicy | null): HostedDetachPolicy {
    return override ?? this.options.settings.detachPolicy();
  }

  /** Every hosted session, newest first. Terminated ones only when asked for. */
  list(options?: { readonly includeTerminated?: boolean | undefined }): readonly HostedSessionRecord[] {
    const includeTerminated = options?.includeTerminated === true;
    return [...this.sessions.values()]
      .map((live) => this.refreshEffective(live))
      .filter((record) => includeTerminated || record.status !== 'terminated')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** One record, or null. */
  get(sessionId: string): HostedSessionRecord | null {
    const live = this.sessions.get(sessionId);
    return live ? this.refreshEffective(live) : null;
  }

  /** Whether this engine hosts a live (non-terminated) session with this id. */
  hosts(sessionId: string): boolean {
    const live = this.sessions.get(sessionId);
    return live !== undefined && live.record.status !== 'terminated';
  }

  /** What a session's loop reports about its contracts (session-contracts.ts): the record lists them, and a line said is persisted and announced. */
  private sessionContracts(sessionId: string): HostedSessionContractSink {
    const change = (update: (record: HostedSessionRecord) => HostedSessionRecord, event: HostedSessionLifecycleEvent, detail: string): void => {
      const live = this.sessions.get(sessionId);
      if (!live || live.record.status === 'terminated') return;
      live.record = update({ ...live.record, updatedAt: this.now() });
      this.publish(event, live.record, { detail });
      void this.persist(live.record);
    };
    return {
      contractIds: () => this.sessions.get(sessionId)?.record.contractIds ?? [],
      started: (contractId) => change((record) => ({ ...record, contractIds: [...record.contractIds, contractId] }), 'hosted-session-contract-started', contractId),
      said: (line) => change((record) => ({ ...record, messageCount: this.sessions.get(sessionId)?.runtime?.conversation.getMessageCount() ?? record.messageCount }), 'hosted-session-contract-notice', line),
    };
  }

  /** The agent managers of the live workspace floors: their workers, for the daemon's fleet. */
  fleetAgentManagers(): readonly HostedWorkspaceFloor['services']['agentManager'][] {
    return this.floors.floors().map((floor) => floor.services.agentManager);
  }

  /** The contracts operator surface's view of this engine (contract/operator-service.ts): every floor's runner, and a live session's. */
  contractRunners(): HostedContractRunners {
    return {
      runners: () => this.floors.floors().map((floor) => floor.contractRunner),
      knows: (sessionId) => this.sessions.has(sessionId),
      ownedByOthers: (sessionId, principalId) => this.sessions.get(sessionId)?.attached.ownedByOthers(principalId) === true,
      forSession: async (sessionId) => {
        const live = this.sessions.get(sessionId);
        if (!live || live.record.status === 'terminated') return null;
        await this.ensureComposed(live);
        this.assertSessionUsable(live);
        if (!live.lease) return null;
        const registry = live.lease.floor.services.providerRegistry;
        return { runner: live.lease.floor.contractRunner, workspaceRoot: live.record.workspaceRoot,
          selectedModel: live.record.modelId ? resolveHostedModelDefinition(registry, live.record.modelId) : registry.getCurrentModel(),
        };
      },
    };
  }

  /**
   * The external work adapter over this engine (contract-work-adapter.ts): a
   * dispatch runs its contract in a hosted session, created for it unless the
   * request names one. Null until the daemon composition attaches it.
   */
  contractWork(): HostedContractWorkAdapter | null {
    return this.contractWorkAdapter;
  }

  /** Wired once by the daemon composition; released when this engine stops. */
  attachContractWork(adapter: HostedContractWorkAdapter): void {
    this.contractWorkAdapter?.close();
    this.contractWorkAdapter = adapter;
  }

  /** The live-turn controls for a hosted session, when its loop is composed. */
  liveTurnControls(sessionId: string): SessionLiveTurnControls | null {
    return this.sessions.get(sessionId)?.runtime?.liveTurnControls ?? null;
  }

  private refreshEffective(live: LiveSession): HostedSessionRecord {
    const effective = this.effectivePolicy(live.record.detachPolicy);
    if (effective !== live.record.effectiveDetachPolicy) {
      live.record = { ...live.record, effectiveDetachPolicy: effective };
    }
    return live.record;
  }

  private async savePermissionMode(sessionId: string, permissionMode: GatePresetName): Promise<void> {
    const live = this.requireLive(sessionId);
    this.assertSessionUsable(live);
    live.record = { ...live.record, permissionMode, updatedAt: this.now() };
    live.modeChosen = true;
    // An acknowledged mode change must survive restart. Unlike routine history
    // snapshots, failure is returned to the operator rather than logged away.
    await this.saveDurably(live, live.runtime?.conversation.toJSON() ?? live.restoredConversation);
    this.assertSessionUsable(live);
  }

  /** Create a hosted session and compose its loop. */
  async create(input: CreateHostedSessionInput, ownership?: { readonly nativeConversation: true; readonly permissionMode?: GatePresetName }): Promise<HostedSessionRecord> {
    this.assertUsable();
    // Own the operation before a factory, registration, or saver can request
    // shutdown. Its final write must never land after shutdown's final record.
    const creation = Promise.resolve().then(() => this.createSession(input, ownership));
    this.creations.add(creation);
    try {
      return await creation;
    } finally {
      this.creations.delete(creation);
    }
  }

  private async createSession(input: CreateHostedSessionInput, ownership?: { readonly nativeConversation: true; readonly permissionMode?: GatePresetName }): Promise<HostedSessionRecord> {
    this.assertUsable();
    const workspaceRoot = this.requireWorkspace(input.workspaceRoot);
    this.assertSessionCapacity();

    const sessionId = newHostedSessionId();
    let lease: HostedWorkspaceFloorLease;
    try {
      lease = await this.floors.acquire(workspaceRoot);
    } catch (error) {
      // Shutdown keeps its own refusal; a floor that could not be built is a
      // refusal that names the workspace and what to check.
      this.assertUsable();
      // A wrapper the floor factory wrote names the step; the cause gives only
      // its name and errno-style code, since its message can carry settings values.
      const wrapped = error instanceof Error && error.cause !== undefined;
      const cause = wrapped ? (error as Error).cause : error;
      const code = cause !== null && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
      logger.warn('[hosted-sessions] the workspace floor for a new session could not be built', {
        workspaceRoot, ...(wrapped ? { step: (error as Error).message } : {}),
        name: cause instanceof Error ? cause.name : typeof cause, ...(code === undefined ? {} : { code }),
      });
      throw new HostedSessionUnavailableError(sessionId, `provider setup failed for ${workspaceRoot}; check the provider settings for that workspace, then create the session again`);
    }
    let live: LiveSession;
    try {
      // A factory may await provider readiness while shutdown or another create
      // changes admission. The lease alone does not authorize a new session.
      this.assertUsable();
      this.assertSessionCapacity();
      const model = input.modelId
        ? resolveHostedModelDefinition(lease.floor.services.providerRegistry, input.modelId)
        : undefined;
      const at = this.now();
      const runtime = createHostedSessionRuntime({
        sessionId, workspaceRoot, floor: lease.floor,
        ...(ownership?.permissionMode === undefined ? {} : { permissionMode: ownership.permissionMode }),
        systemPrompt: this.options.systemPrompt({ sessionId, workspaceRoot }),
        ...(model === undefined ? {} : { model }),
        ...(input.originSurface ? { originSurface: input.originSurface } : {}),
        ...this.surfaceTurnFor(input.originSurface),
        contracts: this.sessionContracts(sessionId),
        isSessionResumable: token => this.isSessionHeld(token),
        permissionModeChanged: mode => this.savePermissionMode(sessionId, mode),
        ...(this.options.cloudflareAuthToken ? { cloudflareAuthToken: this.options.cloudflareAuthToken } : {}),
        ...(this.options.ownerQuestions ? { ownerQuestions: this.options.ownerQuestions } : {}),
        ...(this.options.triggers ? { triggers: this.options.triggers } : {}),
        ...(this.options.workPlan ? { workPlan: this.options.workPlan } : {}),
        attended: () => this.hasAttachedClient(sessionId),
        busyEnded: () => this.wakeTurnWaiters(sessionId),
      });
      const record: HostedSessionRecord = {
        id: sessionId,
        ...(ownership?.nativeConversation ? { nativeConversation: true as const } : {}),
        workspaceRoot,
        title: input.title?.trim() || defaultTitle(input, workspaceRoot),
        status: 'idle',
        detachPolicy: input.detachPolicy ?? null,
        effectiveDetachPolicy: this.effectivePolicy(input.detachPolicy ?? null),
        attachedClients: input.clientId ? [input.clientId] : [],
        ...(model ? { providerId: model.provider, modelId: model.registryKey } : {}),
        createdAt: at, updatedAt: at, turnCount: 0, messageCount: 0,
        restoredFromDisk: false,
        ...(input.originSurface ? { originSurface: input.originSurface } : {}),
        contractIds: [],
        permissionMode: runtime.liveTurnControls.getPermissionMode(),
      };
      live = {
        record,
        runtime,
        lease,
        restoredConversation: null,
        attached: new HostedSessionAttachments(input.principalId === undefined ? [] : [input.principalId]),
        initialization: null, composition: null, parking: null, termination: null,
        ...(ownership?.permissionMode === undefined ? {} : { modeChosen: true as const }),
      };
      if (input.clientId) live.attached.renew(input.clientId, at, this.attachmentLeaseMs(), input.principalId);
      this.sessions.set(sessionId, live);
    } catch (error) {
      lease.release();
      throw error;
    }

    let nativeSaveFailed = false;
    // Own setup before binding, registration, or persistence calls product code.
    const initialization = Promise.resolve().then(() => hostedLifecycleCallbacks.run(this, () =>
      hostedLifecycleCallbacks.run(live, async () => {
        this.assertSessionUsable(live);
        this.options.liveTurns?.bindSession(sessionId, live.runtime!.liveTurnControls);
        this.options.conversations?.opened(sessionId, live.runtime!.conversation, () => this.saveConversation(sessionId));
        this.assertSessionUsable(live);
        await this.spine.register(live.record);
        this.assertSessionUsable(live);
        if (ownership?.nativeConversation) {
          try {
            await this.saveDurably(live, live.runtime?.conversation.toJSON() ?? null);
          } catch (error) {
            nativeSaveFailed = true;
            throw error;
          }
        } else await this.persist(live.record);
        this.assertSessionUsable(live);
      }),
    ));
    live.initialization = initialization;
    try {
      await initialization;
    } catch (error) {
      // The failed setup has settled. Its own cleanup must not await itself.
      if (nativeSaveFailed) {
        await this.terminate(live, 'killed', 'Native session initialization durability failed').catch(() => {});
      }
      throw error;
    } finally {
      live.initialization = null;
    }
    this.assertSessionUsable(live);
    this.publish('hosted-session-created', live.record, { ...(input.clientId ? { clientId: input.clientId } : {}) });

    this.assertSessionUsable(live);
    if (input.initialPrompt && input.initialPrompt.trim().length > 0) {
      // Not awaited: create returns the record, and the turn's progress is on
      // the event stream. A failure before the loop reports its own turn error
      // (the loop could not be composed, the engine was disposed) is logged and
      // published here, so the first prompt is never lost without a trace.
      // The create call itself was authenticated at the gateway: an operator's input.
      void this.deliver(sessionId, input.initialPrompt, undefined, { operatorInput: true }).catch((error: unknown) => {
        const detail = `the first prompt was not delivered: ${summarizeError(error)}`;
        logger.warn('[hosted-sessions] the initial prompt of a new session was not delivered', { sessionId, error: summarizeError(error) });
        this.publish('hosted-session-turn-ended', live.record, { detail });
      });
    }
    this.assertSessionUsable(live);
    return live.record;
  }

  private assertSessionCapacity(): void {
    const liveCount = this.list().length;
    const maxSessions = this.options.settings.maxSessions();
    if (liveCount >= maxSessions) {
      throw new HostedSessionLimitError(
        `This daemon already hosts ${liveCount} sessions, the configured maximum (hostedSessions.maxSessions). Kill one, or raise the setting.`,
      );
    }
  }

  /** Whether a client holds an attachment to the session now, so a person there can be asked. */
  private hasAttachedClient(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.attached.size ?? 0) > 0;
  }

  /**
   * Attach a client. Composes the loop when the session came back from disk,
   * and hands back the history so the client can render what it missed.
   */
  async attach(
    sessionId: string,
    clientId: string,
    options?: { readonly leaseMs?: number | undefined; readonly principalId?: string | undefined },
  ): Promise<HostedSessionAttachment> {
    const live = this.requireLive(sessionId);
    await this.ensureComposed(live);
    this.assertSessionUsable(live);
    if (live.attached.ownedByAnother(clientId, options?.principalId)) throw new HostedSessionClientOwnerError(sessionId, clientId);
    // Attaching again is how a client renews: the call was always idempotent,
    // and this is the same "polling renews the lease" shape the rewind host
    // registration uses. See ./attachments.ts. Attaching does not make the
    // caller an owner: owners grow only by create and share.
    live.attached.renew(clientId, this.now(), clampAttachmentLease(options?.leaseMs, this.attachmentLeaseMs()), options?.principalId);
    live.record = {
      ...live.record,
      attachedClients: live.attached.clientIds(),
      updatedAt: this.now(),
    };
    this.publish('hosted-session-attached', live.record, { clientId });
    const history = this.history(live);
    if (live.runtime?.isRunning()) return { session: live.record, history };
    return { session: live.record, history, historyAsOf: this.now() };
  }

  /**
   * Detach a client and apply the policy when it was the last one.
   *
   * Returns the record as it stands afterwards, terminated when the policy
   * said kill, idle and reattachable when it said survive.
   */
  async detach(sessionId: string, clientId: string, principalId?: string): Promise<HostedSessionRecord> {
    const live = this.requireKnown(sessionId);
    if (live.attached.ownedByAnother(clientId, principalId)) throw new HostedSessionClientOwnerError(sessionId, clientId);
    if (live.termination) return await this.terminate(live, 'detached', 'the last client detached');
    // A client that was never attached changes nothing: naming an id is not
    // the same as being the last attached client leaving.
    if (!live.attached.delete(clientId)) return live.record;
    return await this.afterDetach(live, clientId);
  }

  /** The record's side of a detach whose lease entry has already been removed. */
  private async afterDetach(live: LiveSession, clientId: string): Promise<HostedSessionRecord> {
    if (live.termination) return await this.terminate(live, 'detached', 'the last client detached');
    live.record = { ...live.record, attachedClients: live.attached.clientIds(), updatedAt: this.now() };
    this.publish('hosted-session-detached', live.record, { clientId });
    if (live.attached.size > 0 || live.record.status === 'terminated') {
      await this.persist(live.record);
      return live.record;
    }
    const policy = this.effectivePolicy(live.record.detachPolicy);
    if (policy === 'kill') {
      return await this.terminate(live, 'detached', 'the last client detached and the effective policy is kill');
    }
    live.record = { ...live.record, effectiveDetachPolicy: policy };
    await this.persist(live.record);
    return live.record;
  }

  /** Begin expiring attachments nobody renewed. Idempotent. */
  private startAttachmentSweep(): void {
    if (this.attachmentTimer) return;
    const interval = this.options.attachmentSweepIntervalMs ?? attachmentSweepIntervalFor(this.attachmentLeaseMs());
    this.attachmentTimer = setInterval(() => { void this.reapAttachments(); }, interval);
    (this.attachmentTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * One sweep. A lapsed attachment goes through `detach` rather than being
   * removed quietly: the client did leave, it just never said so, and the
   * session's own policy decides whether that ends it. Public so a test can
   * drive it without waiting on a timer.
   */
  async reapAttachments(): Promise<void> {
    await this.retireTerminated();
    const publisher = this.publisher;
    const connected = publisher?.isClientConnected
      ? (clientId: string): boolean => publisher.isClientConnected!(clientId)
      : publisher?.listClients
        ? (clientId: string): boolean => publisher.listClients!().some((client) => client.id === clientId)
        : undefined;
    for (const live of [...this.sessions.values()]) {
      if (live.record.status === 'terminated') continue;
      for (const clientId of live.attached.expire(this.now(), this.attachmentLeaseMs(), connected)) {
        logger.info('[hosted-sessions] an attachment lapsed without renewal; treating it as a detach', {
          sessionId: live.record.id,
          clientId,
        });
        await this.afterDetach(live, clientId).catch(() => undefined);
      }
      await this.endIfUnattended(live);
    }
  }

  /**
   * End a kill-policy session that no client is attached to once it has sat
   * idle for one attachment lease. "The last client detached" never happens to
   * a session created without a client, so without this it held a workspace
   * floor and a slot until the daemon stopped while its record said it dies on
   * detach. Work still owed to the session keeps it: a running or queued turn,
   * an input not yet delivered, a contract it started that has not settled.
   */
  private async endIfUnattended(live: LiveSession): Promise<void> {
    if (live.record.status !== 'idle' || live.attached.size > 0) return;
    if (live.termination || live.initialization || live.composition || live.parking) return;
    if (this.effectivePolicy(live.record.detachPolicy) !== 'kill') return;
    if (this.now() - live.record.updatedAt < this.attachmentLeaseMs()) return;
    if (live.runtime?.isRunning() || this.spine.hasOutstanding(live.record.id)) return;
    const runner = live.lease?.floor.contractRunner;
    if (runner && live.record.contractIds.some((id) => {
      const contract = runner.get(id);
      return contract !== null && !isTerminalContractStatus(contract.status);
    })) return;
    await this.terminate(live, 'detached', 'no client attached within the attachment lease and the effective policy is kill').catch(() => undefined);
  }

  /**
   * Forget terminated sessions that have outlived `hostedSessions.terminatedRetentionMs`:
   * the store removes the file, and the engine drops the record and what it
   * kept for the session. A retired id is then simply not found.
   */
  private async retireTerminated(): Promise<void> {
    const candidates = [...this.sessions.values()].filter((live) => live.released === true && live.record.status === 'terminated');
    if (candidates.length === 0) return;
    const retired = await this.options.store.sweep(candidates.map((live) => live.record), this.now());
    for (const sessionId of retired) {
      // The verification journal holds the session's tool output and file contents; it goes with the transcript.
      forgetVerificationJournal(this.sessions.get(sessionId)?.record.workspaceRoot, sessionId);
      this.sessions.delete(sessionId);
      this.nativeCheckpoints.delete(sessionId);
      this.nativeCheckpointWrites.delete(sessionId);
      this.nativeDurable.delete(sessionId);
      this.spine.forget(sessionId);
    }
    if (retired.length > 0) logger.info('[hosted-sessions] retired terminated sessions past their retention', { count: retired.length });
  }

  /** A terminated session's transcript is on disk; stop holding it, and stop anything rewriting the file. */
  private releaseTranscript(live: LiveSession): void {
    live.restoredConversation = null;
    live.released = true;
    this.nativeCheckpoints.delete(live.record.id);
    this.nativeCheckpointWrites.delete(live.record.id);
    this.nativeDurable.delete(live.record.id);
  }

  /** End a hosted session on request. */
  async kill(sessionId: string, reason: HostedSessionTerminationReason = 'killed'): Promise<HostedSessionRecord> {
    const live = this.requireKnown(sessionId);
    return await this.terminate(live, reason, 'terminated on request');
  }

  /**
   * Drive a turn on a hosted session: the path `sessions.steer` /
   * `sessions.followUp` reach, and the one `create`'s initial prompt uses.
   * `operatorInput` marks input an authenticated operator sent; it starts the
   * session's next untrusted-content turn (session-runtime.ts).
   * `answersContractQuestion` sends it as the answer to that open contract question.
   */
  async deliver(sessionId: string, text: string, correlationId?: string, delivery?: { readonly operatorInput?: boolean | undefined; readonly answersContractQuestion?: string | undefined }): Promise<void> {
    const live = this.requireLive(sessionId);
    await this.ensureComposed(live);
    this.assertSessionUsable(live);
    const runtime = live.runtime;
    if (!runtime) throw new HostedSessionUnavailableError(sessionId, 'its loop could not be composed');
    try {
      await runtime.submit(text, correlationId, delivery);
    } finally {
      live.record = {
        ...live.record,
        messageCount: runtime.conversation.getMessageCount(),
        updatedAt: this.now(),
      };
      await this.persist(live.record);
    }
  }

  /** Dedicated native path: exact broker input, real permit, no ordinary queue/retry. */
  async deliverNative(sessionId: string, inputId: string, permit: NativeConversationTurnPermit): Promise<void> {
    const source = readNativeConversationTurnPermit(permit);
    const live = this.requireLive(sessionId);
    await this.ensureComposed(live);
    this.assertSessionUsable(live);
    const input = this.options.spine?.getInputsSince(sessionId, {}).find(value => value.id === inputId);
    if (!input || input.state !== 'delivered' || input.body !== source.text || input.correlationId !== `session-input:${inputId}`
      || JSON.stringify(input.metadata?.['nativeConversation']) !== JSON.stringify({ projectId: source.projectId, requestId: source.requestId, sourceRef: source.sourceRef })
      || !live.runtime) throw new Error('Native hosted broker identity mismatch');
    if (source.continuation) {
      if (source.continuation.sessionId !== sessionId) throw new Error('Native continuation session mismatch');
      this.assertNativeContinuation(source.continuation, permit);
    }
    if (!this.nativeCheckpoints.has(sessionId)) this.checkpointNative(live);
    const before = this.nativeCheckpointWrites.get(sessionId);
    await live.runtime.submitNative(permit, input.id, input.correlationId);
    live.record = { ...live.record, messageCount: live.runtime.conversation.getMessageCount(), updatedAt: this.now() };
    // Unlike ordinary best-effort persistence, this failure prevents a completion receipt.
    // A completed turn was already saved durably when it ended; wait for that
    // save instead of writing the same transcript a second time.
    const completed = this.nativeCheckpointWrites.get(sessionId);
    if (completed && completed !== before && completed.revision === live.runtime.conversation.revisionSource.revision()) await completed.done;
    else await this.saveNativeTranscript(live);
    if (!live.runtime.isRunning()) {
      try { this.checkpointNative(live); }
      catch { this.nativeCheckpoints.set(sessionId, null); }
    }
  }

  /** Native owner cancellation interrupts only its exact hosted session. True only when that turn was still running and was aborted. */
  cancelNative(sessionId: string, permit: NativeConversationTurnPermit): boolean { return this.sessions.get(sessionId)?.runtime?.cancelNative(permit) ?? false; }

  /** The conversation as a client renders it. Empty for a session with no loop yet. */
  /** Only completed, durably stored turn checkpoints may become admission context. */
  private readonly nativeCheckpoints = new Map<string, NativeConversationContinuation | null>();
  private readonly nativeCheckpointWrites = new Map<string, NativeCheckpointWrite>();
  /** The last transcript this process saved durably, by conversation revision. */
  private readonly nativeDurable = new Map<string, { readonly revision: number; readonly context: NativeConversationContinuation | null }>();

  private async saveNativeTranscript(live: LiveSession, context: NativeConversationContinuation | null = null): Promise<void> {
    const runtime = live.runtime;
    const revision = runtime?.conversation.revisionSource.revision();
    await this.saveDurably(live, runtime?.conversation.toJSON() ?? null);
    if (revision !== undefined) this.nativeDurable.set(live.record.id, { revision, context });
  }

  private readonly nativeContinuationOwners = new NativeContinuationOwnerMap<LiveSession, ReturnType<typeof createNativeContinuationSnapshotOwner>>();
  private continuationOwner(live: LiveSession) {
    let owner = nativeContinuationApply(nativeContinuationGet, this.nativeContinuationOwners, [live]) as ReturnType<typeof createNativeContinuationSnapshotOwner> | undefined;
    if (!owner) { owner = createNativeContinuationSnapshotOwner(); nativeContinuationApply(nativeContinuationSet, this.nativeContinuationOwners, [live, owner]); }
    return owner;
  }

  private snapshotNative(live: LiveSession): NativeConversationContinuation {
    // Continuation evidence is the transcript text: role and content only.
    const messages = this.history(live).map(({ role, content }) => ({ role, content }));
    const context = this.continuationOwner(live).capture(live.record.id, messages);
    return context;
  }

  private checkpointNative(live: LiveSession): NativeConversationContinuation {
    const context = this.snapshotNative(live);
    this.nativeCheckpoints.set(live.record.id, context);
    this.nativeCheckpointWrites.delete(live.record.id);
    return context;
  }

  /**
   * The terminal event precedes the next queued user append. Snapshot there and
   * save the transcript durably: this is the one save of a completed native
   * turn. True when that save was started, so the caller does not save again.
   */
  private captureCompletedNativeCheckpoint(live: LiveSession): boolean {
    if (!live.runtime || (!live.record.nativeConversation && !this.nativeCheckpoints.has(live.record.id))) return false;
    let context: NativeConversationContinuation;
    try { context = this.snapshotNative(live); }
    catch {
      this.nativeCheckpointWrites.delete(live.record.id);
      this.nativeCheckpoints.set(live.record.id, null);
      return false;
    }
    const sessionId = live.record.id;
    const revision = live.runtime.conversation.revisionSource.revision();
    // toJSON copies the messages, so a later append cannot change what is queued.
    const transcript: unknown = live.runtime.conversation.toJSON();
    let checkpoint!: NativeCheckpointWrite;
    const write = this.saveDurably(live, transcript).then(() => {
      this.nativeDurable.set(sessionId, { revision, context });
      if (this.nativeCheckpointWrites.get(sessionId) === checkpoint) this.nativeCheckpoints.set(sessionId, context);
    }, error => {
      if (this.nativeCheckpointWrites.get(sessionId) === checkpoint) this.nativeCheckpoints.set(sessionId, null);
      throw error;
    });
    checkpoint = { context, done: write, revision };
    this.nativeCheckpointWrites.set(sessionId, checkpoint);
    void write.catch(() => {});
    return true;
  }

  async captureNativeContinuation(sessionId: string): Promise<NativeConversationContinuation> {
    const live = this.requireLive(sessionId);
    await this.ensureComposed(live);
    this.assertSessionUsable(live);
    if (live.runtime?.isRunning()) {
      const pending = this.nativeCheckpointWrites.get(sessionId);
      const previous = pending?.context ?? this.nativeCheckpoints.get(sessionId);
      if (!previous) throw new Error('Native continuation completed checkpoint unavailable');
      await pending?.done;
      this.assertNativeContinuation(previous);
      return captureNativeConversationContinuation(previous);
    }
    // The transcript the last turn saved durably is the continuation while no
    // message has been added since: hand back that snapshot without saving again.
    const revision = live.runtime?.conversation.revisionSource.revision();
    const pending = this.nativeCheckpointWrites.get(sessionId);
    if (pending && pending.revision === revision) { await pending.done; return pending.context; }
    const saved = this.nativeDurable.get(sessionId);
    if (saved?.context && saved.revision === revision) return saved.context;
    // Ordinary completed inputs may have appended since the preceding native
    // checkpoint. Freeze and durably publish the complete idle transcript now;
    // an appended new turn does not rewrite this submission-time snapshot.
    const context = this.snapshotNative(live);
    const completionAtCapture = this.nativeCheckpointWrites.get(sessionId);
    await this.saveNativeTranscript(live, context);
    this.assertNativeContinuation(context);
    if (this.nativeCheckpointWrites.get(sessionId) === completionAtCapture) this.nativeCheckpoints.set(sessionId, context);
    return context;
  }

  assertNativeContinuation(value: NativeConversationContinuation, origin?: NativeConversationCapture | NativeConversationTurnPermit): void {
    const context = captureNativeConversationContinuation(value);
    const live = this.requireLive(context.sessionId);
    let proven = this.continuationOwner(live).owns(context);
    if (!proven && origin) {
      if (isValidatedNativeConversationCapture(origin)) proven = validatedNativeCaptureContinuation(origin, context);
      else { try { proven = isDeepStrictEqual(readNativeConversationTurnPermit(origin).continuation, context); } catch { /* A copied/foreign permit cannot provide the source. */ } }
    }
    // Legacy bare contexts retain their original wire-content verification.
    // V2 needs actual native issuance or validated saved source/turn ownership;
    // a public version flag and matching transcript alone cannot mint it.
    if (!live.runtime || (context.version === 2 ? !proven : !proven && createHash('sha256').update(canonicalNativeConversationContinuation(context.sessionId, context.messages, context.selectedDiff)).digest('hex') !== context.revision)) {
      throw new Error('Native continuation context changed or its original source is unavailable');
    }
    const current = this.history(live);
    if (current.length < context.messages.length || context.messages.some((message, index) =>
      message.role !== current[index]?.role || message.content !== current[index]?.content)) throw new Error('Native continuation prefix changed');
  }

  /** Actual selected-diff derivation keeps the original native transcript
   * owner; arbitrary data/copies cannot become this live session's snapshot. */
  withNativeContinuationDiff(value: NativeConversationContinuation, selectedDiff: NativeSelectedDiffContext): NativeConversationContinuation {
    const context = captureNativeConversationContinuation(value), live = this.requireLive(context.sessionId);
    this.assertNativeContinuation(context);
    return this.continuationOwner(live).withSelectedDiff(context, selectedDiff);
  }

  /** Host FIFO waits for actual runtime ownership, never ordinary queue acceptance. */
  async waitForNativeAvailability(sessionId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const live = this.requireLive(sessionId);
      await this.ensureComposed(live);
      this.assertSessionUsable(live);
      signal.throwIfAborted();
      if (live.runtime && !live.runtime.isRunning() && !live.runtime.orchestrator.isThinking
        && live.runtime.liveTurnControls.listQueuedMessages().length === 0) return;
      // Woken by a turn's start or end event and by the runtime letting go of
      // the session (a submitted turn settled, a queued message deleted); one
      // long fallback covers a missed wake.
      await this.nextTurnChange(sessionId, signal, NATIVE_AVAILABILITY_FALLBACK_MS);
    }
  }

  /** Resolves at the session's next turn start or end, or after `ms`; rejects on abort. */
  private nextTurnChange(sessionId: string, signal: AbortSignal, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let waiters = this.turnWaiters.get(sessionId);
      if (!waiters) { waiters = new Set(); this.turnWaiters.set(sessionId, waiters); }
      const own = waiters;
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        own.delete(wake);
        if (own.size === 0 && this.turnWaiters.get(sessionId) === own) this.turnWaiters.delete(sessionId);
      };
      const wake = (): void => { finish(); resolve(); };
      const abort = (): void => { finish(); reject(signal.reason); };
      const timer = setTimeout(wake, ms);
      timer.unref?.();
      own.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private wakeTurnWaiters(sessionId: string): void {
    const waiters = this.turnWaiters.get(sessionId);
    if (!waiters) return;
    this.turnWaiters.delete(sessionId);
    for (const wake of [...waiters]) wake();
  }

  private history(live: LiveSession): readonly HostedSessionHistoryMessage[] {
    const conversation = live.runtime?.conversation;
    if (conversation) return historyFromMessages(conversation.getMessageSnapshot());
    // Restored from disk and not composed yet: its transcript is the payload it came back with.
    return historyFromConversation(live.restoredConversation);
  }

  /** Read a hosted session's history without attaching. */
  historyOf(sessionId: string): readonly HostedSessionHistoryMessage[] {
    const live = this.sessions.get(sessionId);
    return live ? this.history(live) : [];
  }

  /**
   * Whether `principalId` started this session or an owner shared it with it
   * (its identified owners, which are saved with it and outlive its end and a
   * restart).
   */
  isOwnedBy(sessionId: string, principalId: string | undefined): boolean {
    if (principalId === undefined) return false;
    return this.sessions.get(sessionId)?.attached.identifiedOwners().includes(principalId) === true;
  }

  /** The session's owners (its creator and whoever it was shared with); throws SESSION_NOT_FOUND for an unknown id. */
  ownersOf(sessionId: string): readonly string[] {
    return this.requireKnown(sessionId).attached.identifiedOwners();
  }

  /**
   * Add `principalId` to the session's owners: it may then attach, read the
   * transcript and watch the session's turns live. Who may share is decided by
   * the caller's route (`session.share`, subject the current owners). The new
   * owner is saved with the session, so it survives a restart. One write, only
   * when the principal was not an owner already.
   */
  async share(sessionId: string, principalId: string): Promise<{ readonly session: HostedSessionRecord; readonly owners: readonly string[]; readonly added: boolean }> {
    const live = this.requireKnown(sessionId);
    const added = live.attached.share(principalId);
    if (added) {
      live.record = { ...live.record, updatedAt: this.now() };
      await this.persist(live.record);
    }
    return { session: live.record, owners: live.attached.identifiedOwners(), added };
  }

  /**
   * A session's record and transcript, live or ended. An ended session's
   * transcript is read from the file the store keeps until
   * `hostedSessions.terminatedRetentionMs` retires it, so its reply stays
   * readable after its last client left, its lease lapsed or the daemon
   * restarted. One file read, only for an ended session.
   */
  async readHistory(sessionId: string): Promise<{ readonly session: HostedSessionRecord; readonly history: readonly HostedSessionHistoryMessage[] }> {
    const live = this.requireKnown(sessionId);
    const session = this.refreshEffective(live);
    if (live.runtime || live.restoredConversation) return { session, history: this.history(live) };
    return { session, history: historyFromConversation(await this.options.store.readConversation(sessionId)) };
  }

  /** Compose a restored session's loop on first use, replaying its transcript. */
  private async ensureComposed(live: LiveSession): Promise<void> {
    this.assertSessionUsable(live);
    if (hostedLifecycleCallbacks.active(live) && (live.initialization || live.composition)) {
      throw new HostedSessionUnavailableError(live.record.id, 'its lifecycle callback cannot await its own initialization');
    }
    await live.initialization;
    this.assertSessionUsable(live);
    if (live.runtime) return;
    const composition = live.composition ?? Promise.resolve().then(() => hostedLifecycleCallbacks.run(this, () =>
      hostedLifecycleCallbacks.run(live, () => this.composeSession(live)),
    ));
    live.composition = composition;
    try {
      await composition;
    } catch (error) {
      // Composition has settled before failure cleanup joins termination. A
      // failure that may pass leaves the session restored for the next attempt.
      if (error instanceof HostedSessionNotReadyError) throw error;
      if (!this.disposed && live.record.status !== 'terminated') {
        await this.terminate(live, 'restart-unresumable', `its loop could not be rebuilt: ${summarizeError(error)}`);
      }
      throw error;
    } finally {
      if (live.composition === composition) live.composition = null;
    }
    this.assertSessionUsable(live);
  }

  private async composeSession(live: LiveSession): Promise<void> {
    this.assertSessionUsable(live);
    const workspaceRoot = live.record.workspaceRoot;
    let lease: HostedWorkspaceFloorLease;
    try {
      lease = await this.floors.acquire(workspaceRoot);
    } catch (error) {
      throw new HostedSessionNotReadyError(live.record.id, error, `its workspace floor could not be acquired (${summarizeError(error)})`);
    }
    try {
      this.assertSessionUsable(live);
      // Another restored caller may have finished while this lease was pending.
      // Keep its runtime and return this caller's extra reference.
      if (live.runtime) {
        lease.release();
        return;
      }
      let model: ReturnType<typeof resolveHostedModelDefinition> | undefined;
      try {
        model = live.record.modelId
          ? resolveHostedModelDefinition(lease.floor.services.providerRegistry, live.record.modelId)
          : undefined;
      } catch (error) {
        // The provider registry may simply not be ready yet.
        throw new HostedSessionNotReadyError(live.record.id, error, `its model could not be resolved yet (${summarizeError(error)})`);
      }
      const runtime = createHostedSessionRuntime({
        sessionId: live.record.id, workspaceRoot, floor: lease.floor,
        systemPrompt: this.options.systemPrompt({ sessionId: live.record.id, workspaceRoot }),
        ...(model === undefined ? {} : { model }),
        // Rebuilding as the host would move client-owned settings mid-life.
        ...(live.record.originSurface ? { originSurface: live.record.originSurface } : {}),
        ...this.surfaceTurnFor(live.record.originSurface),
        contracts: this.sessionContracts(live.record.id),
        ...(live.record.permissionMode ? { permissionMode: live.record.permissionMode, permissionModeChosen: live.modeChosen === true } : {}),
        isSessionResumable: token => this.isSessionHeld(token),
        permissionModeChanged: mode => this.savePermissionMode(live.record.id, mode),
        ...(this.options.cloudflareAuthToken ? { cloudflareAuthToken: this.options.cloudflareAuthToken } : {}),
        ...(this.options.ownerQuestions ? { ownerQuestions: this.options.ownerQuestions } : {}),
        ...(this.options.triggers ? { triggers: this.options.triggers } : {}),
        ...(this.options.workPlan ? { workPlan: this.options.workPlan } : {}),
        attended: () => this.hasAttachedClient(live.record.id),
        busyEnded: () => this.wakeTurnWaiters(live.record.id),
      });
      live.runtime = runtime;
      live.lease = lease;
      this.assertSessionUsable(live);
      this.replayConversation(live, runtime);
      this.options.liveTurns?.bindSession(live.record.id, runtime.liveTurnControls);
      this.options.conversations?.opened(live.record.id, runtime.conversation, () => this.saveConversation(live.record.id));
      this.assertSessionUsable(live);
      live.record = {
        ...live.record,
        restoredFromDisk: false,
        permissionMode: runtime.liveTurnControls.getPermissionMode(),
        messageCount: runtime.conversation.getMessageCount(),
        updatedAt: this.now(),
      };
    } catch (error) {
      // Once installed, the session's termination/shutdown owns runtime + lease.
      if (live.lease !== lease) lease.release();
      throw error;
    }
  }

  private replayConversation(live: LiveSession, runtime: HostedSessionRuntime): void {
    const payload = live.restoredConversation;
    if (!payload || typeof payload !== 'object') return;
    try {
      runtime.conversation.fromJSON(payload as Parameters<typeof runtime.conversation.fromJSON>[0]);
      if (live.record.status !== 'terminated') {
        runtime.conversation.addNotice(RESTART_NOTICE, { level: 'warning', kind: 'operational' });
      }
    } catch (error) {
      logger.warn('[hosted-sessions] a restored transcript could not be replayed; the session resumes empty', {
        sessionId: live.record.id,
        error: summarizeError(error),
      });
    } finally {
      live.restoredConversation = null;
    }
  }

  /**
   * Take a session's loop apart, keeping its transcript.
   *
   * The capture is the load-bearing half: `persist` reads the conversation off
   * the live runtime, so disposing first and persisting after would write an
   * empty transcript over a real one, a session that came back from a restart
   * with nothing in it, which is the silent loss this engine exists to avoid.
   */
  private teardownRuntime(live: LiveSession): unknown {
    // Every step runs even when an earlier one throws, so the floor lease is
    // always released and the record can still be persisted. The first
    // failure is returned for the caller to report.
    let firstError: unknown;
    const step = (action: () => void): void => {
      try { action(); } catch (error) { firstError ??= error; }
    };
    const runtime = live.runtime;
    if (runtime) {
      step(() => { live.restoredConversation = runtime.conversation.toJSON(); });
      step(() => runtime.cancel());
      step(() => this.options.liveTurns?.unbindSession(live.record.id, runtime.liveTurnControls));
      step(() => this.options.conversations?.closed(live.record.id, live.record.status === 'terminated'));
      step(() => runtime.dispose());
      live.runtime = null;
    }
    step(() => live.lease?.release());
    live.lease = null;
    return firstError;
  }

  private terminate(
    live: LiveSession,
    reason: HostedSessionTerminationReason,
    detail: string,
  ): Promise<HostedSessionRecord> {
    // Awaiting this drain from an owned callback would await that callback.
    // Refuse honestly; only callers outside that invocation can join completion.
    if (hostedLifecycleCallbacks.active(live)) {
      return Promise.reject(new HostedSessionUnavailableError(live.record.id, 'its lifecycle callback cannot await its own termination'));
    }
    if (live.termination) return live.termination;
    if (live.record.status === 'terminated') return Promise.resolve(live.record);
    const at = this.now();
    // Fence synchronously, before yielding or entering any product callback.
    live.record = {
      ...live.record,
      status: 'terminated',
      attachedClients: [],
      terminatedAt: at,
      terminatedReason: reason,
      updatedAt: at,
    };
    this.spine.fence(live.record.id);
    const termination = Promise.resolve().then(() => hostedLifecycleCallbacks.run(this, () =>
      hostedLifecycleCallbacks.run(live, async () => {
        await Promise.allSettled([live.initialization, live.composition, live.parking]);
        await this.spine.drainRegistrations(live.record.id);
        const teardownError = this.teardownRuntime(live);
        if (teardownError !== undefined) {
          logger.warn('[hosted-sessions] taking a session apart reported an error; it is terminated regardless', {
            sessionId: live.record.id,
            error: summarizeError(teardownError),
          });
        }
        live.attached.clear();
        await this.persist(live.record);
        this.releaseTranscript(live);
        await this.spine.close(live.record.id);
        this.settleOwnerQuestions(live.record);
        this.publish('hosted-session-terminated', live.record, {
          detail: teardownError === undefined ? detail : `${detail}; its loop reported an error while stopping: ${summarizeError(teardownError)}`,
        });
        return live.record;
      }),
    ));
    live.termination = termination;
    void termination.catch(() => {});
    return termination;
  }

  /**
   * Turn transitions, observed on the shared bus and attributed by session id.
   *
   * The engine does not wrap the orchestrator to learn this: the events it
   * already emits are the truth, and reading them keeps one source rather than
   * two that can disagree.
   */
  private observeTurnEvents(): void {
    const bus = this.options.runtimeBus;
    // A native start can submit its turn before the caller learns the session
    // id and opens SSE. Keep the original envelopes in the gateway's bounded
    // replay ring; never re-emit them or invent a render/correlation identity.
    for (const domain of ['turn', 'tools'] as const) {
      this.busUnsubscribers.push(bus.onDomain(domain, (envelope) => {
        if (this.disposed || !envelope.sessionId) return;
        const live = this.sessions.get(envelope.sessionId);
        if (!live?.record.nativeConversation || live.record.status === 'terminated') return;
        this.publisher?.retainRuntimeEvent?.(domain, envelope);
      }));
    }
    // Turn ids each session has submitted and not yet ended. A turn whose only
    // terminal event is PREFLIGHT_FAIL ends the session's run only when that
    // id was submitted; a rejected duplicate submission reports its own fresh
    // id while the real turn keeps running.
    const openTurns = new Map<string, Set<string>>();
    const opened = (sessionId: string): Set<string> => {
      let turns = openTurns.get(sessionId);
      if (!turns) { turns = new Set(); openTurns.set(sessionId, turns); }
      return turns;
    };
    const mark = (sessionId: string | undefined, status: 'running' | 'idle', event: HostedSessionLifecycleEvent, detail: string, turnId?: string): void => {
      if (!sessionId) return;
      // A queued native turn rechecks availability now (waitForNativeAvailability), after the record below is updated.
      queueMicrotask(() => this.wakeTurnWaiters(sessionId));
      const live = this.sessions.get(sessionId);
      if (!live || live.record.status === 'terminated') { openTurns.delete(sessionId); return; }
      if (status === 'running' && turnId !== undefined) opened(sessionId).add(turnId);
      else if (status === 'idle' && turnId !== undefined) {
        const turns = opened(sessionId);
        turns.delete(turnId);
        if (turns.size > 0) return;
        openTurns.delete(sessionId);
      } else if (status === 'idle') openTurns.delete(sessionId);
      // A turn ends only once: an end event for a session that is not running
      // (a second end event for one turn, a stray cancel) counts nothing and
      // publishes nothing. A start on a running session is a re-assertion.
      if (status === 'idle' && live.record.status !== 'running') return;
      live.record = {
        ...live.record,
        status,
        updatedAt: this.now(),
        ...(status === 'idle'
          ? { turnCount: live.record.turnCount + 1, lastTurnAt: this.now(), messageCount: live.runtime?.conversation.getMessageCount() ?? live.record.messageCount }
          : {}),
      };
      const savedDurably = status === 'idle' && detail === 'completed' && this.captureCompletedNativeCheckpoint(live);
      this.publish(event, live.record, { detail });
      if (status === 'idle' && !savedDurably) void this.persist(live.record).catch(() => undefined);
    };
    this.busUnsubscribers.push(
      bus.on<Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>>('TURN_SUBMITTED', (envelope) => mark(envelope.sessionId, 'running', 'hosted-session-turn-started', 'a turn was submitted', envelope.payload.turnId)),
      bus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', (envelope) => {
        this.noteTurnCompleted(envelope.sessionId, envelope.payload.turnId);
        mark(envelope.sessionId, 'idle', 'hosted-session-turn-ended', 'completed');
      }),
      bus.on('TURN_ERROR', (envelope) => mark(envelope.sessionId, 'idle', 'hosted-session-turn-ended', 'errored')),
      bus.on('TURN_CANCEL', (envelope) => mark(envelope.sessionId, 'idle', 'hosted-session-turn-ended', 'cancelled')),
      bus.on<Extract<TurnEvent, { type: 'PREFLIGHT_FAIL' }>>('PREFLIGHT_FAIL', (envelope) => {
        if (!envelope.sessionId || !openTurns.get(envelope.sessionId)?.has(envelope.payload.turnId)) return;
        mark(envelope.sessionId, 'idle', 'hosted-session-turn-ended', 'preflight failed', envelope.payload.turnId);
      }),
    );
  }

  private publish(
    event: HostedSessionLifecycleEvent,
    session: HostedSessionRecord,
    extra?: { readonly clientId?: string | undefined; readonly detail?: string | undefined },
  ): void {
    const payload: HostedSessionUpdatePayload = {
      event,
      session,
      createdAt: this.now(),
      ...(extra?.clientId === undefined ? {} : { clientId: extra.clientId }),
      ...(extra?.detail === undefined ? {} : { detail: extra.detail }),
    };
    try {
      this.publisher?.publishEvent(HOSTED_SESSION_WIRE_EVENT, payload);
    } catch (error) {
      // Warn, not debug: this channel is the only account of what happened to a
      // session, so a notice that did not go out is a transition nobody saw.
      logger.warn('[hosted-sessions] publishing a lifecycle notice failed', {
        sessionId: session.id,
        error: summarizeError(error),
      });
    }
  }

  private async persist(record: HostedSessionRecord): Promise<void> {
    const live = this.sessions.get(record.id);
    if (live?.released) return;
    const conversation = live?.runtime ? live.runtime.conversation.toJSON() : live?.restoredConversation ?? null;
    try {
      await this.options.store.save(record, conversation, { owners: live?.attached.identifiedOwners(), permissionModeChosen: live?.modeChosen === true });
    } catch (error) {
      const reason = summarizeError(error);
      logger.warn('[hosted-sessions] persisting a session failed; it will not survive a restart', {
        sessionId: record.id,
        error: reason,
      });
      this.noteSaveOutcome(record.id, reason);
      return;
    }
    this.noteSaveOutcome(record.id);
  }

  /** Save a session's transcript after a change made outside a turn (a rewind, or its undo). */
  private async saveConversation(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live?.runtime || live.record.status === 'terminated') return;
    live.record = { ...live.record, messageCount: live.runtime.conversation.getMessageCount(), updatedAt: this.now() };
    await this.persist(live.record);
  }

  /** Tell the host a hosted session's turn completed, before the turn's end is recorded. A host failure never reaches the bus. */
  private noteTurnCompleted(sessionId: string | undefined, turnId: string): void {
    if (!sessionId || !this.options.conversations || !this.sessions.get(sessionId)?.runtime) return;
    try {
      this.options.conversations.turnCompleted(sessionId, turnId);
    } catch (error) {
      logger.warn('[hosted-sessions] recording a completed turn for rewind failed', { sessionId, turnId, error: summarizeError(error) });
    }
  }

  /** A save whose failure the caller must see: it is thrown, and kept on the record like any other. */
  private async saveDurably(live: LiveSession, conversation: unknown): Promise<void> {
    try {
      await this.options.store.save(live.record, conversation, { durable: true, owners: live.attached.identifiedOwners(), permissionModeChosen: live.modeChosen === true });
    } catch (error) {
      this.noteSaveOutcome(live.record.id, summarizeError(error));
      throw error;
    }
    this.noteSaveOutcome(live.record.id);
  }

  /**
   * Keeps why the latest save failed on the session's record, where its status
   * and every listing show it, and removes it once a save succeeds. The store
   * writes one session's saves in order, so the latest outcome is the true one.
   */
  private noteSaveOutcome(sessionId: string, failure?: string): void {
    const live = this.sessions.get(sessionId);
    if (!live || live.record.saveError === failure) return;
    if (failure !== undefined) {
      live.record = { ...live.record, saveError: failure };
      return;
    }
    const cleared: { -readonly [K in keyof HostedSessionRecord]: HostedSessionRecord[K] } = { ...live.record };
    delete cleared.saveError;
    live.record = cleared;
  }

  private requireWorkspace(raw: string): string {
    const workspaceRoot = raw.trim();
    if (!workspaceRoot.startsWith('/')) {
      throw new HostedSessionArgumentError(
        `workspaceRoot must be an absolute path; '${raw}' is not. A relative path would be resolved against the daemon's own directory, which is not where the caller meant.`,
      );
    }
    if (this.options.isWorkspaceUsable && !this.options.isWorkspaceUsable(workspaceRoot)) {
      throw new HostedSessionArgumentError(`workspaceRoot '${workspaceRoot}' is not a directory this daemon can host a session in.`);
    }
    const roots = this.options.allowedWorkspaceRoots?.();
    if (roots !== undefined && allowedRootFor(workspaceRoot, roots) === undefined) {
      throw new HostedSessionArgumentError(outsideAllowedRootsMessage(workspaceRoot, roots));
    }
    return workspaceRoot;
  }

  /** The folders a hosted session may be started in; empty when this composition sets no restriction. */
  workspaceRoots(): readonly string[] {
    return this.options.allowedWorkspaceRoots?.() ?? [];
  }

  private requireKnown(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new HostedSessionNotFoundError(sessionId);
    return live;
  }

  private requireLive(sessionId: string): LiveSession {
    const live = this.requireKnown(sessionId);
    if (live.record.status === 'terminated') {
      throw new HostedSessionTerminatedError(sessionId, live.record.terminatedReason);
    }
    return live;
  }

  private assertSessionUsable(live: LiveSession): void {
    this.assertUsable();
    this.requireLive(live.record.id);
  }

  /** A session's keyed tool state stays while the session is live or its record is still stored. */
  private isSessionHeld(sessionToken: string): boolean {
    return this.sessions.has(sessionToken) || this.options.store.has(sessionToken);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('The hosted-session engine has been disposed.');
  }

  /**
   * Stop hosting. Every live session is terminated with `daemon-shutdown` and
   * persisted, so the next start reconciles from a record that says what
   * happened rather than from one that claims it is still running.
   */
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      // Publish before invoking callbacks. A factory/disposer can request this
      // shutdown, but the actual drain must not inherit its reentry shortcut.
      this.disposal = this.spine.outsideCallbacks(() => hostedLifecycleCallbacks.outsideMany(
        [this.floors, ...this.sessions.values()],
        () => Promise.resolve().then(() => hostedLifecycleCallbacks.run(this, () => this.shutdown())),
      ));
      // A recursive caller only requests the fence, so it cannot observe a
      // later failure. Keep the original drain rejected for external callers,
      // while owning its rejection even when the callback was the sole requester.
      void this.disposal.catch(() => {});
    }
    return hostedLifecycleCallbacks.active(this) || hostedLifecycleCallbacks.active(this.floors)
      ? Promise.resolve()
      : this.disposal;
  }

  private async shutdown(): Promise<void> {
    this.spine.stop();
    try {
      await this.options.closeNativeTurns?.();
    } finally {
      // Native close failure remains the caller's error, but cannot abandon
      // workspace factories, runtimes, or floor cleanup already owned here.
      await this.shutdownSessions();
    }
  }

  private async shutdownSessions(): Promise<void> {
    if (this.attachmentTimer) {
      clearInterval(this.attachmentTimer);
      this.attachmentTimer = null;
    }
    this.contractWorkAdapter?.close();
    this.contractWorkAdapter = null;
    for (const unsubscribe of this.busUnsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // A listener that will not detach must not block shutdown.
      }
    }
    try {
      // Admission was fenced synchronously by dispose(). A create already
      // admitted may still be registering or saving its initial idle record;
      // drain it before policy teardown writes the final shutdown record.
      await Promise.allSettled([...this.creations]);
      for (const live of [...this.sessions.values()]) {
        const existingTermination = live.termination;
        if (existingTermination) {
          await existingTermination.catch(() => undefined);
          continue;
        }
        if (live.record.status === 'terminated') continue;
        await Promise.allSettled([live.composition]);
        await this.spine.drainRegistrations(live.record.id);
        const terminationAfterDrain = live.termination;
        if (terminationAfterDrain) {
          await terminationAfterDrain.catch(() => undefined);
          continue;
        }
        // A survive-policy session is not ended by the daemon stopping. That is
        // the whole claim `survive` makes: outliving the client is the small half,
        // outliving a restart (an update swapping the binary, a reboot) is the
        // half that makes it worth having. Its loop comes down, its transcript is
        // written, and the next start restores it idle with an honest line about
        // the turn that did not finish. A kill-policy session ends here, with the
        // reason that actually applies.
        if (this.effectivePolicy(live.record.detachPolicy) === 'survive') {
          await this.parkForShutdown(live).catch(() => undefined);
          if (live.termination) await live.termination.catch(() => undefined);
          continue;
        }
        await this.terminate(live, 'daemon-shutdown', 'the daemon is stopping').catch(() => undefined);
      }
    } finally {
      await this.floors.dispose();
    }
  }

  /**
   * Park a surviving session across a shutdown: loop down, record kept idle,
   * transcript written.
   */
  private parkForShutdown(live: LiveSession): Promise<void> {
    if (live.parking) return live.parking;
    // An explicit kill may arrive while this idle save is pending. It fences
    // immediately, then waits for this admitted write before its final record.
    const parking = Promise.resolve().then(() => hostedLifecycleCallbacks.run(live, async () => {
      if (live.termination) return;
      const teardownError = this.teardownRuntime(live);
      if (teardownError !== undefined) {
        logger.warn('[hosted-sessions] taking a session apart for shutdown reported an error', { sessionId: live.record.id, error: summarizeError(teardownError) });
      }
      live.attached.clear();
      live.record = {
        ...live.record,
        status: 'idle',
        attachedClients: [],
        updatedAt: this.now(),
      };
      await this.persist(live.record);
      if (live.termination) return;
      this.publish('hosted-session-detached', live.record, {
        detail: 'the daemon is stopping; this session survives and is reattachable after the restart',
      });
    }));
    live.parking = parking;
    return parking;
  }
}

function defaultTitle(input: CreateHostedSessionInput, workspaceRoot: string): string {
  const prompt = input.initialPrompt?.trim();
  if (prompt) return prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
  const leaf = workspaceRoot.replace(/\/+$/, '').split('/').pop();
  return leaf ? `Hosted session in ${leaf}` : 'Hosted session';
}

/** One message of a stored or live conversation as a client renders it; anything unreadable is left out. */
function historyFromMessages(messages: readonly unknown[]): HostedSessionHistoryMessage[] {
  const history: HostedSessionHistoryMessage[] = [];
  for (const entry of messages) {
    if (typeof entry !== 'object' || entry === null) continue;
    const message = entry as { readonly role?: unknown; readonly content?: unknown; readonly toolCalls?: unknown; readonly callId?: unknown };
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') continue;
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    // A mirror or resumed copy keeps the model's tool history: which calls an
    // assistant turn made and which call each tool result answers.
    if (role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      const toolCalls = message.toolCalls.flatMap((call: unknown) => {
        if (typeof call !== 'object' || call === null) return [];
        const { id, name, arguments: args } = call as { readonly id?: unknown; readonly name?: unknown; readonly arguments?: unknown };
        if (typeof id !== 'string' || typeof name !== 'string') return [];
        return [{ id, name, arguments: typeof args === 'object' && args !== null ? args as Readonly<Record<string, unknown>> : {} }];
      });
      history.push({ role, content, toolCalls });
      continue;
    }
    if (role === 'tool' && typeof message.callId === 'string') {
      history.push({ role, content, callId: message.callId });
      continue;
    }
    history.push({ role, content });
  }
  return history;
}

/** The history held in a `ConversationManager.toJSON()` payload; an unknown shape has none. */
function historyFromConversation(conversation: unknown): HostedSessionHistoryMessage[] {
  if (typeof conversation !== 'object' || conversation === null) return [];
  const messages = (conversation as { readonly messages?: unknown }).messages;
  return Array.isArray(messages) ? historyFromMessages(messages) : [];
}
