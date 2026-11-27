import type { DaemonRuntimeRouteHandlers } from './context.js';
import type { JsonRecord } from './route-helpers.js';
import type { SessionReadPolicy } from './integration-route-types.js';
import type { ConversationMessageEnvelope } from '@goodvibes/engine/contracts/conversation-message';
import type { Page } from '@goodvibes/engine/errors';

/**
 * The conversation-message envelope, declared once in the contracts package.
 * Companion follow-up routing (kind='message') publishes it to TUI surface
 * subscribers without spawning an agent.
 */
export type { ConversationMessageEnvelope };

/**
 * The surfaces an inbound message or route binding can come from (the
 * platform's transport surfaces). The router hands the platform's broker over
 * against these types, so a list that drifts from the platform's fails to
 * compile there.
 */
export const AUTOMATION_SURFACE_KINDS = [
  'tui', 'web', 'slack', 'discord', 'ntfy', 'webhook', 'homeassistant', 'telegram', 'google-chat',
  'signal', 'whatsapp', 'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix', 'service',
] as const;
/** @public */
export type AutomationSurfaceKind = typeof AUTOMATION_SURFACE_KINDS[number];
/** Every surface a session participant can speak through: the transport surfaces and the first-party products. */
export const SESSION_SURFACE_KINDS = [...AUTOMATION_SURFACE_KINDS, 'agent', 'webui', 'companion', 'automation'] as const;
export type SessionSurfaceKind = typeof SESSION_SURFACE_KINDS[number];
export const SESSION_INPUT_STATES = ['queued', 'delivered', 'spawned', 'completed', 'cancelled', 'failed', 'rejected'] as const;
export type SessionInputState = typeof SESSION_INPUT_STATES[number];
export const SESSION_KINDS = ['tui', 'agent', 'webui', 'companion-task', 'companion-chat', 'automation', 'channel', 'acp', 'hosted'] as const;
export type SessionKind = typeof SESSION_KINDS[number];
export const EXECUTION_RISK_CLASSES = ['safe', 'elevated', 'dangerous'] as const;
export const EXECUTION_NETWORK_POLICIES = ['inherit', 'allow', 'deny', 'scoped'] as const;
export const EXECUTION_FILESYSTEM_POLICIES = ['inherit', 'workspace-write', 'read-only', 'isolated'] as const;

/**
 * How a run asks to be executed; each field the route checked against its list.
 * @public
 */
export interface ExecutionIntent {
  readonly riskClass?: typeof EXECUTION_RISK_CLASSES[number] | undefined;
  readonly requiresApproval?: boolean | undefined;
  readonly networkPolicy?: typeof EXECUTION_NETWORK_POLICIES[number] | undefined;
  readonly filesystemPolicy?: typeof EXECUTION_FILESYSTEM_POLICIES[number] | undefined;
}
export interface SharedSessionRoutingIntent {
  readonly modelId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly providerSelection?: 'inherit-current' | 'concrete' | 'synthetic' | undefined;
  readonly providerFailurePolicy?: 'ordered-fallbacks' | 'fail' | undefined;
  readonly fallbackModels?: readonly string[] | undefined;
  readonly helperModel?: {
    readonly providerId: string;
    readonly modelId: string;
  } | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly executionIntent?: ExecutionIntent | undefined;
  // Kept a plain string rather than a fixed enum: which
  // levels a given model actually accepts is per-model (see the platform package's
  // providers/reasoning-effort.ts, which daemon-api must not depend on), so
  // this stays a plain string rather than a fixed enum.
  readonly reasoningEffort?: string | undefined;
}
interface AutomationRouteBinding {
  readonly id?: string | undefined;
}

