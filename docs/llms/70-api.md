# The operator HTTP API

Every GoodVibes client (the terminal app, Agent, the web UI, `goodvibes-daemon` itself, scripts and other programs) drives the daemon through one API: the operator API on the daemon's control plane. This part explains how an automated client authenticates, which scopes exist, how to call any method, how to run a conversation and a task, how to answer approvals, how to stream events and reconnect, how errors and retries work, and which SDK entry points wrap all of it. The list of every method with its route and scopes is in "Operator API methods" in the reference, and the list of every event in "Events".

## Terms used in this part

| Term | Meaning |
| --- | --- |
| method | One operation of the operator API, named by an id such as `sessions.create`. There are 650 in 3.4.1. |
| REST route | The HTTP method and path a method is bound to, such as `POST /api/sessions`. |
| invoke-only method | A method with no REST route. It is called through `POST /api/control-plane/methods/<id>/invoke` or a WebSocket `call` frame. |
| access | Each method is `public` (no credential), `authenticated` (any valid credential holding its scopes) or `admin` (an admin credential). |
| shared session | A conversation record in the daemon's session broker: messages, inputs, participants. Every conversation has one, whichever process runs its model loop. |
| hosted session | A shared session whose model loop runs inside the daemon. Its id starts with `hosted-`. |
| turn | One model response to one user input, with the tool calls it makes. |
| input | A queued user message for a session (a steer or a follow-up), with a state: `queued`, `delivered`, `completed`, `failed`, `cancelled`. |
| approval | A pending permission ask raised by the permission gate for one tool call. |

## Base address and how to call it

The base address is the daemon's control plane: `http://127.0.0.1:3421` by default. When the daemon was started on another port, use that port. When it is reached through a proxy, Tailscale or TLS, use that address (see "Network exposure" in "The daemon, the web UI and networking").

There are four ways to call a method:

| Way | When to use it |
| --- | --- |
| The method's REST route | The method has one (`GET /api/sessions`, `POST /api/sessions/{sessionId}/follow-up`). |
| `POST /api/control-plane/methods/<id>/invoke` | The method has no REST route (all `sessions.hosted.*`, `pairing.*`, `fleet.*`, `inbox.*`, `relay.*`, `tailscale.*`, and others), or you want one route for everything. |
| A `call` frame on the WebSocket `/api/control-plane/ws` | You already hold a WebSocket open for events. |
| The SDK (`@goodvibes/engine`) | You write TypeScript or JavaScript. See "SDK entry points". |

The daemon describes itself:

| Route | Returns | Scope |
| --- | --- | --- |
| `GET /api/control-plane/methods` | Every method with its id, title, description, access, scopes, REST route, input JSON Schema and output JSON Schema. | `read:control-plane` |
| `GET /api/control-plane/methods/{methodId}` | One method. | `read:control-plane` |
| `GET /api/control-plane/events/catalog` | Every event, its scopes, domains and payload schema. | `read:control-plane`, `read:events` |
| `GET /api/control-plane/contract` | The whole contract document. | `read:control-plane` |
| `GET /status` | Version, build and cluster status. | `read:control-plane` |

Example: what does `sessions.hosted.create` take?

```sh
curl -sS -H "Authorization: Bearer $GV_TOKEN" \
  http://127.0.0.1:3421/api/control-plane/methods/sessions.hosted.create
```

### Three rules clients trip on

1. **The invoke route takes an envelope.** `POST /api/control-plane/methods/<id>/invoke` reads the method's input from a field called `body`, with an optional `query` beside it. Send `{"body":{"workspaceRoot":"/home/alex/projects/app"}}`, not `{"workspaceRoot":"/home/alex/projects/app"}`. The bare form is refused with `400` `{"error":"Missing required field: body. Expected envelope shape: { query?, body }","status":400}`. REST routes take the input directly as the JSON body; only the invoke route uses the envelope.
2. **A non-admin watches only its own sessions live, with `read:own-sessions`.** `GET /api/sessions/{sessionId}/events` answers a non-admin `403` `{"error":"Admin role required","code":"ADMIN_REQUIRED",...}`, and the event domains that carry a turn (`session`, `turn`, `tools`, `gate`) are admin-only for every other session. A credential holding `read:own-sessions` opens `GET /api/control-plane/events?domains=turn,tools,gate,session` and receives those frames, and the `approval-update` and `hosted-session-update` events, of the sessions its own principal created or an owner shared with it (`sessions.hosted.share`), and nothing of any other session (see "The least-privilege client").
3. **`sessions.messages.create` with no `kind` queues a turn; there is no `routedTo` any more.** `POST /api/sessions/{sessionId}/messages` with no `kind` (which means `kind: "message"`) queues the message as the session's next follow-up, as `POST /api/sessions/{sessionId}/follow-up` does: a terminal running the session collects it, runs it as its next turn and reports the answer, and with no terminal on the session the daemon answers it. A queued message is answered `202` `{"messageId":"<id>","sessionId":"...","inputId":"...","mode":"..."}` (`messageId` only when you sent one; a repeat with the same `messageId` gets the first answer); one the daemon starts an agent for, or one the session refused, is answered as `sessions.followUp` answers it.

Every response from the daemon carries the header `x-goodvibes-decision-policy` (for example `{"policy":"Hybrid","operation":"decision","reason":null,"revision":0}`), which says which decision model policy is in force.

## Authentication

Every method except three needs a credential. The three public methods are `control.auth.current` (`GET /api/control-plane/auth`), `control.auth.login` (`POST /login`) and `control.auth.logout` (`POST /logout`). The web UI bundle served at `/` is also public.

A credential is sent in one of two ways:

- `Authorization: Bearer <token>`, for any token;
- the cookie `goodvibes_session=<token>`, which `POST /login` and the web UI's `POST /api/browser-session` set (`HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS), with the readable marker `goodvibes_identity` beside it (a generation and who is signed in, no credential). A request on the cookie is held to the page's origin: a state-changing one must carry the daemon's own `Origin` (or one in `controlPlane.cors.allowedOrigins`), and a read, the event stream included, is refused `403` `ORIGIN_NOT_ALLOWED` when it names another origin.

When both are present, the bearer header is used.

### Which credential an automated client should use

| Situation | Credential |
| --- | --- |
| A script on the daemon's own machine, run by the owner | The operator token from `~/.goodvibes/daemon/operator-tokens.json` (field `token`). It has full authority. |
| A script or service anywhere that should be able to do only some things | A device token minted with a scope list (below). It can be revoked on its own. |
| A program that must keep working after the shared token is revoked | A device token of its own. |
| A person signing in from a browser | A sign-in (`POST /login`), 12 hours. |

Reading the operator token in a shell:

```sh
GV_TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.goodvibes/daemon/operator-tokens.json')))['token'])")
```

### Checking a credential

`GET /api/control-plane/auth` is public and reports what the request authenticated as.

```sh
curl -sS -H "Authorization: Bearer $GV_TOKEN" http://127.0.0.1:3421/api/control-plane/auth
```

```json
{
  "authenticated": true,
  "authMode": "shared-token",
  "tokenPresent": true,
  "authorizationHeaderPresent": true,
  "sessionCookiePresent": false,
  "principalId": "shared-token",
  "principalKind": "token",
  "credential": "local",
  "admin": true,
  "scopes": ["read:accounts", "read:approvals", "...", "write:worktrees"],
  "roles": ["admin"],
  "expiresAt": null
}
```

`authMode` is `anonymous` (no credential sent), `invalid` (a credential that does not authenticate), `shared-token` (the operator token) or `session` (any other valid credential: a device token as well as a sign-in; use `credential` to tell them apart). `credential` is `local` (the operator token sent straight from the daemon's machine), `shared-token` (the operator token from anywhere else, or through a proxy), `device-token`, `agent` (the Agent's own pairing) or `user-session`. `principalId` is `shared-token`, `pairing:<token id>` for a device token, or the sign-in user. `expiresAt` is set for a sign-in.

### Minting a scoped token for a script

A device token with a scope list holds only those scopes and is never admin. `pairing.tokens.create` is not an admin method: any credential holding `write:control-plane` may call it, except the Agent's own credential (the method is owner-only). An admin caller may name any scopes; a narrowed caller may name only scopes it holds itself. Example with the operator token:

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/api/control-plane/methods/pairing.tokens.create/invoke \
  -d '{"body":{"name":"nightly report","scopes":["read:sessions","read:transcripts","read:events","read:tasks"],"attemptId":"nightly-report-1"}}'
```

```json
{"token":{"id":"pair-d58c1c36-428d-4bd7-811d-dc96988d9afa","name":"nightly report","token":"<the secret, shown once>","createdAt":1795022092889}}
```

Rules:

- The secret is returned once and starts with `gvp_`. Only its hash is stored.
- The token is an offer until its first use. If nothing uses it within 15 minutes it stops working (`PAIRING_OFFER_EXPIRED`). Use it once right away.
- `attemptId` must be 8 to 128 letters, digits, `.`, `_`, `:` or `-` (otherwise `400` `INVALID_ARGUMENT` `attemptId must be 8 to 128 letters, digits or . _ : -`). Sending the same `attemptId` again while the token is still unused returns the same token id with a new secret; the earlier secret of that offer stops working, so use the newest one. A lost reply therefore never creates a second token.
- Subset rule: a narrowed caller (not admin) can grant only scopes it holds. Naming one it does not hold is `403` `MISSING_SCOPE` (`A paired device cannot be given scopes this credential does not hold: read:events. Name only scopes you hold, or ask an admin.`). A narrowed caller that leaves `scopes` out gives the new token exactly its own list.
- An admin caller that leaves `scopes` out mints a token with full authority (admin).
- `scopes` must be a nonempty list of scope names. `"*"`, an empty list or an empty name is refused with `400` `INVALID_ARGUMENT` (`scopes must be a nonempty list of operator scopes (such as read:sessions); leave it out for full operator authority.`).
- `client` is `"agent"` or absent (anything else is `400`). `client: "agent"` mints the Agent's own credential; do not use it for scripts.
- Revoke with `pairing.tokens.delete` (`{"body":{"id":"pair-..."}}`). It answers `{"id":"pair-...","revoked":true,"alsoRevoked":["pair-...",...]}`: every token that the revoked token minted is revoked with it, and so on down. A script that mints child tokens with its own device token loses all of them when its own token is revoked. The next request with any of them gets `401`, and their open streams receive a `closed` frame. An unknown id is `404` `PAIRING_TOKEN_NOT_FOUND`. Who may revoke: a credential holding `write:control-plane` revokes its own token and the tokens it minted at once. Any other token (a device the owner paired, another principal's) is access the owner granted, and withdrawing it is his own act (effect `access.withdraw`): the owner's credentials revoke it at once; an admin that is not the owner is answered `202` `OWNER_APPROVAL_PENDING` with the `approvalId`, and the token is revoked when the owner approves it; any other credential is refused `403` `OWNER_ONLY`. A model never makes the call: the Agent's own credential is refused (`403` `{"error":"pairing.tokens.delete is the owner's own act; a call the Agent makes for him is refused. The owner does it from his own app.","code":"OWNER_ONLY","category":"authorization","status":403}`). `pairing.tokens.revokeShared` is the owner's alone: every other credential is refused `403` `OWNER_ONLY`. A method's `ownerOnly` in the contract now means only the owner's credential makes it; `modelRefused` means a model never calls it.

The new token, checked:

```json
{"authMode":"session","principalId":"pairing:pair-d58c1c36-428d-4bd7-811d-dc96988d9afa","principalKind":"token","credential":"device-token","admin":false,"scopes":["read:events","read:sessions","read:tasks","read:transcripts"],"roles":[]}
```

### Signing in with a username and password

```sh
curl -sS -i -X POST -H 'content-type: application/json' http://127.0.0.1:3421/login \
  -d '{"username":"admin","password":"<password>"}'
