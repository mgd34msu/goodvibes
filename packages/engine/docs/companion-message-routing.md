# Companion message routing

This document describes how a companion main-chat message, and a message on
the ntfy chat topic, reach the conversation a terminal program is running and
how their answers come back.

## Background

A companion process may put a message into the operator's live session
without spawning agent work or starting a contract. This is called a companion main-chat
message. The platform routes these through `POST /api/sessions/:sessionId/messages`
with `kind: 'message'` in the request body. If `kind` is omitted, the platform
uses the same conversation route. Callers that want agent/task behavior must
send `kind: 'task'` explicitly.

The message is queued in the session's inputs as a follow-up
(`sessionBroker.followUpMessage`). A terminal program (the terminal app or the
Agent) running that session collects it from `sessions.inputs.list`, claims it,
runs it as its next turn in the same path as typed input (with the message's
origin, so it is not taken for the owner typing at that terminal), and reports
it done with `sessions.inputs.deliver`. Like terminal input, that turn is read
once by the contract intake, which starts a contract only when Jev reads the
text as work (see [Runtime orchestration](./runtime-orchestration.md#turn-loop)).
With no terminal on the session, the daemon starts an agent for it, as for any
follow-up.

## API

```http
POST /api/sessions/:sessionId/messages
Content-Type: application/json

{ "body": "Hello from companion", "kind": "message" }
```

Response (`202 Accepted`):

```json
{ "messageId": "<your id, when you sent one>", "sessionId": "<sessionId>", "inputId": "<input id>", "mode": "queued-for-surface" }
```

`inputId` is the session input that holds the message; `mode` is what became
of it: `queued-for-surface` when a terminal running the session collects it,
`queued-follow-up` or `continued-live` when it waits behind a running turn.
With no terminal on the session the daemon starts an agent for it and answers
as the follow-up route does (`session`, `message`, `input`, `mode`, `agentId`);
a session that refused it answers `409` with the same fields.

To make a retry safe, send your own `messageId` (1 to 128 characters of letters,
digits, `.`, `_`, `:` or `-`; anything else is a `400 INVALID_MESSAGE_ID`). A
message already recorded under that id is answered with its first submission
and does not add a second turn.

- The terminal running the session answers it as a normal turn.
- The `kind` field defaults to `'message'` when omitted.
- `kind: 'task'` explicitly routes through the session broker and can spawn an
  agent continuation or start a contract.

- `kind: 'followup'` queues a follow-up the same way `POST /api/sessions/:id/follow-up`
  does (see below) and answers with that route's shape, not `{ messageId, routedTo }`:
  `202` with `session`, `message`, `input`, `mode` and `agentId`, or `409` with the
  same fields when the broker rejects the input. Any other `kind` is a
  `400 INVALID_KIND`.

To steer an already-running session instead of starting a new task, use the
dedicated steer route, `POST /api/sessions/:id/steer`.

## ntfy chat replies

A message on the ntfy chat topic (`surfaces.ntfy.chatTopic`) takes the same
path: it is queued as a follow-up in the terminal's session, on the topic's
route binding. The terminal that runs it binds the input to its turn while the
turn runs and reports the answer with it (`sessions.inputs.deliver` with
`consumed`, `agentId` and `answer`); the daemon writes the answer into the
shared session and sends it back to the topic through the route's reply
pipeline. A turn that fails or is cancelled sends a short notice saying so
instead of nothing.

The ntfy provider runtime subscribes to route topics as live ingress. It starts
from the current Unix timestamp rather than `since=latest`, because ntfy uses
`since=latest` to return a cached message. Reconnects resume from the last
successfully handled ntfy message id and suppress duplicate ids.

## Envelope consistency

The `ConversationMessageEnvelope` shape is shared between chat-mode events (`turn.started`,
`turn.completed`) and session-message follow-up events. Chat-mode events use:
- `source: 'companion-chat-user'` for user messages
- `source: 'companion-chat-assistant'` for assistant replies

A companion main-chat message carries `source: 'companion-followup'` on its
session input, and a channel message its surface (`ntfy`); the terminal passes
it as the turn's origin.

## Related session routes

Other session routes cover adjacent use cases. Use the one that matches your intent:

| Route | Purpose | Triggers agent turn? |
|---|---|---|
| `POST /api/sessions/:id/messages` | Put a companion main-chat message into the session's conversation | Yes: the terminal running the session answers it, or the daemon when none does |
| `GET  /api/sessions/:id/inputs` | List pending inputs awaiting a response on the active turn | No |
| `POST /api/sessions/:id/steer` | Steer the active turn with new guidance | Yes |
| `POST /api/sessions/:id/follow-up` | Queue a follow-up for delivery after the current agent completes; on an idle session an agent is started for it immediately (`mode: "spawn"`). A rejected input answers `409` | Yes, on delivery |
| `POST /api/sessions/:id/inputs/:inputId/cancel` | Cancel a specific pending input on the active turn | Depends on the input |
| `GET  /api/sessions/:id/messages` | Fetch the full conversation history for the session | n/a |
| `PATCH /api/companion/chat/sessions/:id` | Update a true remote companion-chat session's own provider/model metadata | No immediate turn; affects subsequent remote-session turns |

Callers should route structured intents through the dedicated routes:
`POST /api/sessions/:id/steer` to steer the active turn,
`POST /api/sessions/:id/inputs/:inputId/cancel` to cancel a pending input, and
`POST /api/sessions/:id/follow-up` to queue a follow-up, instead of building
ad-hoc bodies for `/messages`. The follow-up route takes no `kind` field, it is
already the dedicated route:

```http
POST /api/sessions/:id/follow-up
Content-Type: application/json

{ "body": "Continue with option B" }
```

Response (`202 Accepted`):

```json
{
  "session": { "id": "<sessionId>", "...": "shared session record, or null" },
  "message": "<the appended user message, or null>",
  "input": { "...": "the normalized session input record" },
  "mode": "queued-follow-up",
  "agentId": "<active agent id, or null>"
}
```

All companion-chat routes are registered in the live method catalog. Fetch the catalog at `GET /api/control-plane/methods` to confirm the current registration for your daemon build.

| Route | Purpose |
|-------|---------|
| `POST /api/companion/chat/sessions` | Create a new remote companion-chat session |
| `GET /api/companion/chat/sessions` | List companion-chat sessions |
| `PATCH /api/companion/chat/sessions/:id` | Update session provider/model metadata |
| `POST /api/companion/chat/sessions/:id/messages` | Send a message to the companion-chat session |
| `GET /api/companion/chat/sessions/:id/messages` | Fetch the message history for the session; `?limit=` (1-1000) and `?before=<messageId>` return one page with `total`, `more` and `nextBefore` |
| `GET /api/companion/chat/sessions/:id` | Fetch one companion-chat session |
| `POST /api/companion/chat/sessions/:id/close` | Soft-close a session; its record and messages are kept |
| `POST /api/companion/chat/sessions/:id/reopen` | Open a closed session again; the next message continues it with its history |
| `DELETE /api/companion/chat/sessions/:id` | Permanently remove a session (it must be closed first) |
| `POST /api/companion/chat/sessions/:id/messages/retry` | Answer the latest message again (or the one before a given reply); whatever followed it is kept as superseded history, so pressing it again after a failed attempt retries the same exchange |
| `POST /api/companion/chat/sessions/:id/messages/edit` | Edit a user message and branch the conversation from it |
| `POST /api/companion/chat/sessions/:id/messages/steer` | Send a message that interrupts the in-flight turn and runs immediately |
| `POST /api/companion/chat/sessions/:id/turns/cancel` | Stop the in-flight turn; any partial reply is kept marked as cancelled |
| `GET /api/companion/chat/sessions/:id/events` | Stream the session's turn events |

A chat is never closed for being idle: the daemon drops an unused chat's history from memory and rebuilds it from the saved transcript on the next message. A reply that fails, or that the daemon stopped while writing, is saved as an assistant message with `deliveryState: "failed"`, its partial text and a `failureReason`. A change whose save fails is refused with `503 CHAT_SAVE_FAILED` (and `Retry-After`); only that request is refused, and the next one is accepted as usual.

### Companion chat rate limit

A companion chat holds a bounded number of messages waiting to be answered (queued
or running); one more is refused with 429 `COMPANION_CHAT_SESSION_RATE_LIMIT` until
one of them is answered. There is no clock: a person who waits for each answer is
never refused. The bound comes from `runtime.companionChatLimiter.perSessionLimit`
when that key is set to a positive integer. Otherwise the daemon reads the
`GOODVIBES_CHAT_LIMITER_THRESHOLD` environment variable once at startup, and
falls back to its built-in default of 10 when neither is set. One client holds at
most 30 messages waiting across its chats (`COMPANION_CHAT_CLIENT_RATE_LIMIT`).

## Next reads

- [Runtime orchestration](./runtime-orchestration.md): session `kind` routing, the session broker, the contract intake, and how agent continuations and contracts start.
- [Companion app patterns](./companion-app-patterns.md): HTTP bootstrap, realtime subscribe, and snapshot-refresh-on-resume for companion surfaces.
