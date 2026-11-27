import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { ChannelPolicyRecord } from '../channels/types.js';
import { isOwnersAloneConversation } from './owner-channel-conversation.js';
import { HOME_ASSISTANT_SURFACE, HOME_STATE_PROVENANCE_CONTRACT } from '../channels/builtin/homeassistant.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { CompanionChatSession, CompanionChatTurnEvent } from '../companion/companion-chat-types.js';
import type { ConfigManager } from '../config/manager.js';
import type { HomeGraphAskInput, HomeGraphAskResult, HomeGraphSpaceInput } from '../knowledge/home-graph/types.js';

/**
 * The narrow read surface the Home Assistant turn consults to ground itself in
 * the pre-registered home-graph knowledge space (HomeGraphService.ask). Kept
 * structural + optional so a runtime without a home graph degrades to today's
 * ungrounded behavior rather than failing.
 */
export interface HomeGraphGroundingReader {
  ask(input: HomeGraphAskInput): Promise<HomeGraphAskResult>;
}

export const HOME_ASSISTANT_DEFAULT_REMOTE_SESSION_TTL_MS = 20 * 60_000;
const MIN_REMOTE_SESSION_TTL_MS = 60_000;
const MAX_REMOTE_SESSION_TTL_MS = 24 * 60 * 60_000;
/** The longest a turn waits for home-graph grounding when the caller set no tighter deadline. */
const HOME_GRAPH_GROUNDING_MAX_MS = 10_000;

type JsonRecord = Record<string, unknown>;

interface RouteBindingsLike {
  readonly start: RouteBindingManager['start'];
  readonly upsertBinding: RouteBindingManager['upsertBinding'];
  readonly patchBinding: RouteBindingManager['patchBinding'];
}

interface ConfigReader {
  get(key: string): unknown;
}

export interface HomeAssistantChatInput {
  readonly text: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly surfaceId: string;
  readonly channelId: string;
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  /** One-to-one with its user (`direct`), a shared room or device (`channel`), or a thread; the owner's notice routes are read from it. */
  readonly conversationKind?: 'direct' | 'channel' | 'group' | 'thread' | 'service' | undefined;
  readonly displayName?: string | undefined;
  readonly title: string;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly context?: JsonRecord | undefined;
  /**
   * How the message came: `typed` (Assist's text box) or `spoken` (a voice pipeline). Home Assistant's conversation
   * input says neither (its fields: text, context, conversation_id, device_id, satellite_id, language, agent_id,
   * extra_system_prompt), so the route takes the integration's `input` field when it sends one, and otherwise reads a
   * request that names a voice satellite or a device (what a voice pipeline names: the device that heard it) as spoken.
   * A spoken message never counts as the owner's: a voice pipeline names the device, not who spoke.
   */
  readonly inputKind?: 'typed' | 'spoken' | undefined;
  /**
   * Optional grounding reference, the pre-registered home-graph knowledge
   * space / Home Assistant installation this turn should consult. When present
   * (and a home-graph reader is wired), the turn queries that space and folds
   * the retrieved grounding into its system prompt, closing the
   * index-then-query loop the HA integration already opens by registering and
   * refreshing the graph.
   */
  readonly grounding?: HomeGraphSpaceInput | undefined;
  readonly remoteSessionTtlMs: number;
}

export interface HomeAssistantChatResolution {
  readonly binding: AutomationRouteBinding;
  readonly session: CompanionChatSession;
  readonly newSession: boolean;
  readonly sessionExpired: boolean;
}

export interface HomeAssistantChatPostResult extends HomeAssistantChatResolution {
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly error?: string | undefined;
  /** Set only by the local reply deadline, never inferred from failure prose. */
  readonly timedOut?: true | undefined;
  /** Set when the turn was stopped by a cancel (the turn's own `turn.cancelled` event), never inferred from failure prose. */
  readonly cancelled?: true | undefined;
  /** Set when the conversation's chat already holds this message (by the caller's id): nothing was posted, `messageId` is the earlier one's. */
  readonly replayed?: true | undefined;
}

export interface HomeAssistantChatRuntime {
  readonly configManager: Pick<ConfigManager, 'get'> | ConfigReader;
  readonly routeBindings: RouteBindingsLike;
  readonly chatManager: CompanionChatManager;
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
  /** Optional home-graph reader used to ground a turn against its pre-registered space. */
  readonly homeGraph?: HomeGraphGroundingReader | undefined;
  /**
   * The Home Assistant channel's policy ("Treat my own messages here as me", its owner): a message in a conversation
   * proven the owner's alone (daemon/owner-channel-conversation.ts) is his own input when it is on. Absent: never.
   */
  readonly channelPolicy?: (() => Pick<ChannelPolicyRecord, 'ownMessagesAsOwner' | 'ownerId' | 'project'>) | undefined;
}

