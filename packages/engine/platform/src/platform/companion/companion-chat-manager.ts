import { captureOwnedJson } from '../gate/judgment-input.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { readReasoningEffortLevel } from '../providers/reasoning-effort.js';
import type { NativeDataWriteOwner } from '../runtime/native-reader-compatibility.js';
/**
 * companion-chat-manager.ts
 *
 * Disk-backed manager for companion-app chat-mode sessions.
 *
 * Design:
 * - Each session owns a ConversationManager (isolated message history).
 * - Sessions survive daemon restart via CompanionChatPersistence (atomic JSON files).
 * - Inbound messages are rate-limited per session and per client via
 *   CompanionChatRateLimiter (token-bucket, 30 msgs/min per client,
 *   10 msgs/min per session by default, configurable).
 * - When a user message is posted, the manager appends it to the conversation
 *   and runs a lightweight LLM turn using the provider registry.
 * - Tool calls emitted by the LLM are executed via the injected ToolRegistry
 *   (if provided); results are fed back into the stream and published as
 *   turn.tool_result events.
 * - Streaming chunks are fanned out via ControlPlaneGateway.publishEvent
 *   with a per-session clientId filter, so they only reach the subscriber
 *   for that specific session, never the global TUI event feed.
 * - A GC sweep closes sessions that have been idle beyond the TTL.
 */

import { randomUUID } from 'node:crypto';
import { EngineErrorCodes } from '@goodvibes-jev/engine/errors';
import { ConversationManager } from '../core/conversation.js';
import { startTurnForOwnerInput } from '../security/turn-boundary.js';
import type { CompanionPostMessageOptions } from './companion-chat-turn-control.js';
import type { ProviderMessage } from '../providers/interface.js';
import type {
  CancelCompanionChatTurnInput,
  CancelCompanionChatTurnOutput,
  SteerCompanionChatMessageOutput,
  CompanionChatMessageAttachmentInput,
  CompanionChatMessage,
  CompanionChatSession,
  CompanionChatTurnEvent,
  CompanionChatTurnStoppedBy,
  ConversationMessageEnvelope,
  CreateCompanionChatSessionInput,
  EditCompanionChatMessageInput,
  EditCompanionChatMessageOutput,
  RegenerateCompanionChatMessageInput,
  RegenerateCompanionChatMessageOutput,
  UpdateCompanionChatSessionInput,
} from './companion-chat-types.js';
import {
  CompanionChatPersistence,
  defaultSessionsDir,
} from './companion-chat-persistence.js';
import {
  buildProviderUserContent,
  buildReplayUserContent,
  resolveAttachments,
  type CompanionChatArtifactStore,
} from './companion-chat-attachments.js';
import {
  activeMessages,
  applyEditBranch,
  planRegenerate,
} from './companion-chat-branching.js';
import {
  executeCompanionToolCalls,
  runToolExhaustionFinalizer,
} from './companion-chat-turn-execution.js';
import { planCompanionSweep } from './companion-chat-gc.js';
import type { CompanionSessionBrokerBridge } from './companion-chat-broker-bridge.js';
import { CompanionBrokerSync } from './companion-chat-broker-sync.js';
import { CompanionChatRateLimiter } from './companion-chat-rate-limiter.js';
import type { CompanionChatRateLimiterOptions } from './companion-chat-rate-limiter.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolDefinition } from '../types/tools.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../tools/goodvibes-runtime/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { AtomicWriteDurabilityError } from '../utils/atomic-json-store.js';
import type { ConfigManager } from '../config/manager.js';

// ---------------------------------------------------------------------------
// Turn control (per-turn abort scope, cancel finalization, pending queue),
// see companion-chat-turn-control.ts; provider stream types moved with it.
// ---------------------------------------------------------------------------

export type {
  CompanionLLMProvider,
  CompanionProviderChunk,
  CompanionProviderMessage,
} from './companion-chat-turn-control.js';
import {
  awaitCompanionReply,
  cancelActiveTurn,
  createTurnAbortScope,
  finalizeCancelledTurn,
} from './companion-chat-turn-control.js';
import type {
  ActiveCompanionTurn,
  CompanionLLMProvider,
  QueuedCompanionTurn,
} from './companion-chat-turn-control.js';

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

export type { CompanionChatArtifactStore } from './companion-chat-attachments.js';

// ---------------------------------------------------------------------------
// Event publisher interface (subset of ControlPlaneGateway)
// ---------------------------------------------------------------------------

export interface CompanionChatEventPublisher {
  publishEvent(
    event: string,
    payload: unknown,
    filter?: { clientId?: string; clientIdPrefix?: string },
  ): void;
}

// ---------------------------------------------------------------------------
// Idle GC constants (customisable for tests)
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_ACTIVE_MS = 30 * 60 * 1_000; // 30 minutes with messages
const DEFAULT_IDLE_EMPTY_MS = 5 * 60 * 1_000;   // 5 minutes empty session
const DEFAULT_CLOSED_MEMORY_GRACE_MS = 5 * 60 * 1_000; // evict closed bodies from RAM after 5 min
const MAX_REMEMBERED_CLIENT_MESSAGE_IDS = 500; // per session
const GC_INTERVAL_MS = 60 * 1_000;               // sweep every minute

/**
 * Most model/tool rounds one reply may take. A model that keeps asking for
 * tools would otherwise spend provider budget forever and leave the chat
 * "replying"; past this the model is asked, once more and without tools, to
 * answer with what it has.
 */
export const COMPANION_MAX_TOOL_ROUNDS = 24;
const TOOL_EXHAUSTION_FINALIZER_PROMPT =
  'You have used all the tool rounds available for this reply. Do not call any more tools. Answer now with what you already have, and say plainly what you could not finish.';
function assertCompleteProviderModelRoute(
  input: { readonly model?: string | undefined; readonly provider?: string | undefined },
): void {
  if ((input.model !== undefined) === (input.provider !== undefined)) return;
  throw Object.assign(new Error('provider and model must be supplied together'), {
    code: 'INVALID_MODEL_ROUTE',
    status: 400,
  });
}

interface InternalSession {
  readonly meta: CompanionChatSession;
  conversation: ConversationManager;
  messages: CompanionChatMessage[];
  readonly abortController: AbortController;
  /** The in-flight turn, when one is running (see ActiveCompanionTurn). */
  activeTurn?: ActiveCompanionTurn | null;
  /** User messages whose turns have not started yet (queue-when-busy + steer-to-front). */
  pendingTurns?: QueuedCompanionTurn[];
  preparingTurns?: number;
  /** Client-chosen send ids already accepted, so a re-sent request answers with the first message instead of a second turn. Memory only: forgotten with the session or on a restart. */
  clientMessageIds?: Map<string, string>;
  routingUpdatePending?: boolean;
  lastActivityAt: number;
  /**
   * True once the GC has dropped this closed session's replay state (its
   * ConversationManager). The transcript itself stays resident because the
   * session and message routes serve it from memory; evicting it would show a
   * closed chat as empty and let a later save overwrite the file with nothing.
   */
  replayEvicted?: boolean;
}

type MutableSessionMeta = {
  -readonly [K in keyof CompanionChatSession]: CompanionChatSession[K];
};

export interface CompanionChatReplyResult {
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly error?: string | undefined;
  /** Set only by the local reply deadline, never inferred from failure prose. */
  readonly timedOut?: true | undefined;
}

interface PendingReply {
  readonly resolve: (result: CompanionChatReplyResult) => void;
  readonly timeout: ReturnType<typeof setTimeout> | undefined;
}

// ---------------------------------------------------------------------------
// CompanionChatManager
// ---------------------------------------------------------------------------