```

```text
HTTP/1.1 200 OK
set-cookie: goodvibes_session=<token>; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 19 Nov 2026 05:14:45 GMT; Max-Age=43199
set-cookie: goodvibes_identity=<generation>.<username, base64url>; Path=/; SameSite=Strict; Expires=Thu, 19 Nov 2026 05:14:45 GMT; Max-Age=43199
```

```json
{"authenticated":true,"token":"<token>","username":"admin","expiresAt":1795065285233}
```

The `token` works as a bearer token or as the cookie until `expiresAt` (12 hours). A wrong password answers `401` `{"error":"Invalid credentials"}`. Five attempts per minute per address are allowed; the sixth answers `429` with code `RATE_LIMITED` and the header `Retry-After: 60`. A body sent without `content-type: application/json` answers `415` `SIGN_IN_NOT_JSON` and does not count as an attempt. `POST /logout` with the same credential ends that sign-in and answers `{"revoked":true}`; a credential that is not a sign-in answers `401` `SESSION_UNKNOWN`. Creating users and the bootstrap password are in "Sign-in users" in "The daemon, the web UI and networking".

### Credentials over the WebSocket

The upgrade request to `/api/control-plane/ws` must itself be authenticated: send `Authorization: Bearer <token>` on the upgrade, or, from a browser on the same origin, the sign-in cookie. An unauthenticated upgrade answers `401`. An upgrade with an `Origin` header must come from the daemon's own origin or one listed in `controlPlane.cors.allowedOrigins`.

## Scopes

### What a credential holds

| Credential | Scopes held |
| --- | --- |
| Operator token, device token minted without a list, sign-in user with role `admin` and no list | Every scope (admin). |
| Sign-in user without the `admin` role and no list | Every `read:` scope except the owner-private ones below and `read:telemetry-sensitive`. No `write:` scope and no `ingest:` scope. Not admin. |
| Device token with a scope list | Exactly that list. Not admin. A device token's list can never contain `*` (minting refuses it). |
| Sign-in user with a stored scope list | That list, never more than the role's default. Not admin. A stored list containing `*` counts as no list (the role's default set, admin for an `admin` user). |

A method requires every scope it lists, and an `admin` method also requires an admin credential. Some admin methods are additionally owner-only: the Agent's own credential is refused (for example `approvals.approve`, `approvals.deny`, `inbox.answer`, `sessions.permissionMode.set`). Answering what was put to the owner (`approvals.approve`, `approvals.deny`, `inbox.answer`, the purchase answers `payments.purchase.approve`, `payments.purchase.deny`, `payments.checkout.approve`, `payments.purchase.reconcile` and the standing authorizations `payments.standing.create` and `payments.standing.delete`) and entering a card (`payments.cards.create`, `payments.purchase.securityCode`) need the owner's own credential, not only an admin one: any other admin gets `403` `OWNER_ONLY`. Entering a card is also refused, `403` `CARD_ENTRY_TRANSPORT`, unless the request reached the daemon from its own machine, over TLS or over the tailnet. The owner is the operator token, an app on the daemon's own machine, the first sign-in user the daemon holds (the user created at first start), and a device the owner paired himself (`origin: owner-pairing`); an admin sign-in of anyone else and a full token minted for automation are admins, not the owner. A write that loosens a security, permission, judgment or payment setting is put to the owner when an admin who is not the owner makes it (see "A change only the owner makes").

`read:own-sessions` is the scope for a client without the admin role that follows its own work live: it receives the turns, tool calls, approvals and lifecycle notices of the sessions its principal created or was shared, and nothing of any other session (see "The least-privilege client"). A non-admin sign-in holds it by default.

The owner-private read scopes, which a non-admin sign-in does not get by default: `read:email`, `read:profile`, `read:profile-document`, `read:payments`, `read:occasions`, `read:memory`, `read:transcripts`, `read:pairing`, `read:remote`, `read:checkpoints`, `read:calendar`, `read:approvals`, `read:principals`, `read:browser-content`, `read:knowledge-content`, `read:channel-content`, `read:automation-content`, `read:fleet-content`, `read:skill-content`.

### Every scope

Each family has a `read:` scope for looking and a `write:` scope for changing; some families also have a `-content` read scope for the bodies (messages, pages, records) as opposed to their metadata. The complete list of scopes, with how many methods and event streams need each one and whether a read-only grant includes it, is "Operator scopes" in the reference; which scopes each method needs is in "Operator API methods" there.

Scopes that no method lists, because an HTTP route checks them directly:

| Scope | Checked by | Who has it |
| --- | --- | --- |
| `read:telemetry` | `GET /api/v1/telemetry/*` and the telemetry stream. | Every credential without its own scope list, including a non-admin sign-in; a scoped token only when its list names it. |
| `read:telemetry-sensitive` | The raw (unredacted) telemetry view, `?view=raw`. It also needs the setting `telemetry.includeRawPrompts` on; without it the answer is `403` `TELEMETRY_RAW_DISABLED`. | Admin credentials, and a token minted with it. Never part of a non-admin sign-in's default set, although it is not one of the owner-private scopes. |
| `ingest:telemetry`, `write:telemetry` | `POST /api/v1/telemetry/otlp/v1/traces`, `/logs` and `/metrics` (OTLP over HTTP into the daemon). Either one is enough. | Admin credentials, and a token minted with one of them. |

## Access: what each route family and event needs

Every method has one of three access levels, and an event has one of two:

- **public**: no credential.
- **scope** (the contract calls it `authenticated`): any valid credential that holds every scope the method lists. A narrowed device token or a non-admin sign-in can call it when it holds those scopes.
- **admin**: an admin credential (the operator token, a device token minted without a scope list, or a sign-in user with the `admin` role and no narrowing list), and the method's scopes. A non-admin is refused with `403` `ADMIN_REQUIRED` (`Gateway method requires admin access: <method>`, or `Admin role required` on some routes) whatever scopes it holds. A few admin methods need the owner himself (see "Scopes"); another admin is refused `403` `OWNER_ONLY`.

What a method may do is decided from the effects it declares (`effects` on its descriptor, for example `["approval.answer"]` or `["sessions.write", "record.destroy"]`); its access, scopes and owner-only mark are computed from them, so the contract says what the daemon enforces. A refusal body names the effect that refused (`effect`) and what is missing (`missing`: a scope such as `read:transcripts`, or `admin`, `owner`, `peer`).

Each method's access is in the Access column of "Operator API methods" in the reference (`authenticated` there is "scope" here). A client can also ask the daemon: `GET /api/control-plane/methods/{methodId}` answers `{"method":{...}}`, the method's descriptor wrapped in `method`, with the fields `id`, `title`, `description`, `category`, `access`, `scopes`, `effects` (the effects it causes, from which access and scopes are computed), `effect` (`read`, `write` or `outward`), `http` (its REST route, when it has one), `invokable`, `transport`, `source`, `inputSchema`, `outputSchema`, `repeat` (`safe`, `keyed` or `unsafe`: what sending it twice does, see "Idempotency and safe retries"), and, when the method declares them, `replay` (its retry key) and `errorCodes` (`[{code, status, meaning}]`). `GET /api/control-plane/methods` lists them all. By family (the method id's first part, as the contract groups them), the access of the methods that only read and of those that change something:

| Family | Reads | Writes |
| --- | --- | --- |
| accounts | scope | (none) |
| acp | scope | scope |
| approvals | scope | scope, except admin: `approvals.approve`, `approvals.cancel`, `approvals.claim`, `approvals.deny`, `inbox.answer`; the Agent's own credential claims none and cancels only an ask it raised itself (`OWNER_ONLY`, nothing changed), on this node or relayed |
| artifacts | admin | admin |
| auth | admin | admin |
| automation | scope | admin |
| batch | scope | admin |
| browser | scope | scope |
| calendar | scope | admin |
| channels | scope | scope, except admin: `channels.accounts.action.default`, `channels.accounts.action.named`, `channels.actions.invoke`, `channels.allowlist.edit`, `channels.allowlist.resolve`, `channels.authorize`, `channels.drafts.delete`, `channels.drafts.save`, `channels.inbox.applyLabels`, `channels.inbox.triage`, `channels.policies.update`, `channels.profiles.delete`, `channels.profiles.set`, `channels.routing.assign`, `channels.routing.delete`, `channels.targets.resolve`, `channels.tools.invoke` |
| checkin | scope | scope, except admin: `checkin.config.set` |
| checkpoints | scope | scope |
| ci | scope | scope |
| cloudflare | admin | admin |
| companion | scope | scope |
| config | admin | admin |
| continuity | scope | (none) |
| contracts | scope | scope |
| control-plane | scope | scope, except public: `control.auth.current`, `control.auth.login`, `control.auth.logout`; admin: `relay.pairing.mint`, `relay.codes.list`, `relay.codes.revoke`, `update.check` |
| cost | scope | (none) |
| deliveries | scope | scope |
| email | scope, except admin: `email.attachment.get`, `email.drafts.list`, `email.expectation.wait`, `email.inbox.read` | admin |
| flags | scope, except admin: `flags.status` | (none) |
| fleet | scope | scope, except admin: `fleet.interrupt`, `fleet.resume`, `fleet.stop` |
| health | scope, except admin: `runtime.state.get` | scope, except admin: `voice.local.install`, `voice.setup` |
| inbound | admin | admin |
| intelligence | scope | (none) |
| judgment | (none) | scope |
| knowledge | scope | scope, except admin: `homeassistant.homeGraph.generateHomeGraphPacket`, `homeassistant.homeGraph.generateRoomPage`, `homeassistant.homeGraph.import`, `homeassistant.homeGraph.ingestHomeGraphArtifact`, `homeassistant.homeGraph.ingestHomeGraphNote`, `homeassistant.homeGraph.ingestHomeGraphUrl`, `homeassistant.homeGraph.linkHomeGraphKnowledge`, `homeassistant.homeGraph.refinement.run`, `homeassistant.homeGraph.refinement.task.cancel`, `homeassistant.homeGraph.refreshDevicePassport`, `homeassistant.homeGraph.reindex`, `homeassistant.homeGraph.reset`, `homeassistant.homeGraph.reviewHomeGraphFact`, `homeassistant.homeGraph.syncHomeGraph`, `homeassistant.homeGraph.unlinkHomeGraphKnowledge`, `knowledge.candidate.decide`, `knowledge.ingest.artifact`, `knowledge.ingest.bookmarks`, `knowledge.ingest.browserHistory`, `knowledge.ingest.connector`, `knowledge.ingest.url`, `knowledge.ingest.urls`, `knowledge.issue.review`, `knowledge.job-run.cancel`, `knowledge.job.run`, `knowledge.lint`, `knowledge.projection.materialize`, `knowledge.refinement.run`, `knowledge.refinement.task.cancel`, `knowledge.reindex`, `knowledge.schedule.delete`, `knowledge.schedule.enable`, `knowledge.schedule.save`, `projectPlanning.decisions.record`, `projectPlanning.workPlan.clearCompleted`, `projectPlanning.workPlan.task.create`, `projectPlanning.workPlan.task.delete`, `projectPlanning.workPlan.task.status`, `projectPlanning.workPlan.task.update`, `projectPlanning.workPlan.tasks.reorder` |
| mcp | scope, except admin: `mcp.servers.reveal` | admin |
| media | scope, except admin: `multimodal.packet` | admin |
| memory | scope | admin |
| occasions | scope | scope, except admin: `occasions.acknowledge`, `occasions.answer`, `occasions.confirm`, `occasions.conflict.resolve`, `occasions.interview.answer`, `occasions.interview.record`, `occasions.plans.confirm`, `occasions.plans.remove`, `occasions.plans.update`, `occasions.remove`, `occasions.sweep`, `occasions.update` |
| pairing | scope | scope |
| panels | scope | admin |
| payments | scope | admin |
| permissions | scope | scope |
| principals | scope | scope |
| profile | scope | admin |
| providers | scope | admin |
| push | scope | scope |
| quota | scope | (none) |
| relay | scope, except admin: `stepup.credentials.list` | admin |
| remote | scope, except admin: `remote.backends.list` | admin |
| remote-access | scope | admin |
| review | scope | (none) |
| rewind | scope | scope |
| routes | scope, except admin: `routes.bindings.list` | admin |
| runtime | scope | scope |
| scheduler | admin | (none) |
| services | admin | admin |
| sessions | scope | scope, except admin: `sessions.close`, `sessions.create`, `sessions.delete`, `sessions.detach`, `sessions.followUp`, `sessions.inputs.cancel`, `sessions.inputs.deliver`, `sessions.messages.create`, `sessions.permissionMode.set`, `sessions.register`, `sessions.reopen`, `sessions.steer` |
| settings | admin | (none) |
| skills | scope | scope |
| tasks | scope | admin |
| telemetry | scope | (none) |
| voice | scope | admin |
| watchers | scope, except admin: `watchers.triggers.grant.list`, `watchers.triggers.history`, `watchers.triggers.list`, `watchers.triggers.preview`, `watchers.triggers.status` | admin |
| web-search | scope | admin |
| work-ledger | admin | admin |
| workspaces | scope | scope |
| worktrees | scope | scope |

Other route families outside the operator methods:

| Route | Access |
| --- | --- |
| `GET /api/sessions/{sessionId}/events` | admin |
| `GET /api/control-plane/events`, `/api/control-plane/ws` | any credential with `read:events`; what it receives depends on the event access below |
| `GET /v1/models` | any valid credential |
| `POST /v1/chat/completions`, `GET /v1/chat/completions/{id}` | admin |
| `GET /api/cluster/*`, `POST /api/cluster/*` | admin |
| `/api/remote/pair/request`, `/api/remote/pair/verify` | none (peer pairing) |
| `/api/remote/heartbeat`, `/api/remote/work/*` (peer side) | peer token |
| `/webhook/...` | each channel's own check |

### Access of every event

Every event needs `read:events`; some need more. Each event a client can subscribe to, with its catalog name, its SSE name (the `event:` line of a frame), its domain, its access and its scopes, is in "Event streams a client subscribes to" in the reference. A runtime domain's catalog name is `runtime.<domain>` and its SSE name is the domain name; the other events have their own SSE names (`control.approval_update` is `approval-update`). The rules that matter to a client:

- Admin only: the domains that carry a conversation or the daemon's inner state, among them `session`, `turn`, `tools`, `tasks`, `agents`, `gate` (approvals and the owner inbox), `config` and `fleet`, and the `approval-update`, `owner-inbox-update`, `hosted-session-update` and `session-update` events. One exception: a credential holding `read:own-sessions` receives the `turn`, `tools`, `gate` and `session` frames and the `approval-update` and `hosted-session-update` events of the sessions its principal created or an owner shared with it (`sessions.hosted.create`, `sessions.hosted.share`), frame by frame, and of no other session; a frame that names no session is withheld, except an `approval-update` when the credential also holds `read:approvals` (it may then read every approval with `approvals.list`, so it is sent each one). A change put to the owner answers `202` `OWNER_APPROVAL_PENDING` with `followable`: `false` when the caller may not read that approval, and the web UI then shows no waiting notice for it. It must name those domains (`?domains=turn,tools,gate,session`). Ownership is saved with the session and holds across a daemon restart.
- Any credential with the scopes: the rest, among them `providers`, `automation`, `surfaces`, `transport`, `ops` and the `ready` and `heartbeat` frames. `surface-message` also needs `read:transcripts`, and the `remote-*` events `read:remote`.
- An event a plugin adds is admin-only.
- Two frames are not in the catalog: `gap` (events were dropped, see "Reconnecting") and `closed` (the daemon ended the stream, see "Server-Sent Events"). Any stream can receive them.

### The least-privilege client

What a non-admin credential can and cannot do with conversations, for a device token holding `read:sessions`, `write:sessions`, `read:transcripts` and `read:own-sessions`:

| Action | Non-admin? | How |
| --- | --- | --- |
| List workspaces, create a hosted session, give it its first turn | Yes | `sessions.hosted.workspaces`, `sessions.hosted.create` with `initialPrompt` (not with `originSurface` `agent`). |
| Send a further turn (`sessions.followUp`, `sessions.steer`, `sessions.messages.create`) | No | Admin methods. |
| Stream the turn (text deltas, tool calls), its approvals and its lifecycle | Yes, its own sessions | `read:own-sessions`: `GET /api/control-plane/events?domains=turn,tools,gate,session` delivers the frames of the sessions this principal created or attached to, and the `approval-update` and `hosted-session-update` events for them. Every other session's frames are withheld. |
| Know the turn has ended | Yes | Live: `TURN_COMPLETED` on `turn`, or `hosted-session-update` with `hosted-session-turn-ended`. By polling: `sessions.hosted.list` (`read:transcripts`), where the session's `status` goes `running` then `idle`, and `turnCount` and `lastTurnAt` move. |
| Read the reply | Yes, also after the session ended | `sessions.hosted.history` (`read:transcripts`) returns `session` and `history` with the `user`, `assistant`, `system` and `tool` messages, for a live or an ended session, also after a daemon restart, for `hostedSessions.terminatedRetentionMs` (24 hours) after it ended. `sessions.hosted.attach` (`write:sessions` and `read:transcripts`) returns the same `history` while the session is live. `GET /api/sessions/{id}/messages` does not have the reply (see "7. Read the transcript"). |
| Cancel a running turn | Yes | `sessions.turns.cancel` (`write:sessions`). |
| Detach, kill | Yes | `sessions.hosted.detach`, `sessions.hosted.kill`. |
| Approve or deny a tool call the turn asks for | No | Admin and owner-only. In `ask-me` mode a non-admin's turn waits for the owner; with `read:own-sessions` the client sees the ask (`approval-update`) and its answer. |
| Run a task | No | `tasks.create` is admin. |

So the least-privilege client that works end to end is:

- **One turn per session, followed live:** a device token with `read:sessions`, `write:sessions`, `read:transcripts` and `read:own-sessions`. Open `GET /api/control-plane/events?domains=turn,tools,gate,session`, create the session with `initialPrompt`, follow its frames by its id until the turn ends, then call `sessions.hosted.history` and read the last `assistant` message in `history` (a failed turn leaves a `system` message instead, for example `No model 'openrouter:openrouter/free' for provider 'openrouter' in registry.`). Without `read:own-sessions`, poll `sessions.hosted.list` about once a second until the session's `status` is `idle` and its `turnCount` has grown. Kill or detach the session when done.

**The reply stays readable after the session ends.** A session whose detach policy is `kill` (the default, `hostedSessions.detachPolicy`) ends by itself when its last attached client detaches or its attachment lease lapses (an attach renews it; the lease is `leaseMs` on attach, 30 seconds to 24 hours, default `hostedSessions.attachmentTtlMs`, 10 minutes), when no client was ever attached and it has sat idle for one lease after its last turn, and when the daemon restarts. A `survive` session ends only when it is killed. Once ended, `sessions.hosted.attach` answers `409` `HOSTED_SESSION_TERMINATED` (the reason in brackets says why it ended), but `sessions.hosted.history` still returns the record and the whole transcript, the reply included, to the credential that created the session or one an owner shared it with (any admin credential reads any session), for `hostedSessions.terminatedRetentionMs` (24 hours) after it ended, and across a daemon restart. After that the id answers `404` `SESSION_NOT_FOUND`. Another non-admin credential is refused `403` `HOSTED_SESSION_NOT_OWNED`.

- **Several turns, approvals or tasks:** an admin credential. Use a device token minted without a scope list, so it can be revoked on its own.

## Calling a method

### REST routes

Path parameters are in the path; for `GET`, other inputs are query parameters; for `POST`, inputs are the JSON body. Example:

```sh
curl -sS -H "Authorization: Bearer $GV_TOKEN" 'http://127.0.0.1:3421/api/tasks?limit=5'
```

```json
{"queued":0,"running":0,"blocked":0,"totals":{"created":0,"completed":0,"failed":0,"cancelled":0},"tasks":[]}
```

### The invoke route

`POST /api/control-plane/methods/<methodId>/invoke` calls any invokable method by id. The request body is an envelope: the method's input goes under `body`, and `query` is optional.

```json
{ "body": { "<input field>": "<value>" }, "query": { } }
```

Sending the input without the envelope is refused:

```json
{"error":"Missing required field: body. Expected envelope shape: { query?, body }","status":400}
```

An unknown method id answers `404` `{"error":"Unknown gateway method","code":"METHOD_NOT_FOUND","status":404}`. A method that is in the catalog but cannot be dispatched by id (for example the streams, `/login`, `/logout`) answers `400` with code `NOT_INVOKABLE`. The response body is the method's output.

### The WebSocket

Open `ws://<daemon>/api/control-plane/ws?domains=<comma list>` (or `wss://`) with `Authorization: Bearer <token>` on the upgrade. Optional query parameter `lastEventId`: the `id` of the last event frame the client holds; the daemon replays what came after it (as `Last-Event-ID` does on the event stream), and the `ready` payload's `resume` says what the position turned into (`none`, `resumed`, or `unresolved` when it is no longer held: nothing was replayed, so re-read current state). Optional query parameter `clientKind`: `tui`, `web`, `slack`, `discord`, `ntfy`, `daemon` or `webhook` (default `web`). The daemon must serve the WebSocket (`controlPlane.streamMode` `websocket` or `both`; see "Live update streams" in the previous part); otherwise the upgrade answers `409` `STREAM_MODE_NOT_SERVED`.

Frames are JSON text. The client sends:

| Frame | Effect | Reply |
| --- | --- | --- |
| `{"type":"auth","token":"<optional>","domains":["session"],"label":"<optional>"}` | Confirms the principal and optionally adds domains to those the upgrade's `?domains=` subscribed. | `{"type":"auth","ok":true,"clientId":"cp-...","principalId":"shared-token"}` (with `withheldDomains` and `unrecognisedDomains` when some named domains are not served), or `ok:false` with `code` and `category` and the socket closes: `AUTH_REQUIRED` (`authentication`) for a refused credential, `UNKNOWN_EVENT_DOMAIN` (`bad_request`) when `domains` names no runtime event domain at all. |
| `{"type":"subscribe","domains":["turn","tools"]}` | Add event domains. | `{"type":"subscribed","clientId":"...","domains":[...]}`: `domains` are the ones delivered now; `withheldDomains` names those this credential may not read, `unrecognisedDomains` names that are not domains. A list with no known domain answers `{"type":"error","code":"UNKNOWN_EVENT_DOMAIN",...}`. |
| `{"type":"unsubscribe","domains":["tools"]}` | Remove domains (all when `domains` is omitted). A list with no known domain is refused, as for `subscribe`. | `{"type":"unsubscribed",...}` |
| `{"type":"ping"}` | Keep-alive. | `{"type":"pong","ts":1795022871821}` |
| `{"type":"call","id":"c1","methodId":"sessions.hosted.list","body":{}}` | Call a method by id. | `{"type":"response","id":"c1","ok":true,"status":200,"body":{...}}` |
| `{"type":"call","id":"c2","method":"GET","path":"/api/approvals"}` | Call a REST route. | `{"type":"response","id":"c2","ok":true,"status":200,"body":{...}}` |

In a `call` frame with `methodId`, `body` is the method's input itself (the frame is the envelope, so do not nest another `body`); in a `call` frame with `method` and `path`, `body` is the JSON body that route takes. A `call` frame may also carry `query` and `explicitUserRequest: true` (only when a person asked for this action just now). The `ready` event can arrive before the `auth` reply. A method id the daemon does not know answers `{"type":"response","id":"...","ok":false,"status":404,"body":{"error":"Unknown gateway method: <id>","code":"METHOD_NOT_FOUND",...}}` (over HTTP the text is `Unknown gateway method`, without the id). The daemon sends events as `{"type":"event","event":"<event name>","id":"<record id>","payload":{...}}`; the `id` is the position to present as `lastEventId` when connecting again. The `ready` payload names `withheldDomains` (asked for, not covered by the credential) and `unrecognisedDomains` (not domains); nothing arrives for either. The SDK's WebSocket connector sends no `domains` in its `auth` frame, resumes from the last `id` it received, and ends only the feeds of withheld (`EVENT_ACCESS_DENIED`) or unknown (`UNKNOWN_EVENT_DOMAIN`) domains. Observed opening of a socket subscribed to `session`:

```text
{"type":"event","event":"ready","payload":{"clientId":"cp-6e80f602","domains":["session"],"transport":"websocket","resume":{"resume":"none"}}}
{"type":"auth","ok":true,"clientId":"cp-6e80f602","principalId":"shared-token"}
{"type":"pong","ts":1795022871821}
{"type":"response","id":"c1","ok":true,"status":200,"body":{"sessions":[]}}
```

A call made after the credential was revoked answers `{"type":"response","id":"...","ok":false,"status":401,...}`.

## Error answers

### Reading an error answer

Every error is a JSON object. Only `error` (one sentence for a person) is always present; branch on `code`, never on the text. The other fields an error can carry (`code`, `status`, `category`, `state`, `next`, `hint`, `source`, `recoverable`, `requestId`, `retryAfterMs`, the provider fields, `requiredScopes`/`grantedScopes`/`missingScopes` on `MISSING_SCOPE`, and `changes` on `TARGET_CHANGED`) are described in "Error body" in the reference. What a client must know about them:

- Many answers carry only some fields: `{"error":"Invalid config key","status":400}` has no `code`; `{"error":"Unknown shared session","code":"SESSION_NOT_FOUND","status":404}` has no `category`. Read the HTTP status from the response, not from the body.
- `recoverable` is often absent; when present it settles whether to retry (see "Deciding whether to retry").
- A `429` gives its wait as `retryAfterMs` in the body or as the `Retry-After` header (seconds), or neither.
- `TARGET_CHANGED` (`409`) means what a preview or confirmation showed is no longer what the call would act on; nothing was done. `changes` lists each changed field as `{"field","was","now"}` (`now` is `null` when the target is gone) and `next` names the call that shows it again: look again, never repeat the same request. `CREDENTIAL_NOT_FOR_TARGET` means a credential was about to go to a daemon it was not issued for, and nothing was sent. `CREDENTIAL_DESTINATION_UNBOUND` (`409`, from `config.set`, `config.setMany` and `config.reset`) means the write would move where a configured credential is sent (`judgment.endpoint`, a channel's server or bridge URL such as `surfaces.ntfy.baseUrl`) without stating that credential; nothing was saved: send the destination together with its credential key in one `config.setMany` (its current value keeps it, an empty value or `none` clears it), or clear the credential first.
- Some refusals are not errors: a `200` with `"applied":false` and a `refusal` (approvals, the owner inbox), and a `202`/`409` with `"mode":"rejected"` (`POST /task` in a session, `sessions.steer`).
- `/v1/*` routes answer in the OpenAI error shape (see "OpenAI-compatible endpoints"); WebSocket calls wrap the body in `{"type":"response","ok":false,"status":...,"body":{...}}`.

Examples captured from a 3.3.2 daemon:

```json
{"error":"Authentication required","code":"AUTH_REQUIRED","category":"authentication","source":"runtime","status":401}
```

```json
{"error":"Missing required scope for approvals.list: read:approvals","code":"MISSING_SCOPE","category":"authorization","source":"permission","recoverable":false,"status":403,"state":"the credential does not hold read:approvals","next":["Use a credential that holds read:approvals, or an admin session."],"requiredScopes":["read:approvals"],"grantedScopes":["read:events","read:sessions","read:tasks","read:transcripts"],"missingScopes":["read:approvals"],"effect":"approvals.read","missing":"read:approvals"}
```

```json
{"error":"Gateway method requires admin access: sessions.create","code":"ADMIN_REQUIRED","category":"authorization","status":403,"effect":"sessions.administer","missing":"admin","next":["Sign in with an admin account or use the operator token."]}
```

```json
{"error":"Unknown shared session","code":"SESSION_NOT_FOUND","status":404}
```

```json
{"error":"Session is closed","code":"SESSION_CLOSED","status":409}
```

```json
{"error":"Route not found: /api/status","hint":"GET /api/control-plane/methods lists every method with its HTTP path; POST /api/control-plane/methods/{methodId}/invoke calls a method by its id.","code":"NOT_FOUND","category":"not_found","source":"runtime","recoverable":false,"status":404}
```

### Status codes

| Status | Meaning | What to do |
| --- | --- | --- |
| `400` | The input is wrong (`INVALID_ARGUMENT`, `INVALID_MESSAGE_ID`, `INVALID_KIND`, `UNKNOWN_EVENT_DOMAIN`, `NOT_INVOKABLE`, `MODEL_NOT_FOUND`, `MODEL_AMBIGUOUS`, `MODEL_NOT_SELECTABLE`, `TASK_NOT_RETRYABLE`). Nothing was changed. | Fix the input. Do not retry unchanged. |
| `401` | No valid credential (`AUTH_REQUIRED`, `PAIRING_OFFER_EXPIRED`, `PAIRING_TOKEN_ROTATION_DUE`, `RELAY_CODE_REVOKED` for a device whose relay code was revoked). | Get a new credential (for `RELAY_CODE_REVOKED`, pair the device for the relay again). |
| `401` | `STEP_UP_REQUIRED` (category `permission`): the credential was accepted, but a state-changing call over the relay needs a passkey confirmation; the body's `action` says what gets past it. | Sign a step-up challenge and send the call again; do not sign in again. |
| `403` | The credential lacks authority (`MISSING_SCOPE`, `ADMIN_REQUIRED`, `NOT_YOURS`, `PERMISSION_DENIED`, `EVENT_ACCESS_DENIED`, `CONTROL_PLANE_LOCAL_ONLY`, `SESSION_NOT_OWNED`, `HOSTED_SURFACE_FORBIDDEN`, `HOSTED_SESSION_NOT_OWNED`, `OWNER_ONLY`). | Use another credential, or change the setting named. |
| `404` | Not found (`NOT_FOUND`, `METHOD_NOT_FOUND`, `SESSION_NOT_FOUND`, `CONTRACT_NOT_FOUND`, `SESSION_NOT_LOCAL`, `TASK_NOT_FOUND`, `AGENT_NOT_FOUND`, `APPROVAL_NOT_FOUND`). | Check the id. |
| `409` | The state does not allow it (`SESSION_CLOSED`, `SESSION_ACTIVE`, `HOSTED_SESSION_STILL_RUNNING`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_IN_FLIGHT`, `IDEMPOTENCY_OUTCOME_UNKNOWN`, `STREAM_MODE_NOT_SERVED`, `CANCEL_NOT_ALLOWED`, `TASK_SETTINGS_UNAVAILABLE`). | Read the state, then act. |
| `429` | Rate limited (`RATE_LIMITED`). | Wait for `Retry-After` or `retryAfterMs`. |
| `500` | The daemon failed (`INTERNAL_ERROR`, `SESSION_AGENT_BIND_FAILED`, `IDEMPOTENCY_OUTCOME_UNKNOWN` on a repeat of a keyed request that failed partway). | Read the state before retrying. |
| `503` | A dependency is unavailable (`SERVICE_UNAVAILABLE`, `RELAY_DISABLED`). | Retry later. |
| `400` | `INVALID_ARGUMENT` also when the input does not match the method's schema (for example `client must be one of ["agent"]`, `sessionId is required`), and `INVALID_JSON` (`Invalid JSON body`: the body is not JSON). | Fix the input. |

Every code with its HTTP status, meaning and whether to retry is in the reference: "Codes any route may answer" (codes the request layer and the routes send) and "Codes a method declares" (each method's own codes, with the methods that declare it). For one method, `GET /api/control-plane/methods/{methodId}` lists its `errorCodes`. `INVALID_ARGUMENT` is used for any input the method refuses (a workspace outside the allowed roots, a malformed `routing`, a bad `scopes` list), not only for a body field that disagrees with the path.

### Codes that need more than their name

| Code | Status | What happened | What to do |
| --- | --- | --- | --- |
| `CONFIRMATION_REQUIRED` | `400` / `403` | The method declares a `confirmation` in the contract and the call did not meet it; nothing was changed. `confirm` (calendar writes, `email.send`): send `confirm: true` (`400` without it). `owner-request` (payments answers and standing authorisations, `memory.snapshots.restore`, channel routing and drafts): `confirm: true` from a credential that states a person asked, a sign-in, a paired device or an app on the daemon's machine (`403` when `confirm: true` came on another credential, and the reason says so). `not-declined` (profile, occasions, trigger grants, `email.inbox.update`, `email.draft.update`): refused `403` only when the caller declared `explicitUserRequest: false`. One body: `{"error":"<method>: <reason>","code":"CONFIRMATION_REQUIRED","field":"confirm","state":"nothing was changed","next":["..."]}`. | Review the change and send it again as the `next` step says. |
| `OWNER_ONLY` | `403` | The method is the owner's own act and the request came with the Agent's own credential (credential kind `agent`), or with an admin credential that is not the owner's (an admin sign-in of someone else, a token minted for automation), or such a credential imported settings. Body: `{"error":"<method id>: <effect> is the owner's own act; an admin cannot make it.","code":"OWNER_ONLY","category":"authorization","status":403,"effect":"<effect>","missing":"owner","next":["..."]}`; for the Agent's credential the error reads `<method id> is the owner's own act; a call the Agent makes for him is refused. The owner does it from his own app.` Owner-only methods include `approvals.approve`, `approvals.deny`, `inbox.answer`, `credentials.set`, `pairing.tokens.create`, `pairing.tokens.delete` and `sessions.permissionMode.set` (refused to the Agent), and the answers and card methods listed in "Scopes" (refused to every admin but the owner). | Not retryable with that credential. The owner does it from his own app. |
| `HOSTED_SESSION_TERMINATED` | `409` | The hosted session has ended; nothing can run in it. | Do not retry. Read its reply with `sessions.hosted.history` (kept for `hostedSessions.terminatedRetentionMs`); create a new session for more turns. |
| `OWNER_APPROVAL_PENDING` | `202` | A change that loosens a security, permission, judgment or payment setting was asked by an admin who is not the owner (an admin sign-in of someone else, a token minted for automation): nothing changed yet, the change was put to the owner as approval `approvalId` and is applied when he approves it. | Watch the approval (`approvals.list` with `approvalId`, or `approval-update`); do not send the change again. |
| `HOSTED_SESSION_LIMIT_REACHED` | `429` | `hostedSessions.maxSessions` hosted sessions already exist. No `Retry-After`. | Kill or detach a session, or raise the setting. A plain wait succeeds only if a session ends meanwhile. |
| `PAIRING_TOKEN_ROTATION_DUE` | `401` | A device token older than managed token rotation allows (`security.tokenAudit.managed` on, and the token's age past the rotation limit). Body `state`: `the token of "<name>" is <n> days old and managed token rotation (security.tokenAudit.managed) allows <m> days`. | Pair the device again for a new token, then revoke the old one. |
| `PAIRING_OFFER_EXPIRED` | `401` | A device token was not used within 15 minutes of being minted. | Mint a new one and use it at once. |
| `SESSION_NOT_LOCAL` | `404` | `This daemon does not host a live runtime for session <id>.`: a live-session control (`sessions.permissionMode.get`/`.set`, `sessions.contextUsage.get`, `sessions.turns.cancel`, `sessions.toolCalls.cancel`, `sessions.queuedMessages.*`) was asked for a session that has no model loop in this daemon: one a terminal app runs in its own process, a hosted session that ended, or an id nobody holds. A web chat (`companion-chat`) answers `sessions.permissionMode.get` and `.set` with the daemon-wide mode its turns run under (`.set` rewrites `permissions.mode`), and `sessions.contextUsage.get` with `409` `CONTEXT_USAGE_UNAVAILABLE`. | Act on it in the app that runs it, or use a live hosted session of this daemon (`sessions.hosted.list`). |
| `MODEL_NOT_FOUND`, `MODEL_AMBIGUOUS`, `MODEL_NOT_SELECTABLE` | `400` | The model named (`modelId` on `sessions.hosted.create`, `model`, `routing.modelId` or a fallback model on `tasks.create` and the session routes) is not in this daemon's model registry, is served by several providers, or cannot be chosen; `recoverable: false`. Nothing was created or started. | Do not retry; fix the model (provider-qualified for an ambiguous id). |
| `INVALID_JSON` | `400` | The body is not valid JSON. | Fix the body. |

### SDK kinds

The SDK (`@goodvibes/engine/errors`) turns every error into a `GoodVibesError` with a `kind`, computed from the wire `category` (for example `bad_request` becomes `validation`, `rate_limit` becomes `rate-limit`). The full mapping is "Categories and kinds" in the reference. The kind `contract` exists only in the client: the SDK raises it itself, for example when `operator.invoke()` is asked for an invoke-only method (`CONTRACT_MISMATCH`) or a response does not match the contract (`ContractError`). A daemon never sends `category` `contract`.

### Deciding whether to retry

Apply these in order, and give every request a limit on attempts (for example 5) and on total time, so that no rule below can loop forever:

1. The body says `"recoverable": false`: do not repeat the same request.
2. The body says `"recoverable": true`: repeat it, after `retryAfterMs` or `Retry-After` when given.
3. The same `500` body twice in a row: permanent. Do not retry; fix the request. (An unknown model is a `400` with `MODEL_NOT_FOUND`, not a `500`.)
4. `429` `HOSTED_SESSION_LIMIT_REACHED`: free a session first (see the table above); retrying alone does not help.
5. Status `408`, `429`, `500`, `502`, `503`, `504` or `529`: retryable (the SDK treats exactly these as transient). Wait `retryAfterMs` or `Retry-After` when given, otherwise back off (1, 2, 4 ... 30 seconds), and stop at the attempt limit. For a `500` on a write, read the state first (the write may have happened) unless the method is `safe` or the request carried its retry key.
6. Any other `4xx`: not retryable as is. `401` needs a new credential, `403` another credential or setting, `404` another id, `409` a different state (read it first), `400` a corrected request.

The SDK exposes its own answer as `error.recoverable` on every `GoodVibesError`; it follows rules 1, 2, 5 and 6, so apply rules 3 and 4 and the attempt limit yourself.

## Idempotency and safe retries

A client that loses a response cannot tell whether the request was applied. Every method declares what a repeat does, read from its handler, as `repeat` on `GET /api/control-plane/methods/{methodId}` (and the Retry column of "Operator API methods" in the reference):

- `safe`: a repeat changes nothing more. Every read is safe, and so is a write that sets what is already set or finds the thing already done or gone (a second delete answers `404` or `deleted: false`, a second decision `applied: false`). Send it again.
- `keyed`: safe when the call carries its retry key, named in `replay` (`in` `header` or `body`, `name`, and what a repeat returns). Generate the key once per logical request, keep it, and send the same key on every retry.
- `unsafe`: a repeat acts again (a second record, a second browser tab, a second card). After a lost response, read the state and look for what you did before sending again. Two methods that pay for work are `unsafe` because their answer cannot be kept for a replay: `voice.tts.stream` (the audio streams) and `voice.realtime.session` (it hands out a one-time session credential). Every other write that takes money, sends a message or starts work has a key.

Every write that takes money, sends a message or starts work and has no key of its own takes the shared key: the `Idempotency-Key` header (1 to 255 letters, digits, `.`, `_`, `:` or `-`; the one rule for every key a client sends to name an operation, `messageId`, `clientMessageId` and `idempotencyKey` included). Over the method-invoke envelope it may be sent as `idempotencyKey` beside `body` (`{"body":{...},"idempotencyKey":"..."}`), and on a WebSocket `call` frame as `idempotencyKey`. A repeat of the same request (same method, path and body; for a multipart or raw upload, the same fields and the same file content, however the body is encoded, so a new multipart boundary is still the same request) by the same credential under the same key, within a day and across a daemon restart, returns the first answer with the header `Idempotent-Replayed: true` and does not act again. The same key with a different request is `409` `IDEMPOTENCY_KEY_REUSED`; a repeat while the first is still running is `409` `IDEMPOTENCY_KEY_IN_FLIGHT` with `recoverable: true`, `retryAfterMs` and a `Retry-After` header (send it again with the same key after that wait); a repeat after the daemon stopped in the middle of the first is `409` `IDEMPOTENCY_OUTCOME_UNKNOWN`, and a repeat of a first request that failed partway is `500` `IDEMPOTENCY_OUTCOME_UNKNOWN` (either way: check the state, do not send again). A refusal (`4xx`) is not remembered, so the corrected request may use the same key. Among these: `tasks.create`, `tasks.retry`, `sessions.hosted.create`, `acp.sessions.create`, `automation.jobs.run`, `automation.schedules.run`, `automation.runs.retry`, `automation.heartbeat.run`, `watchers.run`, `checkin.run`, `channels.test.send`, `channels.actions.invoke`, `channels.tools.invoke`, `calendar.events.create`, `payments.checkout.approve`, `payments.standing.create`, `remote.peers.invoke`, `devices.capability.request`, `push.subscriptions.verify`, `notifications.deadLetters.replay`, `companion.chat.messages.edit`, `.retry` and `.steer`, `contracts.reply`, `contracts.retryUnit`, `media.generate`, `media.transform`, `batch.jobs.create`, `knowledge.job.run` and the `refinement.run` methods; the ingests, which fetch, extract and enrich again on a repeat (`knowledge.ingest.url`, `.urls`, `.bookmarks`, `.browserHistory`, `.connector` and `.artifact`, `homeassistant.homeGraph.ingestHomeGraphUrl`, `.ingestHomeGraphNote` and `.ingestHomeGraphArtifact`, `multimodal.writeback`); `homeassistant.homeGraph.reindex` (with `force` it enriches again); `config.set`, `config.setMany`, `config.reset` and `sessions.permissionMode.set` (from a paired device, a loosening change asks the owner); `watchers.update` (a running watcher restarts and runs at once); `worktrees.setup.run` (it runs the setup commands); writes that schedule paid work for later (`automation.schedules.create`, `watchers.create`, `ci.watches.create`, `knowledge.schedule.save`); `approvals.raise` (it prompts the owner); `calendar.events.update` and `calendar.ics.import` (they can notify attendees); and the paid queries whose repeat would pay again (`knowledge.ask`, `homeassistant.homeGraph.askHomeGraph`, `web_search.query`, `media.analyze`, `multimodal.analyze`, `voice.stt`, `voice.tts`, `channels.inbox.triage`, `memory.vector.rebuild`). The SDK sends one generated key on every attempt of these calls, and retries a `safe` call by itself. Within its attempts it also repeats a keyed call answered `IDEMPOTENCY_KEY_IN_FLIGHT`, waiting at least the larger of the `Retry-After` header and the body's `retryAfterMs`; every error a keyed call throws carries the key it sent (`error.idempotencyKey`, also on `error.transport.idempotencyKey`), so a caller that repeats the call after the SDK gives up passes that key as the `idempotencyKey` option and gets the first answer instead of a second action. A keyed answer keeps the route's `Retry-After` and `Location` headers, and its replay sends them again.

Methods with a key of their own:

| Method | Key | Behaviour on a repeat |
| --- | --- | --- |
| `sessions.messages.create`, `sessions.steer`, `sessions.followUp` | Body `messageId`: 1 to 255 letters, digits, `.`, `_`, `:` or `-`, chosen by the caller. | The same `messageId` to the same session from the same surface returns the receipt of the input already recorded (same `input.id`, same message) instead of recording a second one; a repeat that arrives while the first is still being stored waits for it and answers as it does (accepted once stored, or the same failure). The match is on the key alone (surface kind, surface id, `messageId`, session), not on the body: a repeat with a different body returns the first input and the new text is dropped. An input that failed is run again under its first text. Another format is refused with `400` `INVALID_MESSAGE_ID`. |
| `contracts.start` | Header `Idempotency-Key` (or body `idempotencyKey`; the header wins). | Same key and same body: the first contract is returned with header `Idempotent-Replayed: true` and `replayed: true`. Same key, different body: `409` `IDEMPOTENCY_KEY_REUSED`. Kept across daemon restarts and shared by every process on the project; a key that cannot be recorded starts nothing (`503` `CONTRACT_KEY_UNRECORDED`), and a repeat while another process is still starting the first is `409` `IDEMPOTENCY_KEY_IN_FLIGHT`. |
| `contracts.dispatch` | Body `idempotencyKey`. | The same caller's repeat with the same `ask` and workspace returns the first dispatch's contract and creates no second session; the same key with another ask or workspace is `409` `IDEMPOTENCY_KEY_REUSED`. Kept across daemon restarts with the workspace's contract store, as for `contracts.start` (`503` `CONTRACT_KEY_UNRECORDED`, `409` `IDEMPOTENCY_KEY_IN_FLIGHT`). The session made for the dispatch ends when its contract settles, also after a restart. |
| `email.send` | Body `clientSendId` (8 to 128 letters, digits, `-` or `_`). | The same id and message within ten minutes returns the first answer; the same id with another message is `409` `CLIENT_SEND_ID_REUSED`. |
| `companion.chat.messages.create` | Body `clientMessageId`. | Returns the first message's id and starts no second turn, also after a daemon restart (the key is saved with the message and read back with the chat). The `202` comes once the message is synced to disk; a repeat that arrives while the first is still being saved waits for it. The same key with a different text is `409` `IDEMPOTENCY_KEY_REUSED`. A repeated steer returns the turn the first one cancelled. The message carries the key as `clientMessageId` in every listing, so a client matches its own pending send to it by the key, never by its text. |
| `payments.checkout.begin` | Body `requestId`. | An admitted `requestId` never starts another purchase; read the outcome with `payments.purchase.status`. |
| `inbox.post` | Body `key`. | While an item the same credential posted under that `key` is open, a repeat returns it with `created: false`; another credential's post under the same key is its own item. |
| `approvals.cancel` | Body `holdId` (with `release: true`). | A repeated release with the same `holdId` gives up nothing more. |
| `automation.jobs.create` | Body `id`. | A job with that id already there is returned unchanged. |
| `homeassistant.conversation.stream` | Body `messageId`, chosen by the caller. | The same `messageId` in the same conversation posts nothing again: the repeat streams the first turn's outcome as its final or error frame. A stream the client drops cancels its own turn, so a repeat after a drop reports it cancelled. A daemon restart forgets the id. |
| `memory.records.add` | Body `id` (`mem_<base36 time>_<8 hex>`), generated by the caller. | The same id and record returns the stored row; the same id with another record is refused. |
| `projectPlanning.workPlan.task.create` | Body `task.taskId`. | A task with that id already there refuses the repeat; nothing more is added. |
| `sessions.register` | Body `sessionId`. | A repeat is a heartbeat and returns the existing record. |
| `pairing.tokens.create`, `pairing.tokens.migrate` | Body `attemptId` (8 to 128 letters, digits, `.`, `_`, `:` or `-`). | While the token is unused, the repeat returns the same token id with a new secret, and the earlier secret stops working. |
| `workLedger.submit`, `workLedger.importLegacy` | Body `requestId`. | Same id, same content: the original result with `replayed: true`. |
| `workLedger.intake.capture`, `.admit`, `.resume`, `workLedger.turn.start`, `.startAgent` | Body `inputId`. | One input is captured, admitted and delivered once; a repeat joins or reports the first. |
| `workLedger.execution.start`, `.resume` | Body `attemptId`. | One attempt runs once; a repeat returns the same execution. |

The HTTP response to a repeated `messageId` has the same status (`202`) and does not carry a `duplicate` field; recognise a repeat by the same `input.id` and `message.id` in the response. Its `mode` reports the input's current progress (for example `continued-live`), not the first answer's `mode`. Two scripts that send to one session with the default surface (`surfaceKind` `web`, `surfaceId` `surface:web`) share one key space: give each script its own `surfaceId`, or messageIds that cannot collide. Choose a new `messageId` for every new message.

The writes a client needs most:

| Write | Repeat after a lost response |
| --- | --- |
| Create a hosted session: `sessions.hosted.create` | Keyed (`Idempotency-Key`): the same key returns the first session. Without one, a repeat creates a second session. |
| Create a shared session: `sessions.create` | `unsafe`: look first with `GET /api/sessions` and create again only if it is not there. |
| Send a message or turn: `sessions.followUp`, `sessions.steer`, `sessions.messages.create` | Keyed with the same `messageId` (above). |
| Run or retry a task: `POST /task` (`tasks.create`), `POST /api/tasks/{taskId}/retry` | Keyed (`Idempotency-Key`): the same key returns the first answer and starts no second agent. |
| Decide an approval: `POST /api/approvals/{id}/approve` or `/deny`, `inbox.answer` | `safe`: the first decision wins. A repeat, or a different decision afterwards, answers `200` with `"applied":false`, a `refusal` (`APPROVAL_SETTLED`) and the current `reading`; nothing changes. |
| Write a setting: `POST /config` (`config.set`), `config.setMany`, `config.reset` | Keyed (`Idempotency-Key`): writing the same value again leaves the same state, but a paired device's change that loosens a setting is put to the owner as an approval, and each unkeyed repeat asks him again. |

## Sessions: shared and hosted

A shared session is the record every conversation has: its messages, queued inputs, participants and status (`active` or `closed`). The `sessions.*` REST methods work on shared sessions.

A hosted session is a shared session whose model loop runs inside the daemon. `sessions.hosted.*` (invoke-only) create, attach, detach, list, share and kill hosted sessions. A credential below admin lists, attaches to, reads and kills only the sessions it created or an owner shared with it; another session's attach or kill is refused `403` `NOT_YOURS` naming `session.share`. Attaching never adds an owner: an owner (or an admin) adds one with `sessions.hosted.share` `{ "sessionId": "<id>", "principalId": "<user name or pairing:<id>>" }`, and the new owner may then attach, read the transcript and watch the session's turns live. A principal the daemon does not know (no such user, no live pairing) is refused `404` `PRINCIPAL_NOT_FOUND`. `sessions.hosted.unshare` with the same body undoes it: the principal is removed from the owners and its attached clients are detached at once; the last owner is never removed (`409` `HOSTED_SESSION_LAST_OWNER`). Below admin, the live-turn verbs (`sessions.turns.cancel`, `sessions.toolCalls.cancel`, `sessions.queuedMessages.list/edit/delete`) act only on a session the caller owns (`403` `NOT_YOURS` otherwise), and `sessions.list`, `sessions.search`, `GET /api/sessions/{id}` and `/messages` show a hosted session only to its owners. A hosted session's id (`hosted-<uuid>`) is also its shared-session id, so the `sessions.*` routes work on it: `sessions.followUp` and `sessions.steer` drive its turns, `sessions.turns.cancel` cancels a turn, and `GET /api/sessions/{id}/messages` lists the user messages sent to it through those routes. Its replies are read with `sessions.hosted.history` (live or ended) or `sessions.hosted.attach` (live), not from `/messages` (see "7. Read the transcript").

For an automated client that wants the model to do work, create a hosted session. A shared session made with `sessions.create` has no model loop of its own; its inputs wait for a surface to collect them.

How to send text to a session:

| Method | Route | Use |
| --- | --- | --- |
| `sessions.followUp` | `POST /api/sessions/{sessionId}/follow-up` | Start a new turn when the session is idle, or queue one to run after the current turn. Use this for a hosted session. |
| `sessions.steer` | `POST /api/sessions/{sessionId}/steer` | On a session answered by a running agent, hand the text to that agent now. On a hosted session it behaves exactly like `sessions.followUp` (see below). |
| `sessions.messages.create` | `POST /api/sessions/{sessionId}/messages` | Append a user message with routing by `kind` (`message`, the default; `task`; `followup`). With the default `kind` the message is queued as the session's next follow-up and the response is `202` `{"messageId":"...","sessionId":"...","inputId":"...","mode":"..."}` (`messageId` only when one was sent); a terminal running the session runs the turn and reports its answer, else the daemon answers it. An unknown `sessionId` is refused with `404` `SESSION_NOT_FOUND` for every `kind`; nothing is recorded or started. |

All three are admin methods with scope `write:sessions` and accept `messageId`, `surfaceKind`, `surfaceId` and `routing` (provider, model, fallbacks, reasoning effort, tool list, execution intent). A missing or empty `body` is refused with `400` (`Missing shared session steer body`, `Missing shared session follow-up body`).

### Steer and follow-up on a hosted session

A hosted session has no agent id of its own; its loop is the session's "surface". So for a hosted session the broker queues every steer and follow-up for the hosted engine, whatever state the session is in, and answers `202` with `"mode":"queued-for-surface"` and `"agentId":null`. The engine then collects the input and submits it to the session's loop:

- If the session is idle, the text starts a new turn at once. This is true for `sessions.steer` as well; `allowSpawnFallback` is not needed and changes nothing for a hosted session.
- If a turn is running, the text waits and runs as the next turn after the current one. Inputs of one session are delivered one after another, in the order they were accepted. While it waits inside the loop it is listed by `GET /api/sessions/{sessionId}/queued-messages`, where it can be edited or deleted.

The `409` `"mode":"rejected"` answer (`No active agent accepted the steer request.`) applies only to a session whose agent is running but did not take the steer; a hosted session never gets it. On a closed session both methods answer `409` `SESSION_CLOSED`; on an unknown id, `404` `SESSION_NOT_FOUND`.

## Starting a hosted session and sending a turn

This is the complete sequence for a script. Every request uses an admin token in `$GV_TOKEN`. The example responses are from a 3.3.1 daemon; ids, times and paths differ on your machine.

### 1. Check the credential

```sh
curl -sS -H "Authorization: Bearer $GV_TOKEN" http://127.0.0.1:3421/api/control-plane/auth
```

Continue only when `authenticated` is `true` and `admin` is `true`.

### 2. Find an allowed workspace

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/api/control-plane/methods/sessions.hosted.workspaces/invoke -d '{"body":{}}'
```

```json
{"roots":["/home/alex/projects/app"]}
```

`workspaceRoot` must be one of these roots or a folder inside one. To add a root, call `workspaces.registrations.add` (`POST /api/workspaces/registrations`, scope `write:workspaces`). The home directory, the filesystem root and the daemon's state directory are refused.

### 3. Create the session

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/api/control-plane/methods/sessions.hosted.create/invoke \
  -d '{"body":{"workspaceRoot":"/home/alex/projects/app","title":"API demo","detachPolicy":"survive"}}'
```

```json
{"session":{"id":"hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c","workspaceRoot":"/home/alex/projects/app","title":"API demo","status":"idle","detachPolicy":"survive","effectiveDetachPolicy":"survive","attachedClients":[],"createdAt":1795021975653,"updatedAt":1795021975653,"turnCount":0,"messageCount":0,"restoredFromDisk":false,"contractIds":[],"permissionMode":"jev-decides"}}
```

Inputs of `sessions.hosted.create`:

| Field | Required | Meaning |
| --- | --- | --- |
| `workspaceRoot` | yes | Absolute path of an allowed folder. |
| `title` | no | Shown in lists. Default: the first prompt. |
| `modelId` | no | A model registry key; checked now, so an unknown, ambiguous or unselectable model is refused here with `400` (see the refusals below). Default: the daemon's current model. |
| `initialPrompt` | no | Submitted as the first user message. The call does not wait for that turn. |
| `detachPolicy` | no | `kill` or `survive`. Default: `hostedSessions.detachPolicy` (`kill`). Use `survive` for a script that may disconnect. |
| `clientId` | no | Attaches this client at creation. |
| `originSurface` | no | `agent`, `tui` or `webui`: whose settings and prompt the session uses. `agent` needs an admin caller (`403` `HOSTED_SURFACE_FORBIDDEN` otherwise). |

Refusals, observed on a 3.3.1 daemon:

| Status | Body | Cause | What to do |
| --- | --- | --- | --- |
| `400` | `INVALID_ARGUMENT`, for example `'/etc' is outside the folders this daemon runs work in (/home/alex/projects/app). Pick one of them, or register the project first: run goodvibes-agent workspaces register --yes in it, or open it in goodvibes and choose Register.` | `workspaceRoot` outside the allowed roots. | Pick an allowed root. |
| `400` | `{"error":"sessionId is required","code":"INVALID_ARGUMENT","category":"bad_request","status":400}` (this example from `sessions.hosted.attach`) | The input does not match the method's schema. | Fix the input. |
| `409` | `{"error":"Hosted session <id> is unavailable: it is terminated (<reason>).","code":"HOSTED_SESSION_TERMINATED",...}` (from `sessions.hosted.attach` and the other `sessions.hosted.*` calls on an ended session) | The session ended (killed, detached under the `kill` policy, the daemon restarted). | Do not retry. Read its history with `sessions.hosted.history`; create a new session for more turns. |
| `429` | `{"error":"This daemon already hosts 1 sessions, the configured maximum (hostedSessions.maxSessions). Kill one, or raise the setting.","code":"HOSTED_SESSION_LIMIT_REACHED","category":"rate_limit","status":429}` | `hostedSessions.maxSessions` live sessions already exist. No `Retry-After` is sent. | Waiting does not help unless a session ends: kill or detach one (`sessions.hosted.list`, then `sessions.hosted.kill`), or raise the setting. |
| `400` | `{"error":"Model 'nope:nope' is not in this daemon's model registry; name a model it holds, or none for its current model.","code":"MODEL_NOT_FOUND",...}` (`MODEL_AMBIGUOUS` for a bare id several providers serve, `MODEL_NOT_SELECTABLE` for one that cannot be chosen) | `modelId` names no model this daemon can run. | Do not retry; pick a model from the registry or leave `modelId` out. |

The session starts in the permission mode shown in `permissionMode`. Change it with `POST /api/sessions/{sessionId}/permission-mode` and body `{"mode":"ask-me"}` (`ask-me`, `jev-decides`, `just-vibes`, `yolo` or `plan`; admin, owner-only). `GET /api/sessions/{sessionId}/permission-mode` answers `{"sessionId","mode","chosenMode","reason","words"}`: `mode` is the mode in force (the one that decides the session's calls), `chosenMode` the mode the session chose or the saved one, and `reason`, present only when they differ, why (for example `jev-decides` runs as `ask-me` while no decision model is set or the set one is not answering). `words` says the same for a person: `chosen` (`Jev decides`), `inForce` (`asking you for now`) and `because` (`no decision model set`, `decision models switched off`, `not measured yet`, `decision model unreachable` or `decision model failing`) when the two differ, `sentence` (what the mode in force does) and `asksBefore` (what GoodVibes asks you before). The web UI reads `words` for session `runtime`, the daemon-wide mode its chats run under. Permission modes are explained in "Permissions, decisions and safety".

### 4. Open the event stream before sending

Open the session's own stream so no event is missed:

```sh
curl -sS -N -H "Authorization: Bearer $GV_TOKEN" \
  http://127.0.0.1:3421/api/sessions/hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c/events
```

`GET /api/sessions/{sessionId}/events` is a Server-Sent Events stream of that session's events on the default domains plus `tools`. It needs an admin credential (`403` `ADMIN_REQUIRED` otherwise). A non-admin client holding `read:own-sessions` follows its own sessions on `GET /api/control-plane/events?domains=turn,tools,gate,session` instead (see "The least-privilege client"). The walkthrough below uses an admin token.

The stream opens with:

```text
event: ready
data: {"clientId":"shared-session:hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c:60e06900","domains":["session","tasks","agents","automation","routes","control-plane","deliveries","surfaces","watchers","transport","ops","knowledge","providers","turn","tools"],"transport":"sse","resume":{"resume":"none"}}
```

### 5. Send the turn

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/api/sessions/hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c/follow-up \
  -d '{"body":"Say hello in one word.","messageId":"demo-2"}'
```

`202 Accepted`:

```json
{"session":{"id":"hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c","kind":"hosted","project":"/home/alex/projects/app","title":"API demo","status":"active","createdAt":1795021975670,"updatedAt":1795022021931,"lastMessageAt":1795022021930,"lastActivityAt":1795022021931,"messageCount":2,"pendingInputCount":1,"routeIds":[],"surfaceKinds":["service","web"],"participants":[{"surfaceKind":"service","surfaceId":"daemon:hosted-sessions","lastSeenAt":1795021975670},{"surfaceKind":"web","surfaceId":"surface:web","lastSeenAt":1795022021929}],"metadata":{"surfaceManaged":true}},"message":{"id":"smsg-0031a27e","sessionId":"hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c","role":"user","body":"Say hello in one word.","createdAt":1795022021930,"surfaceKind":"web","surfaceId":"surface:web","metadata":{"sessionIntent":"follow-up"}},"input":{"id":"sin-3aff9d7a","sessionId":"hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c","intent":"follow-up","state":"queued","correlationId":"session-input:sin-3aff9d7a","causationId":"smsg-0031a27e","body":"Say hello in one word.","createdAt":1795022021930,"updatedAt":1795022021930,"surfaceKind":"web","surfaceId":"surface:web","metadata":{"providerMessageKey":"web:surface:web::demo-2:session:hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c"}},"mode":"queued-for-surface","agentId":null}
```

Sending the same `messageId` again, with this body or any other, returns the same `input.id` (`sin-3aff9d7a`) and message, with `mode` `continued-live` and the input's current state, and records nothing new. In testing, a second follow-up with `"messageId":"k1"` and a different body returned the first message's id and text.

### 6. Read the turn from the stream

The stream then carries, in order (payloads shortened):

```text
event: session-update
data: {"event":"session-message-appended","payload":{"sessionId":"hosted-7f45...","message":{"id":"smsg-0031a27e","role":"user","body":"Say hello in one word.",...}},"createdAt":1795022021930}

event: session-update
data: {"event":"session-input-queued","payload":{"sessionId":"hosted-7f45...","inputId":"sin-3aff9d7a","intent":"follow-up","state":"queued",...},"createdAt":1795022021930}

event: hosted-session-update
data: {"event":"hosted-session-turn-started","session":{"id":"hosted-7f45...","status":"running",...},"createdAt":1795022021935,"detail":"a turn was submitted"}

event: turn
data: {"type":"TURN_SUBMITTED","ts":1795022021934,"traceId":"hosted-7f45...:70f47a4e-...","sessionId":"hosted-7f45...","source":"orchestrator","payload":{"type":"TURN_SUBMITTED","turnId":"70f47a4e-9c8f-47b2-8bdc-a2e6f4d78565","prompt":"Say hello in one word.",...}}

event: turn
data: {"type":"LLM_REQUEST_STARTED",...,"payload":{"type":"LLM_REQUEST_STARTED","turnId":"70f47a4e-...","provider":"openrouter","model":"openrouter/free",...}}

event: turn
data: {"type":"STREAM_DELTA",...,"payload":{"type":"STREAM_DELTA","turnId":"70f47a4e-...","content":"Hello.","provisional":true}}

event: turn
data: {"type":"LLM_RESPONSE_RECEIVED",...,"payload":{"type":"LLM_RESPONSE_RECEIVED","turnId":"70f47a4e-...","provider":"openrouter","model":"openrouter/free","toolCallCount":0,"inputTokens":18104,"outputTokens":7,"durationMs":1741,"retries":0,"costSource":"unknown"}}

event: hosted-session-update
data: {"event":"hosted-session-turn-ended","session":{"id":"hosted-7f45...","status":"idle","turnCount":1,"messageCount":2,...},"createdAt":1795022023832,"detail":"completed"}

event: turn
data: {"type":"TURN_COMPLETED",...,"payload":{"type":"TURN_COMPLETED","turnId":"70f47a4e-9c8f-47b2-8bdc-a2e6f4d78565","response":"Hello.","stopReason":"completed"}}

event: session-update
data: {"event":"session-input-completed","payload":{"sessionId":"hosted-7f45...","inputId":"sin-3aff9d7a","intent":"follow-up","state":"completed",...},"createdAt":1795022023833}
```

Every event frame of this stream also carries an `id:` line (for example `id: evt-78d3f857`), omitted above; keep the last one for reconnecting.

How to read it:

- To tie your input to its turn: `TURN_SUBMITTED` carries `payload.origin.metadata.correlationId` = `session-input:<input.id>`, the `input.id` the follow-up answered with. Take the `turnId` from that frame; every later turn frame carries it.
- `STREAM_DELTA` carries text as it arrives; `provisional: true` text may still be revised.
- A turn ends with exactly one of `TURN_COMPLETED` (with the final `response` and `stopReason`), `TURN_ERROR`, `TURN_CANCEL` or `PREFLIGHT_FAIL`. Wait for one of these with your `turnId`. The `hosted-session-turn-ended` update can arrive before `TURN_COMPLETED` (it did in the capture above); no order between them is promised, so do not stop on it.
- `TURN_ERROR` carries the facts the terminal programs word their failure row from: `status` and `code` when the provider failure had them, `attempts` and `attemptTimes` (requests to the provider that failed last), `provider`, `providerName` and `model`, `changes` (what the turn's successful tool calls changed before it stopped: `files` written, `commands` run, `messages` sent, `unknown` tools of undeclared effect; absent when not recorded), `fallbackOrderSet` and `fallbackNote`, and `refusal` (`no-provider` or `no-model`, with `stopReason` `preflight_failed`) when the turn was refused before any request. `readTurnFailure` from `@goodvibes/engine/platform/platform/core/turn-failure` (no Node imports) turns them into the same headline, cause, next steps, tip and details, and keeps the facts beside the words (`attempts.count` and `attempts.times`; `changed.known`, `files`, `commands`, `messages`, `unknown`), so `Nothing was changed.` is said only when the record shows it. A failed companion reply stores that reading as its `failureReason`, with the same attempts and changes counted by the companion turn. The web UI draws the same row from it on the failed reply (Try again, Use another model, Details, and the backup-model tip as a link to Settings, Models and providers), so it reads the same after a reload.
- Tool activity arrives on the `tools` domain as `TOOL_RECEIVED`, `TOOL_EXECUTING`, `TOOL_SUCCEEDED` and `TOOL_FAILED`.
- The input's final state arrives as `session-input-completed` (or failed).
- Payload fields of every event are in "Events" in the reference.

### 7. Read the transcript

The model's replies of a hosted session are read with `sessions.hosted.attach`:

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/api/control-plane/methods/sessions.hosted.attach/invoke \
  -d '{"body":{"sessionId":"hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c","clientId":"my-script"}}'
```

It returns the hosted session and its `history`: the loop's own transcript, with roles `user`, `assistant`, `system` and `tool`, including tool calls. The last `assistant` message is the reply; a failed turn leaves a `system` message instead. It also attaches the client: attach again with the same `clientId` to renew the lease (`leaseMs` sets it for this attachment), and detach when done (step 9).

`GET /api/sessions/{sessionId}/messages` (and `GET /api/sessions/{sessionId}`, which returns the record with its newest 100 messages) is the shared session's record, not the loop's transcript. For a hosted session it holds the user messages sent through `sessions.followUp`, `sessions.steer` or `sessions.messages.create`, and no replies: the hosted loop settles each input it ran without writing its answer into the shared session (from the code: `settleNativeTurnInput` only marks the input `completed`, `failed` or `cancelled`). An `initialPrompt` given to `sessions.hosted.create` goes straight to the loop and is not there either. Use `/messages` to see what was sent, and `attach` to see what was answered.

### 8. Cancel a turn, if needed

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/api/sessions/hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c/turns/cancel \
  -d '{"expectedTurnId":"70f47a4e-9c8f-47b2-8bdc-a2e6f4d78565"}'
```

The response `status` is `cancellation-requested`, `already-ended`, `stale-turn` (another turn is running; `activeTurnId` names it) or `turn-not-found`. Acceptance does not mean the turn has stopped; wait for its end event. A single tool call can be cancelled with `POST /api/sessions/{sessionId}/tool-calls/{callId}/cancel`.

### 9. Finish

- To leave it running for later: `sessions.hosted.detach` with `sessionId` and `clientId`. With `survive` it stays idle; with `kill` it ends when the last client leaves.
- To end it: `sessions.hosted.kill` with `sessionId`. The record is kept with reason `killed`.

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/api/control-plane/methods/sessions.hosted.kill/invoke \
  -d '{"body":{"sessionId":"hosted-7f45bf4b-2f52-4c97-a54f-2a93a23c443c"}}'
```

After that, sending to it answers `409` `{"error":"Session is closed","code":"SESSION_CLOSED","status":409}`. `POST /api/sessions/{sessionId}/close` on a hosted session that is still running answers `409` `HOSTED_SESSION_STILL_RUNNING`; kill it instead.

## Answering approvals

When the permission mode needs the owner to decide a tool call, the gate raises an approval and the turn waits.

1. Watch for it. Every approval change arrives as event `approval-update` on domain `gate`, with the whole `approval` record and its `reading` (below). Every record carries `revision` (1 when raised, one more on a claim, a decision or an end; a note on the ask, such as a prompt that could not be delivered, or a surface joining or releasing it, does not move it) and `sequence` (one more on every write): apply a frame only when its `sequence` is higher than the one you hold, so a late or repeated frame never brings back an ask that was decided. Frames are not replayed: after a gap or a reconnect, read `GET /api/approvals` once. A stream opened without `?domains=` carries it; a stream that names its domains carries it only when the list includes `gate` (see "What a stream without `domains` carries"). A non-admin credential cannot receive `gate` (`403` `EVENT_ACCESS_DENIED`).
2. Or poll `GET /api/approvals` (scope `read:approvals`): it returns `awaitingDecision`, `mode` (the daemon's `permissions.mode` setting, not any one session's mode), counts and the newest 50 `approvals`, plus every approval still open (pending or claimed) however many settled after it. Add `?approvalId=<id>` to read one; an id that matches no approval is not an error: the answer is `200` with `"approvals":[]` (and the counts), so check that the list is not empty. A pending approval does not expire by itself unless the code that raised it set a time limit; then the record carries `expiresAt` and becomes `expired` when it passes.

   ```json
   {"awaitingDecision":false,"mode":"jev-decides","approvalCount":0,"denialCount":0,"promptCount":0,"totalChecks":0,"approvals":[]}
   ```

   An approval record has `id`, `callId`, `sessionId`, `status` (`pending`, `claimed`, `approved`, `denied`, `cancelled`, `expired`), `revision`, `homeNode` (the daemon's cluster node), `requester` (`in-process`, or `wire` with the `holds` of the surfaces that raised it over `approvals.raise`), `cause` when it was cancelled or expired (`requester-left`, `requester-restarted`, `cancelled-by-actor`, `owner-decision-stale`, `deadline`, `deadline-while-down`), and `request` (`tool`, `args`, `category` `read`/`write`/`execute`/`delegate`, and `analysis` with `classification`, `riskLevel` `low`/`medium`/`high`/`critical`, `summary`, `reasons`, `target`, `blastRadius`).

   Each listed record also carries `reading`, computed for the credential that asked: `phase` (`waiting`, `decided`, `ended`), a stable `reason` (`waiting-for-approver`, `waiting-for-owner`, `claimed-by-you`, `claimed-by-other`, `approved`, `denied`, `amended`, `remembered-approved`, `remembered-denied`, `cancelled-requester-left`, `cancelled-requester-restarted`, `cancelled-by-actor`, `cancelled-owner-decision-stale`, `expired`, `expired-while-down`), `waitingOn`, `deadline` (`expiresAt`, `remainingMs`), `allowedActions` (what this credential may do now; the Agent's never include approve or deny), `refusedActions` with why, `decision` (who decided, from which surface and node, when), `receipt` (`delivered`: the asker has it; `waiting`: a surface that raised it has not yet confirmed it; `requester-reads-record`; `not-applicable`), `work` (`not-reported`: whether the approved work ran is not reported by the approval) and `next` (the lawful next moves). A surface words it its own way; the state, the deadline and the actions come from the reading.
3. Decide it (admin, owner-only, scope `write:approvals`):

   ```sh
   curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
     http://127.0.0.1:3421/api/approvals/<approvalId>/approve -d '{"expectedRevision":2,"note":"ok"}'

   curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
     http://127.0.0.1:3421/api/approvals/<approvalId>/deny -d '{"expectedRevision":2,"reason":"use the staging database instead"}'
   ```

   | Field | Method | Meaning |
   | --- | --- | --- |
   | `rememberTier` | approve, deny | Make it a standing rule: `session`, `exact`, `command-class`, `path` or `tool`. Queued asks it covers are decided too. |
   | `reason` | approve, deny | Free text. On a denial the model receives it, so it can adapt. |
   | `selectedHunks` | approve | For an edit: approve only these hunk indices. |
   | `modifiedArgs` | approve | Approve with changed arguments, for example the answer to a command's prompt. |
   | `expectedRevision` | all (required) | The `revision` of the approval you showed or read. Missing: `400` `INVALID_ARGUMENT`. Stale: not applied (below). A release (`cancel` with `release: true`) needs none. |
   | `note` | all | A note on the record. |
   | `disposition` | approve, deny | Optional and redundant with the URL: `approved` for approve; `denied` or `amended` (the owner changed the request) for deny. Any other value is `400`. |
   | `remember` | approve, deny | A boolean recorded on the decision, asking that it be remembered; `rememberTier` is what makes a standing rule and names its reach. `amended` cannot be combined with `remember: true` or `rememberTier` (`400` `An amendment cannot create a remembered approval rule.`). |

   Every field but `expectedRevision` is optional. A successful decision answers `200`:

   ```json
   {"applied":true,"approval":{"id":"<approvalId>","status":"approved","revision":3,"request":{"tool":"...","args":{},"category":"execute","analysis":{...}},"decision":{...},...},"reading":{"phase":"decided","reason":"approved","receipt":{"state":"delivered"},...},"recorded":{"approved":true,"rememberTier":null,"reasonStored":false,"modifiedArgsDelivered":false}}
   ```

   `recorded` is read back from the record the daemon stored: whether it was approved, the tier saved (or `null`), whether a reason was stored, and whether modified arguments reached the waiting call.

   | Status | Body | Cause |
   | --- | --- | --- |
   | `200` | `"applied":false`, `"refusal":{"code":"APPROVAL_SETTLED",...}`, the record and its `reading` | The approval had already ended (approved, denied, cancelled or expired). Not an error: the first decision wins. |
   | `200` | `"applied":false`, `"refusal":{"code":"APPROVAL_CHANGED",...}`, the record and its `reading` | It changed since the revision you sent (claimed, noted, another surface joined it). Show the returned reading and act on its `revision`. |
   | `200` | `"applied":false`, `"refusal":{"code":"APPROVAL_EXPIRED",...}` | Its deadline passed before the decision reached it; it is now `expired` and nothing was approved. |
   | `200` | `"applied":false`, `"refusal":{"code":"OWNER_DECISION_REQUIRED",...}` | Only the paired-owner decision on the device that raised it can approve it; deny and cancel are allowed. |
   | `400` | `expectedRevision must be the revision of the approval you showed or read ...` | `expectedRevision` missing or not a positive integer. |
   | `400` | `disposition must match the approval action.` | `disposition` was sent and is not `approved` (approve) or `denied`/`amended` (deny). |
   | `400` | `rememberTier must be one of: session, exact, command-class, path, tool.` | Bad `rememberTier`. |
   | `400` | `reason must be a string.` | Bad `reason`. |
   | `400` | `selectedHunks must be an array of integer hunk indices.` | Bad `selectedHunks` (approve only). An index out of range, or `selectedHunks` on an approval that is not an edit, is also `400` with the daemon's message. |
   | `400` | `modifiedArgs must be an object of tool arguments.` | Bad `modifiedArgs` (approve only). |
   | `401` | `AUTH_REQUIRED` | No credential. |
   | `403` | `ADMIN_REQUIRED` | Not an admin credential. |
   | `403` | `{"error":"approvals.approve: approval.answer is the owner's own act; an admin cannot make it.","code":"OWNER_ONLY","effect":"approval.answer","missing":"owner",...}` | An admin credential that is not the owner's (an admin sign-in of someone else, a token minted for automation). Only the owner answers an approval. |
   | `403` | `{"error":"approvals.approve is the owner's own act; a call the Agent makes for him is refused. The owner does it from his own app.","code":"OWNER_ONLY","category":"authorization","status":403}` (`approvals.deny` for a denial) | The request came with the Agent's own credential (credential kind `agent`). Observed the same through `POST /api/approvals/{id}/approve` and through invoke. Applies to approve and deny, not to claim or cancel. |
   | `404` | `{"error":"No approval has that id.","code":"APPROVAL_NOT_FOUND","state":"not in this daemon's approvals","next":["List approvals again and act on an id it shows."],"status":404}` | No approval has that id. |

   The contract marks approve and deny as owner-only but does not name the `OWNER_ONLY` code or the `400` validation messages; the table above is what the daemon returns. The `OWNER_ONLY` check runs before the approval is looked up, so it answers the same for an id that does not exist. The approval id is taken from the path; an `approvalId` in the body is not used.
4. `POST /api/approvals/<approvalId>/claim` marks that you are handling it (advisory). `POST /api/approvals/<approvalId>/cancel` withdraws it. Both take `expectedRevision`.
5. In a group (see "Clusters" in the daemon chapter), every daemon lists the other members' approvals too, each with `homeNode` and an id written `<id>@<node>`, and `reading.waitingOn.homeReachable` false when that node has gone silent. An action on one (`/api/approvals/<id>@<node>/approve`, deny, claim, cancel, or `inbox.answer` on the item) is relayed to the node that owns it, which alone decides: it applies once, recorded as decided by `<person>@<this node>` from surface `node:<this node>`. Changed arguments are not relayed (only `selectedHunks`); an approve of an ask that needs the owner's own decision on its device is `OWNER_DECISION_REQUIRED`. When the owning node does not answer within 5 seconds the answer is `200` `"applied":false` with `refusal.code` `NODE_UNREACHABLE` and state `unknown`: read it again, that node decides whether it was applied. A removed member's approvals are no longer listed, and its relayed actions are refused.
6. A surface that raised an ask with `approvals.raise` holds it (`holdId`). It gives the hold up with `cancel` `{"release":true,"holdId":"..."}`: while the ask waits that means it left (the last hold to go cancels it, `cancelled-requester-left`), and once it is decided that means it received the decision, which is what the reading shows as `receipt: delivered`. A raiser that was away (its stream dropped, the daemon restarted) reads the record again and releases then.

Remember tiers and permission modes are explained in "Permissions, decisions and safety".

### The owner inbox

Approvals are one kind of item in the owner inbox, which also holds questions agents left, channel claims, purchase windows, queued actions, decisions the decision model made, and reports (kind `report`: the answer of a scheduled run or trigger turn that named no surface or whose send failed, answered `read`). `inbox.list` (invoke, `read:approvals`) lists them, newest first (`status` `open`, `closed` or `all`; `kinds`; `sessionId`; `limit`, default 100 and at most 500; `itemId`); while `hasMore` is true, pass `nextCursor` back as `cursor` for the older page. An answered item is kept for good, an approval a person approved or denied (with its reason) included; withdrawn or expired items, and approvals settled by a remembered rule, past the newest 500 are dropped. The web UI's Work page lists answers and decided approvals in its "Your answers" list, with "Show older"; `/questions all` lists every item. `inbox.answer` (invoke, admin, owner-only) answers one with one of its `options`, or with `text`: `{"body":{"itemId":"...","option":"approve","expectedRevision":2}}`. An approval item carries the approval's `revision` and `reading`; answering it needs `expectedRevision`. Every item carries `presentation`, what the ask says, worded once by the daemon so every surface shows the same words: `question`, `place`, `subject`, `consequence` (`tone` `cannot-undo` only for what cannot be undone), `choices` (with `key` and `default`), `remember` (offered tiers, or why not), `why`, `details` and a one-line `title`; an approval item's `title` is its presentation's (`Run bun test?`). Changes arrive as event `owner-inbox-update` on domain `gate`. The first answer wins; a later one returns `applied: false` with who answered, and an answer after an item's deadline changes nothing. A decision item's choice is claimed before it is carried out: a second choice or a withdrawal meanwhile returns `DECISION_IN_PROGRESS`. An answer to a question an agent or session asked is recorded `delivered` only once a model request carrying it was accepted; if the process that took it stops first, the answer is handed to the asker again.

## Settings through the API

All `config.*` and `credentials.*` methods are admin methods: a non-admin, whatever its scopes, gets `403` `ADMIN_REQUIRED` (`Gateway method requires admin access: config.get`).

| Method | Route | Scope | Does |
| --- | --- | --- | --- |
| `config.get` | `GET /config` | `read:config` | Every setting with its current value, as one nested object grouped by the parts of the key (60 top-level groups in 3.4.1: `{"display":{...},"provider":{...},...,"controlPlane":{"enabled":false,"gateway":true,"hostMode":"local",...}}`), not a list of keys. There is no way to ask for one key: `?key=` is ignored and the whole object is returned; read `controlPlane.port` as `.controlPlane.port`. Credential-bearing values that are not a `goodvibes://secrets/` reference read `[redacted]`. |
| `credentials.get` | `GET /config/credentials[?key=<config key>]` | `read:config` | `{"available":true,"credentials":[...]}`: whether each credential is configured and usable, never the secret. `503` `CREDENTIAL_STORE_UNAVAILABLE` when no secret store is wired. |
| `config.set` | `POST /config` `{"key":"<config key>","value":<JSON>}` | `write:config` | Write one value. |
| `config.setMany` | `POST /config/many` `{"entries":[{"key":"...","value":...},...]}` | `write:config` | Write several values as one update: every entry is checked before anything is written. |
| `config.reset` | `POST /config/reset` `{"key":"<config key>"}` | `write:config` | Remove the explicit value so the key reads as its default, in every settings file that holds it. |
| `credentials.set` | invoke only: `{"body":{"key":"<config key>","value":"<secret>"}}` | `write:config`, owner-only | Store a secret for a credential setting (for example `surfaces.telegram.botToken`) in the encrypted store and point the setting at it. Answers `success`, `key`, `secretKey`, `scope`, `reference`, `configScope`, `ownership`, `credentialScope`; never the value. |
| `credentials.delete` | invoke only: `{"body":{"key":"<config key>"}}` | `write:config`, owner-only | Delete the stored secret, then the reference. `cleared: false` means nothing was stored (not an error). |

Example, checked against a 3.3.2 daemon:

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/config -d '{"key":"atRest.retentionMaxAgeDays","value":31}'
```

```json
{"success":true,"key":"atRest.retentionMaxAgeDays","value":31,"persistedTo":"/home/alex/.goodvibes/daemon/settings.json","tier":"daemon","daemonOwned":true,"effectiveOrigin":"daemon"}
```

`value` is what the daemon holds after the write (a value it coerced is shown coerced), `persistedTo` the file written, `tier` the layer (`daemon` for a daemon-owned key; `global` for one written to the daemon's own surface file, `~/.goodvibes/daemon-host/settings.json`; `default` after a reset), and `effectiveOrigin` where the value in force comes from. `config.setMany` answers `{"success":true,"revision":<n>,"entries":[<one such object per key>]}`; `config.reset` answers like `config.set` with the default value.

Refusals:

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{"error":"Missing or invalid key","status":400}` | `config.set` with no `key`. |
| `400` | `{"error":"Invalid config key","status":400}` | `config.set` with a key the daemon does not know. |
| `400` | `CONFIG_ERROR`, for example `Invalid value for atRest.retentionMaxAgeDays (integer in [1, 365])` | A value of the wrong type or out of range. |
| `400` | `SECRET_CONFIG_KEY` `Config key surfaces.telegram.botToken holds a credential and is not written to the config file as plain text.` | A credential setting given a literal value (use `credentials.set`, or pass a `goodvibes://secrets/` reference). `config.reset` refuses a credential setting the same way (use `credentials.delete`). |
| `400` | `CONFIG_ERROR` (`config.set`) or `CONFIG_SECRET_REFERENCE_INVALID` (`config.setMany`) `<key> holds a goodvibes://secrets/ reference that is not well formed.` | A credential setting given a `goodvibes://secrets/` value the resolver cannot read, such as one with no source segment (`goodvibes://secrets/OPENAI_KEY`). Write it as `goodvibes://secrets/goodvibes/<KEY>`. |
| `400` | `INVALID_ARGUMENT` `The request names no config key.` / `The request names no settings to write.` / `Every entry needs a key and a value.` / `<key> is not a config key this daemon knows.` | `config.reset` or `config.setMany` input faults. |
| `400` | `INVALID_ARGUMENT` | `runtime.workingDir` in `config.setMany` or `config.reset`; set it alone with `config.set`, which moves the daemon's workspace once no session is mid-turn (checked again just before the host stops; when the daemon cannot tell whether a turn is running, the move waits). |
| `403` | `CONFIG_MANAGED` | The key is locked by managed policy. |
| `409` | `CONFIG_SET_NOT_APPLIED` `Config key <key> did not take the requested value in <file>. The host now reports <value>.` | A higher layer (managed policy, an environment variable, a daemon-owned value) overrides what was written. `config.setMany` adds `notApplied` (the keys), `revision` and `entries`; the write itself happened. |

### A change only the owner makes

A write that loosens a security, permission, judgment or payment setting (for example `permissions.mode` `yolo`, `sandbox.enabled` `false`, a new `judgment.endpoint` or `judgment.model`, a higher payment limit) is the owner's own act. Made with the owner's own credential it is written at once: the operator token, the owner's sign-in (the first user the daemon holds), an app on the daemon's machine, or a device the owner paired himself. Made by an admin who is not the owner (an admin sign-in of anyone else, a token minted for automation), nothing is written: the change is put to the owner as an approval and the answer is `202`. A credential without the admin role cannot make it at all.

Which tokens are which is recorded on the token when it is minted and never changes; `pairing.tokens.list` shows it as `origin`, and the device lists of the terminal app (`/devices`) and the web UI (Settings, Paired devices) say "owner device" or "automation token":

- `owner-pairing` (owner device): a device paired through the owner's pairing flow, the pairing QR or `goodvibes pair` / `goodvibes-daemon pair` (`pairing.handoff.create`), asked from the owner's own credential (the operator token, his sign-in, an app on his machine, or another owner device, the relay included) with full authority, or the pairing screen and devices list of the terminal app on the daemon's machine. The web UI's "Migrate this browser" button (a browser signed in with the shared operator token moving onto its own token) goes through the same flow (`pairing.handoff.create` with `fromSharedToken: true`), so the owner's browser becomes an owner device.
- `automation` (automation token): every other token: one minted through the API by another token (`pairing.tokens.create`, `pairing.tokens.migrate`), one minted with a narrowed scope list or for a named client (the Agent's credential), one paired from an automation token or the Agent's credential, and every token minted before 3.3.2, which recorded no origin. To make such a device an owner device, pair it again: open the pairing link from the owner's own app on it (`goodvibes pair` or `/devices pair device` in the terminal app, or Settings, Paired devices in the web UI on a device signed in as the owner) and revoke the old token. The web UI says so on the paired-devices list when the browser it runs in is signed in with an automation token.

```json
{"success":false,"code":"OWNER_APPROVAL_PENDING","approvalId":"apr-...","key":"permissions.mode","keys":["permissions.mode"],"reasons":["Changing permissions.mode would loosen the permission mode."],"state":"nothing was changed yet; ...","next":["Watch approval apr-... ..."]}
```

The change is applied when the owner approves it, and only his own credential can approve it (an owner device included), as with every approval: any other credential answering it, through `approvals.approve` or `inbox.answer`, is refused `403` `OWNER_ONLY`. The web UI shows such a change as waiting for the owner's approval and reports how it settled; the terminal app and the Agent say it is waiting, with the approval's id. It expires after a day unanswered, and is cancelled if the daemon restarts before he answers; nothing is changed then, and the request may be sent again. The same holds for `config.setMany`, `config.reset` (a reset that loosens), the `settingsPrecondition` write lane, and `sessions.permissionMode.set` to a looser mode; a settings import (`settingsImportPrecondition`) from any credential but the owner's is refused `403` `OWNER_ONLY`. A change that tightens a setting is written at once from any admin credential.

A replicated setting written on one cluster node reaches the other nodes; see "Clusters" in "The daemon, the web UI and networking".

## Running and watching a task

A task is a one-off piece of agent work: the daemon starts an agent (a sub-agent with its own model loop) for the text you send. `POST /task` (`tasks.create`, admin, scope `write:tasks`) has two forms, chosen by whether the body names a session.

### Form 1: a task on its own

```sh
curl -sS -X POST -H "Authorization: Bearer $GV_TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:3421/task -d '{"task":"say hi","tools":["read"]}'
```

The daemon reads these fields: `task` (required, a non-empty string), `model` (a model registry key), `provider`, `tools` (up to 64 tool names), and `routing` (`modelId`, `providerId`, `tools`, `fallbackModels`, `providerSelection`, `providerFailurePolicy`, `executionIntent`, `reasoningEffort`); a top-level `model`, `provider` or `tools` wins over the same choice in `routing`. `tools` is added to the agent's default tool set, it does not restrict it: in testing `"tools":["read"]` started an agent with `read`, `write`, `edit`, `find`, `exec`, `analyze`, `inspect`, `fetch` and `registry`. The daemon starts the agent at once and answers `202`:

```json
{"acknowledged":true,"agentId":"agent-65854493","status":"pending","task":"say hi","model":null,"tools":["read","write","edit","find","exec","analyze","inspect","fetch","registry"]}
```

`status` is the agent's state when it was started; `model` is `null` when none was named and the daemon's current model is used. An agent that cannot run fails within milliseconds; in testing, with no usable model, `GET /task/agent-65854493` answered `"status":"failed"` with `error` `no route for the planner: The session's model openrouter/free is not available for this work ...`.

### Form 2: a task in a shared session

When the body has `sessionId`, `routeId` or `surfaceKind`, the text is recorded as a message in that shared session first. `sessionId` names an existing session; to start a new session, leave it out and send `surfaceKind` (a new session is created) or `routeId` (the session bound to that route is used or created). The fields read in this form are `task`, `model`, `provider`, `tools`, `routing` (as in form 1), `sessionId`, `routeId`, `surfaceKind` (default `web`), `surfaceId` (default `surface:web`), `externalId`, `threadId`, `userId`, `displayName`, `title` and `metadata`. The answer depends on the session:

| Session state | Status | Body |
| --- | --- | --- |
| An agent is answering the session and took the text | `202` | `{"acknowledged":true,"mode":"continued-live","sessionId":"...","agentId":"<running agent>","inputId":"sin-..."}` |
| An agent is answering the session; the text is queued to run after it | `202` | `{"acknowledged":true,"mode":"queued-follow-up","sessionId":"...","agentId":"...","inputId":"sin-..."}` |
| A live surface (a terminal app or hosted engine) owns the session's turns | `202` | `{"acknowledged":true,"mode":"queued-for-surface","sessionId":"...","agentId":null,"inputId":"sin-..."}`: the text is queued for that surface to collect and run; no daemon agent starts. |
| An agent is answering but did not take it | `409` | `{"acknowledged":false,"mode":"rejected","sessionId":"...","inputId":"sin-..."}` |
| No agent is answering | `202` | `{"acknowledged":true,"mode":"spawn","sessionId":"...","agentId":"<new agent>","status":"pending"}` |

Do not send a task into a hosted session; use `sessions.followUp` there (see "Steer and follow-up on a hosted session").

**An unknown `sessionId` is refused.** Form 2 with a `sessionId` that no session has (a typo, a stale id, an id from another daemon) answers `404` `{"error":"Unknown shared session \"<id>\". Nothing was recorded or started; ...","code":"SESSION_NOT_FOUND",...}`: nothing is recorded and no agent starts. The same holds for `POST /api/sessions/{sessionId}/messages` (every `kind`), `sessions.steer` and `sessions.followUp`. Creating a session is an explicit request: leave `sessionId` out, or create it first with `POST /api/sessions`.

### Every refusal of `POST /task`

| Status | Body | Cause |
| --- | --- | --- |
| `401` | `AUTH_REQUIRED` | No credential. |
| `403` | `ADMIN_REQUIRED` | The credential is not admin. |
| `400` | `{"error":"Missing required field: task (non-empty string)","code":"INVALID_ARGUMENT","field":"task"}` | No `task`, or an empty one. |
| `400` | `MODEL_NOT_FOUND` or `MODEL_AMBIGUOUS` | `model`, `routing.modelId` or a fallback model names no registered model, or a bare id several providers serve. Nothing starts. |
| `400` | `INVALID_ARGUMENT` (`recoverable: false`) | The model routing contradicts itself (a `provider` without a provider-qualified model, a model of another provider, `ordered-fallbacks` with no fallback model, `fail` with fallback models). |
| `404` | `SESSION_NOT_FOUND` | Form 2 with a `sessionId` no session has. Nothing was recorded or started. |
| `400` | `INVALID_ARGUMENT` naming the field | A malformed `routing` or `tools`, or a `surfaceKind` that is not one of the allowed surface kinds (the error lists them). |
| `400` | `INVALID_ARGUMENT` (`tools is an empty list, which selects nothing; ...`) | `tools` or `routing.tools` sent as `[]`: an empty list selects no tool and is never the default set; leave it out for the default tools. `routing.fallbackModels: []` is kept: no fallback model. |
| `400` | `INVALID_JSON` | The body is not a JSON object. |
| `409` | `SESSION_CLOSED` | Form 2 with a closed session; reopen it with `POST /api/sessions/{sessionId}/reopen`. |
| `409` | `"mode":"rejected"` (above) | Form 2: the running agent did not take the text. |
| `429` | `CAPACITY_EXCEEDED`, header `Retry-After: 5`, `hint` naming `fleet.maxSize` | The daemon already runs `fleet.maxSize` agents. Wait and retry, or raise the setting. |
| `500` | the spawn error, or `Failed to spawn agent` | The agent could not be started for a reason in the daemon. In form 2 the input is released back to the queue. |
| `500` | `SESSION_AGENT_BIND_FAILED` | Form 2: the agent started but could not be bound to the session; the input was released to the queue. |

The contract (`tasks.create`) states the same fields, forms, answers and codes.

`POST /task` takes the `Idempotency-Key` header: a repeat under the same key returns the first answer and starts no second agent (see "Idempotency and safe retries").

### Watching and acting on a task

A task started this way is a runtime task of kind `agent` whose id is the agent id (`agent-...`).

Statuses:

| Thing | Values | Where |
| --- | --- | --- |
| Runtime task | `queued`, `running`, `blocked`, `completed`, `failed`, `cancelled` | `GET /api/tasks`, `GET /api/tasks/{taskId}` |
| Agent | `pending`, `running`, `completed`, `failed`, `cancelled` | `GET /task/{agentId}`, the `POST /task` answer |

| Route | Returns | Access |
| --- | --- | --- |
| `GET /task/{agentId}` | `{"agentId","task","status","model","tools","durationMs","toolCallCount","progress","error"}`, not wrapped. `404` `AGENT_NOT_FOUND` (`Agent not found: <agentId>`) for an unknown agent. | scope `read:transcripts` |
| `GET /api/tasks?limit=<n>` | `{"queued","running","blocked","totals":{"created","completed","failed","cancelled"},"tasks":[...]}`, newest first. A caller without `read:transcripts` sees each task's kind as its title and no description. | scope `read:tasks` |
| `GET /api/tasks/{taskId}` | `{"task":{...}}`, wrapped: `id`, `kind` (`exec`, `agent`, `acp`, `scheduler`, `daemon`, `mcp`, `plugin`, `integration`), `title`, `description`, `status`, `owner` (the agent now running it), `cancellable`, `parentTaskId`, `childTaskIds`, `queuedAt`, `startedAt`, `endedAt`, `retryPolicy`, `exitCode`, `error`, `result`, `turnId`. `404` `{"error":"Unknown runtime task","code":"TASK_NOT_FOUND","status":404}`. | scope `read:transcripts` |
| Event domains `tasks`, `agents` | Task and agent lifecycle events. | admin |

Example, a failed task:

```json
{"task":{"id":"agent-65854493","kind":"agent","title":"say hi","description":"say hi","status":"failed","owner":"agent-65854493","cancellable":true,"childTaskIds":[],"queuedAt":1795025546685,"startedAt":1795025546697,"endedAt":1795025546725,"error":"Agent agent-65854493 failed: ..."}}
```

Act on it (admin, `write:tasks`):

- `POST /api/tasks/{taskId}/cancel` stops the task's agent (its `owner`) and asks the task store to mark the task `cancelled` with error `Cancelled via control plane`. It answers `200` `{"task":{...}}` with the task as the store now holds it. There is no state check: cancelling a task that already ended is not an error, and the store decides whether the state changes, so read `task.status` in the answer. An unknown id answers `404` `TASK_NOT_FOUND`.
- `POST /api/tasks/{taskId}/retry` starts a new agent and answers `{"retried":true,"task":{...},"agentId":"<new agent id>"}`. Only failed or cancelled agent tasks can be retried: another kind or state answers `400` `TASK_NOT_RETRYABLE` (`Retry is only implemented for agent tasks`, `Task cannot be retried: only failed or cancelled tasks can be retried`). A full fleet answers `429` `CAPACITY_EXCEEDED`.

What a retry keeps:

- It keeps the text, the model, the provider, the exact tool list the first agent ran with, the routing (fallback models, provider selection and failure policy, reasoning effort), the execution limits, the contract settings, and the session that started it. These are read from the record of the agent that ran the task; when that record is no longer held (the daemon keeps the newest finished agents), nothing starts and the answer is `409` `TASK_SETTINGS_UNAVAILABLE`: create the task again.
- The new run is tracked as a **new** task whose id is the new agent id returned in `agentId`. Follow that id (`GET /task/<new agentId>`, `GET /api/tasks/<new agentId>`).
- The original task is set back to `queued` with `owner` naming the new agent, and stays `queued`: in testing, after the new agent failed, `GET /api/tasks` listed the original as `queued` and the new one as `failed`. Cancel the original if a list of open tasks matters to you.
- Retry takes the `Idempotency-Key` header: a repeat under the same key returns the first answer. Without a key a repeated retry of the same task is refused, because the original is `queued` after the first one (`400` `TASK_NOT_RETRYABLE`). Retrying the new task's id after it fails starts another agent.

For larger work with acceptance criteria, use contracts: `POST /api/contracts` (`contracts.start`, with `Idempotency-Key`), `GET /api/contracts/{contractId}`, `POST /api/contracts/{contractId}/cancel`, `POST /api/contracts/{contractId}/reply`; contracts are explained in "The terminal app (`goodvibes`)".

## Event streams

### Server-Sent Events

`GET /api/control-plane/events?domains=<comma list>` (scope `read:events`) opens a `text/event-stream`. Each frame is:

```text
id: evt-889d6f52
event: <event name>
data: <one line of JSON>
```

The first frame is `ready`:

```text
event: ready
data: {"clientId":"cp-35ac99c9","domains":["session","turn","tools","tasks"],"transport":"sse","resume":{"resume":"none"}}
```

Event names:

| Event name | Carries |
| --- | --- |
| `ready` | The stream is open: client id, domains, resume outcome. |
| `heartbeat` | Sent at open and every 15 seconds: `{"clientId":"...","ts":...}`. |
| A domain name (`turn`, `tools`, `session`, `tasks`, `agents`, ...) | One runtime event of that domain: `{"type":"<EVENT>","ts":...,"traceId":"...","sessionId":"...","source":"...","payload":{...}}`. |
| `session-update` | A shared-session change: `session-created`, `session-message-appended`, `session-input-queued`, `session-input-delivered`, `session-input-completed`, `session-route-attached` and others. |
| `hosted-session-update` | A hosted-session change: `hosted-session-created`, `-attached`, `-turn-started`, `-turn-ended`, `-restored` and others. |
| `approval-update` | An approval record changed (domain `gate`). |
| `owner-inbox-update` | An owner-inbox item changed (domain `gate`). |
| `surface-message` | A message for a surface. |
| `remote-pair-requested`, `remote-peer`, ... | Remote peer activity. |
| `gap` | Events were dropped because this client read too slowly: `{"dropped":<n>,"afterId":"<last delivered id>"}`. Reconnect with `Last-Event-ID` set to `afterId`. |
| `closed` | The daemon ended the stream: `{"reason":"credential-revoked","next":"Sign in again or pair this device again, then reconnect."}`. It is sent when the stream's credential is revoked (the device token deleted, or revoked with the token that minted it, the sign-in ended, the shared token replaced). It is the last frame; do not reconnect with the same credential. On the WebSocket the same frame arrives as `{"type":"closed","reason":"credential-revoked","next":...}`, and the daemon then closes the socket (code `1008`, reason `credential-revoked`). |

The catalog name, SSE name, domain and access of each event are in "Event streams a client subscribes to" in the reference. Runtime events carry `sessionId` at the top level; `session-update` frames carry it as `payload.sessionId` (or `payload.id` for `session-created`), and `hosted-session-update` frames as `session.id`. A client that keeps one session's events must check all three places.

The domains (28 in 3.4.1) are listed with every runtime event, its fields and its domain under "Runtime events by domain" in the reference, and `GET /api/control-plane/events/catalog` returns them from the daemon. A name that is not a domain is refused (below).

How the daemon decides what a stream carries:

| Request | Result |
| --- | --- |
| No `domains` parameter | See "What a stream without `domains` carries" below. |
| Only unknown names (`?domains=bogus`) | `400` `UNKNOWN_EVENT_DOMAIN` with `unrecognisedDomains`; the stream is not opened. |
| Known and unknown names | The known ones are used; `ready` lists the others under `unrecognisedDomains`. |
| Some allowed and some not (`?domains=providers,session,automation` for a non-admin) | The stream opens with the allowed ones. `ready` names the refused ones: `{"clientId":"cp-cb69c602","domains":["providers","automation"],"transport":"sse","withheldDomains":["session"],"resume":{"resume":"none"}}`. |
| None allowed (`?domains=session,turn,tools` for a non-admin), or a credential that may receive nothing | `403` `{"error":"This credential may not receive the requested event domains: session, turn, tools.","code":"EVENT_ACCESS_DENIED","category":"authorization","status":403,"state":"the event stream was not opened","next":["Sign in as an admin, or open the stream with domains this credential may read."],"withheldDomains":["session","turn","tools"]}` |

Always read `withheldDomains` in the `ready` frame: a stream that opened is not a stream that carries everything asked for.

#### What a stream without `domains` carries

Two kinds of frame travel on a stream, and `domains` filters them differently (from the code, `control-plane/gateway.ts` and `gateway-scope-enforcement.ts`; the admin results observed on a 3.3.2 daemon):

| Frames | Opened without `domains` | Opened with `domains=<list>` |
| --- | --- | --- |
| Runtime events (`turn`, `tools`, `gate`, `config`, ... frames named after their domain: `TURN_*`, `TOOL_*` and the rest) | Only the 14 default domains: `session`, `tasks`, `agents`, `automation`, `routes`, `control-plane`, `deliveries`, `surfaces`, `watchers`, `transport`, `ops`, `knowledge`, `providers`, `turn`. These are what the `ready` frame lists. No `tools`, `gate`, `config`, `fleet`, `contracts` or `mcp` runtime events, so no tool calls. | Exactly the listed domains. |
| Broadcast events: `approval-update` and `owner-inbox-update` (tagged `gate`), `session-update` and `hosted-session-update` (tagged `session`), and the untagged ones (`surface-message`, the `remote-*` events) | All of them, whatever the `ready` frame lists, so approvals do arrive. | A tagged one only when its tag is listed (`approval-update` needs `gate` in the list); an untagged one always. |

Access applies on top in both cases: a non-admin credential never receives an admin-only event or domain (`approval-update`, `owner-inbox-update`, `session-update`, `hosted-session-update`, the `session`, `turn`, `tools`, `tasks`, `agents`, `gate` domains and the others in "Access of every event"), except that `read:own-sessions` opens the `turn`, `tools`, `gate` and `session` frames and the `approval-update` and `hosted-session-update` events of the caller's own sessions; a non-admin stream without `domains` opens on the defaults it may read and lists the rest under `withheldDomains`.

So an admin client that wants approvals can open the stream without `domains` (it then also gets every session update but no tool calls), or name its domains and include `gate`: `?domains=gate,session,turn,tools`. A stream opened with `?domains=session` gets no `approval-update`. Listing `domains` replaces the defaults; it does not add to them.

### Reconnecting

- If no frame (not even a heartbeat) arrives for 35 seconds, the connection is dead: reconnect.
- Reconnect with the header `Last-Event-ID: <id of the last event you processed>`. The `ready` frame's `resume` says what happened:
  - `{"resume":"resumed","sinceId":"...","replayed":<n>}`: the events after that id were replayed, in order. Nothing was missed.
  - `{"resume":"unresolved","sinceId":"..."}`: that id is no longer in the daemon's buffer of the last 500 events (or the daemon restarted). Nothing was replayed. Re-read state (`GET /api/sessions/{id}`, `GET /api/approvals`, `GET /api/tasks`) before trusting the stream.
  - `{"resume":"none"}`: no `Last-Event-ID` was sent. The daemon sends up to 20 recent events, plus the start of any turn still running, so a client can render it.
- After a `gap` event, reconnect with `Last-Event-ID` set to its `afterId`.
- A turn's end is always one of `TURN_COMPLETED`, `TURN_ERROR`, `TURN_CANCEL`, `PREFLIGHT_FAIL`. After any reconnect that is not `resumed`, check the session's state instead of waiting for an end event that may already have been sent.
- Back off between attempts (for example 1, 2, 4, 8 seconds, up to 30).
- A `401` on reconnect, or a `closed` frame, means the credential was revoked or expired; do not retry with it.

### Per-session stream

`GET /api/sessions/{sessionId}/events` (admin) carries only that session's events (and events with no session) on the default domains plus `tools`, with the same frames and reconnect rules. It takes no `domains` parameter.

### Telemetry stream

`GET /api/v1/telemetry/stream` (scope `read:telemetry`) is a separate Server-Sent Events stream of telemetry records. See "Telemetry" in "The daemon, the web UI and networking".

## Rate limits

| What | Limit | Answer when exceeded |
| --- | --- | --- |
| `POST /login` | 5 per minute per address | `429` `RATE_LIMITED` |
| `POST /api/remote/pair/request` | 10 per minute per address | `429` `RATE_LIMITED`, `Retry-After: 60` |
| Companion chat messages | `runtime.companionChatLimiter.perSessionLimit` per 60 seconds per session (0 means `GOODVIBES_CHAT_LIMITER_THRESHOLD`, else 10) | refused |

These are the request-rate limits the daemon applies to its own routes. Provider rate limits come back as errors on the turn (`RATE_LIMITED` with `retryAfterMs` when the provider gave one).

## OpenAI-compatible endpoints

When `controlPlane.openaiCompatible.enabled` is `true` (default), the daemon answers OpenAI-style requests under `controlPlane.openaiCompatible.pathPrefix` (default `/v1`). There are three routes and no others (no `/v1/embeddings`, `/v1/completions` or `/v1/responses`):

| Route | Access |
| --- | --- |
| `GET /v1/models` | Any valid credential (a scoped device token works). |
| `POST /v1/chat/completions` | Admin. A non-admin gets the daemon's own `403` body `{"error":"Admin role required","code":"ADMIN_REQUIRED",...}`, not the OpenAI shape, because these requests spend provider money. |
| `GET /v1/chat/completions/{id}` | Admin. Reads back a completion that was queued as batch work. |

No credential answers `401` `AUTH_REQUIRED` in the daemon's own shape.

### Model ids

`GET /v1/models` answers `{"object":"list","data":[{"id":"...","object":"model","created":<seconds>,"owned_by":"<provider>"},...]}`, sorted by id. It always contains `goodvibes/current`, which means the daemon's current model (whatever it is when the request arrives); the others are registry keys `provider:model`, such as `openrouter:openrouter/free` or `decision-router:auto`. A request's `model` may be `goodvibes/current`, a registry key, or a bare model id when exactly one provider has it. `model` is required: there is no default.

### Request

`POST /v1/chat/completions` takes the OpenAI chat-completions body:

| Field | Handling |
| --- | --- |
| `model` | Required. Missing: `400` `model_not_found` `Missing required field: model.`. Unknown: `400` `model_not_found` naming candidates (`Unknown model 'nope-model-x'. Did you mean: ...`). |
| `messages` | Required (missing: `400` `missing_messages`). Roles `system` and `developer` (joined into the system prompt), `user`, `assistant` (with `tool_calls`), `tool` (with `tool_call_id`). Any other role, a message that is not an object or has no role, or a tool message without `tool_call_id` is `400` `invalid_messages`. |
| `stream` | `true` streams `chat.completion.chunk` objects as `data: {...}` lines and ends with `data: [DONE]`; the last chunk before `[DONE]` carries `usage`. |
| `max_completion_tokens`, `max_tokens` | Applied (the first wins). |
| `tools` | Offered to the model as in the OpenAI API; tool calls come back to the caller in `tool_calls`. GoodVibes' own tools are not run. |
| `tool_choice` | `auto` or `none` (`none` offers no tools). Anything else is refused. |
| `reasoning_effort` | Applied. |
| `response_format` | Only `{"type":"text"}`. Anything else is refused. |
| `n` | Only `1`. Anything else is refused. |
| `stop` | Only absent or `[]`. Anything else is refused. |
| `logprobs` | Only absent or `false`. `true` is refused. |
| `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `logit_bias`, `top_logprobs` | Ignored. The request is served, and the response header `x-goodvibes-ignored-params` names the ones that were sent, comma-separated. |

A refused parameter answers `400` with `type` `invalid_request_error`, `code` `unsupported_parameter` and `param` naming it, for example `{"error":{"message":"This endpoint returns one choice per request. Remove \"n\" and resend.","type":"invalid_request_error","param":"n","code":"unsupported_parameter"}}` or `Stop sequences are not applied by this endpoint. Remove "stop" and resend.`.

### Response

```json
{"id":"chatcmpl-goodvibes-<uuid>","object":"chat.completion","created":1795025562,"model":"goodvibes/current",
 "choices":[{"index":0,"message":{"role":"assistant","content":"Hello.","tool_calls":[...]},"logprobs":null,"finish_reason":"stop"}],
 "usage":{"prompt_tokens":18104,"completion_tokens":7,"total_tokens":18111}}
```

`model` echoes what you asked for (`goodvibes/current` stays `goodvibes/current`). `finish_reason` is `stop`, `length` (the token limit), `tool_calls` or `content_filter`. `usage.prompt_tokens` includes cached prompt tokens. `tool_calls` is present only when the model called a tool. Cost is not reported.

### Errors

Every error from these routes, except the credential refusals above, has the OpenAI shape `{"error":{"message":"...","type":"...","param":<name or null>,"code":"..."}}`. `type` follows the status: `401` `authentication_error`, `403` `permission_error`, `404` `not_found_error`, `429` `rate_limit_error`, other `4xx` `invalid_request_error`, `5xx` `server_error`. A provider failure keeps the provider's status (`502` when it gave none) with code `provider_error`. A body that is not JSON is `400` `invalid_json`.

### Batch execution

The header `x-goodvibes-execution` takes `batch` or `live` (anything else: `400` `invalid_execution`). With `batch`, and `batch.mode` not `off`, the request is queued as provider batch work and answered `202` with `{"id":"<job id>","object":"chat.completion.batch_job","status":"queued","created":...,"model":"...","poll":"/v1/chat/completions/<job id>"}` and a `location` header. `GET` that path: `202` with the same body while it waits, `200` with the completion when done, `409` `batch_cancelled`, `410` `batch_expired`, or `502` when it failed. `batch.mode` off with `batch` asked is `409` `batch_disabled`; `batch` with `"stream": true` is `400` `batch_stream_unsupported`.

### With an OpenAI client

Python (`pip install openai`), using an admin token:

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3421/v1", api_key=os.environ["GV_TOKEN"])
print([m.id for m in client.models.list().data][:5])
reply = client.chat.completions.create(
    model="goodvibes/current",
    messages=[{"role": "system", "content": "Answer in one word."}, {"role": "user", "content": "Say hello."}],
    max_tokens=20,
)
print(reply.choices[0].message.content, reply.usage)
for chunk in client.chat.completions.create(model="goodvibes/current", messages=[{"role": "user", "content": "Count to 3."}], stream=True):
    print(chunk.choices[0].delta.content or "", end="")
```

TypeScript (`npm install openai`):

```ts
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://127.0.0.1:3421/v1', apiKey: process.env.GV_TOKEN! });
const reply = await client.chat.completions.create({ model: 'goodvibes/current', messages: [{ role: 'user', content: 'Say hello.' }] });
console.log(reply.choices[0]!.message.content);
```

The client sends the token as `Authorization: Bearer <token>`, which is what the daemon reads. Do not pass `n`, `stop` or a JSON `response_format`; they are refused.

## The MCP bridge

`goodvibes-daemon mcp serve` exposes the operator API as MCP tools over standard input and output, for MCP clients. See "`mcp serve`" in "The daemon, the web UI and networking".

## SDK entry points

The package `@goodvibes/engine` (version 3.4.1) contains typed clients for this API. It does not call model providers itself; the daemon does.

How it is published: two packages of the repository are publishable, `@goodvibes/engine` (`packages/engine`) and `@goodvibes/judgment` (`packages/judgment`); the products (`goodvibes`, `goodvibes-agent`, the daemon, the web UI) are private and never published. The release workflow publishes the two packages to `https://registry.npmjs.org` with provenance only when a release runs from a version tag and the repository variable `PUBLISH_NPM` is `true`; otherwise a release produces the native GitHub release and its installer assets and publishes nothing to npm. The repository does not record that variable's value, so whether a given version is on npm is answered by the registry, not by the source:

```sh
npm view @goodvibes/engine versions --json
```

When the version you need is there, install it like any package:

```sh
bun add @goodvibes/engine@3.4.1
npm install @goodvibes/engine@3.4.1
```

When it is not, use it from a source checkout of the same version, inside that checkout's workspace:

```sh
git clone https://github.com/mgd34msu/goodvibes.git
cd goodvibes
git checkout v3.4.1
bun install
bun run build                 # produces the dist/ directories the package's exports name
mkdir -p products/my-client
cat > products/my-client/package.json <<'JSON'
{ "name": "my-client", "private": true, "type": "module",
  "dependencies": { "@goodvibes/engine": "workspace:*" } }
JSON
bun install                   # links the new workspace
bun products/my-client/main.ts
```

Every folder under `packages/` and `products/` is a workspace, and a script must live inside the checkout for `@goodvibes/engine` to resolve; a script elsewhere fails with `Cannot find module '@goodvibes/engine/...'`. Under Bun the package's `bun` export condition loads the TypeScript sources directly.

Do not make a tarball of the package by hand from a checkout (`npm pack` or `bun pm pack` in `packages/engine`): the tarball keeps the `bun` export condition, which names `src/` files the tarball does not contain, so imports under Bun fail. The release removes that condition when it stages the packages; only a registry release or the checkout's workspace gives a working package.

| Import | Use |
| --- | --- |
| `@goodvibes/engine/platform` | `createGoodVibesPlatform({ baseUrl, authToken })` for Bun and Node: `operator` (typed methods), `realtime` (events), `auth`, `peer`. Also `createMemoryTokenStore`. |
| `@goodvibes/engine/platform/browser` | `createBrowserGoodVibesPlatform`, for web pages. |
| `@goodvibes/engine/platform/react-native`, `@goodvibes/engine/platform/expo` | `createReactNativeGoodVibesPlatform`, `createExpoGoodVibesPlatform`. |
| `@goodvibes/engine/platform/auth` | `createMemoryTokenStore`, `createBrowserTokenStore`. |
| `@goodvibes/engine/operator-client` | `createOperatorApiClient({ baseUrl, authToken })`: the operator client alone. |
| `@goodvibes/engine/transport-http` | The HTTP transport, retry, Server-Sent Events reader, private-network checks. |
| `@goodvibes/engine/transport-realtime` | Event buses and `forSession(events, sessionId)`. |
| `@goodvibes/engine/peer-client` | The peer API client for remote nodes. |
| `@goodvibes/engine/contracts` | The operator and peer contracts, method ids, event domains. |
| `@goodvibes/engine/errors` | `GoodVibesError`, `HttpStatusError`, `ContractError` and the error codes. |
| `@goodvibes/engine/platform/daemon` | `dispatchDaemonApiRoutes` and the pieces for embedding a daemon in your own Bun server. |
| `@goodvibes/engine/daemon-api/relay-server-entry` | The relay server program. |

Example, verified against a 3.3.1 daemon:

```ts
import { createGoodVibesPlatform } from '@goodvibes/engine/platform';
import { forSession } from '@goodvibes/engine/transport-realtime';

const baseUrl = 'http://127.0.0.1:3421';
const token = process.env.GV_TOKEN!;
const gv = createGoodVibesPlatform({ baseUrl, authToken: token });

// Typed methods that have a REST route:
const auth = await gv.operator.invoke('control.auth.current', {});
const sessions = await gv.operator.sessions.list();

// Invoke-only methods are not reachable through operator.invoke(); call the invoke route:
const res = await fetch(`${baseUrl}/api/control-plane/methods/sessions.hosted.create/invoke`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ body: { workspaceRoot: '/home/alex/projects/app', detachPolicy: 'survive' } }),
});
const { session } = await res.json();

// Live events for that session only:
const events = forSession(gv.realtime.viaSse(), session.id);
events.turn.onEnvelope('STREAM_DELTA', (e) => process.stdout.write(e.payload.content));
```

Facts about the SDK:

- `gv.operator` has `invoke(methodId, input)`, `stream`, `listOperations`, `getOperation`, and namespaces `sessions`, `tasks`, `approvals`, `providers`, `accounts`, `localAuth`, `control`, `telemetry`.
- `operator.invoke()` works only for methods with a REST route. For an invoke-only method it throws `GoodVibesError` with code `CONTRACT_MISMATCH` (`Operator method "sessions.hosted.list" does not expose an HTTP binding`). Call the invoke route, or send a WebSocket `call` frame.
- A refused request throws `HttpStatusError` with `code` and `status`, for example `code` `SESSION_NOT_FOUND`, `status` `404`.
- Responses are checked against the contract's output schema by default (`validateResponses: true`); a mismatch throws `ContractError`, which usually means the daemon runs another version.
- `gv.realtime.viaSse()` and `gv.realtime.viaWebSocket()` return event buses with one property per domain (`session`, `turn`, `tools`, `tasks`, `agents`, ...). The connection opens on the first subscription. `viaWebSocket()` sends the token as `Authorization: Bearer` on the upgrade request (Bun and Node 22+ WebSocket accept upgrade headers), so a client that has only a token connects; the token is sent only to `baseUrl`'s own origin.
- When a request is refused with `401`, the client refreshes its token and repeats the request once, but only under the same sign-in: if the stored token now belongs to another login (someone signed in since), the request is not repeated and fails with `401` `AUTH_REQUIRED` ("Signed in as someone else since this request was sent").
- The browser entry's event stream (`streams.open`) refuses an absolute URL on another origin with `CREDENTIAL_NOT_FOR_TARGET` before anything is sent; the token and headers go only to the daemon the client was made for.

## Method and event reference

Every operator method (id, REST route or invoke-only, scopes) is listed in "Operator API methods" in the reference. Every event is listed in "Event streams a client subscribes to" and "Runtime events by domain", and every error code in "Codes any route may answer" and "Codes a method declares". `GET /api/control-plane/methods/{methodId}` returns any one method's full input and output schema from the running daemon.