export async function postHomeAssistantChatMessage(
  runtime: HomeAssistantChatRuntime,
  input: HomeAssistantChatInput,
  options: {
    readonly wait?: boolean;
    readonly timeoutMs?: number | undefined;
    readonly clientId?: string;
    /** In-process tap for the turn's incremental events, forwarded to the chat
     * manager so a caller (the SSE route) can stream deltas while awaiting the reply. */
    readonly onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined;
    /** Called once the conversation's chat session is known, before the message is posted. */
    readonly onResolved?: ((resolution: HomeAssistantChatResolution) => void) | undefined;
    /**
     * The caller's own id for this message. It is kept with the posted message
     * in the conversation's chat transcript, and a message the chat already
     * holds under it is not posted again, also after a daemon restart.
     */
    readonly clientMessageId?: string | undefined;
  } = {},
): Promise<HomeAssistantChatPostResult> {
  // One deadline covers grounding and the reply. Grounding is a read that
  // runs beside the session resolution, outside the per-conversation chain,
  // so a slow graph never holds the next utterance.
  const deadlineAt = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  const grounding = resolveHomeGraphGrounding(runtime.homeGraph, input, deadlineAt);
  const resolution = await resolveHomeAssistantChatSession(runtime, input);
  options.onResolved?.(resolution);
  const { clientMessageId } = options;
  if (clientMessageId !== undefined) {
    // The chat is this conversation's own, so the caller's id is scoped to its installation and conversation.
    const earlier = runtime.chatManager.getMessages(resolution.session.id)
      .find((message) => message.role === 'user' && message.clientMessageId === clientMessageId);
    if (earlier) return { ...resolution, messageId: earlier.id, replayed: true };
  }
  const message = formatHomeAssistantUserMessage(input, await grounding);
  const clientId = options.clientId ?? `homeassistant:${input.surfaceId}:${input.conversationId}`;
  // No `ownerDirect` on either post below, deliberately. A Home Assistant
  // surface is a room: anyone within earshot of the speaker can address it, and
  // a voice pipeline reports WHICH device heard something, never who said it.
  // The daemon genuinely cannot establish the owner here, so it does not claim
  // to, the window stays open and outward effects stay judged on derivation.
  // Wiring this honestly would need speaker identification, not a flag.
  // Its turn is someone else's input, unless the owner chose "Treat my own messages here as me" for Home Assistant and
  // this conversation is proven his alone (Home Assistant's user id of the channel's owner, one-to-one): then it is his.
  const policy = runtime.channelPolicy?.();
  // A spoken message (a voice pipeline: it names the device that heard it, not who spoke) is never his; only a message
  // known to be typed can be.
  const ownerParty = policy?.ownMessagesAsOwner === true && input.inputKind === 'typed'
    && isOwnersAloneConversation(resolution.binding, policy.ownerId);
  if (options.wait === false) {
    const messageId = await runtime.chatManager.postMessage(resolution.session.id, message, clientId, {
      ...(options.onTurnEvent ? { onTurnEvent: options.onTurnEvent } : {}),
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
      ...(ownerParty ? { ownerParty: true } : {}),
    });
    return { ...resolution, messageId };
  }
  let cancelled = false;
  const reply = await runtime.chatManager.postMessageAndWaitForReply(
    resolution.session.id,
    message,
    clientId,
    {
      timeoutMs: deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
      onTurnEvent: (event) => {
        if (event.type === 'turn.cancelled') cancelled = true;
        options.onTurnEvent?.(event);
      },
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
      ...(ownerParty ? { ownerParty: true } : {}),
    },
  );
  return {
    ...resolution,
    messageId: reply.messageId,
    ...(reply.assistantMessageId ? { assistantMessageId: reply.assistantMessageId } : {}),
    ...(reply.response ? { response: reply.response } : {}),
    ...(reply.error ? { error: reply.error } : {}),
    ...(reply.timedOut ? { timedOut: true as const } : {}),
    ...(cancelled ? { cancelled: true as const } : {}),
  };
}

/** What one Home Assistant turn came to, for every caller that reports it. */
export type HomeAssistantReplyStatus = 'completed' | 'timeout' | 'cancelled' | 'failed';

/**
 * The one reading of a turn's result: the status the HTTP route answers with
 * and the short line a Home Assistant event speaks. Internal error text is
 * never spoken; it stays with the caller's own record.
 */
export function homeAssistantReplyOutcome(
  result: Pick<HomeAssistantChatPostResult, 'response' | 'error' | 'timedOut' | 'cancelled'>,
): { readonly status: HomeAssistantReplyStatus; readonly speech: string } {
  const response = result.response?.trim();
  if (result.timedOut) return { status: 'timeout', speech: 'Still working on that.' };
  if (result.cancelled) return { status: 'cancelled', speech: 'That request was stopped before it finished.' };
  if (result.error || !response) return { status: 'failed', speech: 'Sorry, I could not finish that.' };
  return { status: 'completed', speech: response };
}

