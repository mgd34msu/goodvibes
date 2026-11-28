# Agent API index

Generated from the operator contract (product 3.6.7) by `bun run agent-spec:generate`. Spec: [agent-api.openapi.json](./agent-api.openapi.json). Everything not listed here is in the full document, `contracts/artifacts/operator-openapi.json`.

Auth: `Authorization: Bearer <token>` or the login session cookie. Errors are `{ error, state?, next?, hint?, code?, category?, requestId?, retryAfterMs? }`; a 403 for a missing scope also lists `requiredScopes`, `grantedScopes` and `missingScopes`.

## sessions

| Method id | Route | Scopes | Replay key | Does |
| --- | --- | --- | --- | --- |
| `sessions.changes.get` | invoke / WebSocket only | read:checkpoints |  | Return the aggregate workspace file changes a session made, joined over its sessionId-stamped checkpoints: th… |
| `sessions.checkpoints.changed` | invoke / WebSocket only | write:sessions |  | A terminal program that runs its own session (the terminal app, the Agent) tells the daemon it made, pruned o… |
| `sessions.close` | `POST /api/sessions/{sessionId}/close` | write:sessions |  | Mark a shared session as closed. |
| `sessions.contextUsage.get` | `GET /api/sessions/{sessionId}/context-usage` | read:sessions |  | Return the live context-window usage for a session: estimatedContextTokens (the runtime's current estimate, n… |
| `sessions.create` | `POST /api/sessions` | write:sessions |  | Create a shared session for a surface, route, or web client. |
| `sessions.delete` | `DELETE /api/sessions/{sessionId}` | write:sessions |  | Permanently remove a shared session record and its queued inputs/messages from the home-scoped store. |
| `sessions.detach` | `POST /api/sessions/{sessionId}/detach` | write:sessions |  | Remove a surface's participant and its route binding from a session so that surface stops receiving updates, … |
| `sessions.followUp` | `POST /api/sessions/{sessionId}/follow-up` | write:sessions | body `messageId` | Queue a deferred follow-up for a shared session so it runs after the current agent completes, or spawn immedi… |
| `sessions.get` | `GET /api/sessions/{sessionId}` | read:transcripts |  | Return a shared session record with its newest 100 messages. |
| `sessions.hosted.attach` | invoke / WebSocket only | write:sessions, read:transcripts |  | Join a hosted session and receive its transcript so far, so a client that was never connected, or one reconne… |
| `sessions.hosted.create` | invoke / WebSocket only | write:sessions | header `Idempotency-Key` | Compose a full conversation loop INSIDE the daemon for a workspace: the same orchestrator, tool registry and … |
| `sessions.hosted.detach` | invoke / WebSocket only | write:sessions |  | Leave a hosted session. |
| `sessions.hosted.history` | invoke / WebSocket only | read:transcripts |  | Return a hosted session's record and its transcript, live or ended, without attaching. |
| `sessions.hosted.kill` | invoke / WebSocket only | write:sessions |  | End a hosted session regardless of who is attached or what its detach policy says: the in-flight turn is inte… |
| `sessions.hosted.list` | invoke / WebSocket only | read:transcripts |  | Every session this daemon hosts, most recently updated first. |
| `sessions.hosted.share` | invoke / WebSocket only | write:sessions |  | Add a principal (a user name, or `pairing:<id>` for a paired device) to a hosted session's owners, so it may … |
| `sessions.hosted.unshare` | invoke / WebSocket only | write:sessions |  | Remove a principal from a hosted session's owners: it can no longer attach, read the transcript or watch the … |
| `sessions.hosted.workspaces` | invoke / WebSocket only | read:sessions |  | The folders sessions.hosted.create accepts as workspaceRoot: the daemon's working directory and every registe… |
| `sessions.inputs.cancel` | `POST /api/sessions/{sessionId}/inputs/{inputId}/cancel` | write:sessions |  | Cancel a queued shared-session input before it is delivered or spawned. |
| `sessions.inputs.deliver` | `POST /api/sessions/{sessionId}/inputs/{inputId}/deliver` | write:sessions |  | A live registered surface reports that it collected a queued input (moves it to `delivered`) or finished acti… |
| `sessions.inputs.list` | `GET /api/sessions/{sessionId}/inputs` | read:transcripts |  | Return explicit session inputs, including queued follow-ups and delivered steering requests. |
| `sessions.integration.snapshot` | `GET /api/session` | read:transcripts |  | Return the session integration snapshot. |
| `sessions.list` | `GET /api/sessions` | read:transcripts |  | Return shared-session integration state. |
| `sessions.messages.create` | `POST /api/sessions/{sessionId}/messages` | write:sessions | body `messageId` | Append a user message to a shared session. |
| `sessions.messages.list` | `GET /api/sessions/{sessionId}/messages` | read:transcripts |  | Return a page of retained session messages. |
| `sessions.permissionMode.get` | `GET /api/sessions/{sessionId}/permission-mode` | read:sessions |  | Return the session execution mode in force (`mode`): ask-me, jev-decides, just-vibes, yolo, or the read-only … |
| `sessions.permissionMode.set` | `POST /api/sessions/{sessionId}/permission-mode` | write:sessions | header `Idempotency-Key` | Set ask-me, jev-decides, just-vibes, or yolo execution, or enter the read-only plan posture. |
| `sessions.queuedMessages.delete` | `DELETE /api/sessions/{sessionId}/queued-messages/{messageId}` | write:sessions |  | Remove a message still waiting in the mid-turn queue so it is never delivered. |
| `sessions.queuedMessages.edit` | `POST /api/sessions/{sessionId}/queued-messages/{messageId}` | write:sessions |  | Replace the text of a message still waiting in the mid-turn queue. |
| `sessions.queuedMessages.list` | `GET /api/sessions/{sessionId}/queued-messages` | read:transcripts |  | List the messages queued behind the current turn (submitted while the model was thinking), in delivery order. |
| `sessions.register` | `POST /api/sessions/register` | write:sessions | body `sessionId` | Idempotently register (or heartbeat) a session keyed on a caller-supplied id, carrying its kind, project, and… |
| `sessions.reopen` | `POST /api/sessions/{sessionId}/reopen` | write:sessions |  | Reopen a previously closed shared session. |
| `sessions.search` | invoke / WebSocket only | read:transcripts |  | Paginated, filtered query over shared sessions: free-text query (matches id/title), project, kind, surfaceKin… |
| `sessions.steer` | `POST /api/sessions/{sessionId}/steer` | write:sessions | body `messageId` | Deliver a live steering message to the active agent for a shared session, optionally falling back to spawn wh… |
| `sessions.toolCalls.cancel` | `POST /api/sessions/{sessionId}/tool-calls/{callId}/cancel` | write:sessions |  | Cancel a single running tool call by its callId, leaving the turn and any other running calls untouched. |
| `sessions.turns.cancel` | `POST /api/sessions/{sessionId}/turns/cancel` | write:sessions |  | Atomically compare expectedTurnId and request cancellation of that live turn, preserving the session and futu… |

## tasks

| Method id | Route | Scopes | Replay key | Does |
| --- | --- | --- | --- | --- |
| `tasks.cancel` | `POST /api/tasks/{taskId}/cancel` | write:tasks |  | Cancel an in-flight runtime task. |
| `tasks.create` | `POST /task` | write:tasks | header `Idempotency-Key` | Start an agent on `task`. |
| `tasks.get` | `GET /api/tasks/{taskId}` | read:transcripts |  | Return a single runtime task record, as `{ task }`. |
| `tasks.list` | `GET /api/tasks` | read:tasks |  | Return the integration snapshot for runtime tasks. |
| `tasks.retry` | `POST /api/tasks/{taskId}/retry` | write:tasks | header `Idempotency-Key` | Retry a failed or cancelled agent task: a new agent runs the same task on the model, provider, tools, routing… |
| `tasks.status` | `GET /task/{agentId}` | read:transcripts |  | Return lightweight runtime task status by agent id. |

## contracts

| Method id | Route | Scopes | Replay key | Does |
| --- | --- | --- | --- | --- |
| `contracts.budget` | invoke / WebSocket only | write:fleet |  | Replace a running contract's token and cost ceiling (`maxCostUsd`, `maxTokens`, or both); a limit left out ke… |
| `contracts.cancel` | `POST /api/contracts/{contractId}/cancel` | write:fleet |  | Stop a contract and every unit agent it runs; its status line records how many files were already changed and… |
| `contracts.dispatch` | invoke / WebSocket only | write:fleet | body `idempotencyKey` | Start a contract for `ask` (the person's words verbatim) in a hosted session created for it, in `workspaceRoo… |
| `contracts.get` | `GET /api/contracts/{contractId}` | read:fleet |  | One contract with its whole tree, running or ended. |
| `contracts.list` | `GET /api/contracts` | read:fleet |  | Every contract this daemon holds, newest first, each with its whole tree: the ask, the goal, the acceptance c… |
| `contracts.remove` | invoke / WebSocket only | write:fleet |  | Delete the record of a contract that has ended (passed, failed or cancelled): its checkpoint and summary. |
| `contracts.reply` | `POST /api/contracts/{contractId}/reply` | write:fleet | header `Idempotency-Key` | The owner's free-text reply to an open escalation of a contract, read by Jev as approve, reject, amend or unc… |
| `contracts.retryUnit` | invoke / WebSocket only | write:fleet | header `Idempotency-Key` | Run one unit of a running contract again: a unit that is working gets a fresh agent with its brief and previo… |
| `contracts.start` | `POST /api/contracts` | write:fleet | header `Idempotency-Key` | Start a contract for `ask`, the person's words verbatim, which every stated acceptance criterion must trace t… |
| `contracts.status` | invoke / WebSocket only | read:fleet |  | One contract's summary (as `contracts.summaries` gives it), for polling. |
| `contracts.summaries` | invoke / WebSocket only | read:fleet |  | The contracts `contracts.list` returns (same `sessionId` and `includeTerminal`), newest first, each as a smal… |

## approvals

| Method id | Route | Scopes | Replay key | Does |
| --- | --- | --- | --- | --- |
| `approvals.approve` | `POST /api/approvals/{approvalId}/approve` | write:approvals |  | Approve a pending approval. |
| `approvals.cancel` | `POST /api/approvals/{approvalId}/cancel` | write:approvals | body `holdId` | Cancel a pending approval; send `expectedRevision`, the `revision` you read. |
| `approvals.claim` | `POST /api/approvals/{approvalId}/claim` | write:approvals |  | Claim a pending approval for operator handling. |
| `approvals.deny` | `POST /api/approvals/{approvalId}/deny` | write:approvals |  | Deny a pending approval. |
| `approvals.list` | `GET /api/approvals` | read:approvals |  | Return pending and historical approval records, newest 50. |
| `approvals.raise` | invoke / WebSocket only | write:approvals | header `Idempotency-Key` | Raise a permission ask INTO the shared broker from a surface that is not in the daemon's process, the write c… |
| `inbox.answer` | invoke / WebSocket only | write:approvals |  | Answer one open inbox item with one of its `options`, or with `text` when it has none (text may also accompan… |
| `inbox.delivery` | invoke / WebSocket only | write:approvals |  | The asking session reports what became of the answer to a question it posted: `delivered` once the answer is … |
| `inbox.list` | invoke / WebSocket only | read:approvals |  | Everything waiting on the owner in one list, newest first: permission asks (kind approval), questions agents … |
| `inbox.post` | invoke / WebSocket only | write:approvals | body `key` | Leave the owner a question or a queued action from a process that is not the daemon (an agent in a terminal a… |
| `inbox.withdraw` | invoke / WebSocket only | write:approvals |  | Take back an open item this caller posted, because the answer is no longer needed. |

## events

Stream: `GET /api/control-plane/events?domains=<comma list>` (`text/event-stream`), catalog at `GET /api/control-plane/events/catalog`. Methods: `control.events.catalog`, `control.events.stream`.

| Event id | Domains |
| --- | --- |
| `runtime.agents` | agents |
| `runtime.automation` | automation |
| `runtime.communication` | communication |
| `runtime.compaction` | compaction |
| `runtime.config` | config |
| `runtime.contracts` | contracts |
| `runtime.control-plane` | control-plane |
| `runtime.deliveries` | deliveries |
| `runtime.fleet` | fleet |
| `runtime.forensics` | forensics |
| `runtime.gate` | gate |
| `runtime.knowledge` | knowledge |
| `runtime.mcp` | mcp |
| `runtime.ops` | ops |
| `runtime.planner` | planner |
| `runtime.plugins` | plugins |
| `runtime.providers` | providers |
| `runtime.routes` | routes |
| `runtime.security` | security |
| `runtime.session` | session |
| `runtime.surfaces` | surfaces |
| `runtime.tasks` | tasks |
| `runtime.tools` | tools |
| `runtime.transport` | transport |
| `runtime.turn` | turn |
| `runtime.ui` | ui |
| `runtime.watchers` | watchers |
| `runtime.workspace` | workspace |
| `control.own_session_activity` | control |
| `control.approval_update` | gate |
| `control.heartbeat` | control |
| `control.hosted_session_update` | session |
| `control.owner_inbox_update` | gate |
| `control.ready` | control |
| `control.remote_update` | control |
| `control.session_update` | session |
| `control.surface_message` | control |

## Replay

These methods recognise a retry of the same request by a request header or a body field, and return the first result instead of acting twice:

- `approvals.cancel`: body `holdId`. A surface releasing an ask it raised (`release: true`) passes the `holdId` approvals.raise returned: a repeat of that release gives up nothing more, even when another surface holds the same ask. A plain cancel of an ended approval is answered `applied: false`.
- `approvals.raise`: header `Idempotency-Key`. Send a key (1 to 255 characters of letters, digits, ".", "_", ":" or "-") chosen once per logical request, and the same key on every retry: a repeat of the same request (for a multipart or raw upload: the same fields and file content, whatever the encoding) under the same key by the same credential, within a day and across a daemon restart, returns the first answer (with the Idempotent-Replayed: true header) instead of acting again. The same key with a different request is 409 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_KEY_IN_FLIGHT (send it again with the same key after the Retry-After header's seconds, also in the body as retryAfterMs; the SDK does this within its retries); a repeat after the daemon stopped in the middle of the first is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, and a repeat of a first request that failed partway is 500 IDEMPOTENCY_OUTCOME_UNKNOWN (either way: check the state, do not send again). A refusal (4xx) is not remembered, so the same key may be sent again. Over the method-invoke envelope or a WebSocket call frame the key may be sent as `idempotencyKey` beside `body`.
- `inbox.post`: body `key`. A post by the same caller under a `key` that already has an open item it posted returns that item instead of posting a second one, so a repeat asks the owner once.
- `contracts.dispatch`: body `idempotencyKey`. A repeat by the same caller with the same `idempotencyKey`, `ask` and workspace returns the first dispatch's contract instead of starting a second one, and creates no second session; the same key with a different ask or workspace is refused with IDEMPOTENCY_KEY_REUSED. Keys are kept with the workspace's contract store per caller, as for contracts.start, so a retry after a daemon restart, or through another process on the same project, still returns the first contract. A dispatch whose key cannot be recorded is refused with CONTRACT_KEY_UNRECORDED and starts nothing; a repeat while another process is still starting the first is refused with IDEMPOTENCY_KEY_IN_FLIGHT.
- `contracts.reply`: header `Idempotency-Key`. Send a key (1 to 255 characters of letters, digits, ".", "_", ":" or "-") chosen once per logical request, and the same key on every retry: a repeat of the same request (for a multipart or raw upload: the same fields and file content, whatever the encoding) under the same key by the same credential, within a day and across a daemon restart, returns the first answer (with the Idempotent-Replayed: true header) instead of acting again. The same key with a different request is 409 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_KEY_IN_FLIGHT (send it again with the same key after the Retry-After header's seconds, also in the body as retryAfterMs; the SDK does this within its retries); a repeat after the daemon stopped in the middle of the first is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, and a repeat of a first request that failed partway is 500 IDEMPOTENCY_OUTCOME_UNKNOWN (either way: check the state, do not send again). A refusal (4xx) is not remembered, so the same key may be sent again. Over the method-invoke envelope or a WebSocket call frame the key may be sent as `idempotencyKey` beside `body`.
- `contracts.retryUnit`: header `Idempotency-Key`. Send a key (1 to 255 characters of letters, digits, ".", "_", ":" or "-") chosen once per logical request, and the same key on every retry: a repeat of the same request (for a multipart or raw upload: the same fields and file content, whatever the encoding) under the same key by the same credential, within a day and across a daemon restart, returns the first answer (with the Idempotent-Replayed: true header) instead of acting again. The same key with a different request is 409 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_KEY_IN_FLIGHT (send it again with the same key after the Retry-After header's seconds, also in the body as retryAfterMs; the SDK does this within its retries); a repeat after the daemon stopped in the middle of the first is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, and a repeat of a first request that failed partway is 500 IDEMPOTENCY_OUTCOME_UNKNOWN (either way: check the state, do not send again). A refusal (4xx) is not remembered, so the same key may be sent again. Over the method-invoke envelope or a WebSocket call frame the key may be sent as `idempotencyKey` beside `body`.
- `contracts.start`: header `Idempotency-Key`. A retry with the same key and the same body returns the first contract (with the Idempotent-Replayed: true response header) instead of starting a second one; the same key with a different body is refused with IDEMPOTENCY_KEY_REUSED. Keys are kept with the contract store per caller, so a retry after a daemon restart, or through another process on the same project, still returns the first contract; the body is compared field by field, in any order. A start whose key cannot be recorded is refused with CONTRACT_KEY_UNRECORDED and starts nothing; a repeat while another process is still starting the first is refused with IDEMPOTENCY_KEY_IN_FLIGHT (send it again in a few seconds). The key may also be sent as `idempotencyKey` in the body; the header wins when both are given. A replayed result carries `replayed: true`.
- `sessions.followUp`: body `messageId`. Sending the same messageId again to the same session (1 to 255 letters, digits, ".", "_", ":" or "-", chosen by the caller) returns the input already recorded (the same input id, with its current state, and mode continued-live; the reply carries no duplicate flag) instead of recording a second one; an input that failed is run again in that session. The id is scoped to the session and surface: the same id sent to another session is a new message there. Use it to resend after a lost response.
- `sessions.hosted.create`: header `Idempotency-Key`. Send a key (1 to 255 characters of letters, digits, ".", "_", ":" or "-") chosen once per logical request, and the same key on every retry: a repeat of the same request (for a multipart or raw upload: the same fields and file content, whatever the encoding) under the same key by the same credential, within a day and across a daemon restart, returns the first answer (with the Idempotent-Replayed: true header) instead of acting again. The same key with a different request is 409 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_KEY_IN_FLIGHT (send it again with the same key after the Retry-After header's seconds, also in the body as retryAfterMs; the SDK does this within its retries); a repeat after the daemon stopped in the middle of the first is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, and a repeat of a first request that failed partway is 500 IDEMPOTENCY_OUTCOME_UNKNOWN (either way: check the state, do not send again). A refusal (4xx) is not remembered, so the same key may be sent again. Over the method-invoke envelope or a WebSocket call frame the key may be sent as `idempotencyKey` beside `body`.
- `sessions.messages.create`: body `messageId`. Sending the same messageId again to the same session (1 to 255 letters, digits, ".", "_", ":" or "-", chosen by the caller) returns the input already recorded (the same input id, with its current state, and mode continued-live; the reply carries no duplicate flag) instead of recording a second one; an input that failed is run again in that session. The id is scoped to the session and surface: the same id sent to another session is a new message there. Use it to resend after a lost response.
- `sessions.permissionMode.set`: header `Idempotency-Key`. Send a key (1 to 255 characters of letters, digits, ".", "_", ":" or "-") chosen once per logical request, and the same key on every retry: a repeat of the same request (for a multipart or raw upload: the same fields and file content, whatever the encoding) under the same key by the same credential, within a day and across a daemon restart, returns the first answer (with the Idempotent-Replayed: true header) instead of acting again. The same key with a different request is 409 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_KEY_IN_FLIGHT (send it again with the same key after the Retry-After header's seconds, also in the body as retryAfterMs; the SDK does this within its retries); a repeat after the daemon stopped in the middle of the first is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, and a repeat of a first request that failed partway is 500 IDEMPOTENCY_OUTCOME_UNKNOWN (either way: check the state, do not send again). A refusal (4xx) is not remembered, so the same key may be sent again. Over the method-invoke envelope or a WebSocket call frame the key may be sent as `idempotencyKey` beside `body`.
- `sessions.register`: body `sessionId`. Registering the same sessionId again is a heartbeat, not a second session; it returns the existing record.
- `sessions.steer`: body `messageId`. Sending the same messageId again to the same session (1 to 255 letters, digits, ".", "_", ":" or "-", chosen by the caller) returns the input already recorded (the same input id, with its current state, and mode continued-live; the reply carries no duplicate flag) instead of recording a second one; an input that failed is run again in that session. The id is scoped to the session and surface: the same id sent to another session is a new message there. Use it to resend after a lost response.
- `tasks.create`: header `Idempotency-Key`. Send a key (1 to 255 characters of letters, digits, ".", "_", ":" or "-") chosen once per logical request, and the same key on every retry: a repeat of the same request (for a multipart or raw upload: the same fields and file content, whatever the encoding) under the same key by the same credential, within a day and across a daemon restart, returns the first answer (with the Idempotent-Replayed: true header) instead of acting again. The same key with a different request is 409 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_KEY_IN_FLIGHT (send it again with the same key after the Retry-After header's seconds, also in the body as retryAfterMs; the SDK does this within its retries); a repeat after the daemon stopped in the middle of the first is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, and a repeat of a first request that failed partway is 500 IDEMPOTENCY_OUTCOME_UNKNOWN (either way: check the state, do not send again). A refusal (4xx) is not remembered, so the same key may be sent again. Over the method-invoke envelope or a WebSocket call frame the key may be sent as `idempotencyKey` beside `body`.
- `tasks.retry`: header `Idempotency-Key`. Send a key (1 to 255 characters of letters, digits, ".", "_", ":" or "-") chosen once per logical request, and the same key on every retry: a repeat of the same request (for a multipart or raw upload: the same fields and file content, whatever the encoding) under the same key by the same credential, within a day and across a daemon restart, returns the first answer (with the Idempotent-Replayed: true header) instead of acting again. The same key with a different request is 409 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_KEY_IN_FLIGHT (send it again with the same key after the Retry-After header's seconds, also in the body as retryAfterMs; the SDK does this within its retries); a repeat after the daemon stopped in the middle of the first is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, and a repeat of a first request that failed partway is 500 IDEMPOTENCY_OUTCOME_UNKNOWN (either way: check the state, do not send again). A refusal (4xx) is not remembered, so the same key may be sent again. Over the method-invoke envelope or a WebSocket call frame the key may be sent as `idempotencyKey` beside `body`.
- `workLedger.execution.resume`: body `attemptId`. One attempt (workId, attemptId and expectedRevision) runs once: an exact repeat returns the same execution identity instead of starting a second run; launch-claimed effects are never replayed.
- `workLedger.execution.start`: body `attemptId`. One attempt (workId, attemptId and expectedRevision) runs once: an exact repeat returns the same execution identity instead of starting a second run; launch-claimed effects are never replayed.
- `workLedger.intake.admit`: body `inputId`. One input id is captured and admitted once: an exact repeat returns the original source identity or joins the operation already running instead of acting again.
- `workLedger.intake.capture`: body `inputId`. One input id is captured and admitted once: an exact repeat returns the original source identity or joins the operation already running instead of acting again.
- `workLedger.intake.resume`: body `inputId`. One input id is captured and admitted once: an exact repeat returns the original source identity or joins the operation already running instead of acting again.
- `workLedger.submit`: body `requestId`. Sending the same requestId with the same content again returns the original immutable receipt (replayed: true). After a lost response, use workLedger.submission.get with the same requestId.
- `workLedger.turn.start`: body `inputId`. An admitted input (inputId with its sourceRevision) is delivered at most once: a repeat joins or reports the first dispatch instead of starting a second turn. An ambiguous dispatch is never replayed; read it with workLedger.turn.status.
- `workLedger.turn.startAgent`: body `inputId`. An admitted input (inputId with its sourceRevision) is delivered at most once: a repeat joins or reports the first dispatch instead of starting a second turn. An ambiguous dispatch is never replayed; read it with workLedger.turn.status.

## Error codes

Declared by each method beside its route; every operation also lists its own under `x-error-codes`.

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | A field is missing or not in its documented shape (the body names it in `field`); nothing was changed. |
| `MISSING_SCOPE` | 403 | The principal lacks a scope the method requires; the body lists requiredScopes, grantedScopes and missingScopes. |
| `APPROVAL_NOT_FOUND` | 404 | No approval has that id; nothing was answered. |
| `OWNER_ONLY` | 403 | Only you answer this approval, from any of your credentials: the Agent's credential never does (a model is acting with it), and a device whose stored scope list does not hold the right to answer does not. Nothing was answered. |
| `CONTRACT_NOT_FOUND` | 404 | No runner on this daemon holds that contract id. |
| `CONTRACT_ENDED` | 409 | The contract has ended; start a new one for the remaining work. |
| `CONTRACT_NATIVE` | 409 | Native work runs its units through its own execution. |
| `CONTRACT_NOT_RUNNING` | 409 | This runner holds the contract only for inspection. |
| `CONTRACT_HELD` | 409 | The contract is held because no run claim could be taken; another process may run it, so it is not cancelled here. Fix the contract directory and restart, then cancel. |
| `NOT_HOSTING` | 409 | This daemon hosts no sessions, so work cannot be dispatched into a new one; use contracts.start. |
| `CONTRACT_NOT_ENDED` | 409 | The contract is still running or settling; cancel it, then remove it once it has stopped. |
| `ESCALATION_NOT_OPEN` | 409 | The escalation is already answered, or another reply to it is being read. |
| `SESSION_NOT_OWNED` | 403 | The session belongs to another caller. |
| `SESSION_NOT_LIVE` | 409 | sessionId names a hosted session that is no longer live. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | This Idempotency-Key was already used for a different request; use a new key. |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 | Another process is still starting a contract with this key; send the same request again in a few seconds. |
| `CONTRACT_KEY_UNRECORDED` | 503 | The key could not be recorded in the project's contract directory, so nothing was started; make the directory writable and retry. |
| `SESSION_NOT_FOUND` | 404 | No shared session has that id. |
| `HOSTED_SESSION_STILL_RUNNING` | 409 | A daemon-hosted session is still running; end it with sessions.hosted.kill, which also closes the record. Nothing was changed. |
| `SESSION_ACTIVE` | 409 | The session is still active; close it, then delete it. |
| `INVALID_MESSAGE_ID` | 400 | messageId is not 1 to 255 letters, digits, ".", "_", ":" or "-"; nothing was changed. |
| `SESSION_CLOSED` | 409 | The session is closed; reopen it (sessions.reopen) before sending to it. |
| `SESSION_AGENT_BIND_FAILED` | 500 | The input was accepted but the agent started for it could not be bound; the input was released to the queue. |
| `MODEL_NOT_FOUND` | 400 | No registered model answers to the model (or a fallback model) named; nothing was started. Name a model this daemon holds. |
| `MODEL_AMBIGUOUS` | 400 | The bare model id is served by several providers; nothing was started. Name it provider-qualified, as the message lists. |
| `MODEL_NOT_SELECTABLE` | 400 | The model modelId names cannot be chosen; nothing was created. |
| `HOSTED_SURFACE_FORBIDDEN` | 403 | originSurface agent needs an admin credential; nothing was created. |
| `HOSTED_SESSION_LIMIT_REACHED` | 429 | hostedSessions.maxSessions live sessions already exist; end one or raise the setting. |
| `HOSTED_SESSION_UNAVAILABLE` | 409 | The workspace's provider setup failed or the daemon is shutting down; nothing was created. |
| `HOSTED_SESSION_NOT_OWNED` | 403 | The session was not created by this credential or shared with it; ask an owner to share it, or read it with an admin credential. |
| `PRINCIPAL_NOT_FOUND` | 404 | No user, live pairing or owner credential on this daemon has that principal id; nothing was shared. |
| `NOT_YOURS` | 403 | The caller is not an owner of the session and not an admin; nothing was changed. |
| `HOSTED_SESSION_LAST_OWNER` | 409 | That principal is the session's only owner; nothing was changed. |
| `CANCEL_NOT_ALLOWED` | 409 | Only a queued input can be cancelled; the body says whether it is running or ended. |
| `INPUT_NOT_CLAIMABLE` | 409 | Another surface holds the input or it has ended; the body returns the input. Nothing was changed. |
| `INPUT_NOT_DELIVERABLE` | 409 | The input is not in a state a surface may report on; the body returns the input and its state. |
| `INVALID_KIND` | 400 | Unknown message kind (task, message or followup); nothing was changed. |
| `TASK_NOT_FOUND` | 404 | No runtime task has that id. |
| `INVALID_JSON` | 400 | The body is not JSON; nothing was started. |
| `CAPACITY_EXCEEDED` | 429 | The fleet is at fleet.maxSize; nothing was started. Retry after Retry-After seconds. |
| `TASK_NOT_RETRYABLE` | 400 | Only a failed or cancelled agent task can be retried; nothing was started. |
| `TASK_SETTINGS_UNAVAILABLE` | 409 | The record of the agent that ran the task is no longer held, so the model, tools and routing it ran with are unknown; nothing was started. Create the task again. |
| `AGENT_NOT_FOUND` | 404 | No agent with that id is held. |
| `AUTH_REQUIRED`, `PERMISSION_DENIED`, `PAYMENT_REQUIRED`, `RATE_LIMITED`, `NETWORK_UNREACHABLE`, `TIMEOUT`, `CANCELLED`, `NOT_FOUND`, `CONFLICT`, `SESSION_CLOSED`, `TARGET_CHANGED`, `CREDENTIAL_NOT_FOR_TARGET`, `CREDENTIAL_DESTINATION_UNBOUND`, `NOT_INVOKABLE`, `METHOD_NOT_FOUND`, `INVALID_ARGUMENT`, `STEP_UP_REQUIRED`, `RELAY_DISABLED`, `RELAY_CODE_REVOKED`, `AGENT_TIMEOUT`, `AGENT_FAILED`, `TOOL_EXEC_FAILED`, `SERVICE_UNAVAILABLE`, `CONTRACT_MISMATCH`, `PROTOCOL_ERROR`, `INTERNAL_ERROR`, `ENGINE_CONFIGURATION_ERROR`, `ENGINE_CONTRACT_ERROR`, `ENGINE_HTTP_STATUS_ERROR`, `UNKNOWN` | varies | The shared engine codes (`@goodvibes/engine/errors`); the status is the route's. |
