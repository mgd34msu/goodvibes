/**
 * companion-chat-routes.ts
 *
 * HTTP route handlers for the companion-app chat-mode API.
 *
 * Routes:
 *   POST   /api/companion/chat/sessions
 *   GET    /api/companion/chat/sessions/:sessionId
 *   PATCH  /api/companion/chat/sessions/:sessionId
 *   POST   /api/companion/chat/sessions/:sessionId/close   (soft close, history preserved)
 *   POST   /api/companion/chat/sessions/:sessionId/reopen  (a closed chat accepts messages again)
 *   DELETE /api/companion/chat/sessions/:sessionId         (hard delete, record permanently removed)
 *   POST   /api/companion/chat/sessions/:sessionId/messages
 *   GET    /api/companion/chat/sessions/:sessionId/messages   (?limit=&before= for one page)
 *   POST   /api/companion/chat/sessions/:sessionId/turns/cancel (stop the in-flight turn)
 *   POST   /api/companion/chat/sessions/:sessionId/messages/steer (interrupt + send now)
 *   GET    /api/companion/chat/sessions/:sessionId/events  (SSE)
 *   GET    /api/companion/chat/messages/search  (?query=&limit=&cursor=&includeClosed=)
 *
 * All routes require the existing daemon bearer-token auth (enforced by the
 * caller, DaemonHttpRouter.handleRequest already validates auth before
 * dispatching to API routes).
 */

import { createHash } from 'node:crypto';
import { readReasoningEffortLevel } from '../providers/reasoning-effort.js';
import { EngineErrorCodes, readRefusal, refusal, refusalErrorBody, type Refusal } from '@goodvibes-jev/engine/errors';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type {
  CancelCompanionChatTurnInput,
  CompanionChatMessageAttachmentInput,
  CreateCompanionChatSessionInput,
  EditCompanionChatMessageInput,
  ListCompanionChatSessionsInput,
  PostCompanionChatMessageInput,
  RegenerateCompanionChatMessageInput,
  UpdateCompanionChatSessionInput,
} from './companion-chat-types.js';
import type { CompanionChatRouteContext } from './companion-chat-route-types.js';

// ---------------------------------------------------------------------------
// Route dispatch, called from DaemonHttpRouter.dispatchApiRoutes
// ---------------------------------------------------------------------------

/**
 * Try to handle a companion chat route. Returns null if the path/method
 * does not match, so the caller can fall through to other route groups.
 */
/** The path prefix every companion chat route lives under. */
const COMPANION_CHAT_PATH_PREFIX = '/api/companion/chat/';

/**
 * Whether a request is addressed to a companion chat route: its pathname is
 * under /api/companion/chat/. The query string and the host are not part of
 * the route, so text there never selects this dispatcher.
 */
export function isCompanionChatPath(url: URL): boolean {
  return url.pathname.startsWith(COMPANION_CHAT_PATH_PREFIX);
}

/**
 * The paths the companion chat routes serve.
 * Read by the capability-route reconcile, which cannot see a sub-router that is
 * dispatched ahead of the shared route table. `{param}` is one path segment.
 */
