import { captureOwnedJson } from '../gate/judgment-input.js';
import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes-jev/judgment/decisions';
import { readReasoningEffortLevel } from '../providers/reasoning-effort.js';
import type { NativeDataWriteOwner } from '../runtime/native-reader-compatibility.js';
/**
 * companion-chat-manager.ts
 *
 * Disk-backed manager for companion-app chat-mode sessions.
 *
 * Design:
 * - Each session has a transcript (what clients read) and a model-facing
 *   history (a ConversationManager). Either can be absent from memory: an idle
 *   or closed chat keeps only its summary, the transcript is read from disk
 *   when the chat is opened, and the history is rebuilt from the transcript on
 *   the next send (companion-chat-history.ts).
 * - Sessions survive daemon restart via CompanionChatPersistence: a summary
 *   document per chat and an append-only transcript, so a save is one small
 *   write whatever the chat's length.
 * - Inbound messages are rate-limited per session and per client via
 *   CompanionChatRateLimiter (token-bucket, 30 msgs/min per client,
 *   10 msgs/min per session by default, configurable).
 * - When a user message is posted, the manager appends it to the transcript
 *   and runs a turn through the one turn loop (core/turn-loop.ts). Each turn
 *   runs in its own untrusted-content scope, so what one chat reads and when
 *   its owner speaks never move another session's exposure window.
 * - Streaming chunks are fanned out via ControlPlaneGateway.publishEvent
 *   with a per-session clientId filter, so they only reach the subscribers
 *   of that specific session, never the global TUI event feed.
 * - Idleness never closes a chat; only a person (or the integration that
 *   owns it) does, and a closed chat can be reopened.
 */

