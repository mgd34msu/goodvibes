/**
 * method-catalog-control-companion.ts
 *
 * Companion-chat method catalog registration, split out of
 * method-catalog-control-core.ts (see CHANGELOG 1.0.0) to stay under the repo's 800-line
 * hand-authored file cap (see scripts/check-line-cap.ts), this block is
 * self-contained (companion.chat.* descriptors only) and control.ts folds it
 * in unchanged, so this is a pure file-organization move with no API surface
 * change beyond the delete-honesty split it carries (companion.chat.sessions.close
 * as a distinct soft-close verb alongside a genuinely hard-deleting
 * companion.chat.sessions.delete).
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  bodyEnvelopeSchema,
  branchedSchema,
  requirementBranch,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';
import {
  COMPANION_CHAT_MESSAGES_LIST_SCHEMA,
  COMPANION_CHAT_REASONING_EFFORT_SCHEMA,
  COMPANION_CHAT_SESSION_SCHEMA,
  COMPANION_CHAT_SESSIONS_LIST_SCHEMA,
  COMPANION_CHAT_SESSION_WITH_MESSAGES_SCHEMA,
} from './operator-contract-schemas.js';

/** The attachment list every companion-chat message payload carries. */
const COMPANION_CHAT_ATTACHMENTS_SCHEMA = arraySchema(objectSchema({
  artifactId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  metadata: objectSchema({}, []),
}, ['artifactId']));

const COMPANION_CHAT_MESSAGE_PAYLOAD_PROPERTIES: Record<string, Record<string, unknown>> = {
  body: STRING_SCHEMA,
  content: STRING_SCHEMA,
  attachments: COMPANION_CHAT_ATTACHMENTS_SCHEMA,
  metadata: objectSchema({}, []),
};

/**
 * Companion chat refuses a message carrying no text AND no attachments
 * (companion/companion-chat-routes.ts: `content, body, or attachments are
 * required`, 400 INVALID_ARGUMENT). None of the three is required on its own, so
 * a flat `required` array cannot state this, listing any one of them would
 * refuse an attachment-only message, which is a call that works today. The
 * union says exactly what the handler does.
 */
function companionChatMessageInputSchema(
  extraProperties: Record<string, Record<string, unknown>> = {},
  alwaysRequired: readonly string[] = [],
): Record<string, unknown> {
  const properties = { ...extraProperties, ...COMPANION_CHAT_MESSAGE_PAYLOAD_PROPERTIES };
  return branchedSchema(
    bodyEnvelopeSchema(properties, alwaysRequired),
    (['body', 'content', 'attachments'] as const).map((field) =>
      requirementBranch({ [field]: properties[field] as Record<string, unknown> }, [field])),
  );
}

/**
 * `provider` and `model` name one route together and the handler refuses half
 * of it (`provider and model must be supplied together`, 400
 * INVALID_MODEL_ROUTE). Neither is required alone, this is a dependency
 * between two optional fields, which is what `dependentRequired` is for.
 */
const CLIENT_MESSAGE_ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 } as const;

const COMPANION_MODEL_ROUTE_DEPENDENCY: Readonly<Record<string, readonly string[]>> = {
  model: ['provider'],
  provider: ['model'],
};

export const builtinGatewayControlCompanionMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'companion.chat.sessions.create',
    title: 'Create Companion Chat Session',
    description: 'Create a new companion-chat session. Optional `provider` / `model` override the registry default. The session retains its requested `reasoningEffort`; null restores provider defaults. Title and system prompt are stored on the session record.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions' },
    inputSchema: bodyEnvelopeSchema({
      title: STRING_SCHEMA,
      model: STRING_SCHEMA,
      provider: STRING_SCHEMA,
      reasoningEffort: COMPANION_CHAT_REASONING_EFFORT_SCHEMA,
      systemPrompt: STRING_SCHEMA,
    }, [], { dependentRequired: COMPANION_MODEL_ROUTE_DEPENDENCY }),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      createdAt: NUMBER_SCHEMA,
      session: COMPANION_CHAT_SESSION_SCHEMA,
    }, ['sessionId', 'createdAt', 'session']),
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.list',
    title: 'List Companion Chat Sessions',
    description: 'List active companion-chat sessions. Pass `includeClosed` to include recently closed sessions. Each record carries its title and system prompt, so it needs read:transcripts.',
    category: 'companion',
    scopes: ['read:transcripts'],
    http: { method: 'GET', path: '/api/companion/chat/sessions' },
    inputSchema: objectSchema({
      includeClosed: BOOLEAN_SCHEMA,
      limit: NUMBER_SCHEMA,
    }, []),
    outputSchema: COMPANION_CHAT_SESSIONS_LIST_SCHEMA,
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.get',
    title: 'Get Companion Chat Session',
    description: 'Return a companion-chat session record together with its full message history.',
    category: 'companion',
    scopes: ['read:transcripts'],
    http: { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: COMPANION_CHAT_SESSION_WITH_MESSAGES_SCHEMA,
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.update',
    title: 'Update Companion Chat Session',
    description: 'Update companion-chat session metadata, including session-local provider, model and requested reasoning effort, without changing the daemon/TUI current model. Routing changes are refused while a reply is active; null effort restores provider defaults.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'PATCH', path: '/api/companion/chat/sessions/{sessionId}' },
    // An update with nothing to update is refused (`At least one of title,
    // provider, model, or systemPrompt is required`), and provider/model still
    // travel as a pair. Both facts are declared: a union over the four fields,
    // each branch carrying the pairing dependency.
    inputSchema: branchedSchema(
      bodyEnvelopeSchema({
        sessionId: STRING_SCHEMA,
        title: STRING_SCHEMA,
        model: STRING_SCHEMA,
        provider: STRING_SCHEMA,
        reasoningEffort: COMPANION_CHAT_REASONING_EFFORT_SCHEMA,
        systemPrompt: STRING_SCHEMA,
      }, ['sessionId'], { dependentRequired: COMPANION_MODEL_ROUTE_DEPENDENCY }),
      (['title', 'model', 'provider', 'systemPrompt', 'reasoningEffort'] as const).map((field) =>
        requirementBranch({ [field]: field === 'reasoningEffort' ? COMPANION_CHAT_REASONING_EFFORT_SCHEMA : STRING_SCHEMA }, [field])),
    ),
    outputSchema: objectSchema({
      session: COMPANION_CHAT_SESSION_SCHEMA,
    }, ['session']),
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.close',
    title: 'Close Companion Chat Session',
    description: 'Close a companion-chat session (soft close). The session record and its messages are preserved in closed state and remain listable with includeClosed. Distinct from companion.chat.sessions.delete, which permanently removes the record.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/close' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      status: STRING_SCHEMA,
    }, ['sessionId', 'status']),
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.reopen',
    title: 'Reopen Companion Chat Session',
    description: 'Open a closed companion-chat session again so it accepts messages. The model history is rebuilt from the saved transcript on the next send. A chat that is already open answers `reopened: false` with its current status; an unknown id is a 404 SESSION_NOT_FOUND.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/reopen' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      status: STRING_SCHEMA,
      reopened: BOOLEAN_SCHEMA,
    }, ['sessionId', 'status', 'reopened']),
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.delete',
    title: 'Delete Companion Chat Session',
    description: 'Permanently remove a companion-chat session: the on-disk record file is deleted and the session is dropped from the shared session store, this does NOT merely close it (use companion.chat.sessions.close for a soft close). Requires the session to already be closed: deleting a still-active session is rejected with 409 SESSION_ACTIVE (close it, then delete). An unknown or already-deleted id is a 404 SESSION_NOT_FOUND, never a 200-noop.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'DELETE', path: '/api/companion/chat/sessions/{sessionId}' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      deleted: BOOLEAN_SCHEMA,
    }, ['sessionId', 'deleted']),
  }),
  methodDescriptor({
    id: 'companion.chat.messages.create',
    effect: 'outward',
    title: 'Send Companion Chat Message',
    description: 'Post a user message to a companion-chat session. Accepts either `body` or `content` in the payload; `body` wins when both are provided. Attachments reference artifacts created through `artifacts.create`. A message queued behind a running turn whose turn can never run (the chat closed, the service shut down or the daemon restarted first) ends as `deliveryState: "unanswered"`. Optional `clientMessageId` (1-128 characters) makes the send safe to repeat: a second send with the same id returns the first message\'s id and starts no second turn, so a client whose response was lost can resend. The id is remembered while the session stays loaded in the daemon; a daemon restart forgets it.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages' },
    inputSchema: companionChatMessageInputSchema({ sessionId: STRING_SCHEMA, clientMessageId: CLIENT_MESSAGE_ID_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      messageId: STRING_SCHEMA,
    }, ['messageId']),
  }),
  methodDescriptor({
    id: 'companion.chat.messages.list',
    title: 'List Companion Chat Messages',
    description: 'Return the messages of a companion-chat session, oldest first. With neither `limit` nor `before` the whole transcript is returned. With `limit` (1-1000, default 100 when only `before` is given) and/or `before` (a message id) one page is returned: the messages just before `before`, or the newest ones. Every answer carries `total` and `more`; while `more` is true, pass `nextBefore` back as `before` to read the page before it. A `before` that names no message in the chat is 404 MESSAGE_NOT_FOUND.',
    category: 'companion',
    scopes: ['read:transcripts'],
    http: { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/messages' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA, limit: NUMBER_SCHEMA, before: STRING_SCHEMA }, ['sessionId']),
    outputSchema: COMPANION_CHAT_MESSAGES_LIST_SCHEMA,
  }),
  methodDescriptor({
    id: 'companion.chat.messages.search',
    title: 'Search Companion Chat Messages',
    description: 'Find companion-chat messages whose text contains `query` (case-insensitive) across every chat, newest first. Each item names the chat (`sessionId`, `sessionTitle`), the message (`messageId`, `role`), a snippet around the match and `createdAt`. History retained behind a regenerate or edit is not searched. Closed chats are searched only with `includeClosed`. Paged: `limit` 1-100 (default 25); pass `nextCursor` back as `cursor` while `hasMore` is true. A blank query is 400 INVALID_ARGUMENT; a cursor this search did not return is 400 INVALID_CURSOR.',
    category: 'companion',
    scopes: ['read:transcripts'],
    http: { method: 'GET', path: '/api/companion/chat/messages/search' },
    inputSchema: objectSchema({
      query: STRING_SCHEMA,
      limit: NUMBER_SCHEMA,
      cursor: STRING_SCHEMA,
      includeClosed: BOOLEAN_SCHEMA,
    }, ['query']),
    outputSchema: objectSchema({
      query: STRING_SCHEMA,
      items: arraySchema(objectSchema({
        sessionId: STRING_SCHEMA,
        sessionTitle: STRING_SCHEMA,
        messageId: STRING_SCHEMA,
        role: STRING_SCHEMA,
        snippet: STRING_SCHEMA,
        createdAt: NUMBER_SCHEMA,
      }, ['sessionId', 'sessionTitle', 'messageId', 'role', 'snippet', 'createdAt'])),
      total: NUMBER_SCHEMA,
      hasMore: BOOLEAN_SCHEMA,
      nextCursor: STRING_SCHEMA,
    }, ['query', 'items', 'total', 'hasMore']),
  }),
  methodDescriptor({
    id: 'companion.chat.messages.retry',
    effect: 'outward',
    title: 'Regenerate Companion Chat Response',
    description: 'Regenerate an assistant response. Omitted `messageId`: the latest answered user message is answered again; whatever followed it in its exchange (its reply, a failed reply, or nothing) is SUPERSEDED, while a reply to an earlier message that was stored after it stays active, so retrying a failed regenerate repeats the same exchange. With `messageId` (an active assistant message): that response and every message after it are superseded, and the turn re-runs from the user message it answered. Superseded messages are kept in the message list and on disk, flagged as retained history, never deleted. Returns the superseded message ids so the caller can render the honest lineage. Rejected on a closed session (409 SESSION_CLOSED) or unknown session (404 SESSION_NOT_FOUND); a `messageId` that is unknown is 404 MESSAGE_NOT_FOUND, already superseded 409 MESSAGE_SUPERSEDED, not an assistant message 400 NOT_AN_ASSISTANT_MESSAGE; with no user message to answer again it is 409 NO_ANCHOR_MESSAGE. While a reply is streaming, a message is being prepared, or sends are queued it is refused with 409 CHAT_TURN_BUSY and nothing changes: stop the reply (or let it and the queue finish), then retry.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages/retry' },
    inputSchema: bodyEnvelopeSchema({
      sessionId: STRING_SCHEMA,
      messageId: STRING_SCHEMA,
    }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      regeneratedFrom: STRING_SCHEMA,
      supersededMessageIds: arraySchema(STRING_SCHEMA),
      turnStarted: BOOLEAN_SCHEMA,
    }, ['sessionId', 'regeneratedFrom', 'supersededMessageIds', 'turnStarted']),
  }),
  methodDescriptor({
    id: 'companion.chat.messages.edit',
    effect: 'outward',
    title: 'Edit Companion Chat Message And Branch',
    description: 'Edit a user message and branch the conversation from it. `messageId` (required) is the user message to edit; the edited text is passed as `body` or `content` (as message create accepts), with optional `attachments` referencing artifacts. The original message and everything after it are SUPERSEDED, retained as history, never deleted, a new user message carrying `revisionOf` back to the original is appended, and a fresh turn answers it. Returns the new message id and the superseded ids for honest lineage. Same closed/unknown-session refusals as companion.chat.messages.retry, and the same 409 CHAT_TURN_BUSY while a reply, a message being prepared, or queued sends are in flight (nothing is superseded).',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages/edit' },
    // `messageId` is refused unconditionally (`messageId is required`), and the
    // edited text follows the same body/content/attachments rule as a create.
    inputSchema: companionChatMessageInputSchema(
      { sessionId: STRING_SCHEMA, messageId: STRING_SCHEMA },
      ['sessionId', 'messageId'],
    ),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      editedFrom: STRING_SCHEMA,
      messageId: STRING_SCHEMA,
      supersededMessageIds: arraySchema(STRING_SCHEMA),
      turnStarted: BOOLEAN_SCHEMA,
    }, ['sessionId', 'editedFrom', 'messageId', 'supersededMessageIds', 'turnStarted']),
  }),
  methodDescriptor({
    id: 'companion.chat.messages.steer',
    effect: 'outward',
    title: 'Steer Companion Chat (Interrupt And Send)',
    description: 'Send a message that runs IMMEDIATELY, interrupting the in-flight turn if one is running. The message jumps to the front of the pending-turn queue; the active turn is cancelled through the same finalization path as companion.chat.turns.cancel (any non-empty partial reply is persisted with `deliveryState: "cancelled"` and the terminal `turn.cancelled` event reaches every subscriber), then the steered message\'s turn starts. Messages queued behind an active turn keep their places behind the steer. With no turn running this behaves as an ordinary send. Accepts the same payload as companion.chat.messages.create (`body`/`content`, `attachments`, `metadata`). Returns the new message id, `steered: true`, and `cancelledTurnId` when a turn was interrupted. Ordinary sends posted while a turn is running are QUEUED (transcript-visible immediately with `deliveryState: "queued"`, answered in order), steer is the explicit jump-the-line verb. A queued message whose turn can never run (the chat closed, the service shut down or the daemon restarted first) ends as `deliveryState: "unanswered"`, never silently dropped.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages/steer' },
    inputSchema: companionChatMessageInputSchema({ sessionId: STRING_SCHEMA, clientMessageId: CLIENT_MESSAGE_ID_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      messageId: STRING_SCHEMA,
      steered: BOOLEAN_SCHEMA,
      cancelledTurnId: STRING_SCHEMA,
      turnStarted: BOOLEAN_SCHEMA,
    }, ['sessionId', 'messageId', 'steered', 'turnStarted']),
  }),
  methodDescriptor({
    id: 'companion.chat.turns.cancel',
    title: 'Cancel Companion Chat Turn',
    description: 'Stop the in-flight turn for a companion chat session, a true server-side stop: the provider stream is aborted, any non-empty partial reply is persisted to the transcript with an explicit `deliveryState: "cancelled"` marker (an honest partial, never disguised as a complete reply) AND committed to the model-facing conversation history with an explicit interruption note, later turns can reason about what the user saw and stopped, which is usually what a follow-up or steer refers to, and the terminal `turn.cancelled` event is published to every subscriber of the session stream so a stop from one client converges on all others. Any announced tool call without a result is closed with a synthetic error `turn.tool_result` before the terminal event. Optional `turnId` guards against cancelling a newer turn a stale stop raced against (409 TURN_MISMATCH). No turn in flight is the benign 404 NO_ACTIVE_TURN (the turn finished before the stop landed). When the turn has not stopped within 3 seconds (a tool call or the provider has not ended yet) the stop is still accepted and the answer is 409 TURN_STOPPING with `state: "stopping"`: treat the turn as stopping, not failed; the terminal `turn.cancelled` event follows when it stops. Repeat cancels are idempotent successes. The session stays open; the next message starts a fresh turn normally.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/turns/cancel' },
    inputSchema: bodyEnvelopeSchema({
      sessionId: STRING_SCHEMA,
      turnId: STRING_SCHEMA,
    }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      turnId: STRING_SCHEMA,
      cancelled: BOOLEAN_SCHEMA,
      alreadyCancelled: BOOLEAN_SCHEMA,
      partialPersisted: BOOLEAN_SCHEMA,
    }, ['sessionId', 'turnId', 'cancelled', 'partialPersisted']),
  }),
  methodDescriptor({
    id: 'companion.chat.queuedMessages.list',
    title: 'List Queued Companion Chat Messages',
    description: 'The messages of a companion chat waiting behind the running reply (sent while it was still being written), in the order they will be answered. Each stays editable and removable until its turn starts; a message whose turn has started no longer appears. An unknown chat is 404 SESSION_NOT_FOUND.',
    category: 'companion',
    scopes: ['read:transcripts'],
    http: { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/queued-messages' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      messages: arraySchema(objectSchema({
        id: STRING_SCHEMA,
        queuedAt: NUMBER_SCHEMA,
        text: STRING_SCHEMA,
      }, ['id', 'queuedAt', 'text'])),
    }, ['sessionId', 'messages']),
  }),
  methodDescriptor({
    id: 'companion.chat.queuedMessages.edit',
    title: 'Edit a Queued Companion Chat Message',
    description: 'Replace the text of a companion chat message still waiting for its turn; its attachments stay. The transcript shows the new text. A message whose turn has started (or that was removed) is 404 MESSAGE_NOT_QUEUED.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/queued-messages/{messageId}' },
    inputSchema: bodyEnvelopeSchema({
      sessionId: STRING_SCHEMA,
      messageId: STRING_SCHEMA,
      text: STRING_SCHEMA,
    }, ['sessionId', 'messageId', 'text']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      id: STRING_SCHEMA,
      text: STRING_SCHEMA,
    }, ['sessionId', 'id', 'text']),
  }),
  methodDescriptor({
    id: 'companion.chat.queuedMessages.delete',
    title: 'Remove a Queued Companion Chat Message',
    description: 'Take a companion chat message out of the queue before its turn starts, so it is never answered. The transcript keeps it, marked `deliveryState: "unanswered"`, and leaves it out of what the model sees. A message whose turn has started (or that was already removed) is 404 MESSAGE_NOT_QUEUED.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'DELETE', path: '/api/companion/chat/sessions/{sessionId}/queued-messages/{messageId}' },
    inputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      messageId: STRING_SCHEMA,
    }, ['sessionId', 'messageId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      id: STRING_SCHEMA,
      deleted: BOOLEAN_SCHEMA,
    }, ['sessionId', 'id', 'deleted']),
  }),
  methodDescriptor({
    id: 'companion.chat.events.stream',
    title: 'Stream Companion Chat Events',
    description: 'Server-Sent Events stream of turn and agent events scoped to a single companion-chat session.',
    category: 'companion',
    scopes: ['read:transcripts'],
    transport: ['http'],
    http: { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/events' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: EMPTY_OBJECT_SCHEMA,
    invokable: false,
    metadata: { responseKind: 'sse', stream: true, wireEventPrefix: 'companion-chat.' },
  }),
];