export const COMPANION_CHAT_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'POST', path: '/api/companion/chat/sessions' },
  { method: 'GET', path: '/api/companion/chat/sessions' },
  { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}' },
  { method: 'PATCH', path: '/api/companion/chat/sessions/{sessionId}' },
  { method: 'DELETE', path: '/api/companion/chat/sessions/{sessionId}' },
  { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/close' },
  { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/reopen' },
  { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages' },
  { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/messages' },
  { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages/retry' },
  { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages/edit' },
  { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages/steer' },
  { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/turns/cancel' },
  { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/events' },
  { method: 'GET', path: '/api/companion/chat/messages/search' },
];

export async function dispatchCompanionChatRoutes(
  req: Request,
  context: CompanionChatRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  // POST /api/companion/chat/sessions
  if (pathname === '/api/companion/chat/sessions' && req.method === 'POST') {
    return handleCreateSession(req, context);
  }

  // GET /api/companion/chat/sessions
  if (pathname === '/api/companion/chat/sessions' && req.method === 'GET') {
    return handleListSessions(url, context);
  }

  // GET /api/companion/chat/messages/search
  if (pathname === '/api/companion/chat/messages/search' && req.method === 'GET') {
    return handleSearchMessages(url, context);
  }

  const sessionMatch = pathname.match(
    /^\/api\/companion\/chat\/sessions\/([^/]+)(\/(.+))?$/,
  );
  if (!sessionMatch) return null;

  const sessionId = sessionMatch[1]!;
  const sub = sessionMatch[3]! ?? '';

  // GET /api/companion/chat/sessions/:sessionId
  if (!sub && req.method === 'GET') {
    return handleGetSession(sessionId, context);
  }

  // PATCH /api/companion/chat/sessions/:sessionId
  if (!sub && req.method === 'PATCH') {
    return handleUpdateSession(req, sessionId, context);
  }

  // POST /api/companion/chat/sessions/:sessionId/close
  if (sub === 'close' && req.method === 'POST') {
    return handleCloseSession(sessionId, context);
  }

  // POST /api/companion/chat/sessions/:sessionId/reopen
  if (sub === 'reopen' && req.method === 'POST') {
    return handleReopenSession(sessionId, context);
  }

  // DELETE /api/companion/chat/sessions/:sessionId
  if (!sub && req.method === 'DELETE') {
    return handleDeleteSession(sessionId, context);
  }

  // POST /api/companion/chat/sessions/:sessionId/messages
  if (sub === 'messages' && req.method === 'POST') {
    return handlePostMessage(req, sessionId, context);
  }

  if (sub === 'messages' && req.method === 'GET') {
    return handleGetMessages(url, sessionId, context);
  }

  // POST /api/companion/chat/sessions/:sessionId/messages/retry   (regenerate)
  if (sub === 'messages/retry' && req.method === 'POST') {
    return handleRegenerateMessage(req, sessionId, context);
  }

  // POST /api/companion/chat/sessions/:sessionId/messages/edit    (edit + branch)
  if (sub === 'messages/edit' && req.method === 'POST') {
    return handleEditMessage(req, sessionId, context);
  }

  // POST /api/companion/chat/sessions/:sessionId/turns/cancel
  if (sub === 'turns/cancel' && req.method === 'POST') {
    return handleCancelTurn(req, sessionId, context);
  }

  // POST /api/companion/chat/sessions/:sessionId/messages/steer
  if (sub === 'messages/steer' && req.method === 'POST') {
    return handleSteerMessage(req, sessionId, context);
  }

  // GET /api/companion/chat/sessions/:sessionId/events
  if (sub === 'events' && req.method === 'GET') {
    return handleGetEvents(req, sessionId, context);
  }

  return null;
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions
// ---------------------------------------------------------------------------

async function handleCreateSession(
  req: Request,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseOptionalJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;

  const body = (bodyOrResponse ?? {}) as Record<string, unknown>;
  const hasModel = typeof body['model'] === 'string';
  const hasProvider = typeof body['provider'] === 'string';
  if (hasModel !== hasProvider) {
    return Response.json(
      { error: 'provider and model must be supplied together', code: 'INVALID_MODEL_ROUTE' },
      { status: 400 },
    );
  }

  // Resolve provider/model from registry only when caller did not specify a route.
  const shouldResolveDefaults = !hasModel && !hasProvider;
  const hasDefaultResolver = typeof context.resolveDefaultProviderModel === 'function';
  const resolvedDefaults = hasDefaultResolver && shouldResolveDefaults
    ? (context.resolveDefaultProviderModel?.() ?? null)
    : null;

  const reasoningEffort = body['reasoningEffort'];
  if (reasoningEffort !== undefined && reasoningEffort !== null && readReasoningEffortLevel(reasoningEffort) === undefined) {
    return Response.json({ error: 'Invalid chat reasoning effort', code: 'INVALID_ARGUMENT' }, { status: 400 });
  }
  const input: CreateCompanionChatSessionInput = {
    title: typeof body['title'] === 'string' ? body['title'] : undefined,
    model: hasModel ? (body['model'] as string) : (resolvedDefaults?.model ?? undefined),
    provider: hasProvider ? (body['provider'] as string) : (resolvedDefaults?.provider ?? undefined),
    reasoningEffort: reasoningEffort === null ? null : readReasoningEffortLevel(reasoningEffort) ?? resolvedDefaults?.reasoningEffort,
    systemPrompt: typeof body['systemPrompt'] === 'string' ? body['systemPrompt'] : undefined,
  };

  if (shouldResolveDefaults
    && (!input.provider || !input.model)
    && (hasDefaultResolver || Object.keys(body).length === 0)) {
    return Response.json(
      { error: 'No provider or model configured. Set a current model before creating a companion chat session.', code: 'NO_MODEL_CONFIGURED' },
      { status: 400 },
    );
  }

  try {
    // Saved before it is returned: a chat whose save failed is refused, not half-created.
    const session = context.chatManager.createSession(input);
    // Drain the best-effort broker mirror before responding so /api/sessions
    // reflects this session synchronously, matching CompanionBrokerSync's
    // documented contract (see companion-chat-broker-sync.ts).
    await context.chatManager.flushBrokerSync();
    return Response.json(
      { sessionId: session.id, createdAt: session.createdAt, session },
      { status: 201 },
    );
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/companion/chat/sessions
// ---------------------------------------------------------------------------

function readBooleanQuery(url: URL, key: string): boolean | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}

function readLimitQuery(url: URL): number | undefined {
  const value = url.searchParams.get('limit');
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// GET /api/companion/chat/messages/search
// ---------------------------------------------------------------------------

const MESSAGE_SEARCH_DEFAULT_LIMIT = 25;
const MESSAGE_SEARCH_MAX_LIMIT = 100;
const MESSAGE_SEARCH_SNIPPET_CONTEXT = 80;

/** Up to 160 characters of `text` around the first match of `needle` (lower case). */
function searchSnippet(text: string, needle: string): string {
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return text.slice(0, MESSAGE_SEARCH_SNIPPET_CONTEXT * 2);
  const start = Math.max(0, index - MESSAGE_SEARCH_SNIPPET_CONTEXT);
  const end = Math.min(text.length, index + needle.length + MESSAGE_SEARCH_SNIPPET_CONTEXT);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * Find chat messages whose text contains `query` (case-insensitive), across
 * every chat the daemon holds, newest first: one scan here in place of a
 * client reading every transcript. Each hit names the chat, the message, a
 * snippet and the time. Retained history behind a regenerate or edit is not
 * searched. Paged by an opaque cursor; closed chats only with includeClosed.
 */
function handleSearchMessages(url: URL, context: CompanionChatRouteContext): Response {
  const query = (url.searchParams.get('query') ?? '').trim();
  if (!query) {
    return Response.json({ error: 'query is required', code: 'INVALID_ARGUMENT' }, { status: 400 });
  }
  const requested = readLimitQuery(url);
  const limit = Math.min(MESSAGE_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(requested ?? MESSAGE_SEARCH_DEFAULT_LIMIT)));
  const rawCursor = url.searchParams.get('cursor');
  const offset = rawCursor === null || rawCursor === '' ? 0 : Number(rawCursor);
  if (!Number.isInteger(offset) || offset < 0) {
    return Response.json({ error: 'cursor is not one this search returned', code: 'INVALID_CURSOR' }, { status: 400 });
  }
  const includeClosed = url.searchParams.get('includeClosed') === 'true';
  const needle = query.toLowerCase();
  const { sessions } = context.chatManager.listSessions({ includeClosed, limit: Number.MAX_SAFE_INTEGER });
  const hits: {
    readonly sessionId: string;
    readonly sessionTitle: string;
    readonly messageId: string;
    readonly role: string;
    readonly snippet: string;
    readonly createdAt: number;
  }[] = [];
  for (const session of sessions) {
    for (const message of context.chatManager.getMessages(session.id)) {
      if (message.supersededAt !== undefined) continue;
      if (!message.content.toLowerCase().includes(needle)) continue;
      hits.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: message.id,
        role: message.role,
        snippet: searchSnippet(message.content, needle),
        createdAt: message.createdAt,
      });
    }
  }
  hits.sort((left, right) => right.createdAt - left.createdAt || left.messageId.localeCompare(right.messageId));
  const items = hits.slice(offset, offset + limit);
  const hasMore = offset + limit < hits.length;
  return Response.json({
    query,
    items,
    total: hits.length,
    hasMore,
    ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
  });
}

function handleListSessions(
  url: URL,
  context: CompanionChatRouteContext,
): Response {
  const input: ListCompanionChatSessionsInput = {
    includeClosed: readBooleanQuery(url, 'includeClosed'),
    limit: readLimitQuery(url),
  };
  return Response.json(context.chatManager.listSessions(input));
}

// ---------------------------------------------------------------------------
// GET /api/companion/chat/sessions/:sessionId
// ---------------------------------------------------------------------------

async function handleGetSession(
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const session = context.chatManager.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  try {
    // Read after the transcript loads: opening a chat can settle what a restart left unfinished.
    const messages = context.chatManager.getMessages(sessionId);
    return Response.json({ session: context.chatManager.getSession(sessionId) ?? session, messages });
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/companion/chat/sessions/:sessionId
// ---------------------------------------------------------------------------

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function readOptionalNonEmptyString(
  body: Record<string, unknown>,
  key: string,
): string | Response | undefined {
  if (!hasOwn(body, key)) return undefined;
  const value = body[key]!;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return Response.json(
      { error: `${key} must be a non-empty string`, code: 'INVALID_ARGUMENT' },
      { status: 400 },
    );
  }
  return value.trim();
}

function readOptionalSystemPrompt(
  body: Record<string, unknown>,
): string | null | Response | undefined {
  if (!hasOwn(body, 'systemPrompt')) return undefined;
  const value = body['systemPrompt'];
  if (value === null) return null;
  if (typeof value !== 'string') {
    return Response.json(
      { error: 'systemPrompt must be a string or null', code: 'INVALID_ARGUMENT' },
      { status: 400 },
    );
  }
  return value;
}

async function handleUpdateSession(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;

  const body = bodyOrResponse as Record<string, unknown>;
  const input: UpdateCompanionChatSessionInput = {};

  const title = readOptionalNonEmptyString(body, 'title');
  if (title instanceof Response) return title;
  if (title !== undefined) (input as { title?: string }).title = title;

  const model = readOptionalNonEmptyString(body, 'model');
  if (model instanceof Response) return model;
  if (model !== undefined) {
    (input as { model?: string }).model = model;
  }

  const provider = readOptionalNonEmptyString(body, 'provider');
  if (provider instanceof Response) return provider;
  if (provider !== undefined) (input as { provider?: string }).provider = provider;

  if ((model !== undefined) !== (provider !== undefined)) {
    return Response.json(
      { error: 'provider and model must be updated together', code: 'INVALID_MODEL_ROUTE' },
      { status: 400 },
    );
  }

  const effort = body['reasoningEffort'];
  if (effort !== undefined) {
    const parsed = effort === null ? null : readReasoningEffortLevel(effort);
    if (parsed === undefined) return Response.json({ error: 'Invalid chat reasoning effort', code: 'INVALID_ARGUMENT' }, { status: 400 });
    (input as { reasoningEffort?: string | null }).reasoningEffort = parsed;
  }

  const systemPrompt = readOptionalSystemPrompt(body);
  if (systemPrompt instanceof Response) return systemPrompt;
  if (systemPrompt !== undefined) (input as { systemPrompt?: string | null }).systemPrompt = systemPrompt;

  if (Object.keys(input).length === 0) {
    return Response.json(
      { error: 'At least one of title, provider, model, reasoningEffort, or systemPrompt is required', code: 'INVALID_ARGUMENT' },
      { status: 400 },
    );
  }

  try {
    const session = await context.chatManager.updateSessionPersisted(sessionId, input);
    // Drain the best-effort broker mirror before responding, an update
    // heartbeats the shared record (see CompanionBrokerSync.registerSession).
    await context.chatManager.flushBrokerSync();
    return Response.json({ session });
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions/:sessionId/close
// ---------------------------------------------------------------------------

async function handleCloseSession(
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  try {
    const session = context.chatManager.closeSession(sessionId);
    if (!session) {
      return Response.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
    }
    // Drain the best-effort broker mirror before responding so /api/sessions
    // reflects the close synchronously (matches CompanionBrokerSync's docs).
    await context.chatManager.flushBrokerSync();
    return Response.json({ sessionId: session.id, status: session.status });
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions/:sessionId/reopen
// ---------------------------------------------------------------------------

/** Reopen a closed chat; the model's history is rebuilt from the transcript on the next send. */
async function handleReopenSession(
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  try {
    const result = context.chatManager.reopenSession(sessionId);
    await context.chatManager.flushBrokerSync();
    return Response.json(result);
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/companion/chat/sessions/:sessionId  (see CHANGELOG 1.0.0: a real hard delete)
// ---------------------------------------------------------------------------

async function handleDeleteSession(
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  try {
    const result = await context.chatManager.deleteSession(sessionId);
    // Drain the best-effort broker mirror before responding so /api/sessions
    // no longer shows the session by the time this response returns.
    await context.chatManager.flushBrokerSync();
    return Response.json(result);
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

/**
 * Read the message content from an incoming POST body.
 * Returns empty string when neither field is present, the caller must
 * check for empty and return 400 INVALID_ARGUMENT.
 *
 * @param body - Parsed JSON body from the request.
 * @returns Raw (un-trimmed) string value, or '' if neither field is present.
 */
export function readCompanionChatMessageBody(body: Record<string, unknown>): string {
  return typeof body['body'] === 'string'
    ? body['body']
    : typeof body['content'] === 'string'
      ? body['content']
      : '';
}

function readCompanionChatAttachments(
  body: Record<string, unknown>,
): CompanionChatMessageAttachmentInput[] | Response {
  const raw = body['attachments'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return Response.json(
      { error: 'attachments must be an array', code: 'INVALID_ARGUMENT' },
      { status: 400 },
    );
  }
  const attachments: CompanionChatMessageAttachmentInput[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return Response.json(
        { error: `attachments[${index}] must be an object`, code: 'INVALID_ARGUMENT' },
        { status: 400 },
      );
    }
    const record = item as Record<string, unknown>;
    if (typeof record['artifactId'] !== 'string' || record['artifactId'].trim().length === 0) {
      return Response.json(
        { error: `attachments[${index}].artifactId is required`, code: 'INVALID_ARGUMENT' },
        { status: 400 },
      );
    }
    const attachment: CompanionChatMessageAttachmentInput = {
      artifactId: record['artifactId'].trim(),
    };
    if (typeof record['label'] === 'string' && record['label'].trim()) {
      (attachment as { label?: string }).label = record['label'].trim();
    }
    if (typeof record['metadata'] === 'object' && record['metadata'] !== null && !Array.isArray(record['metadata'])) {
      (attachment as { metadata?: Record<string, unknown> }).metadata = record['metadata'] as Record<string, unknown>;
    }
    attachments.push(attachment);
  }
  return attachments;
}

const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;

/** The sender's idempotency id for a send: absent, a usable string, or the 400 that names the problem. */
function readClientMessageId(body: Record<string, unknown>): string | undefined | Response {
  const raw = body['clientMessageId'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
    return Response.json(
      { error: `clientMessageId must be a non-empty string of at most ${MAX_CLIENT_MESSAGE_ID_LENGTH} characters`, code: 'INVALID_ARGUMENT' },
      { status: 400 },
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions/:sessionId/messages
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/companion/chat/sessions/:sessionId/messages.
 *
 * Accepts either `{body}` or `{content}` in the request payload.
 * If both are present, `{body}` takes precedence (shared-session canonical field).
 * Returns 400 INVALID_ARGUMENT when neither field is present or both are empty.
 */
async function handlePostMessage(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;

  const body = bodyOrResponse as Record<string, unknown>;
  const rawContent =
    typeof body['body'] === 'string'
      ? body['body']
      : typeof body['content'] === 'string'
        ? body['content']
        : '';
  const attachments = readCompanionChatAttachments(body);
  if (attachments instanceof Response) return attachments;
  const clientMessageId = readClientMessageId(body);
  if (clientMessageId instanceof Response) return clientMessageId;
  const attachmentRefusal = refuseUnreadableAttachments(req, attachments, context);
  if (attachmentRefusal) return attachmentRefusal;
  const input: PostCompanionChatMessageInput = {
    content: rawContent,
    attachments,
    metadata: typeof body['metadata'] === 'object' && body['metadata'] !== null
      ? (body['metadata'] as Record<string, unknown>)
      : undefined,
  };

  if (!input.content.trim() && attachments.length === 0) {
    return Response.json(
      { error: 'content, body, or attachments are required', code: 'INVALID_ARGUMENT' },
      { status: 400 },
    );
  }

  try {
    const messageId = await context.chatManager.postMessage(sessionId, input.content, requestClientId(req, context), {
      attachments: input.attachments,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
      // This route sits behind the daemon's auth, validated by
      // DaemonHttpRouter.handleRequest before any API route is dispatched (see
      // this file's header). The daemon's own credential (shared token, paired
      // device, admin user) IS being the owner, so for those the daemon can
      // honestly attest this message is theirs, and does. A user session
      // without the admin role does not get the attestation, and the router
      // already refuses it the write:sessions scope this route needs.
      //
      // This is what gives the webui a turn boundary. Without it the window
      // never reset for anything the owner typed there, and the taint guard
      // would weigh a page read an hour ago against a message they are
      // writing now.
      ownerDirect: isOwnerRequest(req, context),
    });
    return Response.json({ messageId }, { status: 202 });
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

/** A refusal as the wire answer: state, reason and next step, with Retry-After when it says when. */
function respondWithRefusal(value: Refusal): Response {
  const status = value.status ?? 500;
  return Response.json(refusalErrorBody(value), {
    status,
    ...(value.retryAfterMs !== undefined
      ? { headers: { 'Retry-After': String(Math.max(1, Math.ceil(value.retryAfterMs / 1000))) } }
      : {}),
  });
}

/**
 * Map a manager error to a JSON error response.
 *
 * A refusal the manager raised (a save that failed, the service stopping, a
 * closed chat) is answered with its own state, reason and next step; those
 * never carry a storage path. Other errors the manager raised on purpose (a
 * string `code` and a client-error status, or a rate-limit refusal) reach the
 * caller with their own message. Anything else is logged in full and answered
 * with a fixed sentence.
 */
function respondWithManagerError(err: unknown): Response {
  const declared = readRefusal(err);
  if (declared && declared.status !== undefined) {
    if (declared.status >= 500) logger.warn('Companion chat request refused', { code: declared.code, error: summarizeError(err) });
    return respondWithRefusal(declared);
  }
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown; status?: unknown; message?: unknown; category?: unknown; retryAfterMs?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : '';
  if (e.category === 'rate_limit' && code !== undefined) {
    return Response.json(
      { error: message, code, ...(typeof e.retryAfterMs === 'number' ? { retryAfterMs: e.retryAfterMs } : {}) },
      {
        status: 429,
        ...(typeof e.retryAfterMs === 'number'
          ? { headers: { 'Retry-After': String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))) } }
          : {}),
      },
    );
  }
  if (code !== undefined && status !== undefined && status >= 400 && status < 500) {
    return Response.json({ error: message, code }, { status });
  }
  logger.error('Companion chat request failed', { error: summarizeError(err) });
  return Response.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, { status: 500 });
}

/**
 * Whether this request may attest that the owner typed the message. The caller
 * holds the daemon's own credential only when it is an admin (the shared token,
 * a paired device, or an admin user); a signed-in user without that role is
 * authenticated but is not the owner. A context that cannot tell keeps the
 * historical answer, because the router already validated the credential.
 */
function isOwnerRequest(req: Request, context: CompanionChatRouteContext): boolean {
  return context.requireAdmin ? context.requireAdmin(req) === null : true;
}

/**
 * Attaching an artifact makes its content part of the chat, so a caller that
 * may write sessions but not read artifacts must not be able to use a message
 * to reach one (nor to learn from the answer which artifact ids exist). Returns
 * the refusal to send, or null when there is nothing attached or the caller may
 * read artifacts. A context that cannot tell leaves the check to the router.
 */
function refuseUnreadableAttachments(
  req: Request,
  attachments: readonly CompanionChatMessageAttachmentInput[],
  context: CompanionChatRouteContext,
): Response | null {
  if (attachments.length === 0) return null;
  return context.requireScope?.(req, 'read:artifacts') ?? null;
}

/**
 * The identity the per-client message cap counts against, taken from the
 * request's own credential and never from the body. The credential is hashed so
 * the token is never kept in the limiter or printed in its refusal. Empty only
 * for a request that carries none, which skips the per-client cap.
 */
function requestClientId(req: Request, context: CompanionChatRouteContext): string {
  const explicit = context.resolveClientId?.(req);
  if (explicit) return explicit;
  const credential = `${req.headers.get('authorization') ?? ''}\n${req.headers.get('cookie') ?? ''}`;
  if (credential.trim() === '') return '';
  return `credential:${createHash('sha256').update(credential).digest('hex').slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions/:sessionId/messages/retry  (regenerate)
// ---------------------------------------------------------------------------

/**
 * Regenerate an assistant response. Optional `messageId` in the body targets a
 * specific assistant message; omitted, the latest assistant response is re-run.
 * The prior response is superseded (retained as history), never deleted.
 */
async function handleRegenerateMessage(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseOptionalJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;
  const body = (bodyOrResponse ?? {}) as Record<string, unknown>;
  const input: RegenerateCompanionChatMessageInput = {
    messageId: typeof body['messageId'] === 'string' ? body['messageId'] : undefined,
  };
  try {
    return Response.json(context.chatManager.regenerateMessage(sessionId, input, { clientId: requestClientId(req, context) }), { status: 202 });
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions/:sessionId/messages/edit  (edit + branch)
// ---------------------------------------------------------------------------

/**
 * Edit a user message and branch the conversation from it. Accepts `messageId`
 * (required) plus the edited text as `body` or `content` (as the message-post
 * route does). The original message and everything after it are superseded
 * (retained as history) and a fresh turn runs from the edited message.
 */
async function handleEditMessage(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;
  const body = bodyOrResponse as Record<string, unknown>;

  const messageId = typeof body['messageId'] === 'string' ? body['messageId'].trim() : '';
  if (!messageId) {
    return Response.json({ error: 'messageId is required', code: 'INVALID_ARGUMENT' }, { status: 400 });
  }
  const attachments = readCompanionChatAttachments(body);
  if (attachments instanceof Response) return attachments;
  const attachmentRefusal = refuseUnreadableAttachments(req, attachments, context);
  if (attachmentRefusal) return attachmentRefusal;

  const input: EditCompanionChatMessageInput = {
    messageId,
    content: readCompanionChatMessageBody(body),
    attachments,
    metadata: typeof body['metadata'] === 'object' && body['metadata'] !== null
      ? (body['metadata'] as Record<string, unknown>)
      : undefined,
  };
  try {
    // Same attestation as a posted message: an edit is new owner input, which is
    // what restarts the untrusted-content window. A regenerate is not, and passes none.
    return Response.json(
      context.chatManager.editMessage(sessionId, input, { ownerDirect: isOwnerRequest(req, context), clientId: requestClientId(req, context) }),
      { status: 202 },
    );
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/companion/chat/sessions/:sessionId/messages
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/companion/chat/sessions/:sessionId/messages.
 *
 * Without query parameters the whole transcript is returned (the `messages`
 * field of the session-detail endpoint). With `limit` (1-1000) and/or `before`
 * (a message id) one page is returned, oldest first, with `total`, `more` and
 * `nextBefore` to read the page before it.
 */
async function handleGetMessages(
  url: URL,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const session = context.chatManager.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  const limit = readLimitQuery(url);
  const before = url.searchParams.get('before') ?? undefined;
  try {
    if (limit === undefined && before === undefined) {
      const messages = context.chatManager.getMessages(sessionId);
      return Response.json({ sessionId, messages, total: messages.length, more: false });
    }
    return Response.json({ sessionId, ...context.chatManager.getMessagePage(sessionId, { before, limit }) });
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions/:sessionId/turns/cancel
// ---------------------------------------------------------------------------

/**
 * Stop the in-flight turn for a session. Optional `turnId` in the body guards
 * against cancelling a newer turn a stale stop click raced against
 * (409 TURN_MISMATCH). No turn in flight is the benign 404 NO_ACTIVE_TURN;
 * a stop accepted for a turn still ending is 409 TURN_STOPPING (stopping, not
 * failed); repeat cancels are idempotent successes. The terminal `turn.cancelled` SSE
 * event (emitted to every subscriber) is the authoritative convergence signal.
 */
async function handleCancelTurn(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseOptionalJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;
  const body = (bodyOrResponse ?? {}) as Record<string, unknown>;
  const input: CancelCompanionChatTurnInput = {
    turnId: typeof body['turnId'] === 'string' && body['turnId'].trim() ? body['turnId'].trim() : undefined,
  };
  try {
    return Response.json(await context.chatManager.cancelTurn(sessionId, input));
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions/:sessionId/messages/steer
// ---------------------------------------------------------------------------

/**
 * Steer: send a message that runs immediately, interrupting the in-flight
 * turn (cancelled through the same finalization path as an explicit stop,
 * honest partial + terminal turn.cancelled). Accepts the same payload as the
 * message-post route (`body`/`content`, `attachments`, `metadata`).
 */
async function handleSteerMessage(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;
  const body = bodyOrResponse as Record<string, unknown>;
  const rawContent = readCompanionChatMessageBody(body);
  const attachments = readCompanionChatAttachments(body);
  if (attachments instanceof Response) return attachments;
  const clientMessageId = readClientMessageId(body);
  if (clientMessageId instanceof Response) return clientMessageId;
  const attachmentRefusal = refuseUnreadableAttachments(req, attachments, context);
  if (attachmentRefusal) return attachmentRefusal;
  if (!rawContent.trim() && attachments.length === 0) {
    return Response.json(
      { error: 'content, body, or attachments are required', code: 'INVALID_ARGUMENT' },
      { status: 400 },
    );
  }
  try {
    const result = await context.chatManager.steerMessage(sessionId, rawContent, requestClientId(req, context), {
      attachments,
      metadata: typeof body['metadata'] === 'object' && body['metadata'] !== null
        ? (body['metadata'] as Record<string, unknown>)
        : undefined,
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
      // Same auth as the post route above, so the same attestation.
      // A steer is the owner speaking with more urgency, not less authority,
      // wiring one and not the other would leave them a way to start a turn
      // that silently did not end the previous one.
      ownerDirect: isOwnerRequest(req, context),
    });
    return Response.json(result, { status: 202 });
  } catch (err: unknown) {
    return respondWithManagerError(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/companion/chat/sessions/:sessionId/events  (SSE)
// ---------------------------------------------------------------------------

async function handleGetEvents(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const session = context.chatManager.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  if (session.status === 'closed') {
    return respondWithRefusal(refusal({
      code: EngineErrorCodes.SESSION_CLOSED,
      status: 410,
      retryable: false,
      state: 'the chat is closed',
      reason: 'A closed chat has no live events',
      next: ['Reopen the chat (companion.chat.sessions.reopen), then open its event stream again'],
    }));
  }

  // Delegate to the caller-provided SSE stream opener which wires up the
  // gateway live-client registration and returns an SSE Response.
  return context.openSessionEventStream(req, sessionId);
}