const resolutionTails = new Map<string, Promise<unknown>>();

/**
 * Runs `run` after every earlier call with the same key has settled. Resolving a
 * conversation's chat session reads the binding, awaits, then creates a
 * session and writes the binding back; two overlapping calls would both see no
 * session and leave the first turn in an orphan.
 */
function serializeResolution<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = resolutionTails.get(key) ?? Promise.resolve();
  const result = previous.then(run);
  const tail = result.then(() => undefined, () => undefined);
  resolutionTails.set(key, tail);
  void tail.then(() => { if (resolutionTails.get(key) === tail) resolutionTails.delete(key); });
  return result;
}

const HOME_ASSISTANT_SYSTEM_PROMPT_OPENING = 'You are GoodVibes responding inside Home Assistant.';

/** True for a chat session this module created for a Home Assistant conversation; the opening line of its stored system prompt marks it, so it survives a daemon restart. */
export function isHomeAssistantChatSession(session: Pick<CompanionChatSession, 'systemPrompt'>): boolean {
  return session.systemPrompt?.startsWith(HOME_ASSISTANT_SYSTEM_PROMPT_OPENING) === true;
}

export function resolveHomeAssistantChatSession(
  runtime: HomeAssistantChatRuntime,
  input: HomeAssistantChatInput,
): Promise<HomeAssistantChatResolution> {
  const key = [HOME_ASSISTANT_SURFACE, input.surfaceId, input.threadId ?? '', input.conversationId].join('\u0000');
  return serializeResolution(key, () => resolveHomeAssistantChatSessionNow(runtime, input));
}

async function resolveHomeAssistantChatSessionNow(
  runtime: HomeAssistantChatRuntime,
  input: HomeAssistantChatInput,
): Promise<HomeAssistantChatResolution> {
  await runtime.chatManager.init();
  await runtime.routeBindings.start();
  const binding = await runtime.routeBindings.upsertBinding({
    kind: input.threadId ? 'thread' : 'channel',
    surfaceKind: HOME_ASSISTANT_SURFACE,
    surfaceId: input.surfaceId,
    externalId: input.conversationId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    channelId: input.channelId,
    title: input.title,
    metadata: {
      source: 'homeassistant',
      directoryKind: input.threadId ? 'thread' : 'user',
      // Who it is with and whether it is one-to-one: the owner's own conversations (owner-alert.ts isOwnerConversation).
      ...(input.userId ? { userId: input.userId } : {}),
      conversationKind: input.threadId ? 'thread' : input.conversationKind ?? 'direct',
      // Typed or spoken, for this message (the owner rule reads it: a spoken message is never his).
      inputKind: input.inputKind ?? 'spoken',
      messageId: input.messageId,
      conversationId: input.conversationId,
      remoteSessionTtlMs: input.remoteSessionTtlMs,
      ...(input.context ? { homeAssistantContext: input.context } : {}),
    },
  });

  const now = Date.now();
  const existingSessionId = readString(binding.metadata.homeAssistantChatSessionId);
  const existing = existingSessionId ? runtime.chatManager.getSession(existingSessionId) : null;
  const expired = Boolean(existing && existing.status !== 'closed' && now - existing.updatedAt > input.remoteSessionTtlMs);
  if (expired && existing) {
    runtime.chatManager.closeSession(existing.id);
  }

  const defaultProviderModel = runtime.resolveDefaultProviderModel?.() ?? null;
  const provider = input.providerId ?? defaultProviderModel?.provider;
  const model = input.modelId ?? defaultProviderModel?.model;
  // The prompt is stable for the conversation, so the provider's prompt cache
  // holds across turns; per-turn grounding travels in the user message.
  const systemPrompt = buildHomeAssistantSystemPrompt(input);
  // The project the channel's conversations work in ("Project for this channel"): every conversation there works in it,
  // and one made for another project (the choice changed since) moves to it and keeps its history. With none chosen, a
  // conversation keeps the project it has (its own, made the first time the owner's own message there needed one:
  // workspace/automatic-projects.ts, or one the owner attached it to).
  const project = runtime.channelPolicy?.().project || undefined;
  const shouldCreate = !existing || existing.status === 'closed' || expired;
  if (!shouldCreate && existing && project !== undefined && (existing.project ?? undefined) !== project) {
    runtime.chatManager.moveSessionToProject(existing.id, project);
  }
  const session = shouldCreate
    ? runtime.chatManager.createSession({
        title: input.title || 'Home Assistant',
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        systemPrompt,
        ...(project ? { project } : {}),
      })
    : runtime.chatManager.updateSession(existing.id, {
        title: input.title || existing.title,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        systemPrompt,
      });

  await runtime.routeBindings.patchBinding(binding.id, {
    sessionId: null,
    jobId: null,
    runId: null,
    metadata: {
      homeAssistantChatSessionId: session.id,
      homeAssistantChatSessionUpdatedAt: now,
      remoteSessionTtlMs: input.remoteSessionTtlMs,
    },
  });

  return {
    // The binding as it now stands, so a caller reading its metadata sees this session.
    binding: { ...binding, metadata: { ...binding.metadata, homeAssistantChatSessionId: session.id } },
    session,
    newSession: shouldCreate,
    sessionExpired: expired,
  };
}

