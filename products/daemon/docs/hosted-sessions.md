# Hosted sessions

A hosted session runs its conversation loop inside the daemon. Its record and
transcript belong to that host. Whether the session continues after its last
client leaves depends on its detach policy.

The daemon composes each session with tools, model providers, and a workspace
runtime. Workspace trust applies to the session's workspace, rather than the
daemon's working directory. The decision is kept in your own state
(`~/.goodvibes/shared/workspace-registrations.json`, by the directory's real
path), never in the workspace, so a project cannot mark itself trusted. An
undecided workspace raises one trust question, which stays open until it is
answered from an attached surface. Reads run meanwhile; a write, command or
delegation waits for the answer at most ten minutes after the question was
raised, and after that is refused at once, saying the question is still open.
A command the owner's own message leads to runs as one in their terminal would:
inside the sandbox when the sandbox setting is on, and as their mode allows. A
message someone else put into the session runs no command outside a real
sandbox and writes no file, whatever the mode. Jev admission and current
permission constraints still govern tool actions. An attachment or a `survive`
policy grants no additional tool authority. See the
[daemon composition](../src/runtime/hosted-session-composition.ts).

## Inspect or end a session

The CLI supports these session operations:

```sh
goodvibes-daemon sessions list
goodvibes-daemon sessions list --all --json
goodvibes-daemon sessions kill <session-id>
```

`session` is an alias for `sessions`. Listing excludes terminated sessions unless
`--all` is supplied. Killing interrupts the turn and ends the selected session,
regardless of its attachments or detach policy. Killing an already terminated
session returns its retained record. A missing identifier is a usage error.