export interface CompanionChatManagerConfig {
  readonly provider: CompanionLLMProvider;
  /** Resolve historical null routes once at admission, never per tool round. */
  readonly resolveDefaultRoute?: (() => QueuedCompanionTurn['route']) | undefined;
  readonly eventPublisher: CompanionChatEventPublisher;
  /**
   * ToolRegistry to use for executing tool calls emitted by the LLM.
   * When omitted, tool_call chunks are published as events but not executed;
   * the LLM receives no tool result and must degrade gracefully.
   */
  readonly toolRegistry?: ToolRegistry | undefined;
  /**
   * Permission boundary used when executing model-originated tool calls.
   * Tool calls are denied when a registry is present without this manager.
   */
  readonly permissionManager?: PermissionManager | null | undefined;
  /** Optional hook dispatcher for Pre/Post/Fail tool hooks. */
  readonly hookDispatcher?: HookDispatcherLike | null | undefined;
  /** Optional runtime event bus for typed tool telemetry. */
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  /** Source of `runtime.toolBudget.*`; omitted means tool calls run without a budget. */
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  /** Optional artifact store used to resolve and inline chat attachments. */
  readonly artifactStore?: CompanionChatArtifactStore | null | undefined;
  /** Directory for session JSON files. Default `<homeDirectory>/.goodvibes/companion-chat/sessions/`
   * (else OS home). Prefer passing this (or `homeDirectory`) so an isolated-home daemon stays in. */
  readonly sessionsDir?: string | undefined;
  /** Injected home dir; when `sessionsDir` is omitted, the persistence root is
   * derived from THIS home (not the OS home) so an isolated-home daemon stays in. */
  readonly homeDirectory?: string | undefined;
  /**
   * Optional bridge to the shared session broker. When supplied, companion
   * sessions register INTO the broker at write time (create/close), so
   * `/api/sessions` reflects companion activity immediately (same-process, no
   * restart). The boot-time importer fold remains the reconciliation path.
   */
  readonly sessionBroker?: CompanionSessionBrokerBridge | null | undefined;
  /** Age (ms past closedAt) at which a CLOSED session's heavy in-memory handles
   * are evicted while its meta stays listable (bounds resident memory). Default 5 min. */
  readonly closedSessionMemoryGraceMs?: number | undefined;
  /** Age (ms past closedAt) at which a CLOSED session's persisted file is PERMANENTLY
   * deleted. Closed sessions are HISTORY: default `undefined` = retain indefinitely. */
  readonly closedSessionRetentionMs?: number | undefined;
  /** Pass `false` to disable disk persistence entirely (useful in tests). Default: true */
  readonly persist?: boolean | undefined;
  /** Actual installed writer declares retained session-effort semantics before publication. */
  readonly nativeDataWriter?: NativeDataWriteOwner | undefined;
  /** Rate-limiting options. Defaults: 30 msgs/min per client, 10/min per session. */
  readonly rateLimiter?: CompanionChatRateLimiterOptions | false | undefined;
  /** Override for tests */
  readonly idleActiveMs?: number | undefined;
  /** Override for tests */
  readonly idleEmptyMs?: number | undefined;
  /** Override for tests */
  readonly gcIntervalMs?: number | undefined;
}

export class CompanionChatManager {
  readonly #ownedMessages = new WeakSet<CompanionChatMessage>();
  private readonly sessions = new Map<string, InternalSession>();
  private readonly provider: CompanionLLMProvider;
  private readonly resolveDefaultRoute: CompanionChatManagerConfig['resolveDefaultRoute'];
  private readonly nativeDataWriter: NativeDataWriteOwner | undefined;
  private readonly eventPublisher: CompanionChatEventPublisher;
  private readonly toolRegistry: ToolRegistry | null;
  private readonly permissionManager: PermissionManager | null;
  private readonly hookDispatcher: HookDispatcherLike | null;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly configManager: Pick<ConfigManager, 'get'> | undefined;
  private readonly artifactStore: CompanionChatArtifactStore | null;
  private readonly persistence: CompanionChatPersistence | null;
  private readonly rateLimiter: CompanionChatRateLimiter | null;
  private readonly idleActiveMs: number;
  private readonly idleEmptyMs: number;
  private readonly closedMemoryGraceMs: number;
  private readonly closedRetentionMs: number | undefined;
  /** Live mirror of sessions into the shared broker store. */
  private readonly _brokerSync: CompanionBrokerSync;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks whether the async init() has completed. */
  private initCompleted = false;
  private readonly pendingReplies = new Map<string, PendingReply>();
  /** True once dispose() ran, lets a cancelled turn report stoppedBy 'shutdown' honestly. */
  private disposed = false;
  /**
   * Serializes persistence writes per session to prevent write-after-write
   * races where two concurrent saves could result in an older snapshot
   * overwriting a newer one.
   */
  private readonly _pendingSaves = new Map<string, Promise<void>>();
  private readonly saveFailures = new Map<string, unknown>();
  private readonly recoveringSaves = new Set<string>();
  private readonly activeWork = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;