/** A stored route binding, as the binding store returns it and a new session adopts it. */
export interface RouteBindingRecordLike {
  readonly id: string;
  readonly kind: 'session' | 'thread' | 'channel' | 'message';
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly sessionPolicy?: 'create-or-bind' | 'continue-existing' | 'require-existing' | undefined;
  readonly threadPolicy?: 'preserve' | 'replace' | 'detached' | undefined;
  readonly deliveryGuarantee?: 'best-effort' | 'at-least-once' | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly runId?: string | undefined;
  readonly title?: string | undefined;
  readonly lastSeenAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

/** A session participant: the surface it speaks through and who it is there. */
export interface SessionParticipantInput {
  readonly surfaceKind: SessionSurfaceKind;
  readonly surfaceId: string;
  readonly externalId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly routeId?: string | undefined;
  readonly lastSeenAt: number;
}
/** Provider routing an agent was started with, as its record keeps it. */
export interface AgentProviderRoutingLike {
  readonly providerSelection?: 'inherit-current' | 'concrete' | 'synthetic' | undefined;
  readonly providerFailurePolicy?: 'ordered-fallbacks' | 'fail' | undefined;
  readonly fallbackModels?: readonly string[] | undefined;
}

/**
 * How an agent was started, as its record keeps it: everything a retry needs
 * to start the same work again on the same model, tools and routing.
 */
export interface AgentSpawnSettingsLike {
  readonly template?: string | undefined;
  readonly provider?: string | undefined;
  readonly fallbackModels?: readonly string[] | undefined;
  readonly routing?: AgentProviderRoutingLike | undefined;
  readonly executionIntent?: ExecutionIntent | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly context?: string | undefined;
  readonly outsideContract?: boolean | undefined;
  readonly executionProtocol?: 'direct' | 'gather-plan-apply' | undefined;
  readonly reviewMode?: 'none' | 'contract' | undefined;
  readonly communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct' | undefined;
  readonly successCriteria?: readonly string[] | undefined;
  readonly requiredEvidence?: readonly string[] | undefined;
  readonly writeScope?: readonly string[] | undefined;
  /** The session that started the agent; a retry belongs to it too. */
  readonly sessionId?: string | undefined;
}

export type AgentRecordLike = AgentSpawnSettingsLike & {
  readonly id: string;
  readonly status: string;
  readonly task: string;
  readonly model?: string | null | undefined;
  readonly tools: readonly string[];
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
  readonly toolCallCount?: number | undefined;
  readonly progress?: string | null | undefined;
  readonly error?: string | null | undefined;
};

/** What the daemon starts an agent with. */
export interface TrySpawnAgentInput extends AgentSpawnSettingsLike {
  readonly mode: 'spawn';
  readonly task: string;
  readonly model?: string | undefined;
  readonly tools?: string[] | readonly string[] | undefined;
  /** With `tools`: the agent gets exactly that list, not the template's defaults added to it. */
  readonly restrictTools?: boolean | undefined;
  /** The project the agent works in (its folder's full path), as its caller named it and the daemon checked it. */
  readonly workingDirectory?: string | undefined;
}
type AutomationJobLike = { readonly id: string };
type AutomationRunLike = {
  readonly id: string;
  readonly jobId: string;
  readonly agentId?: string | undefined;
  readonly status: string;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly queuedAt: number;
  readonly continuationMode?: string | undefined;
};
interface RuntimeTaskLike {
  readonly kind?: string | undefined;
  readonly owner?: string | undefined;
  readonly description?: string | undefined;
  readonly title?: string | undefined;
}
interface RuntimeTaskStateLike {
  readonly tasks: Map<string, RuntimeTaskLike>;
}

/**
 * What a submitted message became. Only `spawn` carries the task to start an
 * agent with; every other mode has none, so a route must switch on `mode`.
 */
export type RouteSessionSubmission<Input> = {
  input: Input;
  session: { id: string; status: string };
  routeBinding?: AutomationRouteBinding | undefined;
  activeAgentId?: string | null | undefined;
  userMessage?: unknown | undefined;
} & (
  | { mode: 'spawn'; task: string }
  | { mode: 'continued-live' | 'queued-follow-up' | 'queued-for-surface' | 'rejected'; task?: undefined }
);

export interface DaemonRuntimeRouteContext {
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly recordApiResponse: (req: Request, path: string, response: Response) => Response;
  readonly requireAdmin: (req: Request) => Response | null;
  /** Whether the caller may read a session (a hosted one: its owners and admins). Absent: every session the route admits. */
  readonly mayReadSession?: SessionReadPolicy | undefined;
  /**
   * The principal the request was authenticated as, keyed with its kind by the listener (pairing/principal-ids.ts
   * `callerKey`: a sign-in is `user:<name>`, never taken for a credential whose id is that name). A session is kept as
   * registered by the principal whose `sessions.register` made it; only that principal may name it as a question's asker.
   */
  readonly requestPrincipalId?: ((req: Request) => string | undefined) | undefined;
  readonly sessionBroker: {
    start(): Promise<void>;
    submitMessage(input: {
      sessionId?: string | undefined;
      routeId?: string | undefined;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string | undefined;
      threadId?: string | undefined;
      userId?: string | undefined;
      displayName?: string | undefined;
      title?: string | undefined;
      body: string;
      providerMessageId?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      routing?: SharedSessionRoutingIntent | undefined;
    }): Promise<RouteSessionSubmission<{ id: string; routing?: SharedSessionRoutingIntent | undefined }>>;
    steerMessage(input: {
      sessionId?: string | undefined;
      routeId?: string | undefined;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string | undefined;
      threadId?: string | undefined;
      userId?: string | undefined;
      displayName?: string | undefined;
      title?: string | undefined;
      body: string;
      providerMessageId?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      routing?: SharedSessionRoutingIntent | undefined;
      allowSpawnFallback?: boolean | undefined;
    }): Promise<RouteSessionSubmission<{ id: string; state: string; routing?: SharedSessionRoutingIntent | undefined }>>;
    followUpMessage(input: {
      sessionId?: string | undefined;
      routeId?: string | undefined;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string | undefined;
      threadId?: string | undefined;
      userId?: string | undefined;
      displayName?: string | undefined;
      title?: string | undefined;
      body: string;
      providerMessageId?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      routing?: SharedSessionRoutingIntent | undefined;
    }): Promise<RouteSessionSubmission<{ id: string; state: string; routing?: SharedSessionRoutingIntent | undefined }>>;
    /** `inputId` names the exact queued input the agent was started for; without it the oldest queued input is claimed. */
    bindAgent(sessionId: string, agentId: string, inputId?: string): Promise<unknown>;
    createSession(input: {
      id?: string | undefined;
      title?: string | undefined;
      /** The project folder the session belongs to (checked for the caller before the route runs). */
      project?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      routeBinding?: RouteBindingRecordLike | undefined;
      participant?: SessionParticipantInput | undefined;
    }): Promise<{ id: string }>;
    register(input: {
      sessionId: string;
      kind?: SessionKind | undefined;
      project?: string | undefined;
      title?: string | undefined;
      participant: SessionParticipantInput;
      reopen?: boolean | undefined;
      /** The principal registering it; kept on a session this registration makes, never changed after. */
      registeredBy?: string | undefined;
    }): Promise<{
      record: { id: string };
      reopened: boolean;
      conflict?: { readonly status: 'closed' } | undefined;
    }>;
    getSession(sessionId: string): { id: string; kind?: string | undefined; status: string; messageCount: number; activeAgentId?: string | undefined } | null;
    getMessages(sessionId: string, limit: number, offset?: number): unknown[];
    getInputs(sessionId: string, limit: number): unknown[];
    /** One page of the session's inputs after `since`, oldest first; `more` says ask again from `next`. */
    getInputsPage(sessionId: string, options: { state?: SessionInputState | undefined; since?: number | undefined; limit?: number | undefined }): Page<unknown>;
    markInputDelivered(sessionId: string, inputId: string, options: { consumed?: boolean | undefined; agentId?: string | undefined; claim?: boolean | undefined; surfaceInstance?: string | undefined; claimEpoch?: number | null | undefined; beforeApply?: (() => void) | undefined }): Promise<unknown | null>;
    closeSession(sessionId: string): Promise<{ id: string } | null>;
    reopenSession(sessionId: string): Promise<{ id: string } | null>;
    detachParticipant(sessionId: string, surfaceId: string): Promise<{ id: string; status: string } | null>;
    /**
     * Hard-remove a session record + its messages/inputs (see CHANGELOG 1.0.0: a real delete
     * verb, distinct from close). Requires the session already closed,
     * `'active'` means the caller must close it first (409); `'not-found'`
     * covers an unknown OR already-deleted id (404, never a 200-noop).
     */
    deleteSession(sessionId: string): Promise<'deleted' | 'not-found' | 'active'>;
    cancelInput(sessionId: string, inputId: string): Promise<unknown | null>;
    /** Mark a queued/delivered input failed with the reason; hosts without it fall back to cancelInput. */
    failInput?(sessionId: string, inputId: string, error: string): Promise<unknown | null>;
    completeAgent(sessionId: string, agentId: string, message: string, meta: { status: string; routeId?: string }): Promise<void>;
  };
  readonly agentManager: {
    getStatus(agentId: string): AgentRecordLike | null;
    cancel(agentId: string): void;
  };
  /**
   * The automation empty state a surface renders while automation is enabled
   * with zero routines (how-to-create-your-first-routine); null once any
   * routine exists or when automation is off. Supplied by the composition
   * root (the platform owns the copy); absent = the jobs list omits emptyState.
   */
  readonly automationEmptyState?: (() => { readonly title: string; readonly body: string } | null) | undefined;
  readonly automationManager: {
    listJobs(): AutomationJobLike[];
    listRuns(): AutomationRunLike[];
    getRun(runId: string): AutomationRunLike | null | undefined;
    triggerHeartbeat(input: { source: string }): Promise<unknown>;
    /** Jobs waiting for the next heartbeat. Hosts that cannot list them omit it and the queue reads as empty. */
    listHeartbeatWakes?(): readonly unknown[];
    cancelRun(runId: string, reason: string): Promise<unknown | null>;
    retryRun(runId: string): Promise<unknown>;
    createJob(input: Record<string, unknown>): Promise<AutomationJobLike>;
    updateJob(jobId: string, input: Record<string, unknown>): Promise<AutomationJobLike | null>;
    removeJob(jobId: string): Promise<void>;
    setEnabled(jobId: string, enabled: boolean): Promise<AutomationJobLike | null>;
    runNow(jobId: string): Promise<{ id: string; agentId?: string; status: string }>;
    getSchedulerCapacity(): { slotsTotal: number; slotsInUse: number; queueDepth: number; oldestQueuedAgeMs: number | null };
    /** The zone a cron schedule created without one is stored in: where the owner is, else the host's zone. */
    defaultTimezone(): string;
  };
  readonly normalizeAtSchedule: (at: number) => unknown;
  readonly normalizeEverySchedule: (interval: string | number, anchorAt?: number) => unknown;
  readonly normalizeCronSchedule: (expression: string, timezone?: string, staggerMs?: unknown) => unknown;
  readonly routeBindings: {
    start(): Promise<void>;
    getBinding(id: string): RouteBindingRecordLike | undefined;
  };
  readonly trySpawnAgent: (input: TrySpawnAgentInput, logLabel: string, sessionId?: string) => AgentRecordLike | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly sessionId?: string; },
  ) => void;

  /**
   * A surface that ran the turn in its own process reports the answer, so the
   * daemon can write it into the shared session and push it down the reply
   * pipeline. The daemon's own completion poll only ever sees agents THIS
   * process spawned, so without this an answer produced by a client that
   * collected the input over `sessions.inputs.list` never reached the
   * conversation it came from.
   */
  readonly completeSurfaceReplyFromSurface: (input: {
    readonly agentId: string;
    readonly sessionId?: string | undefined;
    readonly body: string;
    readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
  }) => Promise<boolean>;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly syncSpawnedAgentTask: (record: AgentRecordLike, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: AgentRecordLike) => void;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly runtimeStore: { getState(): { tasks: RuntimeTaskStateLike } } | null;
  readonly runtimeDispatch: {
    transitionRuntimeTask(
      taskId: string,
      status: string,
      patch: Record<string, unknown>,
      source: string,
    ): void;
    /** Whether the task's current status allows an explicit retry (canRetry). */
    canRetryRuntimeTask?(taskId: string): boolean;
  } | null;
  /** Open a shared-session SSE stream for turn and agent events. */
  readonly openSessionEventStream: (req: Request, sessionId: string) => Response;
  /**
   * Whether the owner typed this message into their own program: the request was authenticated as the owner with a
   * person's credential (this machine, their paired device or their login), names itself a terminal app or the Agent, and
   * claims a person asked for it. Stamped on the input (OWNER_TYPED_METADATA_KEY); absent means never.
   */
  readonly ownerTypedAtProgram?: ((req: Request) => boolean) | undefined;
  /**
   * Whether the request is the owner in person (platform daemon/method-owner-decision.ts `ownerHimself`: their signed-in
   * session or their verified program). Stamped on the input (OWNER_HIMSELF_METADATA_KEY); a hosted session the owner
   * made in person runs such a message as their own turn. Absent means never.
   */
  readonly ownerHimself?: ((req: Request) => boolean) | undefined;
}

export type DaemonRuntimeRouteHandlerMap = DaemonRuntimeRouteHandlers;