The [remote-target convention](commands-reference.md#the-remote-target-convention)
applies to `--host`, `--port`, and `--token`. Defaults use the configured control
plane and the local operator token. The CLI calls the verbs with one authenticated
request each to `POST /api/control-plane/methods/{methodId}/invoke`, the route the
terminal apps use for the same verbs.
It has no session-create, attach, or stream subcommand.
See the [CLI implementation](../src/daemon/sessions-command.ts).

## Create, attach, and detach through the control plane

The [hosted method catalog](../../../packages/engine/platform/src/platform/control-plane/method-catalog-hosted-sessions.ts)
declares these WebSocket verbs. They require authenticated access; listing declares
`read:sessions`, and the other verbs declare `write:sessions`.

| Method | Parameters | Result |
| --- | --- | --- |
| `sessions.hosted.create` | Required `workspaceRoot`. Optional `title`, `modelId`, `initialPrompt`, `detachPolicy`, `clientId`, and `originSurface`. | `{ session }` |
| `sessions.hosted.attach` | Required `sessionId` and `clientId`. Optional positive `leaseMs`. | `{ session, history }` |
| `sessions.hosted.detach` | Required `sessionId` and `clientId`. | `{ session }` after applying the detach policy |
| `sessions.hosted.kill` | Required `sessionId`. | `{ session }` with its termination reason |
| `sessions.hosted.list` | Optional `includeTerminated`. | `{ sessions }`, most recently updated first |
| `sessions.hosted.workspaces` | None. | `{ roots }`: the folders a session may be started in |
| `sessions.hosted.history` | Required `sessionId`. | `{ session, history }`, live or ended, without attaching |
| `sessions.hosted.share` | Required `sessionId` and `principalId` (a user name, or `pairing:<id>` for a paired device). An unknown principal is refused `PRINCIPAL_NOT_FOUND`. | `{ session, owners, added }` |
| `sessions.hosted.unshare` | Required `sessionId` and `principalId`. Removes the owner and detaches its clients; the last owner is refused `HOSTED_SESSION_LAST_OWNER`. | `{ session, owners, removed }` |

`workspaceRoot` must be an absolute, existing directory on the daemon's machine, and it
must be the daemon's working directory or a registered workspace (`workspaces.registrations.add`),
or lie inside one; symlinks are resolved first. Anything else is refused with the allowed
folders named. Contract work dispatched into a new hosted session is held to the same list.
Creation resolves a supplied `modelId` against the host's live model registry.
Unknown or ambiguous models are refused. `clientId` attaches the creating client;
`originSurface` preserves the originating product's settings identity across
restarts and must be `agent`, `tui` or `webui`; any other value is refused
before the session is created. A session created for `agent` (the Agent's routed
turns, its channel hand-offs, the web UI's GoodVibes Agent choice, or any client
that names it and holds admin) answers as the GoodVibes Agent. Its operator tools
act on this daemon with full operator authority, so a caller without admin (a
non-admin sign-in, or a pairing with a narrowed scope list) is refused with
`HOSTED_SURFACE_FORBIDDEN` and nothing is created. In such a session each model request gets the Agent's
prompt (its operator policy and capture rules, VIBE, project context, persona,
reviewed skills, routines and memory, read from the same `~/.goodvibes/agent`
stores the Agent uses) and the session has the Agent's `profile`, `occasions`,
`agent_artifacts`, `agent_documents`, `agent_research_runs`,
`agent_research_sources`, `agent_review_packet_presets`, `agent_review_packet_share`,
`agent_media_generate`, `agent_notify`, `agent_local_registry`, `agent_learning_consolidation`, `agent_channel_send`,
`browser` and `google`
tools beside the platform tools (using the daemon's own channel delivery, media providers, webhook notifier,
memory store, the browser its `browser.*` methods drive, and the Google account and `calendar.events.*`
methods it holds), and `agent_work_plan` when the session is in the daemon's own project. Its `schedule`,
`agent_autonomy_schedule`, `agent_reminder_schedule` and `agent_schedule_edit` tools list, create, edit, run,
pause, resume and delete the daemon's own schedules through the daemon's own request path, admitted and
judged as in the Agent's own process. Its `agent_knowledge` and `agent_knowledge_ingest` tools read
and add to the Agent's own knowledge store (`/api/goodvibes-agent/knowledge/*`) the same way, its
`agent_research_report` tool saves sourced reports under the Agent's own screening consent
(`tools.hostedResearchScreening` in the Agent's settings, or no decision model set) with the screening keys
(`ABACUSAI_API_KEY`, `TYPESAFE_API_KEY`) read from the environment or the Agent's own credential stores, and its `agent_model_compare` tool
blind-compares this session's models and, on apply, sets the Agent's own `provider.model`. Its `agent_operator_briefing`,
`agent_operator_action` and `agent_operator_method` tools read and act on this daemon through the same
request path, which serves them as requests from this machine. They present the credentials the Agent presents
to a daemon on its own machine: its pairing with this daemon when it has one, otherwise the daemon's operator
credential (credential kind `local`), and for a call the Agent makes on the owner's behalf (a schedule change,
a channel draft, a profile or occasion write) the Agent's delegated credential (credential kind `agent`), so
the daemon judges that call as the Agent's. A purchase start or cancel therefore carries the owner's request
as it does from the Agent itself. Its `accounts` tool keeps the Agent's register of the accounts
it created, where a signup alias opens this daemon's own watch for the verification mail. Its `profile` and `occasions` tools reach the
daemon the same way, so a read presents the Agent's ordinary credential and a profile or occasion write the Agent
makes for the owner runs under the Agent's pairing, with its scopes and its native authority, as it does from the
Agent itself; `google` reaches this daemon's `calendar.events.*` the same way, with the Agent's ordinary credential.
One rule decides which credential every one of these calls presents, in the Agent and in a hosted session alike. A
worker agent such a session spawns is built as the Agent builds its workers: the platform tools with the Agent's
read and settings admission, its settings routed to the Agent's own file, and the Agent's tool policy. Its platform tools carry the
Agent's tool policy: the read-mode table, so a mode reads or changes exactly as it does in the Agent; `read`
runs only under the admission recorded for its exact files; `goodvibes_settings` writes only what was
prepared against the setting's owning store and judged (a client-owned key goes to the Agent's own settings
file); and `goodvibes_context` is a read. The Agent tools that work through the Agent's own
command session are named in that prompt with the platform tool that covers the
same facts, and a call to one is refused with the reason and the next step. Creation submits `initialPrompt` without waiting for its turn to finish.
A creation response therefore does not prove successful model execution.
A `clientId` belongs to the principal that first attached it: another principal that attaches or detaches the same `clientId` is refused with 403 `HOSTED_CLIENT_FORBIDDEN`, so choose a `clientId` of your own.
The principal that creates a session is its owner. Attaching never makes the caller an owner: an owner (or an admin) adds another principal with `sessions.hosted.share`, and that is the only way another credential joins. A credential below admin attaches to, or reads the history of, only a session its principal created or was shared; anyone else is refused (`NOT_YOURS`, or `HOSTED_SESSION_NOT_OWNED` for history). Owners are kept with the session when their clients detach or their leases run out, and across a daemon restart, until an owner removes one with `sessions.hosted.unshare` (the web UI's Remove beside each owner); the session's contracts are visible only to its owners (see `contracts.list`).

There are no dedicated REST routes for these hosted verbs. The daemon also
accepts them through its generic authenticated
`POST /api/control-plane/methods/<method>/invoke` endpoint, with method parameters
inside the JSON envelope's `body` property. HTTP requests require an operator
credential or an authenticated user session, with the method's required access.
See the [HTTP dispatcher](../../../packages/engine/daemon-api/src/operator.ts),
[invocation handler](../../../packages/engine/daemon-api/src/control-routes.ts),
and [hosted handlers](../../../packages/engine/platform/src/platform/control-plane/routes/hosted-sessions.ts).

`POST /api/sessions` creates a shared session record through the session broker.
It is a separate contract from `sessions.hosted.create` and does not take that
method's workspace and model parameters.

## Read history and live output

Attaching returns the retained conversation history. Subsequent text deltas,
turn transitions, usage, and tool events are available through authenticated
`GET /api/sessions/<session-id>/events` as server-sent events. This route requires
admin access. Set the variables below to the selected daemon, its operator
credential, and the returned session identifier:

```sh
curl --no-buffer \
	--header "Authorization: Bearer $OPERATOR_TOKEN" \
	"$DAEMON_URL/api/sessions/$SESSION_ID/events"
```

The stream filters events carrying another session's identifier. Events with no
session identifier can still be delivered. Closing the HTTP stream releases its
subscription. Stream closure is not an explicit `sessions.hosted.detach` call.
See [session event streaming](../../../packages/engine/platform/src/platform/daemon/http/session-event-stream.ts).

Ordinary session message, steer, and follow-up HTTP contracts are defined in
[runtime session routes](../../../packages/engine/daemon-api/src/runtime-session-routes.ts).
A `202` conversation-message response means the input was persisted and routed;
it does not mean the turn completed. Native Agent and WebUI delivery uses the
separate [native hosted-turn protocol](../../../packages/engine/platform/src/platform/control-plane/method-catalog-native-hosted-turn.ts),
which binds admitted source identity to its owner (an app on the daemon's own
machine with the operator token it holds, or a paired device) and requires fresh
operator authentication. A status read never grants delivery or retries an
ambiguous dispatch.

## Detach policy and leases

`kill` is the default. The last client detaching terminates the session with
`terminatedReason: "detached"`. With `survive`, the session remains reattachable
and an active turn can continue. Detaching one of several clients does not end
the session. A per-session override takes precedence over the live
`hostedSessions.detachPolicy` setting.

An attachment expires unless renewed. Calling `attach` again with the same
`clientId` renews it. The daemon also renews an expired attachment when a live
control-plane connection has that same client identifier. An unrelated SSE
subscription does not renew an arbitrary attachment. When the last lease lapses,
the sweep applies the session's detach policy.

The [configuration schema](../../../packages/engine/platform/src/platform/config/schema-domain-hosted-sessions.ts)
defines these defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `hostedSessions.detachPolicy` | `kill` | Policy when the last attachment leaves |
| `hostedSessions.attachmentTtlMs` | `600000` | Attachment lease, clamped to 30 seconds through 24 hours |
| `hostedSessions.maxSessions` | `8` | Maximum live sessions; terminated sessions do not count |
| `hostedSessions.maxMessagesPerSession` | `500` | Most recent messages persisted per session |
| `hostedSessions.terminatedRetentionMs` | `86400000` | Retention for terminated records; the daemon retires them (file and memory) on its attachment sweep once they are older |

The [attachment implementation](../../../packages/engine/platform/src/platform/hosted-sessions/attachments.ts)
sweeps leases at intervals between 15 and 60 seconds. Expiry is applied by that
sweep, rather than exactly at the deadline.

## Restart and refusal behavior

The host persists bounded session state. A surviving session restores idle, with
no attached clients, and rebuilds its loop on attach or delivery. When the
retained conversation can be replayed, its transcript states that a
turn interrupted by restart did not finish. Malformed conversation state can
restore without that history and produces a warning. In-flight execution
does not resume from its previous instruction. A kill-policy session restores
terminated with reason `daemon-shutdown`. A loop rebuild that fails because the
workspace could not be acquired or the stored model could not be resolved leaves
the session restored and idle, and the next attach or delivery retries it; any
other rebuild failure records `restart-unresumable`. Changing a session's effective policy before recovery
changes how recovery treats it.

Persistence failures are logged; a `survive` policy cannot guarantee recovery
when the state was not written. Inspect `status`, `terminatedReason`, and
`restoredFromDisk`, rather than treating a missing or interrupted turn as success.
The [manager](../../../packages/engine/platform/src/platform/hosted-sessions/manager.ts)
and [store](../../../packages/engine/platform/src/platform/hosted-sessions/store.ts)
own these transitions.

Hosted handlers distinguish `INVALID_ARGUMENT` with status 400,
`SESSION_NOT_FOUND` with 404, `HOSTED_SESSION_TERMINATED` with 409 (the
session ended for good: start a new one), `HOSTED_SESSION_UNAVAILABLE` with 409
(the session exists but cannot serve this request now: do not start a second
one for the same conversation), `HOSTED_SESSION_NOT_READY` with 503, and
`HOSTED_SESSION_LIMIT_REACHED` with 429. Authentication failure is separate.
A host without hosted-session composition refuses the capability; its method
catalog alone does not prove that a session can run.