  constructor(config: CompanionChatManagerConfig) {
    this.provider = config.provider;
    this.resolveDefaultRoute = config.resolveDefaultRoute;
    this.nativeDataWriter = config.nativeDataWriter;
    this.eventPublisher = config.eventPublisher;
    this.toolRegistry = config.toolRegistry ?? null;
    this.permissionManager = config.permissionManager ?? null;
    this.hookDispatcher = config.hookDispatcher ?? null;
    this.runtimeBus = config.runtimeBus ?? null;
    this.configManager = config.configManager;
    this.artifactStore = config.artifactStore ?? null;
    this.idleActiveMs = config.idleActiveMs ?? DEFAULT_IDLE_ACTIVE_MS;
    this.idleEmptyMs = config.idleEmptyMs ?? DEFAULT_IDLE_EMPTY_MS;
    this.closedMemoryGraceMs = config.closedSessionMemoryGraceMs ?? DEFAULT_CLOSED_MEMORY_GRACE_MS;
    this.closedRetentionMs = config.closedSessionRetentionMs;
    this._brokerSync = new CompanionBrokerSync(config.sessionBroker ?? null);

    // Persistence
    // Default is false, most callers (tests, downstream consumers) get the
    // safe no-write default. The daemon opts into persistence explicitly via
    // persist: true in facade-composition. When sessionsDir is omitted, derive
    // the root from the INJECTED home so an isolated-home daemon stays inside it.
    const persist = config.persist === true;
    this.persistence = persist
      ? new CompanionChatPersistence(config.sessionsDir ?? defaultSessionsDir(config.homeDirectory))
      : null;

    // Rate limiter
    this.rateLimiter =
      config.rateLimiter === false
        ? null
        : new CompanionChatRateLimiter(config.rateLimiter ?? {});

    const gcIntervalMs = config.gcIntervalMs ?? GC_INTERVAL_MS;
    this.gcTimer = setInterval(() => {
      this._gcSweep();
      this.rateLimiter?.cleanup();
      void this.recoverFailedSaves().catch((error: unknown) => {
        logger.warn('[companion-chat] retrying failed chat saves threw', { error: summarizeError(error) });
      });
    }, gcIntervalMs);
    // Don't block node process on this timer
    this.gcTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Async initialisation, load persisted sessions from disk
  // ---------------------------------------------------------------------------

  /**
   * Load sessions persisted from a previous daemon run.
   * Should be called once after construction before accepting requests.
   * Safe to call multiple times (idempotent after first call).
   */
  async init(): Promise<void> {
    if (this.initCompleted || !this.persistence) {
      this.initCompleted = true;
      return;
    }

    const stored = await this.persistence.loadAll();
    const rejected = this.persistence.rejectedOnLoad();
    if (rejected.length > 0) {
      // Set-aside chats are not in the list; say so at startup so a missing chat is explained.
      logger.warn('[companion-chat] saved chats could not be loaded and were set aside', {
        rejected: rejected.length,
        rejectedFiles: rejected.map((entry) => `${entry.file}: ${entry.reason}`),
      });
    }
    for (const { meta, messages } of stored) {
      const normalizedMessages = messages.map((message) => this.normalizeMessage(message));
      const conversation = new ConversationManager();
      // Closed-skip fix: closed sessions load in a lightweight terminal state
      // (meta + messages retained, listable/importable; no history replay). GC
      // (_gcSweep) remains the sole deletion authority.
      if (meta.status !== 'closed') {
        for (const msg of normalizedMessages) {
          if (msg.role === 'user') {
            conversation.addUserMessage(buildReplayUserContent(msg));
          } else {
            conversation.addAssistantMessage(msg.content);
          }
        }
      }

      const loaded: InternalSession = {
        meta,
        conversation,
        messages: normalizedMessages,
        abortController: new AbortController(),
        lastActivityAt: meta.updatedAt,
      };
      this.sessions.set(meta.id, loaded);
      // A queued send lived in memory only; nothing is left to run it after a
      // restart, so the transcript must stop saying it is waiting.
      if (this._markUnanswered(loaded)) this._persist(meta.id);
    }

    this.initCompleted = true;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  createSession(input: CreateCompanionChatSessionInput = {}): CompanionChatSession {
    this.assertAvailable();
    assertCompleteProviderModelRoute(input);
    this.assertEffortPublication(input.reasoningEffort);
    this.assertAvailable();
    const id = randomUUID();
    const now = Date.now();
    const meta: CompanionChatSession = {
      id,
      kind: 'companion-chat',
      title: input.title ?? 'Chat',
      model: input.model ?? null,
      provider: input.provider ?? null,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      systemPrompt: input.systemPrompt ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      messageCount: 0,
    };

    const conversation = new ConversationManager();

    this.sessions.set(id, {
      meta,
      conversation,
      messages: [],
      abortController: new AbortController(),
      lastActivityAt: now,
    });

    this._persist(id);
    // Live spine: mirror the new session into the shared broker at write time so
    // /api/sessions reflects it same-process (no restart). Best-effort.
    this._brokerSync.track(meta.id, () => this._brokerSync.registerSession(meta));

    return meta;
  }

  getSession(sessionId: string): CompanionChatSession | null {
    if (this.disposed) return null;
    return this.sessions.get(sessionId)?.meta ?? null;
  }

  listSessions(input: { readonly includeClosed?: boolean | undefined; readonly limit?: number | undefined } = {}): {
    readonly sessions: readonly CompanionChatSession[];
    readonly totals: { readonly sessions: number; readonly active: number; readonly closed: number };
  } {
    const all = [...this.sessions.values()].map((session) => session.meta);
    const active = all.filter((session) => session.status === 'active').length;
    const closed = all.length - active;
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.max(0, Math.floor(input.limit))
      : 100;
    const sessions = all
      .filter((session) => input.includeClosed || session.status !== 'closed')
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
    return {
      sessions,
      totals: {
        sessions: all.length,
        active,
        closed,
      },
    };
  }

  getMessages(sessionId: string): CompanionChatMessage[] {
    // Headers belong to the manager. A caller may rearrange its view, never the transcript.
    return [...(this.sessions.get(sessionId)?.messages ?? [])];
  }

  /** Borrow one immutable header for a live source check without copying the transcript. */
  getMessage(sessionId: string, messageId: string): CompanionChatMessage | undefined {
    return this.sessions.get(sessionId)?.messages.find(message => message.id === messageId);
  }

  private normalizeMessage(message: CompanionChatMessage): CompanionChatMessage {
    if (this.#ownedMessages.has(message)) return message;
    const owned = Object.freeze({
      ...message,
      attachments: message.attachments ?? [],
      // Disk/caller revisions are not proof of this owner's current source.
      contentRevision: randomUUID(),
    });
    this.#ownedMessages.add(owned);
    return owned;
  }

  updateSession(
    sessionId: string,
    input: UpdateCompanionChatSessionInput,
  ): CompanionChatSession {
    const session = this._requireOpenSession(sessionId);
    const patch = this.prepareSessionPatch(session, input);
    const updated = this._updateMeta(session, patch);
    this._persist(sessionId);
    // Heartbeat the broker record (advances participant.lastSeenAt). Title is
    // never overwritten by this path (broker treats register as a heartbeat).
    this._brokerSync.track(updated.id, () => this._brokerSync.registerSession(updated));
    return updated;
  }

  /**
   * Register the SSE clientId for this session so events are routed only to
   * the correct subscriber. Replaces any previous registration (single subscriber
   * per session in v1, the last SSE connection wins).
   */
  /** HTTP metadata changes publish before acknowledging or changing the live
   * route. A failure leaves the old in-memory metadata and saved bytes intact
   * when publication was not reached; uncertain publication holds the session. */
  async updateSessionPersisted(sessionId: string, input: UpdateCompanionChatSessionInput): Promise<CompanionChatSession> {
    const session = this._requireOpenSession(sessionId);
    const admitted = captureOwnedJson(input) as UpdateCompanionChatSessionInput;
    this.prepareSessionPatch(session, admitted);
    const routing = admitted.model !== undefined || admitted.provider !== undefined || admitted.reasoningEffort !== undefined;
    if (routing) session.routingUpdatePending = true;
    try {
      return await this.queueSave(sessionId, () => {
        if (this.sessions.get(sessionId) !== session || session.meta.status !== 'active') throw Object.assign(new Error('Original chat ended before metadata publication'), { chatEnded: true });
        const patch = this.prepareSessionPatch(session, admitted, routing);
        const updated = { ...session.meta, ...patch };
        if (this.persistence) this.persistence.saveSync({ meta: updated, messages: session.messages });
        const committed = this._updateMeta(session, patch);
        this._brokerSync.track(committed.id, () => this._brokerSync.registerSession(committed));
        return committed;
      });
    } catch (error) {
      // A failed write is named as one: the failure is recorded for the chat a
      // tick later, so the generic "shutting down or changed" text would send
      // the operator to a restart when the disk is the problem.
      const chatEnded = typeof error === 'object' && error !== null && (error as { chatEnded?: unknown }).chatEnded === true;
      throw this.storageUnavailable(chatEnded ? undefined : sessionId, chatEnded ? undefined : error);
    }
    finally { if (routing) session.routingUpdatePending = false; }
  }

  private prepareSessionPatch(session: InternalSession, input: UpdateCompanionChatSessionInput, ownPending = false): Partial<MutableSessionMeta> {
    assertCompleteProviderModelRoute(input);
    if ((session.activeTurn || session.preparingTurns || session.routingUpdatePending && !ownPending)
      && (input.model !== undefined || input.provider !== undefined || input.reasoningEffort !== undefined)) {
      throw Object.assign(new Error('Wait for this chat’s current reply to finish before changing its model or effort.'), { code: 'CHAT_ROUTE_BUSY', status: 409 });
    }
    const original = session.meta, closing = this.disposed;
    this.assertEffortPublication(input.reasoningEffort);
    if (session.meta !== original || this.sessions.get(original.id) !== session || this.disposed !== closing) throw this.storageUnavailable();
    const patch: Partial<MutableSessionMeta> = { updatedAt: Date.now() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.model !== undefined) patch.model = input.model;
    if (input.provider !== undefined) patch.provider = input.provider;
    if (input.reasoningEffort !== undefined) patch.reasoningEffort = input.reasoningEffort;
    if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
    return patch;
  }

  /**
   * A reader opened a stream on the session. Events are published to every
   * stream of the session by prefix, not to one remembered client id: a second
   * reader would otherwise displace the first, and a closed last reader would
   * leave the survivor with a stale id and no events.
   */
  registerSubscriber(sessionId: string, _clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Close a session cleanly. Aborts any in-flight turn. Returns the session
   * snapshot, or null if not found.
   */
  closeSession(sessionId: string): CompanionChatSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.meta.status === 'closed') return session.meta;

    session.abortController.abort();
    this._abandonQueuedTurns(session, 'This chat was closed before this queued message was answered.');
    const now = Date.now();
    const updated = this._updateMeta(session, { status: 'closed', closedAt: now, updatedAt: now });

    this._persist(sessionId);
    // Live spine: flip the shared broker record to closed at write time.
    this._brokerSync.track(sessionId, () => this._brokerSync.closeSession(sessionId));

    return updated;
  }

  /**
   * Cancel the in-flight turn (`companion.chat.turns.cancel`), a per-turn
   * stop that never touches the session controller. Refusal semantics and the
   * bounded finalization wait live in companion-chat-turn-control.ts.
   */
  async cancelTurn(sessionId: string, input: CancelCompanionChatTurnInput = {}): Promise<CancelCompanionChatTurnOutput> {
    this.assertAvailable(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    return cancelActiveTurn(sessionId, session.activeTurn ?? null, input);
  }

  /**
   * Permanently delete a session (see CHANGELOG 1.0.0: `delete` is now a genuine removal,
   * distinct from `closeSession` above). Aborts any in-flight turn, removes
   * the on-disk record file, and drops the in-memory entry, reusing
   * {@link _hardRemove}, the SAME primitive the GC 'delete-persistent' sweep
   * action uses, so there is exactly one removal code path.
   *
   * Requires the session to already be closed: deleting a still-active
   * session throws `{ code: 'SESSION_ACTIVE', status: 409 }` (the caller must
   * close it first, mirroring the SESSION_CLOSED-throw convention elsewhere
   * in this file). An unknown OR already-deleted id throws
   * `{ code: 'SESSION_NOT_FOUND', status: 404 }`, delete is not a 200-noop.
   */
  async deleteSession(sessionId: string): Promise<{ readonly sessionId: string; readonly deleted: true }> {
    this.assertAvailable(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status !== 'closed') {
      throw Object.assign(new Error('Session is active, close it, then delete.'), { code: 'SESSION_ACTIVE', status: 409 });
    }

    session.abortController.abort();
    await this._hardRemove(sessionId);
    // Live spine: drop the mirrored shared broker record entirely (not just closed).
    this._brokerSync.track(sessionId, () => this._brokerSync.deleteSession(sessionId));

    return { sessionId, deleted: true };
  }

  /**
   * Post a user message and start an async LLM turn. Returns the messageId.
   *
   * Rate-limited per session and per client (throws GoodVibesError{kind:'rate-limit'}
   * if limits are exceeded).
   *
   * Throws if the session is closed or not found.
   *
   * @param sessionId - The session to post to.
   * @param content   - The message text.
   * @param clientId  - The SSE/HTTP client identity for per-client rate limiting.
   *                    Pass '' to skip client-level rate limiting.
   */
  async postMessage(
    sessionId: string,
    content: string,
    clientId = '',
    options: CompanionPostMessageOptions = {},
  ): Promise<string> {
    return await this._postMessageInternal(sessionId, content, clientId, { ...options });
  }

  async postMessageAndWaitForReply(
    sessionId: string,
    content: string,
    clientId = '',
    options: {
      readonly timeoutMs?: number | undefined;
      readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
      /** In-process tap for this turn's incremental events; independent of the gateway SSE fan-out. */
      readonly onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined;
    } = {},
  ): Promise<CompanionChatReplyResult> {
    return awaitCompanionReply(
      options.timeoutMs ?? 0,
      (pendingReply) => this._postMessageInternal(sessionId, content, clientId, {
        pendingReply,
        attachments: options.attachments,
        ...(options.onTurnEvent ? { onTurnEvent: options.onTurnEvent } : {}),
      }),
      (messageId) => this.pendingReplies.delete(messageId),
    );
  }

  private async _postMessageInternal(
    sessionId: string,
    content: string,
    clientId: string,
    options: {
      readonly pendingReply?: PendingReply | undefined;
      readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
      readonly onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined;
      /** Steer: jump the pending queue (the caller cancels the active turn). */
      readonly steer?: boolean | undefined;
      readonly ownerDirect?: boolean | undefined;
      /** Idempotency key chosen by the sender: a second post with the same key returns the first message's id and starts nothing. */
      readonly clientMessageId?: string | undefined;
      /** Called synchronously as the message joins the queue, with the turn running at that instant. */
      readonly onEnqueued?: ((activeTurn: ActiveCompanionTurn | null) => void) | undefined;
    } = {},
  ): Promise<string> {
    this.assertAvailable(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') {
      throw Object.assign(new Error('Session is closed'), { code: EngineErrorCodes.SESSION_CLOSED, status: 409 });
    }

    // A re-sent request (the first answer never arrived) is answered with the
    // first message, before it can count against the rate limit or run again.
    const alreadyAccepted = options.clientMessageId === undefined ? undefined : session.clientMessageIds?.get(options.clientMessageId);
    if (alreadyAccepted !== undefined) return alreadyAccepted;

    // Rate-limit check (throws GoodVibesError on violation)
    this.rateLimiter?.check(sessionId, clientId);

    if (session.routingUpdatePending) throw Object.assign(new Error('Wait for this chat’s model or effort change to finish.'), { code: 'CHAT_ROUTE_BUSY', status: 409 });
    this.assertEffortPublication(session.meta.reasoningEffort);
    const route = this.captureTurnRoute(session.meta);
    const attachments = resolveAttachments(options.attachments ?? [], this.artifactStore);
    if (!content.trim() && attachments.length === 0) {
      throw Object.assign(new Error('content or attachments are required'), { code: 'INVALID_ARGUMENT', status: 400 });
    }

    const messageId = randomUUID();
    const now = Date.now();

    // Provider-ready content is built at post time but committed to the
    // conversation only when the turn STARTS, committing now would leak a
    // queued message into the active turn's later tool rounds, which re-read
    // the conversation every round.
    session.preparingTurns = (session.preparingTurns ?? 0) + 1;
    let providerContent: QueuedCompanionTurn['providerContent'];
    const preparation = buildProviderUserContent(content, attachments, this.artifactStore);
    this.activeWork.add(preparation);
    try { providerContent = await preparation; }
    finally { session.preparingTurns--; this.activeWork.delete(preparation); }
    if (this.disposed || this.sessions.get(sessionId) !== session || session.meta.status !== 'active') {
      throw Object.assign(new Error('The original chat ended before its message was prepared.'), { code: EngineErrorCodes.SESSION_CLOSED, status: 409 });
    }

    // A send that lands while another turn is running QUEUES (visible in the
    // transcript immediately, marked 'queued', answered after the current
    // turn), it must never start a concurrent turn against the same
    // conversation. A steer jumps the queue instead (see steerMessage). Decided
    // here, after the preparation await, because a turn that started during it
    // is the one this message waits behind.
    // A duplicate that was still being prepared when the first one landed.
    const acceptedWhilePreparing = options.clientMessageId === undefined ? undefined : session.clientMessageIds?.get(options.clientMessageId);
    if (acceptedWhilePreparing !== undefined) return acceptedWhilePreparing;
    if (options.clientMessageId !== undefined) {
      const accepted = (session.clientMessageIds ??= new Map());
      accepted.set(options.clientMessageId, messageId);
      if (accepted.size > MAX_REMEMBERED_CLIENT_MESSAGE_IDS) {
        const oldest = accepted.keys().next().value;
        if (oldest !== undefined) accepted.delete(oldest);
      }
    }
    const queuedBehindActiveTurn = session.activeTurn != null && options.steer !== true;
    const userMsg: CompanionChatMessage = {
      id: messageId,
      sessionId,
      role: 'user',
      content,
      attachments,
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      createdAt: now,
      ...(queuedBehindActiveTurn ? { deliveryState: 'queued' as const } : {}),
    };
    session.messages.push(this.normalizeMessage(userMsg));
    session.lastActivityAt = now;
    this._updateMeta(session, {
      messageCount: session.messages.length,
      updatedAt: now,
    });

    this._persist(sessionId);

    if (options.pendingReply) {
      this.pendingReplies.set(messageId, options.pendingReply);
    }

    const entry: QueuedCompanionTurn = {
      userMessageId: messageId,
      route,
      providerContent,
      ...(options.onTurnEvent ? { onTurnEvent: options.onTurnEvent } : {}),
      ...(options.ownerDirect === undefined ? {} : { ownerDirect: options.ownerDirect }),
    };
    const queue = (session.pendingTurns ??= []);
    if (options.steer === true) queue.unshift(entry);
    else queue.push(entry);
    options.onEnqueued?.(session.activeTurn ?? null);
    this._startNextTurn(session);

    return messageId;
  }

  dispose(): void { void this.close().catch(error => logger.warn('[companion-chat] close failed', { error: summarizeError(error) })); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    // Reserve the one close operation before synchronous abort listeners can reenter.
    void this.closing.catch(() => {});
    this.disposed = true;
    if (this.gcTimer) { clearInterval(this.gcTimer); this.gcTimer = null; }
    for (const session of this.sessions.values()) {
      session.abortController.abort();
      const hadQueued = session.messages.some((message) => message.deliveryState === 'queued');
      this._abandonQueuedTurns(session, 'The companion chat service shut down before this queued message was answered.');
      if (hadQueued) this._persist(session.meta.id);
    }
    void (async () => {
      while (this.activeWork.size) await Promise.allSettled([...this.activeWork]);
      while (this._pendingSaves.size) await Promise.allSettled([...this._pendingSaves.values()]);
      await this._brokerSync.flush();
      const failures = [...this.saveFailures.values()];
      this.sessions.clear();
      if (failures.length) throw new AggregateError(failures, 'Companion chat persistence did not complete');
    })().then(completion.resolve, completion.reject);
    return this.closing;
  }

  /**
   * Steer: send a message that runs IMMEDIATELY, cancelling the in-flight
   * turn if one is running (`companion.chat.messages.steer`). The message
   * jumps to the FRONT of the pending queue, then the active turn is
   * cancelled through the same finalization path as an explicit stop (honest
   * partial persisted, terminal `turn.cancelled` to every subscriber), and
   * the drain starts the steer's turn. With no turn running this is an
   * ordinary send. Queued messages keep their places behind the steer.
   */
  async steerMessage(
    sessionId: string,
    content: string,
    clientId = '',
    options: CompanionPostMessageOptions = {},
  ): Promise<SteerCompanionChatMessageOutput> {
    // The turn to stop is the one running when the message joined the queue,
    // not the one running before the message was prepared: a turn that started
    // during preparation is what this message would otherwise wait behind.
    let activeAtEnqueue: ActiveCompanionTurn | null = null;
    const messageId = await this._postMessageInternal(sessionId, content, clientId, {
      ...options,
      steer: true,
      onEnqueued: (turn) => { activeAtEnqueue = turn; },
    });
    let cancelledTurnId: string | undefined;
    const running = activeAtEnqueue as ActiveCompanionTurn | null;
    if (running) {
      try {
        const result = await this.cancelTurn(sessionId, { turnId: running.turnId });
        cancelledTurnId = result.turnId;
      } catch (err: unknown) {
        // Benign races: the turn finished naturally (NO_ACTIVE_TURN), or the
        // slot already belongs to a newer turn, possibly this very steer
        // (TURN_MISMATCH). The turnId guard is what makes this safe: a steer
        // must never cancel its own turn or an unrelated newer one.
        const code = (err as { code?: string }).code;
        if (code !== 'NO_ACTIVE_TURN' && code !== 'TURN_MISMATCH') {
          // The message is already queued, so failing here would invite a
          // retry that sends it twice. Report what happened instead.
          logger.warn('[companion-chat] a steer could not stop the running reply', { sessionId, error: summarizeError(err) });
        }
      }
    }
    const session = this.sessions.get(sessionId);
    if (session) this._startNextTurn(session);
    // The steer sits at the front of the queue, so it has started exactly when
    // it has left the queue; otherwise it is waiting for a reply that is still
    // finishing.
    const turnStarted = session !== undefined && session.meta.status === 'active'
      && !(session.pendingTurns?.some((entry) => entry.userMessageId === messageId) ?? false);
    return {
      sessionId,
      messageId,
      steered: true,
      ...(cancelledTurnId !== undefined ? { cancelledTurnId } : {}),
      turnStarted,
    };
  }

  // ---------------------------------------------------------------------------
  // Turn execution
  // ---------------------------------------------------------------------------

  /**
   * The single turn-start funnel: runs the next pending turn iff no turn is
   * active and the session is open. Every turn exit drains through here, so
   * queued sends and steers can never race into concurrent turns.
   */
  private _startNextTurn(session: InternalSession): void {
    if (this.disposed || session.activeTurn || session.meta.status === 'closed') return;
    const next = session.pendingTurns?.shift();
    if (!next) return;
    const idx = session.messages.findIndex((m) => m.id === next.userMessageId);
    const queuedMsg = idx >= 0 ? session.messages[idx] : undefined;
    if (queuedMsg?.deliveryState === 'queued') {
      const { deliveryState: _cleared, ...delivered } = queuedMsg;
      session.messages[idx] = this.normalizeMessage(delivered);
      this._persist(session.meta.id);
    }
    // The companion/webui turn boundary: this manager runs its own turn loop,
    // so the one in Orchestrator.runTurn never reached it. See turn-boundary.ts.
    startTurnForOwnerInput({ ownerDirect: next.ownerDirect === true });

    // Deferred from post time (see _postMessageInternal).
    session.conversation.addUserMessage(next.providerContent);
    this.ownTurn(this._runTurn(session, next.userMessageId, next.onTurnEvent, next.route), (error: unknown) => {
      logger.warn('[companion-chat] turn execution failed', {
        sessionId: session.meta.id,
        messageId: next.userMessageId,
        error: summarizeError(error),
      });
    });
  }

  private ownTurn(work: Promise<void>, failed: (error: unknown) => void): void {
    this.activeWork.add(work);
    void work.then(() => { this.activeWork.delete(work); }, error => { this.activeWork.delete(work); failed(error); });
  }

  private captureTurnRoute(meta: CompanionChatSession): QueuedCompanionTurn['route'] {
    if ((meta.model === null) !== (meta.provider === null)) throw new Error('The saved chat route is incomplete');
    let fallback: QueuedCompanionTurn['route'] | undefined;
    if (meta.model === null && this.resolveDefaultRoute) {
      const value: unknown = this.resolveDefaultRoute();
      try {
        fallback = captureOwnedJson(value) as QueuedCompanionTurn['route'];
        if (!fallback || typeof fallback.provider !== 'string' || !fallback.provider || typeof fallback.model !== 'string' || !fallback.model) throw new Error();
      } catch { drainOwned(value); throw new Error('The default chat route is unavailable'); }
    }
    const effort = meta.reasoningEffort !== undefined ? meta.reasoningEffort : fallback?.reasoningEffort;
    return Object.freeze({ model: meta.model ?? fallback?.model ?? null, provider: meta.provider ?? fallback?.provider ?? null, systemPrompt: meta.systemPrompt,
      ...(effort === undefined ? {} : { reasoningEffort: effort }) });
  }

  private async _runTurn(
    session: InternalSession,
    userMessageId: string,
    onTurnEvent?: (event: CompanionChatTurnEvent) => void,
    route = this.captureTurnRoute(session.meta),
    /** Runs inside the turn, after it owns the active slot and before the first provider round. */
    prepareConversation?: () => Promise<void>,
  ): Promise<void> {
    const turnId = randomUUID();
    const sessionId = session.meta.id;

    // Per-turn abort scope chained under the session controller, see
    // companion-chat-turn-control.ts for why the session controller must
    // never be aborted for a single-turn stop.
    const scope = createTurnAbortScope(turnId, session.abortController.signal);
    const abortSignal = scope.abortSignal;

    // Track announced-but-unresolved tool calls so a cancelled turn can close
    // them (every turn.tool_call gets a turn.tool_result before the terminal
    // event, no client is ever left rendering a wedged tool block).
    const openToolCalls = new Map<string, string>();

    const publish = (event: CompanionChatTurnEvent): void => {
      if (event.type === 'turn.tool_call' && event.toolCallId) {
        openToolCalls.set(event.toolCallId, event.toolName);
      } else if (event.type === 'turn.tool_result' && event.toolCallId) {
        openToolCalls.delete(event.toolCallId);
      }
      this.eventPublisher.publishEvent(
        `companion-chat.${event.type}`,
        event,
        // Never unfiltered: with no stream open the gateway would deliver the turn to every client.
        // Streams register as `companion-chat:<sessionId>:<suffix>`, so the prefix reaches every
        // reader of this session, including one that opens later, and no one else's.
        { clientIdPrefix: `companion-chat:${session.meta.id}:` },
      );
      // In-process tap (e.g. the HA SSE route); a throwing listener must not break the turn.
      try { onTurnEvent?.(event); } catch { /* isolate listener */ }
    };

    // Build user-message envelope for turn.started
    const userMsg = session.messages.find((m) => m.id === userMessageId);
    const startEnvelope: ConversationMessageEnvelope = {
      sessionId,
      messageId: userMessageId,
      body: userMsg?.content ?? '',
      source: 'companion-chat-user',
      timestamp: userMsg?.createdAt ?? Date.now(),
      ...(userMsg?.attachments?.length ? { attachments: userMsg.attachments } : {}),
    };

    let assistantContent = '';
    // The tail not yet committed to the conversation history (completed tool
    // rounds commit as they finish), what a cancel hands to the model-facing
    // history so later turns can reason about the interruption.
    let uncommittedContent = '';
    const assistantMessageId = randomUUID();

    const finalizeCancelled = (): void => finalizeCancelledTurn({
      sessionId,
      turnId,
      assistantMessageId,
      userMessageId,
      getAssistantContent: () => assistantContent,
      getUncommittedContent: () => uncommittedContent,
      commitPartialToHistory: (content) => { session.conversation.addAssistantMessage(content); },
      openToolCalls,
      wasCancelRequested: () => scope.activeTurn.cancelRequested,
      isShutdown: () => this.disposed,
      publish,
      persistPartial: (message) => {
        session.messages.push(this.normalizeMessage(message));
        session.lastActivityAt = message.createdAt;
        this._updateMeta(session, { messageCount: session.messages.length, updatedAt: message.createdAt });
        this._persist(sessionId);
      },
      resolveReply: (extra) => this.resolvePendingReply(userMessageId, { messageId: userMessageId, ...extra, error: 'Turn cancelled' }),
      settle: scope.settle,
    });

    let decisionRoute: import('../providers/decision-router.js').DecisionRouterRouteInfo | undefined;
    let actualUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    try {
      // Inside the try so a throwing publisher still releases the slot and drains the queue.
      session.activeTurn = scope.activeTurn;
      publish({ type: 'turn.started', sessionId, messageId: userMessageId, turnId, envelope: startEnvelope });
      const toolDefinitions = this.toolRegistry?.getToolDefinitions() ?? [];
      if (prepareConversation) await prepareConversation();

      let rounds = 0;
      while (!abortSignal.aborted) {
        rounds += 1;
        const stream = this.provider.chatStream([...session.conversation.getMessagesForLLM()], {
          routingContext: { sessionId, turnId, ...(userMsg ? { prompt: userMsg.content } : {}) },
          systemPrompt: appendGoodVibesRuntimeAwarenessPrompt(route.systemPrompt),
          model: route.model,
          provider: route.provider,
          reasoningEffort: route.reasoningEffort,
          tools: toolDefinitions,
          abortSignal,
        });

        uncommittedContent = '';
        const toolCalls: ToolCall[] = [];

        for await (const chunk of stream) {
          if (abortSignal.aborted) break;

          switch (chunk.type) {
            case 'text_delta': {
              const delta = chunk.delta ?? '';
              uncommittedContent += delta;
              assistantContent += delta;
              publish({ type: 'turn.delta', sessionId, turnId, delta });
              break;
            }
            case 'tool_call': {
              const toolCallId = chunk.toolCallId ?? '';
              const toolName = chunk.toolName ?? '';
              const toolInput = (chunk.toolInput ?? {}) as Record<string, unknown>;
              publish({
                type: 'turn.tool_call',
                sessionId,
                turnId,
                toolCallId,
                toolName,
                toolInput,
              });
              if (toolCallId && toolName) {
                toolCalls.push({ id: toolCallId, name: toolName, arguments: toolInput });
              }
              break;
            }
            case 'tool_result': {
              publish({
                type: 'turn.tool_result',
                sessionId,
                turnId,
                toolCallId: chunk.toolCallId ?? '',
                toolName: chunk.toolName ?? '',
                result: chunk.result ?? null,
                isError: chunk.isError ?? false,
              });
              break;
            }
            case 'error': {
              throw new Error(chunk.error ?? 'Provider streaming error');
            }
            case 'done':
              if (chunk.decisionRoute) decisionRoute = chunk.decisionRoute;
              if (chunk.usage) actualUsage = {
                inputTokens: actualUsage.inputTokens + chunk.usage.inputTokens,
                outputTokens: actualUsage.outputTokens + chunk.usage.outputTokens,
                cacheReadTokens: actualUsage.cacheReadTokens + (chunk.usage.cacheReadTokens ?? 0),
                cacheWriteTokens: actualUsage.cacheWriteTokens + (chunk.usage.cacheWriteTokens ?? 0),
              };
              break;
          }
        }

        if (abortSignal.aborted) break;

        if (toolCalls.length === 0) {
          session.conversation.addAssistantMessage(uncommittedContent);
          uncommittedContent = '';
          break;
        }

        const closeUnrun = (reason: string): void => {
          for (const call of toolCalls) {
            publish({ type: 'turn.tool_result', sessionId, turnId, toolCallId: call.id, toolName: call.name, result: reason, isError: true });
          }
        };

        if (!this.toolRegistry) {
          // Nothing will answer these calls, so they stay out of the history: a
          // provider rejects a later turn that carries a tool call with no result.
          if (uncommittedContent) session.conversation.addAssistantMessage(uncommittedContent);
          uncommittedContent = '';
          break;
        }

        if (rounds >= COMPANION_MAX_TOOL_ROUNDS) {
          if (uncommittedContent) session.conversation.addAssistantMessage(uncommittedContent);
          uncommittedContent = '';
          closeUnrun(`Not run: this reply reached its limit of ${String(COMPANION_MAX_TOOL_ROUNDS)} tool rounds.`);
          const finalText = await runToolExhaustionFinalizer(
            { provider: this.provider, finalizerPrompt: TOOL_EXHAUSTION_FINALIZER_PROMPT },
            { meta: { id: sessionId, model: route.model, provider: route.provider, reasoningEffort: route.reasoningEffort, systemPrompt: route.systemPrompt }, conversation: session.conversation },
            abortSignal, turnId, publish,
          );
          assistantContent += finalText;
          uncommittedContent = finalText;
          if (!abortSignal.aborted) {
            session.conversation.addAssistantMessage(finalText);
            uncommittedContent = '';
          }
          break;
        }

        session.conversation.addAssistantMessage(uncommittedContent, { toolCalls });
        uncommittedContent = '';

        const toolResults = await executeCompanionToolCalls(
          { toolRegistry: this.toolRegistry, permissionManager: this.permissionManager, hookDispatcher: this.hookDispatcher, runtimeBus: this.runtimeBus, configManager: this.configManager },
          toolCalls, publish, sessionId, turnId,
        );
        session.conversation.addToolResults(toolResults);
      }

      // A detected abort (user cancel, session close, or shutdown) where the
      // provider ended its stream gracefully instead of throwing: finalize as
      // a cancellation, persist the honest partial and emit the terminal
      // turn.cancelled, never record it as a successful complete reply.
      if (abortSignal.aborted) {
        finalizeCancelled();
        return;
      }

      const now = Date.now();
      const assistantMsg: CompanionChatMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        ...(decisionRoute ? { metadata: { decisionRoute, usage: actualUsage } } : {}),
        content: assistantContent,
        attachments: [],
        createdAt: now,
        inReplyTo: userMessageId,
      };
      session.messages.push(this.normalizeMessage(assistantMsg));
      session.lastActivityAt = now;
      this._updateMeta(session, { messageCount: session.messages.length, updatedAt: now });

      // Persist assistant reply
      this._persist(sessionId);

      const completedEnvelope: ConversationMessageEnvelope = {
        sessionId,
        messageId: assistantMessageId,
        body: assistantContent,
        source: 'companion-chat-assistant',
        timestamp: now,
      };

      publish({ type: 'turn.completed', sessionId, turnId, assistantMessageId, envelope: completedEnvelope });
      this.resolvePendingReply(userMessageId, { messageId: userMessageId, assistantMessageId, response: assistantContent });
    } catch (err: unknown) {
      if (!abortSignal.aborted) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        // The waiter is answered first: a publisher that threw once may throw again.
        this.resolvePendingReply(userMessageId, { messageId: userMessageId, error: errorMessage });
        publish({ type: 'turn.error', sessionId, turnId, error: errorMessage });
      } else {
        finalizeCancelled();
      }
    } finally {
      // Release the active-turn slot only if this turn still owns it (a newer
      // concurrent turn may have taken it), detach the session-abort chain,
      // and settle for any exit path that did not run finalizeCancelled
      // (resolve is idempotent, a second call is a no-op).
      if (session.activeTurn === scope.activeTurn) session.activeTurn = null;
      scope.detach();
      scope.settle({ partialPersisted: false });
      // Drain: a queued send (or a steer that jumped the queue) starts now.
      this._startNextTurn(session);
    }
  }

  // ---------------------------------------------------------------------------
  // Regenerate + edit-and-branch (honest lineage, see companion-chat-branching.ts)
  // ---------------------------------------------------------------------------

  /**
   * Regenerate an assistant response: supersede the target assistant message (an
   * explicit id, or the latest response) and everything after it, retained as
   * history, never deleted, then re-run a fresh turn from the preceding user
   * message. Refuses a closed (409 SESSION_CLOSED) or unknown (404
   * SESSION_NOT_FOUND) session; honest code when there is nothing to regenerate.
   */
  regenerateMessage(
    sessionId: string,
    input: RegenerateCompanionChatMessageInput = {},
    options: { readonly ownerDirect?: boolean | undefined; readonly clientId?: string | undefined } = {},
  ): RegenerateCompanionChatMessageOutput {
    const session = this._requireOpenSession(sessionId);
    this._assertNoTurnInFlight(session, 'regenerate a reply');
    this.rateLimiter?.check(sessionId, options.clientId ?? '');
    const route = this.captureTurnRoute(session.meta);
    const now = Date.now();
    const plan = planRegenerate(session, input.messageId, now);
    this._commitBranchAndRun(session, sessionId, plan.anchorUserMessageId, now, route, options.ownerDirect === true);
    const { regeneratedFrom, supersededMessageIds } = plan;
    return { sessionId, regeneratedFrom, supersededMessageIds, turnStarted: true };
  }

  /**
   * Edit a user message and branch from it: supersede the target user message and
   * everything after it (retained history), append a new user message carrying
   * `revisionOf` back to the original, and run a fresh turn. Same closed/unknown
   * refusals as {@link regenerateMessage}.
   */
  editMessage(
    sessionId: string,
    input: EditCompanionChatMessageInput,
    options: { readonly ownerDirect?: boolean | undefined; readonly clientId?: string | undefined } = {},
  ): EditCompanionChatMessageOutput {
    const session = this._requireOpenSession(sessionId);
    this._assertNoTurnInFlight(session, 'edit a message');
    this.rateLimiter?.check(sessionId, options.clientId ?? '');
    const route = this.captureTurnRoute(session.meta);
    const now = Date.now();
    const plan = applyEditBranch(session, sessionId, input, this.artifactStore, now);
    this._commitBranchAndRun(session, sessionId, plan.newMessageId, now, route, options.ownerDirect === true);
    const { editedFrom, newMessageId, supersededMessageIds } = plan;
    return { sessionId, editedFrom, messageId: newMessageId, supersededMessageIds, turnStarted: true };
  }

  /**
   * Regenerate and edit replace the conversation and start a turn of their
   * own, so they cannot run beside a reply, a message being prepared, or
   * queued sends: the older turn would keep streaming into the new branch.
   */
  private _assertNoTurnInFlight(session: InternalSession, action: string): void {
    const queued = session.pendingTurns?.length ?? 0;
    if (!session.activeTurn && !session.preparingTurns && !queued && !session.routingUpdatePending) return;
    const state = session.activeTurn ? 'is still replying' : queued ? `has ${String(queued)} queued message${queued === 1 ? '' : 's'} waiting` : 'is still preparing a message';
    throw Object.assign(
      new Error(`This chat ${state}, so it cannot ${action} now. Stop the current reply (or wait for it and any queued messages to finish), then try again.`),
      { code: 'CHAT_TURN_BUSY', status: 409 },
    );
  }

  /** Look up an active (open) session or throw the closed/not-found machine codes. */
  private _requireOpenSession(sessionId: string): InternalSession {
    this.assertAvailable(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') {
      throw Object.assign(new Error('Session is closed'), { code: EngineErrorCodes.SESSION_CLOSED, status: 409 });
    }
    return session;
  }

  /**
   * Shared tail of regenerate/edit: rebuild the LLM-facing conversation from the
   * ACTIVE (non-superseded) chain (mirroring init()'s replay so the next turn
   * sees only the live branch), persist, and fire the new turn.
   */
  private _commitBranchAndRun(
    session: InternalSession,
    sessionId: string,
    anchorUserMessageId: string,
    now: number,
    route: QueuedCompanionTurn['route'],
    ownerDirect: boolean,
  ): void {
    session.messages = session.messages.map(message => this.normalizeMessage(message));
    const conversation = new ConversationManager();
    let anchor: CompanionChatMessage | undefined;
    for (const msg of activeMessages(session.messages)) {
      if (msg.id === anchorUserMessageId) { anchor = msg; continue; }
      if (msg.role === 'user') conversation.addUserMessage(buildReplayUserContent(msg));
      else conversation.addAssistantMessage(msg.content);
    }
    session.conversation = conversation;
    this._updateMeta(session, { messageCount: session.messages.length, updatedAt: now });
    this._persist(sessionId);
    // Same funnel as a fresh send: an owner-driven edit restarts the
    // untrusted-content window; a caller that cannot attest ownership does not.
    startTurnForOwnerInput({ ownerDirect });
    // The message the turn answers goes to the model the way a fresh send
    // does, with its files read in, not as the text-only summary used to
    // rebuild older history. Built inside the turn so its read is owned by it.
    const prepareAnchor = async (): Promise<void> => {
      if (!anchor) return;
      conversation.addUserMessage(await buildProviderUserContent(anchor.content, anchor.attachments ?? [], this.artifactStore));
    };
    this.ownTurn(this._runTurn(session, anchorUserMessageId, undefined, route, prepareAnchor), (error: unknown) => {
      logger.warn('[companion-chat] branch turn execution failed', { sessionId, error: summarizeError(error) });
    });
  }

  // ---------------------------------------------------------------------------
  // GC sweep
  // ---------------------------------------------------------------------------

  /**
   * Periodic GC sweep. Deletion authority is SPLIT (charter: closed sessions are
   * HISTORY): close-idle closes an idle active session; evict-memory drops a
   * long-closed session's replay state (transcript, meta and on-disk copy kept);
   * delete-persistent removes the file ONLY under an explicit finite retention
   * window (default retains indefinitely, see {@link planCompanionSweep}).
   */
  _gcSweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const action = planCompanionSweep(
        {
          status: session.meta.status,
          closedAt: session.meta.closedAt,
          lastActivityAt: session.lastActivityAt,
          hasReplayInMemory: !session.replayEvicted,
          isEmpty: session.messages.length === 0,
        },
        {
          now,
          idleActiveMs: this.idleActiveMs,
          idleEmptyMs: this.idleEmptyMs,
          closedMemoryGraceMs: this.closedMemoryGraceMs,
          closedRetentionMs: this.closedRetentionMs,
        },
      );

      switch (action.kind) {
        case 'close-idle':
          // A long reply or queued work is activity, however long ago the last message landed.
          if (session.activeTurn || session.preparingTurns || session.pendingTurns?.length) break;
          session.abortController.abort();
          this._abandonQueuedTurns(session, 'This chat was closed for inactivity before this queued message was answered.');
          this._updateMeta(session, { status: 'closed', closedAt: now, updatedAt: now });
          this._persist(id);
          this._brokerSync.track(id, () => this._brokerSync.closeSession(id));
          break;
        case 'evict-memory':
          // Free the replay state only. The transcript stays: the routes serve
          // it from memory, and a later save writes it, so dropping it would
          // show an empty chat and could replace the saved file with nothing.
          session.conversation = new ConversationManager();
          session.replayEvicted = true;
          break;
        case 'delete-persistent':
          void this._hardRemove(id).catch((error: unknown) => {
            logger.warn('[companion-chat] session delete failed', {
              sessionId: id,
              error: summarizeError(error),
            });
          });
          break;
        case 'retain':
          break;
      }
    }
  }

  private _updateMeta(
    session: InternalSession,
    patch: Partial<MutableSessionMeta>,
  ): CompanionChatSession {
    const updated: CompanionChatSession = { ...session.meta, ...patch };
    (session as { meta: CompanionChatSession }).meta = updated;
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Live shared-broker registration, see companion-chat-broker-sync.ts
  // ---------------------------------------------------------------------------

  /**
   * Await all in-flight best-effort broker-sync operations. The daemon's
   * companion HTTP routes call this before responding so `/api/sessions`
   * reflects the change synchronously; tests use it to make the mirror
   * deterministic. A no-op when no broker bridge is configured.
   */
  async flushBrokerSync(): Promise<void> {
    await this._brokerSync.flush();
  }

  /**
   * Hard-remove a session's persisted file and in-memory record. The ONE
   * removal code path, shared by {@link deleteSession} and the GC
   * 'delete-persistent' action. Never fork this. Order matters:
   * drop the map entry, drain any in-flight {@link _persist} save for this
   * id, THEN unlink, else a save mid-write from {@link closeSession} can
   * resurrect the file post-unlink.
   */
  private async _hardRemove(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    try {
      const pendingSave = this._pendingSaves.get(sessionId);
      if (pendingSave) await pendingSave.catch(() => {});
      await this.persistence?.delete(sessionId);
    } catch (error) {
      // The file is still on disk, so the chat must stay known: otherwise it is
      // gone from the API, back after a restart, and the delete cannot be retried.
      if (session && !this.sessions.has(sessionId)) this.sessions.set(sessionId, session);
      throw error;
    }
  }

  /**
   * Schedule a persistence save for the given session.
   * Saves are serialized per-session: each new save waits for the prior one to
   * complete before writing. The save always reads the CURRENT session state,
   * so rapid create→update→close sequences correctly persist the final state.
   */
  private assertEffortPublication(effort: string | null | undefined): void {
    if (effort === undefined) return;
    if (effort !== null && readReasoningEffortLevel(effort) === undefined) {
      throw Object.assign(new Error('Invalid chat reasoning effort.'), { code: 'INVALID_ARGUMENT', status: 400 });
    }
    if (!this.persistence) return;
    try {
      const result: unknown = this.nativeDataWriter?.declare('companion-chat-effort-v1');
      if (result !== undefined) { drainOwned(result); throw new Error('Session effort publication requires a synchronous native writer'); }
    } catch (error) { drainOwned(error); throw error instanceof Error ? error : new Error('Session effort publication is unavailable'); }
  }

  async flushSession(sessionId: string): Promise<void> {
    try {
      await this._pendingSaves.get(sessionId);
      if (this.saveFailures.has(sessionId)) throw this.storageUnavailable(sessionId);
    } catch { throw this.storageUnavailable(sessionId); }
  }

  private storageUnavailable(sessionId?: string, cause?: unknown): Error & { readonly code: string; readonly status: number } {
    // A failed save is not retried by the change that follows it: a later snapshot could land out of order. The chat refuses changes until recoverFailedSaves() writes its current state in one piece.
    const failure = sessionId !== undefined && this.saveFailures.has(sessionId) ? this.saveFailures.get(sessionId) : cause;
    const held = failure instanceof AtomicWriteDurabilityError && failure.phase === 'published-indeterminate';
    const message = failure === undefined
      ? 'The companion chat service is shutting down, or this chat changed while the request was running. Retry the request; if the service is shutting down, retry after it restarts.'
      : held
        ? `Saving this chat may have partly succeeded (${summarizeError(failure)}), so the daemon cannot tell what is on disk and the chat accepts no more changes. Restart the daemon: it reloads the saved chat, and the chat opens again.`
        : `Saving this chat failed (${summarizeError(failure)}), so it accepts no more changes for now. The daemon retries saving it on its own and opens the chat again once that works; check that the companion chat storage directory is writable and has space, then try again in a minute.`;
    return Object.assign(new Error(message), { code: 'CHAT_PERSISTENCE_UNAVAILABLE', status: 503 });
  }

  private assertAvailable(sessionId?: string): void {
    if (this.disposed || sessionId !== undefined && this.saveFailures.has(sessionId)) {
      throw this.storageUnavailable(sessionId);
    }
  }

  private queueSave<T>(sessionId: string, save: () => T | Promise<T>): Promise<T> {
    const prior = this._pendingSaves.get(sessionId) ?? Promise.resolve();
    const operation = prior.then(() => { this.assertAvailableForSave(sessionId); return save(); });
    const tracked = operation.then(() => undefined);
    this._pendingSaves.set(sessionId, tracked);
    const done = () => { if (this._pendingSaves.get(sessionId) === tracked) this._pendingSaves.delete(sessionId); };
    void tracked.then(done, error => {
      this.saveFailures.set(sessionId, error); done();
      logger.warn('[companion-chat] session persistence failed', { sessionId, error: summarizeError(error) });
    });
    return operation;
  }

  private assertAvailableForSave(sessionId: string): void {
    if (this.saveFailures.has(sessionId)) throw this.saveFailures.get(sessionId);
  }

  /**
   * Try again to save every chat whose save failed, and reopen the ones that
   * work.
   *
   * Safe against an older snapshot landing over a newer one: a chat with a
   * recorded failure refuses every change and every queued save, so once its
   * saves already in flight have settled nothing else can be writing it, and
   * the snapshot taken here is the latest there is. Run by the periodic sweep.
   * Returns how many chats were reopened.
   */
  async recoverFailedSaves(): Promise<number> {
    if (!this.persistence || this.disposed) return 0;
    let reopened = 0;
    for (const sessionId of [...this.saveFailures.keys()]) {
      if (this.recoveringSaves.has(sessionId)) continue;
      // A write that may already have been published is held for a restart to
      // reload from disk: what it published is not necessarily this chat's
      // in-memory state (a refused route change), so rewriting would guess.
      const failure = this.saveFailures.get(sessionId);
      if (failure instanceof AtomicWriteDurabilityError && failure.phase === 'published-indeterminate') continue;
      this.recoveringSaves.add(sessionId);
      try {
        await this._pendingSaves.get(sessionId)?.catch(() => undefined);
        const session = this.sessions.get(sessionId);
        if (!session) { this.saveFailures.delete(sessionId); continue; }
        if (this.disposed) return reopened;
        try {
          await this.persistence.save({ meta: session.meta, messages: session.messages });
        } catch (error) {
          this.saveFailures.set(sessionId, error);
          logger.debug('[companion-chat] retrying a failed chat save did not work yet', { sessionId, error: summarizeError(error) });
          continue;
        }
        this.saveFailures.delete(sessionId);
        reopened += 1;
        logger.info('[companion-chat] a chat whose save had failed saved again and accepts changes', { sessionId });
        // A turn that was already running while the chat was refused may have
        // appended since the snapshot above; its own saves were refused.
        this._persist(sessionId);
      } finally { this.recoveringSaves.delete(sessionId); }
    }
    return reopened;
  }

  private _persist(sessionId: string): void {
    if (!this.persistence) return;
    void this.queueSave(sessionId, () => this._doSave(sessionId));
  }

  private async _doSave(sessionId: string): Promise<void> {
    if (!this.persistence) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.assertEffortPublication(session.meta.reasoningEffort);
    await this.persistence.save({ meta: session.meta, messages: session.messages });
  }

  /**
   * Queued sends whose turn can no longer start (the chat closed, or the
   * service is going away): answer every waiter with an error instead of
   * leaving it pending forever, and move each from `queued` to the terminal
   * `unanswered` in the transcript so nothing keeps showing a message as
   * waiting for a turn that will never run. The caller persists.
   */
  private _abandonQueuedTurns(session: InternalSession, reason: string): void {
    for (const entry of session.pendingTurns?.splice(0) ?? []) {
      this.resolvePendingReply(entry.userMessageId, { messageId: entry.userMessageId, error: reason });
    }
    this._markUnanswered(session);
  }

  /** Every user message still marked `queued` becomes `unanswered`. True when any changed. */
  private _markUnanswered(session: InternalSession): boolean {
    let changed = false;
    session.messages = session.messages.map((message) => {
      if (message.role !== 'user' || message.deliveryState !== 'queued') return message;
      changed = true;
      return this.normalizeMessage({ ...message, deliveryState: 'unanswered' });
    });
    return changed;
  }

  private resolvePendingReply(messageId: string, result: CompanionChatReplyResult): void {
    const pending = this.pendingReplies.get(messageId);
    if (!pending) return;
    this.pendingReplies.delete(messageId);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }
}