export function readHomeAssistantRemoteSessionTtlMs(
  configManager: ConfigReader,
  value: unknown,
): number {
  return clampNumber(
    value,
    Number(configManager.get('surfaces.homeassistant.remoteSessionTtlMs') ?? HOME_ASSISTANT_DEFAULT_REMOTE_SESSION_TTL_MS),
    MIN_REMOTE_SESSION_TTL_MS,
    MAX_REMOTE_SESSION_TTL_MS,
  );
}

export function buildHomeAssistantSystemPrompt(input: HomeAssistantChatInput): string {
  const contextLines = [
    `Conversation id: ${input.conversationId}`,
    `Surface id: ${input.surfaceId}`,
    input.channelId ? `Area/entity channel: ${input.channelId}` : '',
    input.userId ? `Home Assistant user id: ${input.userId}` : '',
    input.displayName ? `Home Assistant display name: ${input.displayName}` : '',
  ].filter(Boolean);
  return [
    HOME_ASSISTANT_SYSTEM_PROMPT_OPENING,
    'Answer as a normal assistant. Do not emit JSON summaries, contract status summaries, agent reports, changelogs, or engineering-stage output.',
    'Use Home Assistant tools whenever the user asks about devices, entities, rooms, services, automations, templates, or current home state.',
    HOME_STATE_PROVENANCE_CONTRACT,
    'For weather questions, first look for Home Assistant weather entities or other relevant sensors before saying live weather is unavailable.',
    'Ask a concise follow-up only when Home Assistant does not expose enough information to answer safely.',
    contextLines.length ? `Home Assistant context:\n${contextLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Consult the pre-registered home-graph space for this turn and return a
 * grounding block for the user message, or undefined when there is nothing to
 * add (no reader wired, no grounding reference, empty query, an empty/failed
 * answer). Grounding is a read: it never repairs extractions, refreshes device
 * pages or queues enrichment (those stay with the admin home-graph routes),
 * and it ends at the caller's deadline. Any failure degrades to an ungrounded
 * turn rather than breaking the conversation.
 */
async function resolveHomeGraphGrounding(
  reader: HomeGraphGroundingReader | undefined,
  input: HomeAssistantChatInput,
  deadlineAt: number | undefined,
): Promise<string | undefined> {
  if (!reader || !input.grounding || !input.text.trim()) return undefined;
  const hasRef = readString(input.grounding.installationId) !== undefined
    || readString(input.grounding.knowledgeSpaceId) !== undefined;
  if (!hasRef) return undefined;
  try {
    const remainingMs = deadlineAt === undefined ? HOME_GRAPH_GROUNDING_MAX_MS : deadlineAt - Date.now();
    if (remainingMs <= 0) return undefined;
    const result = await reader.ask({
      query: input.text,
      mode: 'concise',
      includeSources: false,
      readOnly: true,
      timeoutMs: Math.min(remainingMs, HOME_GRAPH_GROUNDING_MAX_MS),
      ...(input.grounding.installationId ? { installationId: input.grounding.installationId } : {}),
      ...(input.grounding.knowledgeSpaceId ? { knowledgeSpaceId: input.grounding.knowledgeSpaceId } : {}),
    });
    const answer = result.answer.text.trim();
    if (!answer) return undefined;
    const confidencePct = Math.round(result.answer.confidence * 100);
    return [
      `Home graph grounding (from the pre-registered home knowledge space ${result.spaceId}, confidence ${confidencePct}%):`,
      answer,
      'Treat this grounding as prior knowledge about the home; still verify live device/entity state through Home Assistant tools before acting on it.',
    ].join('\n');
  } catch {
    // Grounding is best-effort, an unreachable/empty graph must never break the turn.
    return undefined;
  }
}

function formatHomeAssistantUserMessage(input: HomeAssistantChatInput, grounding?: string | undefined): string {
  const metadata = {
    source: 'homeassistant',
    messageId: input.messageId,
    conversationId: input.conversationId,
    surfaceId: input.surfaceId,
    channelId: input.channelId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.context ? { context: input.context } : {}),
  };
  return [
    input.text,
    `Home Assistant metadata: ${JSON.stringify(metadata)}`,
    ...(grounding ? [grounding] : []),
  ].join('\n\n');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
