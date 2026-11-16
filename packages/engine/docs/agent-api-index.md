# Agent API index

Generated from the operator contract (product 3.3.0) by `bun run agent-spec:generate`. Spec: [agent-api.openapi.json](./agent-api.openapi.json). Everything not listed here is in the full document, `contracts/artifacts/operator-openapi.json`.

Auth: `Authorization: Bearer <token>` or the login session cookie. Errors are `{ error, state?, next?, hint?, code?, category?, requestId?, retryAfterMs? }`; a 403 for a missing scope also lists `requiredScopes`, `grantedScopes` and `missingScopes`.

## sessions

| Method id | Route | Scopes | Replay key | Does |
| --- | --- | --- | --- | --- |
| `sessions.changes.get` | invoke / WebSocket only | read:sessions |  | Return the aggregate workspace file changes a session made, joined over its sessionId-stamped checkpoints: th… |
| `sessions.close` | `POST /api/sessions/{sessionId}/close` | write:sessions |  | Mark a shared session as closed. |
| `sessions.contextUsage.get` | `GET /api/sessions/{sessionId}/context-usage` | read:sessions |  | Return the live context-window usage for a session: estimatedContextTokens (the runtime's current estimate, n… |
| `sessions.create` | `POST /api/sessions` | write:sessions |  | Create a shared session for a surface, route, or web client. |
| `sessions.delete` | `DELETE /api/sessions/{sessionId}` | write:sessions |  | Permanently remove a shared session record and its queued inputs/messages from the home-scoped store. |
| `sessions.detach` | `POST /api/sessions/{sessionId}/detach` | write:sessions |  | Remove a surface's participant and its route binding from a session so that surface stops receiving updates, … |
| `sessions.followUp` | `POST /api/sessions/{sessionId}/follow-up` | write:sessions |  | Queue a deferred follow-up for a shared session so it runs after the current agent completes, or spawn immedi… |
| `sessions.get` | `GET /api/sessions/{sessionId}` | read:sessions |  | Return metadata for a shared session. |
| `sessions.hosted.attach` | invoke / WebSocket only | write:sessions |  | Join a hosted session and receive its transcript so far, so a client that was never connected, or one reconne… |
| `sessions.hosted.create` | invoke / WebSocket only | write:sessions |  | Compose a full conversation loop INSIDE the daemon for a workspace: the same orchestrator, tool registry and … |
| `sessions.hosted.detach` | invoke / WebSocket only | write:sessions |  | Leave a hosted session. |
| `sessions.hosted.kill` | invoke / WebSocket only | write:sessions |  | End a hosted session regardless of who is attached or what its detach policy says: the in-flight turn is inte… |
| `sessions.hosted.list` | invoke / WebSocket only | read:sessions |  | Every session this daemon hosts, most recently updated first. |
| `sessions.hosted.workspaces` | invoke / WebSocket only | read:sessions |  | The folders sessions.hosted.create accepts as workspaceRoot: the daemon's working directory and every registe… |
| `sessions.inputs.cancel` | `POST /api/sessions/{sessionId}/inputs/{inputId}/cancel` | write:sessions |  | Cancel a queued shared-session input before it is delivered or spawned. |
| `sessions.inputs.deliver` | `POST /api/sessions/{sessionId}/inputs/{inputId}/deliver` | write:sessions |  | A live registered surface reports that it collected a queued input (moves it to `delivered`) or finished acti… |
| `sessions.inputs.list` | `GET /api/sessions/{sessionId}/inputs` | read:sessions |  | Return explicit session inputs, including queued follow-ups and delivered steering requests. |
| `sessions.integration.snapshot` | `GET /api/session` | read:sessions |  | Return the session integration snapshot. |
| `sessions.list` | `GET /api/sessions` | read:sessions |  | Return shared-session integration state. |
| `sessions.messages.create` | `POST /api/sessions/{sessionId}/messages` | write:sessions |  | Append a user message to a shared session. |
| `sessions.messages.list` | `GET /api/sessions/{sessionId}/messages` | read:sessions |  | Return a page of retained session messages. |
| `sessions.permissionMode.get` | `GET /api/sessions/{sessionId}/permission-mode` | read:sessions |  | Return the effective session execution mode: safe-owner, safe-jev, yolo, or the read-only plan posture. |
| `sessions.permissionMode.set` | `POST /api/sessions/{sessionId}/permission-mode` | write:sessions |  | Set safe-owner, safe-jev, or yolo execution, or enter the read-only plan posture. |
| `sessions.queuedMessages.delete` | `DELETE /api/sessions/{sessionId}/queued-messages/{messageId}` | write:sessions |  | Remove a message still waiting in the mid-turn queue so it is never delivered. |
| `sessions.queuedMessages.edit` | `POST /api/sessions/{sessionId}/queued-messages/{messageId}` | write:sessions |  | Replace the text of a message still waiting in the mid-turn queue. |
| `sessions.queuedMessages.list` | `GET /api/sessions/{sessionId}/queued-messages` | read:sessions |  | List the messages queued behind the current turn (submitted while the model was thinking), in delivery order. |
| `sessions.register` | `POST /api/sessions/register` | write:sessions | body `sessionId` | Idempotently register (or heartbeat) a session keyed on a caller-supplied id, carrying its kind, project, and… |
| `sessions.reopen` | `POST /api/sessions/{sessionId}/reopen` | write:sessions |  | Reopen a previously closed shared session. |
| `sessions.search` | invoke / WebSocket only | read:sessions |  | Paginated, filtered query over shared sessions: free-text query (matches id/title), project, kind, surfaceKin… |
| `sessions.steer` | `POST /api/sessions/{sessionId}/steer` | write:sessions |  | Deliver a live steering message to the active agent for a shared session, optionally falling back to spawn wh… |
| `sessions.toolCalls.cancel` | `POST /api/sessions/{sessionId}/tool-calls/{callId}/cancel` | write:sessions |  | Cancel a single running tool call by its callId, leaving the turn and any other running calls untouched. |
| `sessions.turns.cancel` | `POST /api/sessions/{sessionId}/turns/cancel` | write:sessions |  | Atomically compare expectedTurnId and request cancellation of that live turn, preserving the session and futu… |

## tasks

| Method id | Route | Scopes | Replay key | Does |
| --- | --- | --- | --- | --- |
| `tasks.cancel` | `POST /api/tasks/{taskId}/cancel` | write:tasks |  | Cancel an in-flight runtime task. |
| `tasks.create` | `POST /task` | write:tasks |  | Submit a task to the daemon or a shared session. |
| `tasks.get` | `GET /api/tasks/{taskId}` | read:tasks |  | Return a single runtime task record. |
| `tasks.list` | `GET /api/tasks` | read:tasks |  | Return the integration snapshot for runtime tasks. |
| `tasks.retry` | `POST /api/tasks/{taskId}/retry` | write:tasks |  | Retry a runtime task through the task action endpoint. |
| `tasks.status` | `GET /task/{agentId}` | read:tasks |  | Return lightweight runtime task status by agent id. |

## contracts

| Method id | Route | Scopes | Replay key | Does |
| --- | --- | --- | --- | --- |
| `contracts.cancel` | `POST /api/contracts/{contractId}/cancel` | write:fleet |  | Stop a contract and every unit agent it runs; its status line records how many files were already changed and… |
| `contracts.dispatch` | invoke / WebSocket only | write:fleet |  | Start a contract for `ask` (the person's words verbatim) in a hosted session created for it, in `workspaceRoo… |
| `contracts.get` | `GET /api/contracts/{contractId}` | read:fleet |  | One contract with its whole tree, running or ended. |
| `contracts.list` | `GET /api/contracts` | read:fleet |  | Every contract this daemon holds, newest first, each with its whole tree: the ask, the goal, the acceptance c… |
| `contracts.remove` | invoke / WebSocket only | write:fleet |  | Delete the record of a contract that has ended (passed, failed or cancelled): its checkpoint and summary. |
| `contracts.reply` | `POST /api/contracts/{contractId}/reply` | write:fleet |  | The owner's free-text reply to an open escalation of a contract, read by Jev as approve, reject, amend or unc… |
| `contracts.start` | `POST /api/contracts` | write:fleet | header `Idempotency-Key` | Start a contract for `ask`, the person's words verbatim, which every stated acceptance criterion must trace t… |
| `contracts.status` | invoke / WebSocket only | read:fleet |  | One contract's summary (as `contracts.summaries` gives it), for polling. |
| `contracts.summaries` | invoke / WebSocket only | read:fleet |  | The contracts `contracts.list` returns (same `sessionId` and `includeTerminal`), newest first, each as a smal… |

## approvals

| Method id | Route | Scopes | Replay key | Does |
| --- | --- | --- | --- | --- |
| `approvals.approve` | `POST /api/approvals/{approvalId}/approve` | write:approvals |  | Approve a pending approval. |
| `approvals.cancel` | `POST /api/approvals/{approvalId}/cancel` | write:approvals |  | Cancel a pending approval. |
| `approvals.claim` | `POST /api/approvals/{approvalId}/claim` | write:approvals |  | Claim a pending approval for operator handling. |
| `approvals.deny` | `POST /api/approvals/{approvalId}/deny` | write:approvals |  | Deny a pending approval. |
| `approvals.list` | `GET /api/approvals` | read:approvals |  | Return pending and historical approval records, newest 50. |
| `approvals.raise` | invoke / WebSocket only | write:approvals |  | Raise a permission ask INTO the shared broker from a surface that is not in the daemon's process, the write c… |
| `inbox.answer` | invoke / WebSocket only | write:approvals |  | Answer one open inbox item with one of its `options`, or with `text` when it has none (text may also accompan… |
| `inbox.list` | invoke / WebSocket only | read:approvals |  | Everything waiting on the owner in one list, newest first: permission asks (kind approval), questions agents … |
| `inbox.post` | invoke / WebSocket only | write:approvals |  | Leave the owner a question or a queued action from a process that is not the daemon (an agent in a terminal a… |
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

- `contracts.start`: header `Idempotency-Key`. A retry with the same key and the same body returns the first contract (with the Idempotent-Replayed: true response header) instead of starting a second one; the same key with a different body is refused with IDEMPOTENCY_KEY_REUSED. Keys are kept with the contract store per caller, so a retry after a daemon restart still returns the first contract; the body is compared field by field, in any order. The key may also be sent as `idempotencyKey` in the body; the header wins when both are given. A replayed result carries `replayed: true`.
- `sessions.register`: body `sessionId`. Registering the same sessionId again is a heartbeat, not a second session; it returns the existing record.
- `workLedger.importLegacy`: body `requestId`. Sending the same requestId again replays the durable result without a new admission evaluation.
- `workLedger.submit`: body `requestId`. Sending the same requestId with the same content again returns the original immutable receipt (replayed: true). After a lost response, use workLedger.submission.get with the same requestId.

## Error codes

Declared by each method beside its route; every operation also lists its own under `x-error-codes`.

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | An input is not one the method accepts; the error names it and nothing was changed. |
| `MISSING_SCOPE` | 403 | The principal lacks a scope the method requires; the body lists requiredScopes, grantedScopes and missingScopes. |
| `CONTRACT_NOT_FOUND` | 404 | No runner on this daemon holds that contract id. |
| `CONTRACT_NATIVE` | 409 | Native work keeps its record with its native execution. |
| `CONTRACT_NOT_RUNNING` | 409 | This runner holds the contract only for inspection. |
| `NOT_HOSTING` | 409 | This daemon hosts no sessions, so work cannot be dispatched into a new one; use contracts.start. |
| `CONTRACT_NOT_ENDED` | 409 | The contract is still running or settling; cancel it, then remove it once it has stopped. |
| `CONTRACT_ENDED` | 409 | The contract has ended. |
| `ESCALATION_NOT_OPEN` | 409 | The escalation is already answered, or another reply to it is being read. |
| `SESSION_NOT_OWNED` | 403 | The session belongs to another caller. |
| `SESSION_NOT_LIVE` | 409 | sessionId names a hosted session that is no longer live. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | This Idempotency-Key was already used for a different request; use a new key. |
| `SESSION_NOT_FOUND` | 404 | No shared session has that id. |
| `HOSTED_SESSION_STILL_RUNNING` | 409 | A daemon-hosted session is still running; end it with sessions.hosted.kill, which also closes the record. Nothing was changed. |
| `SESSION_ACTIVE` | 409 | The session is still active; close it, then delete it. |
| `SESSION_CLOSED` | 409 | The session is closed; reopen it (sessions.reopen) before sending to it. |
| `WORKSPACE_BUSY` | 409 | A workspace swap is in progress; retry after retryAfterMs. |
| `SESSION_AGENT_BIND_FAILED` | 500 | The input was accepted but the agent started for it could not be bound; the input was released to the queue. |
| `CANCEL_NOT_ALLOWED` | 409 | Only a queued input can be cancelled; the body says whether it is running or ended. |
| `INPUT_NOT_CLAIMABLE` | 409 | Another surface holds the input or it has ended; the body returns the input. Nothing was changed. |
| `INPUT_NOT_DELIVERABLE` | 409 | The input is not in a state a surface may report on; the body returns the input and its state. |
| `INVALID_KIND` | 400 | Unknown message kind (task, message or followup); nothing was changed. |
| `INVALID_MESSAGE_ID` | 400 | messageId is not 1 to 128 letters, digits, ".", "_", ":" or "-"; nothing was changed. |
| `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `PERMISSION_DENIED`, `PAYMENT_REQUIRED`, `RATE_LIMITED`, `NETWORK_UNREACHABLE`, `TIMEOUT`, `CANCELLED`, `NOT_FOUND`, `CONFLICT`, `SESSION_CLOSED`, `NOT_INVOKABLE`, `METHOD_NOT_FOUND`, `VALIDATION_FAILED`, `AGENT_TIMEOUT`, `AGENT_FAILED`, `TOOL_EXEC_FAILED`, `SERVICE_UNAVAILABLE`, `CONTRACT_MISMATCH`, `PROTOCOL_ERROR`, `INTERNAL_ERROR`, `ENGINE_CONFIGURATION_ERROR`, `ENGINE_CONTRACT_ERROR`, `ENGINE_HTTP_STATUS_ERROR`, `UNKNOWN` | varies | The shared engine codes (`@goodvibes-jev/engine/errors`); the status is the route's. |