import { randomUUID } from 'node:crypto';
import { EngineErrorCodes, RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import type { ConversationManager } from '../core/conversation.js';
import { startTurnForOwnerInput } from '../security/turn-boundary.js';
import { withUntrustedContentScope } from '../security/untrusted-content.js';
import type { CompanionPostMessageOptions } from './companion-chat-turn-control.js';
import type {
  CancelCompanionChatTurnInput,
  CancelCompanionChatTurnOutput,
  SteerCompanionChatMessageOutput,
  CompanionChatMessageAttachmentInput,
  CompanionChatMessage,
  CompanionChatMessagePage,
  CompanionChatSession,
  CompanionChatTurnEvent,
  ConversationMessageEnvelope,
  CreateCompanionChatSessionInput,
  EditCompanionChatMessageInput,
  EditCompanionChatMessageOutput,
  RegenerateCompanionChatMessageInput,
  RegenerateCompanionChatMessageOutput,
  ReopenCompanionChatSessionOutput,
  UpdateCompanionChatSessionInput,
} from './companion-chat-types.js';
import {
  CompanionChatPersistence,
  defaultSessionsDir,
} from './companion-chat-persistence.js';
import {
  buildProviderUserContent,
  resolveAttachments,
  type CompanionChatArtifactStore,
} from './companion-chat-attachments.js';
import {
  applyEditBranch,
  planRegenerate,
} from './companion-chat-branching.js';
import {
  DAEMON_STOPPED_REASON,
  TurnHistoryWriter,
  rebuildConversation,
  turnFailureNote,
} from './companion-chat-history.js';
import {
  executeCompanionToolCalls,
} from './companion-chat-turn-execution.js';
import { planCompanionSweep } from './companion-chat-gc.js';
import type { CompanionSessionBrokerBridge } from './companion-chat-broker-bridge.js';
import { CompanionBrokerSync } from './companion-chat-broker-sync.js';
import { CompanionChatRateLimiter } from './companion-chat-rate-limiter.js';
import type { CompanionChatRateLimiterOptions } from './companion-chat-rate-limiter.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { toolCallActivity } from '@goodvibes-jev/engine/contracts';
import { runTurn, type TurnModelResponse, type TurnRequest } from '../core/turn-loop.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../tools/goodvibes-runtime/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
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
// Memory constants (customisable for tests)
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_ACTIVE_MS = 30 * 60 * 1_000; // drop an idle chat's history from memory after 30 minutes
const DEFAULT_IDLE_EMPTY_MS = 5 * 60 * 1_000;   // 5 minutes for an empty chat
const DEFAULT_CLOSED_MEMORY_GRACE_MS = 5 * 60 * 1_000; // evict closed bodies from RAM after 5 min
const MAX_REMEMBERED_CLIENT_MESSAGE_IDS = 500; // per session
const GC_INTERVAL_MS = 60 * 1_000;               // sweep every minute
const DEFAULT_MESSAGE_PAGE = 100;
const MAX_MESSAGE_PAGE = 1_000;

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

/** The untrusted-content scope a chat's turns run in. */
export function companionChatContentScope(sessionId: string): string {
  return `companion-chat:${sessionId}`;
}

/** What a storage failure is called in a refusal: its error code, never a path. */
function storageFailureName(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'a storage error';
}

interface InternalSession {
  meta: CompanionChatSession;
  /** The transcript; null while it is only on disk (an idle or closed chat). */
  messages: CompanionChatMessage[] | null;
  /** The model-facing history; null until it is rebuilt from the transcript for the next turn. */
  conversation: ConversationManager | null;
  /** Aborts everything the chat runs; replaced when a closed chat is reopened. */
  abortController: AbortController;
  /** The in-flight turn, when one is running (see ActiveCompanionTurn). */
  activeTurn?: ActiveCompanionTurn | null;
  /** User messages whose turns have not started yet (queue-when-busy + steer-to-front). */
  pendingTurns?: QueuedCompanionTurn[];
  preparingTurns?: number;
  /** Client-chosen send ids already accepted, so a re-sent request answers with the first message instead of a second turn. Memory only: forgotten with the session or on a restart. */
  clientMessageIds?: Map<string, string>;
  lastActivityAt: number;
  /** Messages whose save failed after they were already in memory; the next save of this chat writes them. */
  unsaved?: Set<string>;
  metaUnsaved?: boolean;
  /** Why the last of those saves failed. */
  saveError?: unknown;
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
  /** Directory for session files. Default `<homeDirectory>/.goodvibes/companion-chat/sessions/`
   * (else OS home). Prefer passing this (or `homeDirectory`) so an isolated-home daemon stays in. */
  readonly sessionsDir?: string | undefined;
  /** Injected home dir; when `sessionsDir` is omitted, the persistence root is
   * derived from THIS home (not the OS home) so an isolated-home daemon stays in. */
  readonly homeDirectory?: string | undefined;
  /**
   * Optional bridge to the shared session broker. When supplied, companion
   * sessions register INTO the broker at write time (create/close/reopen), so
   * `/api/sessions` reflects companion activity immediately (same-process, no
   * restart). The boot-time importer fold remains the reconciliation path.
   */
  readonly sessionBroker?: CompanionSessionBrokerBridge | null | undefined;
  /** Age (ms past closedAt) at which a CLOSED session's transcript leaves memory
   * while its summary stays listable (bounds resident memory). Default 5 min. */
  readonly closedSessionMemoryGraceMs?: number | undefined;
  /** Age (ms past closedAt) at which a CLOSED session's files are PERMANENTLY
   * deleted, or a reader of it that is asked on every sweep (a setting). Closed
   * sessions are HISTORY: absent or undefined = retain indefinitely. */
  readonly closedSessionRetentionMs?: number | (() => number | undefined) | undefined;
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
  private readonly closedRetention: () => number | undefined;
  private readonly sessionBroker: CompanionSessionBrokerBridge | null;
  /** Live mirror of sessions into the shared broker store. */
  private readonly _brokerSync: CompanionBrokerSync;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks whether the async init() has completed. */
  private initCompleted = false;
  private readonly pendingReplies = new Map<string, PendingReply>();
  /** True once dispose() ran, lets a cancelled turn report stoppedBy 'shutdown' honestly. */
  private disposed = false;
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
    const retention = config.closedSessionRetentionMs;
    this.closedRetention = typeof retention === 'function' ? retention : () => retention;
    this.sessionBroker = config.sessionBroker ?? null;
    this._brokerSync = new CompanionBrokerSync(this.sessionBroker);

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
    }, gcIntervalMs);
    // Don't block node process on this timer
    this.gcTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Async initialisation, load persisted sessions from disk
  // ---------------------------------------------------------------------------

  /**
   * Load the summaries of sessions persisted by a previous daemon run. Their
   * transcripts are read when each chat is first opened.
   * Should be called once after construction before accepting requests.
   * Safe to call multiple times (idempotent after first call).
   */
  async init(): Promise<void> {
    if (this.initCompleted || !this.persistence) {
      this.initCompleted = true;
      return;
    }

    const metas = this.persistence.loadIndex();
    const rejected = this.persistence.rejectedOnLoad();
    if (rejected.length > 0) {
      // Set-aside chats are not in the list; say so at startup so a missing chat is explained.
      logger.warn('[companion-chat] saved chats could not be loaded and were set aside', {
        rejected: rejected.length,
        rejectedFiles: rejected.map((entry) => `${entry.file}: ${entry.reason}`),
      });
    }
    for (const meta of metas) {
      this.sessions.set(meta.id, {
        meta,
        messages: null,
        conversation: null,
        abortController: new AbortController(),
        lastActivityAt: meta.updatedAt,
      });
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

    const session: InternalSession = {
      meta,
      conversation: null,
      messages: [],
      abortController: new AbortController(),
      lastActivityAt: now,
    };
    // Saved before it exists anywhere else: a chat whose summary could not be
    // written is refused rather than lost at the next restart.
    this.saveForRequest(session, [], meta);
    this.sessions.set(id, session);
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
    const session = this.sessions.get(sessionId);
    return session ? [...this.transcript(session)] : [];
  }

  /**
   * One page of a chat's transcript, oldest first: the `limit` messages
   * (default 100, at most 1000) before `before`, or the latest ones without it.
   */
  getMessagePage(sessionId: string, input: { readonly before?: string | undefined; readonly limit?: number | undefined } = {}): CompanionChatMessagePage {
    const session = this.sessions.get(sessionId);
    const all = session ? this.transcript(session) : [];
    const limit = Math.min(MAX_MESSAGE_PAGE, Math.max(1, Math.floor(input.limit ?? DEFAULT_MESSAGE_PAGE)));
    let end = all.length;
    if (input.before !== undefined) {
      const index = all.findIndex((message) => message.id === input.before);
      if (index === -1) {
        throw Object.assign(new Error(`Message not found: ${input.before}`), { code: 'MESSAGE_NOT_FOUND', status: 404 });
      }
      end = index;
    }
    const start = Math.max(0, end - limit);
    const messages = all.slice(start, end);
    return {
      messages,
      total: all.length,
      more: start > 0,
      ...(start > 0 && messages[0] ? { nextBefore: messages[0].id } : {}),
    };
  }

  /** Borrow one immutable header for a live source check without copying the transcript. */
  getMessage(sessionId: string, messageId: string): CompanionChatMessage | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.transcript(session).find(message => message.id === messageId) : undefined;
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

  /**
   * The chat's transcript, read from disk when it is not in memory. Reading it
   * also settles what a previous daemon run left unfinished: a queued send
   * (the queue lived in memory) is marked unanswered, and a reply the daemon
   * stopped in is recorded as a failed reply.
   */
  private transcript(session: InternalSession): CompanionChatMessage[] {
    if (session.messages) return session.messages;
    if (!this.persistence) return (session.messages = []);
    const loaded = this.persistence.loadTranscript(session.meta.id);
    const messages = loaded.messages.map((message) => this.normalizeMessage(message));
    session.messages = messages;
    const changed: CompanionChatMessage[] = [];
    for (const [index, message] of messages.entries()) {
      if (message.role !== 'user' || message.deliveryState !== 'queued') continue;
      const unanswered = this.normalizeMessage({ ...message, deliveryState: 'unanswered' });
      messages[index] = unanswered;
      changed.push(unanswered);
    }
    const stoppedIn = this.unfinishedReplyAfterLoad(session, messages, loaded.lastTurn);
    if (stoppedIn) {
      const failed = this.normalizeMessage({
        id: randomUUID(),
        sessionId: session.meta.id,
        role: 'assistant',
        content: '',
        attachments: [],
        createdAt: Date.now(),
        inReplyTo: stoppedIn,
        deliveryState: 'failed',
        failureReason: DAEMON_STOPPED_REASON,
      });
      messages.push(failed);
      changed.push(failed);
    }
    const counted = messages.length !== session.meta.messageCount;
    if (counted) session.meta = { ...session.meta, messageCount: messages.length };
    if (changed.length > 0 || counted) this.saveInBackground(session, changed, changed.length > 0 || counted);
    return messages;
  }

  /** The user message whose reply a previous daemon run was writing when it stopped, if any. */
  private unfinishedReplyAfterLoad(
    session: InternalSession,
    messages: readonly CompanionChatMessage[],
    lastTurn: { readonly userMessageId: string; readonly phase: 'started' | 'ended' } | undefined,
  ): string | undefined {
    const answered = (id: string): boolean => messages.some((m) => m.role === 'assistant' && m.inReplyTo === id);
    if (lastTurn) {
      return lastTurn.phase === 'started' && !answered(lastTurn.userMessageId) && messages.some((m) => m.id === lastTurn.userMessageId)
        ? lastTurn.userMessageId
        : undefined;
    }
    // Chats saved before turns were marked: an active chat that ends in a
    // delivered question with no reply was cut off.
    if (session.meta.status !== 'active') return undefined;
    const last = [...messages].reverse().find((m) => m.supersededAt === undefined);
    return last?.role === 'user' && last.deliveryState === undefined && !answered(last.id) ? last.id : undefined;
  }

  updateSession(
    sessionId: string,
    input: UpdateCompanionChatSessionInput,
  ): CompanionChatSession {
    const session = this._requireOpenSession(sessionId);
    const admitted = captureOwnedJson(input) as UpdateCompanionChatSessionInput;
    const patch = this.prepareSessionPatch(session, admitted);
    const updated: CompanionChatSession = { ...session.meta, ...patch };
    // Saved before the change takes effect: a refused save leaves the chat as it was.
    this.saveForRequest(session, [], updated);
    session.meta = updated;
    // Heartbeat the broker record (advances participant.lastSeenAt). Title is
    // never overwritten by this path (broker treats register as a heartbeat).
    this._brokerSync.track(updated.id, () => this._brokerSync.registerSession(updated));
    return updated;
  }

  /** The HTTP form of {@link updateSession}: the change is saved before it is acknowledged. */
  async updateSessionPersisted(sessionId: string, input: UpdateCompanionChatSessionInput): Promise<CompanionChatSession> {
    return this.updateSession(sessionId, input);
  }

  private prepareSessionPatch(session: InternalSession, input: UpdateCompanionChatSessionInput): Partial<MutableSessionMeta> {
    assertCompleteProviderModelRoute(input);
    if ((session.activeTurn || session.preparingTurns)
      && (input.model !== undefined || input.provider !== undefined || input.reasoningEffort !== undefined)) {
      throw Object.assign(new Error('Wait for this chat’s current reply to finish before changing its model or effort.'), { code: 'CHAT_ROUTE_BUSY', status: 409 });
    }
    this.assertEffortPublication(input.reasoningEffort);
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
   * Close a session cleanly (a person's or its integration's decision). Aborts
   * any in-flight turn. Returns the session snapshot, or null if not found. A
   * closed chat can be reopened with {@link reopenSession}.
   */
  closeSession(sessionId: string): CompanionChatSession | null {
    this.assertAvailable();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.meta.status === 'closed') return session.meta;

    const now = Date.now();
    const updated: CompanionChatSession = { ...session.meta, status: 'closed', closedAt: now, updatedAt: now };
    this.saveForRequest(session, [], updated);
    session.abortController.abort();
    session.meta = updated;
    this._abandonQueuedTurns(session, 'This chat was closed before this queued message was answered.');
    // Live spine: flip the shared broker record to closed at write time.
    this._brokerSync.track(sessionId, () => this._brokerSync.closeSession(sessionId));

    return updated;
  }

  /**
   * Open a closed chat again (`companion.chat.sessions.reopen`). The model's
   * history is rebuilt from the transcript on the next send. Reopening an open
   * chat changes nothing and says so.
   */
  reopenSession(sessionId: string): ReopenCompanionChatSessionOutput {
    this.assertAvailable();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status !== 'closed') return { sessionId, status: session.meta.status, reopened: false };
    const updated: CompanionChatSession = { ...session.meta, status: 'active', closedAt: null, updatedAt: Date.now() };
    this.saveForRequest(session, [], updated);
    session.meta = updated;
    session.abortController = new AbortController();
    session.conversation = null;
    session.lastActivityAt = updated.updatedAt;
    const broker = this.sessionBroker;
    if (broker) {
      this._brokerSync.track(sessionId, async () => {
        try {
          await broker.register({
            sessionId,
            kind: 'companion-chat',
            project: 'unknown',
            title: updated.title,
            participant: { surfaceKind: 'companion', surfaceId: sessionId, lastSeenAt: Date.now() },
            reopen: true,
          });
        } catch (error) {
          logger.warn('[companion-chat] broker reopen failed', { sessionId, error: summarizeError(error) });
        }
      });
    }
    return { sessionId, status: 'active', reopened: true };
  }

  /**
   * Cancel the in-flight turn (`companion.chat.turns.cancel`), a per-turn
   * stop that never touches the session controller. Refusal semantics and the
   * bounded finalization wait live in companion-chat-turn-control.ts.
   */
  async cancelTurn(sessionId: string, input: CancelCompanionChatTurnInput = {}): Promise<CancelCompanionChatTurnOutput> {
    this.assertAvailable();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    return cancelActiveTurn(sessionId, session.activeTurn ?? null, input);
  }

  /**
   * Permanently delete a session (see CHANGELOG 1.0.0: `delete` is now a genuine removal,
   * distinct from `closeSession` above). Aborts any in-flight turn, removes
   * the on-disk files, and drops the in-memory entry, reusing
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
    this.assertAvailable();
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
    const session = this._requireOpenSession(sessionId);

    // A re-sent request (the first answer never arrived) is answered with the
    // first message, before it can count against the rate limit or run again.
    const alreadyAccepted = options.clientMessageId === undefined ? undefined : session.clientMessageIds?.get(options.clientMessageId);
    if (alreadyAccepted !== undefined) return alreadyAccepted;

    // Rate-limit check (throws GoodVibesError on violation)
    this.rateLimiter?.check(sessionId, clientId);

    this.assertEffortPublication(session.meta.reasoningEffort);
    const route = this.captureTurnRoute(session.meta);
    const attachments = resolveAttachments(options.attachments ?? [], this.artifactStore);
    if (!content.trim() && attachments.length === 0) {
      throw Object.assign(new Error('content or attachments are required'), { code: 'INVALID_ARGUMENT', status: 400 });
    }

    const messageId = randomUUID();

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
    if (this.disposed) throw this.serviceStopping();
    if (this.sessions.get(sessionId) !== session || session.meta.status !== 'active') throw this.chatClosed('The chat was closed while this message was being prepared.');

    // A duplicate that was still being prepared when the first one landed.
    const acceptedWhilePreparing = options.clientMessageId === undefined ? undefined : session.clientMessageIds?.get(options.clientMessageId);
    if (acceptedWhilePreparing !== undefined) return acceptedWhilePreparing;

    // A send that lands while another turn is running QUEUES (visible in the
    // transcript immediately, marked 'queued', answered after the current
    // turn), it must never start a concurrent turn against the same
    // conversation. A steer jumps the queue instead (see steerMessage). Decided
    // here, after the preparation await, because a turn that started during it
    // is the one this message waits behind.
    const queuedBehindActiveTurn = session.activeTurn != null && options.steer !== true;
    const now = Date.now();
    const userMsg = this.normalizeMessage({
      id: messageId,
      sessionId,
      role: 'user',
      content,
      attachments,
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      createdAt: now,
      ...(queuedBehindActiveTurn ? { deliveryState: 'queued' as const } : {}),
    });
    const messages = this.transcript(session);
    const meta: CompanionChatSession = { ...session.meta, messageCount: messages.length + 1, updatedAt: now };
    // Saved before it is accepted: a message whose save failed is refused, and
    // nothing else about the chat changes.
    this.saveForRequest(session, [userMsg], meta);
    messages.push(userMsg);
    session.meta = meta;
    session.lastActivityAt = now;

    if (options.clientMessageId !== undefined) {
      const accepted = (session.clientMessageIds ??= new Map());
      accepted.set(options.clientMessageId, messageId);
      if (accepted.size > MAX_REMEMBERED_CLIENT_MESSAGE_IDS) {
        const oldest = accepted.keys().next().value;
        if (oldest !== undefined) accepted.delete(oldest);
      }
    }

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
      this._abandonQueuedTurns(session, 'The companion chat service shut down before this queued message was answered.');
    }
    void (async () => {
      while (this.activeWork.size) await Promise.allSettled([...this.activeWork]);
      await this._brokerSync.flush();
      // One last attempt for changes whose save failed earlier; what still fails is reported.
      const owes = (session: InternalSession): boolean => Boolean(session.unsaved?.size || session.metaUnsaved);
      for (const session of this.sessions.values()) if (owes(session)) this.saveInBackground(session, [], false);
      const stillUnsaved = [...this.sessions.values()].filter(owes).length;
      try { await this.persistence?.flush(); } finally { this.persistence?.close(); }
      this.sessions.clear();
      if (stillUnsaved) throw new Error(`Companion chat changes were not saved for ${stillUnsaved} chat(s)`);
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
        // must never cancel its own turn or an unrelated newer one. A turn
        // still stopping (TURN_STOPPING) is not reported as cancelled; the
        // steer starts when it has stopped.
        const code = (err as { code?: string }).code;
        if (code !== 'NO_ACTIVE_TURN' && code !== 'TURN_MISMATCH' && code !== 'TURN_STOPPING') {
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
    const messages = this.transcript(session);
    const idx = messages.findIndex((m) => m.id === next.userMessageId);
    const queuedMsg = idx >= 0 ? messages[idx] : undefined;
    if (queuedMsg?.deliveryState === 'queued') {
      const { deliveryState: _cleared, ...rest } = queuedMsg;
      const delivered = this.normalizeMessage(rest);
      messages[idx] = delivered;
      this.saveInBackground(session, [delivered], false);
    }
    this.launchTurn(session, next.ownerDirect === true, () => this._runTurn(session, next.userMessageId, next.onTurnEvent, next.route, async () => {
      const conversation = await this.ensureConversation(session, next.userMessageId);
      conversation.addUserMessage(next.providerContent);
      return conversation;
    }));
  }

  /**
   * Start a turn in the chat's own untrusted-content scope. The scope is what
   * keeps the owner's message here from ending another session's exposure
   * window, and what this chat's tools read from counting against another
   * session's sends. Cost: one AsyncLocalStorage.run per turn.
   */
  private launchTurn(session: InternalSession, ownerDirect: boolean, run: () => Promise<void>): void {
    const sessionId = session.meta.id;
    const work = withUntrustedContentScope(companionChatContentScope(sessionId), () => {
      // The companion/webui turn boundary: this manager runs its own turn loop,
      // so the one in Orchestrator.runTurn never reached it. See turn-boundary.ts.
      startTurnForOwnerInput({ ownerDirect });
      return run();
    });
    this.activeWork.add(work);
    void work.then(() => { this.activeWork.delete(work); }, (error: unknown) => {
      this.activeWork.delete(work);
      logger.warn('[companion-chat] turn execution failed', { sessionId, error: summarizeError(error) });
    });
  }

  /** The chat's model-facing history, rebuilt from the transcript when it is not in memory. */
  private async ensureConversation(session: InternalSession, answering: string): Promise<ConversationManager> {
    if (session.conversation) return session.conversation;
    const rebuilt = await rebuildConversation(this.transcript(session), answering, this.artifactStore);
    session.conversation ??= rebuilt;
    return session.conversation;
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

  private markTurn(session: InternalSession, userMessageId: string, phase: 'started' | 'ended'): void {
    if (!this.persistence) return;
    try {
      this.persistence.markTurn(session.meta.id, { userMessageId, phase, at: Date.now() });
    } catch (error) {
      logger.warn('[companion-chat] recording a turn boundary failed', { sessionId: session.meta.id, error: summarizeError(error) });
    }
  }

  /** Add a reply the turn produced to the transcript and save it. */
  private recordReply(session: InternalSession, message: CompanionChatMessage): void {
    const owned = this.normalizeMessage(message);
    this.transcript(session).push(owned);
    session.lastActivityAt = owned.createdAt;
    session.meta = { ...session.meta, messageCount: this.transcript(session).length, updatedAt: owned.createdAt };
    this.saveInBackground(session, [owned], true);
  }

  private async _runTurn(
    session: InternalSession,
    userMessageId: string,
    onTurnEvent: ((event: CompanionChatTurnEvent) => void) | undefined,
    route: QueuedCompanionTurn['route'],
    /** Runs inside the turn, after it owns the active slot: brings the history to the point the turn answers. */
    prepareConversation: () => Promise<ConversationManager>,
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
    const userMsg = this.transcript(session).find((m) => m.id === userMessageId);
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
    // rounds commit as they finish), what a cancel or failure hands to the
    // model-facing history so later turns can reason about the interruption.
    let uncommittedContent = '';
    const assistantMessageId = randomUUID();
    let writer: TurnHistoryWriter | null = null;

    const finalizeCancelled = (): void => finalizeCancelledTurn({
      sessionId,
      turnId,
      assistantMessageId,
      userMessageId,
      getAssistantContent: () => assistantContent,
      getUncommittedContent: () => uncommittedContent,
      commitPartialToHistory: (content) => { writer?.addAssistantMessage(content); },
      openToolCalls,
      wasCancelRequested: () => scope.activeTurn.cancelRequested,
      isShutdown: () => this.disposed,
      publish,
      persistPartial: (message) => {
        const history = writer?.entriesToSave();
        this.recordReply(session, { ...message, ...(history ? { modelHistory: history } : {}) });
      },
      resolveReply: (extra) => this.resolvePendingReply(userMessageId, { messageId: userMessageId, ...extra, error: 'Turn cancelled' }),
      settle: scope.settle,
    });

    let decisionRoute: import('../providers/decision-router.js').DecisionRouterRouteInfo | undefined;
    let actualUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    try {
      // Inside the try so a throwing publisher still releases the slot and drains the queue.
      session.activeTurn = scope.activeTurn;
      this.markTurn(session, userMessageId, 'started');
      publish({ type: 'turn.started', sessionId, messageId: userMessageId, turnId, envelope: startEnvelope });
      const conversation = await prepareConversation();
      const history = new TurnHistoryWriter(conversation);
      writer = history;

      const toolRegistry = this.toolRegistry;
      // One request of the turn. The closing request after the round limit asks
      // for an answer without tools, under the finalizer prompt.
      const request = async ({ tools, signal, onDelta }: TurnRequest): Promise<TurnModelResponse> => {
        uncommittedContent = '';
        const stream = this.provider.chatStream([...conversation.getMessagesForLLM()], {
          routingContext: { sessionId, turnId, ...(tools && userMsg ? { prompt: userMsg.content } : {}) },
          systemPrompt: appendGoodVibesRuntimeAwarenessPrompt(tools
            ? route.systemPrompt
            : [route.systemPrompt, TOOL_EXHAUSTION_FINALIZER_PROMPT].filter(Boolean).join('\n\n')),
          model: route.model,
          provider: route.provider,
          reasoningEffort: route.reasoningEffort,
          // Core tools in full, the rest one line each (tool_schema loads them), read per request.
          ...(tools ? { tools: this.toolRegistry?.getModelToolDefinitions() ?? [] } : {}),
          abortSignal: signal,
        });
        let content = '';
        const toolCalls: ToolCall[] = [];
        for await (const chunk of stream) {
          if (signal.aborted) break;
          switch (chunk.type) {
            case 'text_delta': {
              const delta = chunk.delta ?? '';
              content += delta;
              onDelta(delta);
              break;
            }
            case 'tool_call': {
              if (!tools) break;
              const toolCallId = chunk.toolCallId ?? '';
              const toolName = chunk.toolName ?? '';
              const toolInput = (chunk.toolInput ?? {}) as Record<string, unknown>;
              const activity = toolCallActivity(toolRegistry?.definitionOf(toolName)?.activity, toolInput);
              publish({ type: 'turn.tool_call', sessionId, turnId, toolCallId, toolName, toolInput, ...(activity ? { activity } : {}) });
              if (toolCallId && toolName) toolCalls.push({ id: toolCallId, name: toolName, arguments: toolInput });
              break;
            }
            case 'tool_result': {
              if (!tools) break;
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
            case 'error':
              throw new Error(chunk.error ?? 'Provider streaming error');
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
        return { content, toolCalls };
      };

      await runTurn({
        signal: abortSignal,
        request,
        conversation: {
          addAssistantMessage: (content, options) => {
            history.addAssistantMessage(content, options);
            if (!options?.toolCalls?.length) uncommittedContent = '';
          },
          addToolResults: (results) => {
            history.addToolResults(results);
            uncommittedContent = '';
          },
        },
        ...(toolRegistry ? {
          executeTools: (calls: ToolCall[], { signal, onSettled }: { signal: AbortSignal; onSettled(result: ToolResult): void }) => executeCompanionToolCalls(
            { toolRegistry, permissionManager: this.permissionManager, hookDispatcher: this.hookDispatcher, runtimeBus: this.runtimeBus, configManager: this.configManager,
              autonomousSource: () => ({ goal: userMsg?.content ?? '', criteria: [] }) },
            calls, publish, sessionId, turnId, { signal, onSettled },
          ),
        } : {}),
      }, {
        speaker: 'owner',
        budget: { turns: COMPANION_MAX_TOOL_ROUNDS },
        completion: { maxRejectedDrafts: 0, deadlineMs: 0 },
        delegates: 'return',
        sink: {
          delta: (delta) => {
            uncommittedContent += delta;
            assistantContent += delta;
            publish({ type: 'turn.delta', sessionId, turnId, delta });
          },
          unrunCalls: (calls, reason) => {
            for (const call of calls) {
              publish({ type: 'turn.tool_result', sessionId, turnId, toolCallId: call.id, toolName: call.name, result: reason, isError: true });
            }
          },
        },
      });

      // A detected abort (user cancel, session close, or shutdown) where the
      // provider ended its stream gracefully instead of throwing: finalize as
      // a cancellation, persist the honest partial and emit the terminal
      // turn.cancelled, never record it as a successful complete reply.
      if (abortSignal.aborted) {
        finalizeCancelled();
        return;
      }

      const now = Date.now();
      const modelHistory = history.entriesToSave();
      this.recordReply(session, {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        ...(decisionRoute ? { metadata: { decisionRoute, usage: actualUsage } } : {}),
        content: assistantContent,
        attachments: [],
        createdAt: now,
        inReplyTo: userMessageId,
        ...(modelHistory ? { modelHistory } : {}),
      });

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
        this.recordFailedTurn(session, {
          error: err, turnId, userMessageId, assistantMessageId, writer,
          assistantContent, uncommittedContent, publish,
        });
      } else {
        finalizeCancelled();
      }
    } finally {
      // Release the active-turn slot only if this turn still owns it (a newer
      // concurrent turn may have taken it), detach the session-abort chain,
      // and settle for any exit path that did not run finalizeCancelled
      // (resolve is idempotent, a second call is a no-op).
      if (session.activeTurn === scope.activeTurn) session.activeTurn = null;
      this.markTurn(session, userMessageId, 'ended');
      scope.detach();
      scope.settle({ partialPersisted: false });
      // Drain: a queued send (or a steer that jumped the queue) starts now.
      this._startNextTurn(session);
    }
  }

  /**
   * The error exit of a turn, recorded like a cancel: the partial text is
   * saved as a failed reply with the reason, the model-facing history gets the
   * partial and a failure note (so the next send is not two questions in a
   * row), and the waiter and every stream are told.
   */
  private recordFailedTurn(session: InternalSession, turn: {
    readonly error: unknown;
    readonly turnId: string;
    readonly userMessageId: string;
    readonly assistantMessageId: string;
    readonly writer: TurnHistoryWriter | null;
    readonly assistantContent: string;
    readonly uncommittedContent: string;
    readonly publish: (event: CompanionChatTurnEvent) => void;
  }): void {
    const sessionId = session.meta.id;
    const reason = turn.error instanceof Error ? turn.error.message : String(turn.error);
    if (turn.writer) {
      turn.writer.dropHeld();
      turn.writer.addAssistantMessage(turn.uncommittedContent + turnFailureNote(reason));
    } else {
      // The turn failed before its history was ready; the next turn rebuilds it from the transcript.
      session.conversation = null;
    }
    const modelHistory = turn.writer?.entriesToSave();
    try {
      this.recordReply(session, {
        id: turn.assistantMessageId,
        sessionId,
        role: 'assistant',
        content: turn.assistantContent,
        attachments: [],
        createdAt: Date.now(),
        inReplyTo: turn.userMessageId,
        deliveryState: 'failed',
        failureReason: reason,
        ...(modelHistory ? { modelHistory } : {}),
      });
    } catch (error) {
      logger.warn('[companion-chat] recording a failed reply failed', { sessionId, error: summarizeError(error) });
    }
    // The waiter is answered first: a publisher that threw once may throw again.
    this.resolvePendingReply(turn.userMessageId, {
      messageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      ...(turn.assistantContent ? { response: turn.assistantContent } : {}),
      error: reason,
    });
    turn.publish({ type: 'turn.error', sessionId, turnId: turn.turnId, error: reason, assistantMessageId: turn.assistantMessageId });
  }

  // ---------------------------------------------------------------------------
  // Regenerate + edit-and-branch (honest lineage, see companion-chat-branching.ts)
  // ---------------------------------------------------------------------------

  /**
   * Regenerate: answer a user message again. Without an id the latest user
   * message is answered again and whatever followed it is superseded (so a
   * regenerate whose turn failed is retried by pressing it again); with an
   * assistant id, that reply and everything after it are superseded. Nothing
   * is deleted. Refuses a closed (409 SESSION_CLOSED) or unknown (404
   * SESSION_NOT_FOUND) session; honest code when there is nothing to answer.
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
    const branch = { messages: [...this.transcript(session)], lastActivityAt: session.lastActivityAt };
    const plan = planRegenerate(branch, input.messageId, now);
    this._commitBranchAndRun(session, branch, plan.anchorUserMessageId, now, route, options.ownerDirect === true);
    const { regeneratedFrom, supersededMessageIds, anchorUserMessageId } = plan;
    return {
      sessionId,
      regeneratedFrom: regeneratedFrom ?? anchorUserMessageId,
      supersededMessageIds,
      turnStarted: true,
    };
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
    const branch = { messages: [...this.transcript(session)], lastActivityAt: session.lastActivityAt };
    const plan = applyEditBranch(branch, sessionId, input, this.artifactStore, now);
    this._commitBranchAndRun(session, branch, plan.newMessageId, now, route, options.ownerDirect === true);
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
    if (!session.activeTurn && !session.preparingTurns && !queued) return;
    const state = session.activeTurn ? 'is still replying' : queued ? `has ${String(queued)} queued message${queued === 1 ? '' : 's'} waiting` : 'is still preparing a message';
    throw Object.assign(
      new Error(`This chat ${state}, so it cannot ${action} now. Stop the current reply (or wait for it and any queued messages to finish), then try again.`),
      { code: 'CHAT_TURN_BUSY', status: 409 },
    );
  }

  /** Look up an active (open) session or throw the closed/not-found machine codes. */
  private _requireOpenSession(sessionId: string): InternalSession {
    this.assertAvailable();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') throw this.chatClosed('This chat is closed.');
    return session;
  }

  /**
   * Shared tail of regenerate/edit: save the branch (superseded marks and any
   * new message) before it takes effect, drop the model-facing history so the
   * turn rebuilds it from the active chain, and fire the new turn.
   */
  private _commitBranchAndRun(
    session: InternalSession,
    branch: { messages: CompanionChatMessage[]; lastActivityAt: number },
    anchorUserMessageId: string,
    now: number,
    route: QueuedCompanionTurn['route'],
    ownerDirect: boolean,
  ): void {
    const before = new Set(this.transcript(session));
    const messages = branch.messages.map(message => this.normalizeMessage(message));
    const changed = messages.filter((message) => !before.has(message));
    const meta: CompanionChatSession = { ...session.meta, messageCount: messages.length, updatedAt: now };
    this.saveForRequest(session, changed, meta);
    session.messages = messages;
    session.meta = meta;
    session.lastActivityAt = branch.lastActivityAt;
    session.conversation = null;
    const anchor = messages.find((message) => message.id === anchorUserMessageId);
    // The message the turn answers goes to the model the way a fresh send
    // does, with its files read in. An owner-driven edit restarts the
    // untrusted-content window; a caller that cannot attest ownership does not.
    this.launchTurn(session, ownerDirect, () => this._runTurn(session, anchorUserMessageId, undefined, route, async () => {
      const conversation = await this.ensureConversation(session, anchorUserMessageId);
      if (anchor) conversation.addUserMessage(await buildProviderUserContent(anchor.content, anchor.attachments ?? [], this.artifactStore));
      return conversation;
    }));
  }

  // ---------------------------------------------------------------------------
  // GC sweep
  // ---------------------------------------------------------------------------

  /**
   * Periodic GC sweep. Deletion authority is SPLIT (charter: closed sessions are
   * HISTORY): evict-memory drops an idle or long-closed chat's transcript and
   * history from memory (summary and files kept; both come back on demand);
   * delete-persistent removes the files ONLY under an explicit finite retention
   * window (default retains indefinitely, see {@link planCompanionSweep}).
   */
  _gcSweep(): void {
    const now = Date.now();
    const closedRetentionMs = this.closedRetention();
    for (const [id, session] of this.sessions) {
      const action = planCompanionSweep(
        {
          status: session.meta.status,
          closedAt: session.meta.closedAt,
          lastActivityAt: session.lastActivityAt,
          hasReplayInMemory: session.conversation !== null || (this.persistence !== null && session.messages !== null),
          isEmpty: session.meta.messageCount === 0,
        },
        {
          now,
          idleActiveMs: this.idleActiveMs,
          idleEmptyMs: this.idleEmptyMs,
          closedMemoryGraceMs: this.closedMemoryGraceMs,
          closedRetentionMs,
        },
      );

      switch (action.kind) {
        case 'evict-memory':
          // A long reply, queued work or a change not yet saved keeps the chat in memory.
          if (session.activeTurn || session.preparingTurns || session.pendingTurns?.length || session.unsaved?.size || session.metaUnsaved) break;
          session.conversation = null;
          if (this.persistence) {
            session.messages = null;
            this.persistence.release(id);
          }
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
   * Hard-remove a session's persisted files and in-memory record. The ONE
   * removal code path, shared by {@link deleteSession} and the GC
   * 'delete-persistent' action. Never fork this.
   */
  private async _hardRemove(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    try {
      await this.persistence?.delete(sessionId);
    } catch (error) {
      // The file is still on disk, so the chat must stay known: otherwise it is
      // gone from the API, back after a restart, and the delete cannot be retried.
      if (session && !this.sessions.has(sessionId)) this.sessions.set(sessionId, session);
      throw error;
    }
  }

  /**
   * Resolves once everything this chat saved is on disk. A change still owed
   * from an earlier failed save is written first; when that fails again the
   * call rejects with the refusal that says so.
   */
  async flushSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && (session.unsaved?.size || session.metaUnsaved)) {
      this.saveInBackground(session, [], false);
      if (session.unsaved?.size || session.metaUnsaved) throw this.saveFailed(session.saveError);
    }
    await this.persistence?.flush();
  }

  private assertEffortPublication(effort: string | null | undefined): void {
    if (effort === undefined) return;
    if (effort !== null && readReasoningEffortLevel(effort) === undefined) {
      throw Object.assign(new Error('Invalid chat reasoning effort.'), { code: 'INVALID_ARGUMENT', status: 400 });
    }
    if (!this.persistence) return;
    try {
      assertSynchronousJudgmentGuard(() => this.nativeDataWriter?.declare('companion-chat-effort-v1'), () => new Error('Session effort publication requires a synchronous native writer'));
    } catch (error) { drainOwned(error); throw error instanceof Error ? error : new Error('Session effort publication is unavailable'); }
  }

  // ---------------------------------------------------------------------------
  // Saving. A change a request makes is saved before it takes effect, and a
  // failed save refuses that request only. A change a turn makes (a reply, a
  // delivery state) is already in memory when it is saved; if that save fails
  // the change is kept and written by the chat's next save. Each save is one
  // appended line per message plus, when the summary changed, one small
  // document: its cost does not grow with the chat.
  // ---------------------------------------------------------------------------

  /** Write the chat's changes now, or refuse the request that made them. */
  private saveForRequest(session: InternalSession, changed: readonly CompanionChatMessage[], meta: CompanionChatSession): void {
    if (!this.persistence) return;
    try {
      this.write(session, changed, meta);
    } catch (error) {
      logger.warn('[companion-chat] saving a chat change failed; the request was refused', { sessionId: meta.id, error: summarizeError(error) });
      throw this.saveFailed(error);
    }
  }

  /** Write changes already in memory; a failure is kept for the chat's next save. */
  private saveInBackground(session: InternalSession, changed: readonly CompanionChatMessage[], metaChanged: boolean): void {
    if (!this.persistence) return;
    try {
      this.write(session, changed, metaChanged || session.metaUnsaved ? session.meta : undefined);
    } catch (error) {
      logger.warn('[companion-chat] saving a chat change failed; the next change of this chat writes it', { sessionId: session.meta.id, error: summarizeError(error) });
      const unsaved = (session.unsaved ??= new Set());
      for (const message of changed) unsaved.add(message.id);
      if (metaChanged) session.metaUnsaved = true;
      session.saveError = error;
    }
  }

  private write(session: InternalSession, changed: readonly CompanionChatMessage[], meta: CompanionChatSession | undefined): void {
    const persistence = this.persistence;
    if (!persistence) return;
    const owed = session.unsaved?.size && session.messages
      ? session.messages.filter((message) => session.unsaved!.has(message.id) && !changed.includes(message))
      : [];
    const summary = meta ?? (session.metaUnsaved ? session.meta : undefined);
    if (summary) {
      this.assertEffortPublication(summary.reasoningEffort);
      persistence.writeMeta(summary);
    }
    persistence.appendMessages(summary?.id ?? session.meta.id, [...owed, ...changed]);
    delete session.unsaved;
    delete session.saveError;
    session.metaUnsaved = false;
  }

  // ---------------------------------------------------------------------------
  // Refusals
  // ---------------------------------------------------------------------------

  private saveFailed(error: unknown): RefusalError {
    return new RefusalError(refusal({
      code: 'CHAT_SAVE_FAILED',
      status: 503,
      retryAfterMs: 1_000,
      state: 'this change to the chat was not saved and did not take effect',
      reason: `Saving the chat failed (${storageFailureName(error)})`,
      next: [
        'Send the same request again',
        'If it keeps failing, check that the companion chat storage directory is writable and has free space',
      ],
    }), { cause: error });
  }

  private serviceStopping(): RefusalError {
    return new RefusalError(refusal({
      code: 'SERVICE_STOPPING',
      status: 503,
      retryable: true,
      state: 'the companion chat service is stopping',
      reason: 'The daemon is shutting down, so the chat accepts no changes',
      next: ['Send the request again once the daemon has restarted'],
    }));
  }

  private chatClosed(reason: string): RefusalError {
    return new RefusalError(refusal({
      code: EngineErrorCodes.SESSION_CLOSED,
      status: 409,
      retryable: false,
      state: 'the chat is closed',
      reason,
      next: ['Reopen the chat (companion.chat.sessions.reopen), then send again', 'Or start a new chat'],
    }));
  }

  private assertAvailable(): void {
    if (this.disposed) throw this.serviceStopping();
  }

  /**
   * Queued sends whose turn can no longer start (the chat closed, or the
   * service is going away): answer every waiter with an error instead of
   * leaving it pending forever, and move each from `queued` to the terminal
   * `unanswered` in the transcript so nothing keeps showing a message as
   * waiting for a turn that will never run.
   */
  private _abandonQueuedTurns(session: InternalSession, reason: string): void {
    for (const entry of session.pendingTurns?.splice(0) ?? []) {
      this.resolvePendingReply(entry.userMessageId, { messageId: entry.userMessageId, error: reason });
    }
    const messages = session.messages;
    if (!messages) return;
    const changed: CompanionChatMessage[] = [];
    for (const [index, message] of messages.entries()) {
      if (message.role !== 'user' || message.deliveryState !== 'queued') continue;
      const unanswered = this.normalizeMessage({ ...message, deliveryState: 'unanswered' });
      messages[index] = unanswered;
      changed.push(unanswered);
    }
    if (changed.length > 0) this.saveInBackground(session, changed, false);
  }

  private resolvePendingReply(messageId: string, result: CompanionChatReplyResult): void {
    const pending = this.pendingReplies.get(messageId);
    if (!pending) return;
    this.pendingReplies.delete(messageId);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }
}
