# GoodVibes platform security best practices

> **Surface scope:** This document describes the security model for the **full surface (Bun runtime)**. Companion consumers (React Native, browser, Hermes) operate through the subset of the security stack exposed via `./react-native`, `./browser`, and related companion-surface barrels. See [Runtime Surfaces](./surfaces.md) for the full surface breakdown.

This guide covers the security model of the GoodVibes daemon and platform. It is intended for operators embedding the daemon, developers building surfaces, and anyone configuring authentication for production deployments.

For vulnerability reporting, see [`SECURITY.md`](../../../SECURITY.md) at the repo root.

---

## Authentication modes

The daemon accepts bearer tokens and session cookies. A presented bearer token is checked
against three sources in order, a per-device pairing token first, then the legacy shared token,
then a user session. Only the shared-token and session-login paths are configured at daemon
startup; per-device pairing tokens are minted on demand whenever a device pairs.

### Per-device pairing tokens

**When to use:** this is the current pairing mechanism for companion apps and browsers. See
[Companion app pairing](./pairing.md) for the full mint/revoke/migrate flow.

Every device that pairs mints its own named, individually-revocable token
(`PairingTokenManager`, prefix `gvp_`) instead of sharing one operator-wide token. Only a
SHA-256 hash of each token is persisted; the plaintext is returned exactly once, at mint
time. Revoking one device's token (`pairing.tokens.delete`) leaves every other paired
device working. A device pairing while already at the `device.nodes.maxPaired` cap that is
re-pairing under its existing name supersedes its own prior token rather than being
refused; a genuinely new device at the cap is refused with a named, actionable error.

A device still holding the legacy shared token calls `pairing.tokens.migrate` once to mint
its own per-device token without disrupting other clients; `pairing.tokens.revokeShared`
then turns the legacy shared token off entirely, after which only per-device tokens and
user sessions authenticate.

A paired device (per-device token or legacy shared token) carries the same operator
authority as the shared token: `isOperatorAdmin()` returns true for either.

### Shared bearer token

**When to use:** local development, single-user deployments, service-to-service connections where you control both ends.

A single static token is configured. Every request that presents this token is granted full access. `matchesSharedToken()` checks the UTF-8 byte lengths, then compares equal-length buffers with `timingSafeEqual`:

```ts
function matchesSharedToken(token: string, sharedToken: string): boolean {
  const supplied = Buffer.from(token, 'utf8');
  const expected = Buffer.from(sharedToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
```

**Implications:**
- No user concept; all requests are effectively admin
- Token exposure means full daemon compromise
- Suitable only when network access to the daemon is already restricted (localhost, private LAN, VPN)
- Do not use in multi-user environments

### Session login

**When to use:** multi-user deployments, web UI access, companion apps where individual identity matters.

Users authenticate with a username and password via the login endpoint. On success, the daemon issues a session token (random 32-byte hex string). Subsequent requests present this token as a bearer credential or in the `goodvibes_session` cookie.

`UserAuthManager` manages the user store and sessions:
- Passwords are hashed with **scrypt** (64-byte key, random salt). The stored hash format is `base64(salt):N:r:p:base64(derived)` (salt, the scrypt cost parameters, then the derived key); the legacy 2-part `salt:hash` form is still accepted on verify for backward compatibility
- Default session TTL is **1 hour** (`DEFAULT_SESSION_TTL_MS = 3_600_000`)
- Sessions are pruned on access; expired sessions are rejected and cleaned up
- Local auth status reports expose an independent opaque session `id`, username and expiry. Use that ID to revoke a session; raw session bearer tokens are not returned by status APIs
- On first boot with no user store, the daemon bootstraps a default admin account and writes a plaintext credential file for initial login; this file should be deleted after the first login
- Login failures are locked out per account and client address, independent of the per-address login rate limiter below, so repeated failures from one address never lock the owner out from another. Failures never leak whether the username exists; an unknown username still runs a constant-time password check against a dummy hash. The lockout escalates with repeated failures, 30 seconds at 6-9 failures, 5 minutes at 10-19, and 30 minutes at 20 or more. The thresholds are set above the default 5-per-minute IP login budget so the per-IP limiter throttles an attacker before the account lock engages for a normal in-budget attempt. A successful login clears the failure count.

Session tokens are carried as:
1. `Authorization: Bearer <token>` header
2. `goodvibes_session` cookie (HTTP-only, SameSite=Lax, Secure when on HTTPS)

The session cookie is set on login and cleared on logout by the daemon's internal cookie builders (`buildOperatorSessionCookie()` / `buildExpiredOperatorSessionCookie()`). These builders are daemon-host HTTP wiring and are **not** exported from the `@goodvibes-jev/engine/platform/platform/security` barrel.

**Role model:**
- Users may have any combination of string roles
- `isOperatorAdmin()` returns true for shared-token requests, per-device pairing-token requests, OR for session users with the `admin` role
- Admin-gated routes call `requireElevatedAccess` before proceeding

---

## Token management

**Public subpath:** `@goodvibes-jev/engine/platform/platform/security`: exports `ApiTokenAuditor`, the `TokenScopePolicy` type, `UserAuthManager`, `isOperatorAdmin`, and `authenticateOperatorToken`. (The operator session cookie builders referenced above are internal daemon wiring and are not part of this barrel.)

### Sub-agent spawning limits

There are no spawn tokens. Every agent spawn (a manual batch, a plan step, a recursive child) is admitted by `evaluateOrchestrationSpawn` in `runtime/orchestration/spawn-policy.ts`, the one place that bounds recursion, nesting depth and fleet size. It reads `orchestration.recursionEnabled`, `orchestration.maxDepth` and `fleet.maxSize`, and a refusal names the setting that bound it and its value.

### API token auditing

`ApiTokenAuditor` enforces scope minimization and rotation cadence for registered API tokens (LLM provider keys, integration credentials, etc.).

**Two audit dimensions:**

1. **Scope audit.** Each token is evaluated against its `TokenScopePolicy`. Tokens holding scopes outside `allowedScopes` are flagged as violations.
2. **Rotation audit.** Tokens are checked against the policy's `rotationCadenceMs` (default: **90 days**). A warning is emitted when `msUntilDue ≤ rotationWarningThresholdMs` (default: **14 days**). When overdue, the token is flagged.

**Managed vs advisory mode:**

| Mode | Behavior |
|---|---|
| `managed: true` | Tokens with scope violations or overdue rotation are **blocked** from use |
| `managed: false` | Violations are reported via `SecurityEvent` emissions but tokens remain usable |

> **Settings gate:** managed-mode blocking only takes effect while `security.tokenAudit.enabled` is on (its default). With the audit off, even `managed: true` instances behave as advisory. See [Feature settings](./feature-settings.md) for how capabilities are configured.

```ts
const auditor = new ApiTokenAuditor({ managed: true });
auditor.registerPolicy({
  id: 'openai',
  name: 'OpenAI API',
  allowedScopes: ['completions:write', 'models:read'],
  rotationCadenceMs: 90 * 24 * 60 * 60 * 1000,
});
auditor.registerToken({
  id: 'tok_main',
  label: 'OPENAI_API_KEY',
  issuedAt: Date.now(),
  grantedScopes: ['completions:write', 'models:read'],
  policyId: 'openai',
});
const report = auditor.auditAll();
```

On rotation: call `deregisterToken(oldId)` then `registerToken(newMetadata)` to update the registry.

### Token storage recommendations

- **Per-device pairing tokens** are stored, hashed, under `<surfaceRoot>/control-plane/pairing-tokens.json` (a daemon's `surfaceRoot` is `tui` for historical reasons; see [Companion app pairing](./pairing.md)). Only a SHA-256 hash is persisted; the plaintext is returned once, at mint time.
- **The legacy shared/operator token** is stored at `<daemonHomeDir>/operator-tokens.json` (default: `~/.goodvibes/daemon/operator-tokens.json`). The file is written at mode `0600`. Consumers should keep the daemon-home directory outside any project tree.
- **Session tokens** are in-memory only; they are not persisted to disk.
- **API keys and provider credentials** should be stored via `SecretsManager` in secure (encrypted) mode, not plaintext. See [Secret Management](#secret-management) below.

---

## Companion app pairing

**Public subpath:** `@goodvibes-jev/engine/platform/platform/pairing` (daemon embedders).

Pairing connects a companion app or browser to the daemon without requiring the user to
manually enter credentials, by scanning a QR code or opening a deep link. For the full
pairing walkthrough, both the current per-device token flow and the legacy shared-token
flow, the deep-link/QR content, offer set, migration path, and client integration, see
[Companion app pairing](./pairing.md).

### Security properties

1. **Two token shapes.** The current mechanism mints a named, individually-revocable
   **per-device token** (prefix `gvp_`) for every pairing; only its SHA-256 hash is
   persisted, and the plaintext is returned exactly once, at mint time. The **legacy
   shared token** (prefix `gv_`, `randomBytes(24)` base64url-encoded, 192 bits of entropy)
   is stored in full at `<daemonHomeDir>/operator-tokens.json` and is shared by every
   client that has not migrated off it.

2. **Deep link, not a raw connection blob.** The current QR/deep-link content is the
   `#pair=<token>` URL fragment (plus an `offers=` key); the legacy flow instead encoded a
   raw JSON connection object as the QR content. A `#` fragment is never sent to a server,
   so the current flow's one-time token cannot leak through an access log or `Referer`
   header.

3. **No challenge-response.** Pairing is a direct token transfer. Security relies on the
   QR/link being shown only in a trusted context, the transport using TLS when the daemon
   is reachable over a network, and the token being individually revocable
   (`pairing.tokens.delete` for a per-device token; `pairing.tokens.revokeShared` turns the
   legacy shared token off for everyone using it).

4. **Connection.** After scanning, the companion app connects using `transport-http` with
   `Authorization: Bearer <token>`. The daemon validates this through the normal
   `authenticateOperatorToken()` path, which checks per-device pairing tokens before the
   legacy shared token.

5. **Device cap.** Pairing a device beyond the configured `device.nodes.maxPaired` limit is
   refused with a named, actionable error rather than silently succeeding; a device
   re-pairing under a name it already holds is never refused by the cap.

---

## Network security

### Security settings report

platform hosts can expose a user-facing explanation of security-relevant settings with:

- `getSecuritySettingsReport(gates)` from the runtime surface
- `IntegrationHelperService.getSecuritySettingsReport()`
- daemon `GET /api/security-settings`
- gateway method `security.settings`

Each report entry includes the setting key, default state, current state, what the setting does, why the disabled state is less restrictive, what enabling it changes, and any operational requirements. This is intended for TUI/onboarding flows so users see exactly which security-relevant settings are on, off, and why.

The current report covers ten security-sensitive settings, each guarding one
enforcement mechanism. Their enablement shapes and defaults are in the
[feature settings catalog](./feature-settings.md); the security angle of each
is what it guards.

| Setting | What it guards |
| --- | --- |
| `fetch.sanitizeMode` | How untrusted web content is sanitized before the model sees it |
| `permissions.engine` | Whether the layered policy engine evaluates user and managed tool/path/parameter rules inside the gate |
| `permissions.simulation` | Shadow dual-evaluation that records permission divergences without blocking |
| `permissions.divergenceDashboard` | The divergence aggregation that gates enforce-mode transitions |
| `policy.registryEnabled` | The policy bundle promote/rollback registry |
| `policy.requireSignedBundles` | HMAC validation of policy bundles; unsigned, altered or key-less loads are refused (key in `GOODVIBES_POLICY_SIGNING_KEY`) |
| `runtime.toolBudget.enforced` | A tool call is stopped at its wall-clock limit; one that finishes over its token or cost limit is reported as failed |
| `permissions.commandParser` | Per-segment AST parsing of shell commands before execution (it refuses a command that parses to no segment; what a command would destroy, and obfuscation, are the gate's reading) |
| `security.tokenAudit.enabled` | Advisory auditing of token scopes and rotation |
| `tools.contractVerification` | Registration-time verification that keeps malformed tools out of the registry |

### TLS

When the daemon is accessed over a network (not localhost), TLS is strongly recommended. The session cookie system sets the `Secure` attribute automatically when the request comes over HTTPS (or via a trusted proxy with `X-Forwarded-Proto: https`):

```ts
function isSecureRequest(req: Request, trustProxy = false): boolean {
  // checks req.url protocol, then x-forwarded-proto if trustProxy
}
```

For reverse proxies (nginx, Caddy, Traefik), set `trustProxy: true` in the daemon config so the `Secure` cookie attribute is applied correctly.

### CORS

CORS policy should be configured at the network edge (reverse proxy) or in the daemon's HTTP server configuration. Do not rely on the browser's same-origin restriction alone when deploying the web UI on a different origin than the daemon.

### Rate Limiting {#rate-limiting}

The daemon ships two built-in rate limiters:

- **Login rate limiter.** 5 sign-in attempts per minute per client address, on `POST /login` of both the control-plane port and the optional HTTP listener (`loginRateLimit` option on the listener). It is checked before the body is read or any password work runs; past it the daemon answers `429` with `Retry-After`.
- **General rate limiter.** 60 requests per minute per client address on the optional HTTP listener (configurable via `rateLimit` option). Applied to all of its routes except login.

The client address is the socket peer, or the forwarded address when `controlPlane.trustProxy` (or `httpListener.trustProxy`) says a trusted reverse proxy is in front. Every failed sign-in event and audit entry carries that address. Limits survive a restart of the listener.

The password check is memory-hard (scrypt, about 128 MiB) and runs off the daemon's event loop, one sign-in at a time; when more than 8 sign-ins are already waiting, a new one is answered `503` with `Retry-After` and no password check, so a burst of attempts cannot stall streams, channels or turns.

A request that carries no credential is answered `401` and is not reported as a failed sign-in: a starting terminal app's identity check is such a request. Only a credential the daemon refused is reported (`AUTH_FAILED`).

For production deployments, place an additional rate-limiting reverse proxy (nginx, Traefik middleware, Cloudflare) **in front of** the daemon to provide a defence-in-depth second layer and to protect against:
- High-volume denial-of-service via expensive LLM requests that the per-IP limiter alone may not catch
- Enumeration attacks on the knowledge or session endpoints from rotating IPs
- Distributed login brute-force from botnets that bypass per-IP limits

The reverse proxy rate limiter supplements the daemon's built-in limits; do not remove the built-in limits when adding a proxy.

### Private host SSRF protection

The remote fetch proxy has explicit SSRF protection via `resolvePrivateHostFetchOptions()` (in `http-policy.ts`), applied by the media and artifact fetch routes. When a client requests a fetch to a private/internal host, the daemon checks:
1. `network.remoteFetch.allowPrivateHosts` must be `true` in config (disabled by default)
2. Elevated access must be granted (`requireElevatedAccess` returns null)

If either check fails, the request is rejected with HTTP 403. Do not enable `allowPrivateHosts` unless your deployment specifically requires internal URL resolution.

The `fetch` tool sanitizes responses by default (`fetch.sanitizeMode`, default `safe-text`). It classifies initial hosts and every redirect target before reading the response, blocks private/link-local/cloud-metadata targets absolutely (by the host as written and, before every hop, by every A and AAAA answer the host resolves to; the request is then sent to the checked address with the written name kept for the Host header, TLS SNI and the certificate check, so a second lookup cannot rebind it, and a name that does not resolve is refused), gates localhost dev servers behind a one-tap approval saved in your own settings (`fetch.allowLocalhost`; a project file cannot turn it on), applies unknown-host safe-text sanitization, and stops reading once `max_content_length` is reached (5 MB when a call sets none). Only `http` and `https` URLs are fetched, including every redirect target; a `file:` or other scheme is refused before anything is sent. Addresses in the carrier-grade NAT range (`100.64.0.0/10`, where some clouds place their metadata service), `198.18.0.0/15`, `192.0.0.0/24` and `fec0::/10`, and IPv6 addresses that carry an IPv4 address (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, IPv4-mapped) by the address they carry, are refused like the other internal ranges. Which hosts are trusted comes from `fetch.trustedHosts`; a call's own `trusted_hosts` is ignored. A request that is not `GET`, `HEAD` or `OPTIONS` is retried on another address of a host only after a refused connection. Setting `fetch.sanitizeMode` to `none` skips content sanitization only. Host blocking is unaffected.

---

## Secret management

**Public subpath:** `@goodvibes-jev/engine/platform/platform/config` (daemon embedders).

### SecretsManager

`SecretsManager` provides layered credential storage with three enforced policies:

| Policy | Description | Use Case |
|---|---|---|
| `plaintext_allowed` | Secrets may be written to unencrypted files | Local development only |
| `preferred_secure` | Use encrypted storage when available; fall back to plaintext | Default for most deployments |
| `require_secure` | Reject all plaintext writes; encrypted storage is mandatory | Production / multi-user |

Encrypted stores use AES-256-GCM with a key derived at runtime. Plaintext stores are JSON files, useful for development but not suitable for production.

The read order follows a precedence hierarchy:
1. Environment variables (highest precedence, always checked first)
2. Project-scoped secure store
3. Project-scoped plaintext store
4. User-scoped secure store
5. User-scoped plaintext store (lowest precedence)

Use `inspect()` to audit the current storage state: it reports the active policy, whether secure storage is available, how many keys are in each store, and any warnings about plaintext storage of sensitive keys.

### Secret refs

Instead of storing secret values directly in config files, use secret references, a URI (`goodvibes://secrets/...`) or a structured object pointing to an external secret source. The supported sources (`env`, `goodvibes`, `file`, `exec`, `1password`, `bitwarden`/`vaultwarden`, `bitwarden-secrets-manager`/`bws`), the `goodvibes://` URI shape, and resolution semantics (`resolveSecretRef()`) are documented canonically in [Secret References](./secrets.md). The generic `secret://...` scheme is intentionally not accepted.

Slack setup uses this same URI mechanism. Direct setup writes Slack token values to the GoodVibes secret store and places references such as `goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN` and `goodvibes://secrets/goodvibes/SLACK_APP_TOKEN` in config. Service-registry based Slack setup can use `primary`, `signingSecret`, `webhookUrl`, and `appToken` fields.

**Best practices:**
- Prefer `1password` or `bitwarden-secrets-manager` for production deployments
- Use `env` refs for CI/CD pipelines
- Use `exec` refs sparingly and validate the command does not echo secrets to stderr
- Never commit `goodvibes://secrets/goodvibes/...` refs that point to keys only present in a plaintext local store

---

## The gate

**Public subpaths:** `@goodvibes-jev/engine/platform/platform/gate` (the boundary, the presets, the stakes reading and surface authority) and `@goodvibes-jev/engine/platform/platform/gate/policy` (the policy and posture runtimes the TUI and agent call). `@goodvibes-jev/engine/platform/platform/runtime` keeps the `security.*` namespace for policy simulation and signed policy bundles.

The gate replaces the old permission layer. It is the one path every tool call takes before it runs, and `PermissionManager` (`platform/permissions/manager.ts`) runs it. Code first settles who decides the call; only a call left to judgment passes the boundary and graduated autonomy: Jev reads what the call does, code composes the reading into the call's stakes, and the active preset maps the stakes to allow, ask or deny.

### 0. Who decides

Before any reading, one function in code classifies the call (`platform/gate/classify.ts`) from facts the gate already holds: the effects and the argument paths the tool declared, the paths classed against the working directory, the rule or answer that matched, the surface the instruction came from, and whether the turn read untrusted text. No model is asked and nothing is read from disk. The first step that applies decides:

1. **Surface authority**, then **plan**: a change asked for from an input-only surface is refused, and so is a change in plan mode.
2. **yolo** runs everything that passed step 1.
3. A **deny** (a saved rule, a session answer, managed policy, `permissions.tools.<tool>: deny`) refuses the call.
4. An item **only the owner decides** goes to the owner, in every mode but yolo, and Jev is never asked: changing what an MCP server may do (`set-trust`, `set-role`, `approve-quarantine`) and any tool that declares itself dangerous. When the owner answers with a remember choice, that answer settles the same item next time; an allow given for something else never does.
5. An **allow** settles the call. After the turn read untrusted text, an allow still settles a call that stays on this machine, but a call that can reach outside goes to judgment, where the outward-effect check below reads where its content came from.
6. **Declared effects**: a read inside the working directory, and a change inside it that the tool records for undo (`write` of text, `edit`), run at once. The tools themselves still refuse a path whose link leads outside their root.
7. Anything else is a judgment: sections 1 to 4 below apply to it.

Every result carries a `decision` (state, who decided, the reason, the rule or limit that decided, what the agent can do next), so a refused call tells the asking agent why and what to do instead. A refusal also says whether it stands (`standing: true`: a tool switched off in settings, managed policy, a saved deny rule, a call the owner refused earlier this session, or the mode) or covers only this call (the owner declined it, or a boundary check refused this content), so the agent does not retry variations of a call that cannot succeed.

### 1. The boundary

For a call left to judgment, the boundary runs on Jev's reading of the call (step 3 below asks every question in one round) and before any preset; no preset or phrase in the conversation relaxes it (`platform/gate/boundary.ts`). Each check was read for what it actually decides, and its disposition follows from that, not from being a security check:

| Check | What it decides | Disposition and why | Reason code |
|---|---|---|---|
| Catastrophic command | Whether a shell command would destroy the machine or the user's data wholesale. | **Jev** (`engine.gate.boundary`, `catastrophic`). It is a judgment about what a command does; the old frozen list only knew the spellings someone wrote down (`find / -delete` and `rm -rf ~/*` walked past it). A yes refuses outright; an uncertain reading makes the call critical stakes, so every preset asks. The gate reads it before the call runs; the exec tool does not read it a second time, so a run path with no gate in front of it is not covered by this check. | `boundary_catastrophic` |
| Surface authority | Whether the surface the turn's instruction came from can direct work. | **Code** (the owner's per-surface declarations, `gate/surface-authority.ts`). What it depends on is who can write to the surface in this deployment (who holds the bot token, who can mail the address), which no text in the call shows; the owner declared it, and an undeclared surface is input-only. Whether the call is consequential is Jev's reading (`mutates`, `outward`). | `boundary_surface_authority` |
| Card details | Whether an outward call carries a person's payment card details. | **Jev** (`engine.gate.boundary`, `cardDetails`). A checksum cannot tell a card from an order number and misses a card written in words or split across fields. A yes refuses; an uncertain reading is refused unless the owner approves the exact call. | `boundary_card_details` |
| Outward-effect taint | Whether what an outward call sends derives from untrusted text read this turn. | **Jev over a recorded fact.** That the turn read untrusted text is the untrusted-content ledger's record (what happened). Whether the call's content derives from it is `engine.security.content-derivation`, read for each string field of the call against the recent sources in one request per field, a long source as consecutive pieces, with pairs already cleared in the turn not asked again (security/content-taint.ts findContentTaint, the same reading the email, calendar and channel send paths use: reply-aware, with a boilerplate question), replacing the shared-word and shared-character overlap counts. One battery asks this question for the whole engine. When the ledger kept no text there is nothing to read, and the owner is asked. | `boundary_outward_effect` |
| Trust-gated approval | Whether an owner approval clears a card-uncertain or taint refusal. | **Code.** The approval is minted only from the prompt the owner answered for this call; the check is that it names this action, that its fingerprint equals the fingerprint of the exact content being sent, and that its five minutes have not passed. Hash equality and a clock comparison decide nothing; the owner's answer is the decision. | `owner_approved_outward` |

Which calls are outward is Jev's `outward` reading alone; there is no fixed tool list.

### 2. Explicit owner decisions

After the boundary, decisions the owner made explicitly stand as given:

1. **`behavior.autoApprove`** (`config_policy` / `config_allow`): the owner's opt-out of the presets and prompts. It never bypasses the boundary.
2. **Policy as code**, when the `permissions-policy-engine` feature is on: user and managed policy rules (`managed_policy`). Matching a rule the owner wrote carries out the owner's decision. The evaluator's mode layer is not consulted, and it has no safety layer: its old destructive-prefix, dangerous-pattern, path-traversal and SQL lists decided what a call does by spelling, and those questions are the gate's readings now. Rules that filter on a call's classification get it from the gate's reading (escalation by risk family, then network, destructive, write or read), not from lists of tool names. The policy linter decides the spellings that cover everything (`**`, `/`, `/*`, `/**`, `~/**`; host `*`, `*.*`, `*:*`) in code, in every mode, and reads whether any other path or host pattern is broad (`engine.gate.policy-breadth`); with no decision model those other patterns are reported as not evaluated. `/policy lint` and `/policy preflight` show the findings, and a broad pattern in an allow rule blocks preflight.
3. **Per-tool restrictions** (`permissions.tools.*`): `deny` blocks a tool in every mode except `yolo`. `allow` and `prompt` are read only in Classic operation, when the decision model is not in use.
4. **Remembered approvals**: the session cache (`session_override`) and durable rules (`user_rule`). A remembered allow does not carry a change into the plan preset, and never lifts an administrator's deny (a managed deny rule outranks every user or remembered allow). A durable rule remembered from a prompt is saved with the project it was made in and applies only there; rules saved before this, or written by hand, have no project and keep applying everywhere. A session answer belongs to the session that gave it: another hosted session is asked again. A remembered command-class or prefix allow covers only a simple command: one with `;`, `&&`, `||`, `|`, `&`, a newline, a substitution, a redirection or a subshell is covered only when every part matches on its own and none of it is a substitution or redirection. An exact allow also needs the same environment, working directory, detachment and file operations it was approved with. If a choice to remember cannot be saved, the answer still applies to that call and the result says it was not saved and why.
5. **Hook changes**: adding, enabling, disabling or removing a hook through `state mode=hooks` is never decided by a category, a preset or a remembered rule. The owner is asked every time (a surface must not offer to remember it), and the prompt states the hook type, the events it fires on, the command, script, URL or prompt (an `agent` hook is named as starting an agent with tools), the `matcher` that narrows it, the `model`, `async`, `once` and `timeout` fields when set (`timeout: 0` as no deadline), that on a `Pre` event its output can block the call, change its arguments or add text to the conversation, that an http hook sends tool arguments and results to its URL, the header names (not values) and whether `allowInternal` is on. Plan mode refuses it; only the mode that skips every prompt allows it unasked.

A call to a built-in read-only tool (read, find, analyze, inspect, state, registry and the other `read`-category tools except `fetch`) that section 0 did not settle is asked one question, whether it touches secret or credential material (`secrets`); a no runs it with no further reading, a yes gives it the full reading, where it is at least high stakes. There is no shipped list of credential paths: a list decided every unlisted path by omission. Search, list and map tools do not ask that question per file: through `PermissionManager.readAccess` they withhold the content of a file only when the owner denied reads (`permissions.tools.read` deny, a policy rule or a remembered deny), and show its path flagged as access-restricted. A secret in a file nobody denied is not withheld from a search or map result.

### 3. The stakes reading

Jev reads every other call through three batteries asked in parallel (`platform/gate/batteries`), each question narrow and read through a band scaled to its stakes:

| Battery | Questions |
|---|---|
| `engine.gate.side-effect` | Does the call change state (`mutates`)? Does it send data or cause an effect outside this machine (`outward`)? Does it read, print, send or embed secrets (`secrets`)? For a shell command: is it written to hide what it does (`obfuscated`)? For an unknown tool: what kind of action is it (`kind`)? |
| `engine.gate.risk-family` | Which risk family is it (the closed set the approval brief and checklists use)? Is its effect hard to undo (`irreversible`)? Does it reach beyond the project (`beyondProject`)? Does it loosen a security boundary (`weakensSecurity`)? |
| `engine.gate.boundary` | For a shell command: would it destroy the machine or the user's data wholesale (`catastrophic`)? Does the call carry payment card details (`cardDetails`)? |

Code composes the facts into stakes (`gate/reading.ts`, `stakesFromFacts`). A fact whose reading is uncertain counts as true, so doubt raises the stakes and never lowers them:

| Stakes | When |
|---|---|
| `critical` | Loosens a security boundary; is written to hide what it does; might be catastrophic (an uncertain boundary reading); is hard to undo and reaches beyond the project or outside the machine; or sends secrets out |
| `high` | Hard to undo, touches secrets, reaches beyond the project, or goes outside the machine |
| `medium` | Changes something |
| `low` | Changes nothing |

The stakes become the analysis `riskLevel`; the family, the facts, the side effects and the blast radius ride on the analysis and the decision (`reading`), and the tool pipeline emits them as `STAKES_READ` on the `gate` event domain. When Jev cannot answer, the judgment port's error propagates and the call fails; no heuristic stands in.

### 4. Presets over the stakes table

`permissions.mode` takes four values, each selecting a preset (`platform/gate/presets.ts`). Older settings files still load: `prompt`, `normal`, `accept-edits` and `custom` become `safe-owner`, `auto` becomes `safe-jev`, and `allow-all` becomes `yolo`; `behavior.autoApprove` is a deprecated alias for `yolo`.

| Setting value | low | medium | high | critical | Notes |
|---|---|---|---|---|---|
| `safe-owner` (default) | allow | allow | allow | ask | dangerous actions wait for the owner |
| `safe-jev` | allow | allow | allow | ask | Jev stands in for the owner |
| `yolo` | allow | allow | allow | allow | no general safety denial or prompt; host containment, secret storage and payment rules still apply |
| `plan` | allow | allow | allow | ask | any call Jev reads as a change or outward is refused (`plan_mode`) |

The mode cycle (Shift+Tab) is `safe-owner`, `safe-jev`, `yolo`; `plan` is outside it. Per-tool `permissions.tools.*` settings are separate from the mode: an explicit `deny` blocks that tool in the safe modes.

An allow reports `stakes_preset` / `preset_allow`, a plan refusal `runtime_mode` / `plan_mode`, and an ask goes to the owner's approval prompt (`user_prompt`), where the answer can be remembered at the tier the owner picks. `PRESET_CHANGED` on the `gate` domain announces a preset change.

Background agents follow the same gate. The escape hatch `permissions.backgroundAgents: 'allow-all'` exempts them from presets and prompts, never from the boundary.

### Sandbox escalations

What host access a sandboxed command needs (the network, host privileges) is Jev's reading, `engine.gate.sandbox-needs`, replacing the shell classifier's fixed binary and subcommand sets and the package-install table. The exec tool opens the network inside the sandbox only for a command that Jev reads as needing it and whose every command the owner's egress allowlist names; a listed command that needs no network, or a `*` allowlist, does not get it, and when Jev's reading is unavailable the network stays closed. Approving an ask never opens the network for an unlisted command: the ask names the unlisted commands, and the owner adds them to `sandbox.egressAllowlist`. A sandboxed command that needs host access asks the owner through the same approval broker, once, inside the call that runs it; the terminal app's approval card leaves that question to the exec tool, so the owner is not asked it twice and no answer carries over to another call. Host privilege is never granted inside the boundary: approving a command that wants it only lets it run without root. With `sandbox.judgment` set to annotate or auto-approve, the `engine.gate.sandbox-advisory` battery reads whether the command shows a risk the owner should see; the reading annotates the ask, and only in the opt-in auto-approve mode does a confident looks-safe reading approve it. It never denies and never touches the catastrophic list.

### MCP tool calls

When a server's profile lists allowed capabilities, `McpPermissionManager` reads each server tool's capability class once (the side-effect battery's `capability` question, kept for the life of the process per server, tool and listed schema) and denies a tool whose class is not listed; with no decision model the class is `generic`. A server with no capability list costs no reading. When the owner set allowed paths or hosts for a server, code picks the values the scope applies to: a value is a path when its argument is named like one (`path`, `filename`, `target`, `sourcePath`, ...) or the whole value is shaped like one (no whitespace, and a separator, a home prefix or a `file:` URL), and a destination when its argument is named like one, it has a URL scheme, or it is an address (an IP, `localhost`, or a host with a port). Each such value must lie inside the owner's scope, compared on real paths (`..` resolved, symlinks followed, whole path components, a relative path resolved against the server's working directory) and on the URL grammar's host. A refusal names the argument, its value and the scope it fell outside. A server whose trust mode is `blocked` (the owner's setting), or whose schema is quarantined, is refused before any reading.

`checkDetailed()` returns a `PermissionCheckResult` with `approved`, `persisted`, `sourceLayer`, `reasonCode`, the `analysis`, and when present the `boundary` checks, the `reading`, the `preset` decision and a `detail` explaining a refusal.

For headless automation, `permissions.mode: safe-jev` lets Jev decide in the owner's place and still refuses genuinely harmful actions. `permissions.mode: yolo` (and its deprecated alias `behavior.autoApprove: true`) removes the general safety denials and prompts, so use it only where the surroundings contain the work. To forbid a tool outright:

```yaml
permissions:
  mode: safe-owner
  tools:
    exec: deny
    write: deny
```

---

## Daemon security hardening

### Port binding

By default, the daemon binds to `localhost` only. If you need network access, bind to a specific interface rather than `0.0.0.0` unless you have a firewall or reverse proxy handling ingress. Exposing the daemon port directly to the internet without TLS and rate limiting is not supported.

### Authentication requirement

Always configure either a shared token or session auth before exposing the daemon to any network beyond localhost. A daemon with no auth configured accepts all requests.

### Admin vs user roles

- **Admin principals** (shared-token requests, or session users with the `admin` role): full access to all routes including control plane, user management, and config mutation
- **Non-admin principals**: access to conversational and operational routes only; admin-gated routes return 403

When creating user accounts with `UserAuthManager.addUser()`, the default role is `['admin']`. For least-privilege companion or integration accounts, pass a custom role array that excludes `admin`.

### Principal kinds and scopes

The `AuthenticatedPrincipal` type carries a `principalKind` (`user` | `bot` | `service` | `token`) and a `scopes` array. Route handlers use `buildMissingScopeBody()` to enforce required scopes before processing a request. Scope violations return a structured error with `requiredScopes`, `grantedScopes`, and `missingScopes` fields.

### Bootstrap credential file

**Note:** The bootstrap credential file is written internally during first-boot bootstrap and by `rotatePassword('admin', …)`; the only public `UserAuthManager` method that touches it directly is `clearBootstrapCredentialFile()` (accessed as `authManager.clearBootstrapCredentialFile()`). The `UserAuthManager` class is importable from `@goodvibes-jev/engine/platform/platform/security`; host code reaches the configured, operational instance through daemon/runtime composition rather than instantiating it ad hoc.

#### What it is and when it is created

On first boot, if no persistent user store exists (`auth-users.json` is absent or empty), `UserAuthManager` calls `loadOrBootstrapUsers()`, which:

1. Generates a 16-byte cryptographically random password (`randomBytes(16).toString('hex')`) for the default `admin` account
2. Hashes and stores the password in the user store file (`bootstrapFilePath`, e.g. `.goodvibes/tui/auth-users.json`)
3. Writes the raw plaintext credentials to a second file (`bootstrapCredentialPath`, e.g. `.goodvibes/tui/auth-bootstrap.txt`) and sets its permissions to `0o600` (owner read/write only)

The bootstrap file format is plain key-value text:

```
GoodVibes bootstrap auth
username=admin
password=<32-hex-chars>
purpose=Use these credentials only for local daemon/http listener /login routes when those surfaces are enabled.
note=Normal platform host usage does not require these credentials.
```

This file is an **output**, not an authentication input. The runtime reads it only for drift detection and to recognize bootstrap-credential logins; the hash in `auth-users.json` is authoritative, so edits to this file do not change the stored password hash.

#### Drift detection

Every time `UserAuthManager` is constructed (daemon startup), `detectBootstrapCredentialDrift()` runs automatically when operating in file-backed mode. It reads the bootstrap file and verifies that the stored password still matches the hash in `auth-users.json`. If they have drifted, for example because someone manually edited the file, a `warn`-level log is emitted:

```
Bootstrap credential file password does not match the stored hash; /login with this password will fail.
Rotate the password via UserAuthManager.rotatePassword() or regenerate the credential by deleting both files so they are re-created in sync.
```

Drift detection fires only on file-backed instances; test configs that pass explicit `users` are exempt.

#### Recommended lifecycle after first login

1. Log in once using the bootstrap credentials (via the `/login` route)
2. Immediately rotate the admin password to a value you control:
   ```ts
   authManager.rotatePassword('admin', newPassword);
   ```
   `rotatePassword()` updates the user store, revokes all active sessions for that user, and overwrites the bootstrap file with the new password.
3. Delete the bootstrap file:
   ```ts
   authManager.clearBootstrapCredentialFile(); // returns true if the file existed and was removed
   ```
   Alternatively, delete the file manually: `rm .goodvibes/tui/auth-bootstrap.txt`.
   Or, from a remote operator client using the platform:
   ```ts
   // Requires admin access. Available via the operator control surface
   // (HTTP DELETE /api/local-auth/bootstrap-file).
   await platformClient.operator.invoke('local_auth.bootstrap.delete', {});
   ```
4. Verify the file is gone:
   ```ts
   const snap = authManager.inspect();
   console.assert(!snap.bootstrapCredentialPresent, 'Bootstrap file still present!');
   ```

#### Failure modes

| Situation | Outcome |
|---|---|
| Bootstrap file deleted before first login | Re-bootstrap by deleting both `auth-bootstrap.txt` **and** `auth-users.json`; both files are regenerated on next start |
| `auth-users.json` deleted while `auth-bootstrap.txt` still exists | Daemon re-bootstraps with a new password; the previous bootstrap file becomes stale. Drift detection will warn on next start |
| Both files deleted | Clean re-bootstrap: a new admin account and new bootstrap file are created. All existing sessions are invalidated (sessions are in-memory) |
| Bootstrap file manually edited | Password mismatch; `/login` will reject the edited password. Drift detection warns on next startup. Fix by calling `rotatePassword()` to bring both files back in sync |

There is no recovery path for a forgotten admin password beyond deleting both files to trigger a re-bootstrap.

#### Security implications

- The bootstrap file contains a **plaintext password**. `0o600` limits access to the file owner, but it is not encrypted.
- Keep `bootstrapCredentialPath` outside the project root to prevent accidental inclusion in Docker `COPY` layers, version control, or build artifacts.
- Do not leave the file present after first login. A stale bootstrap file is a standing credential that grants admin access to any process running as the same OS user.
- The bootstrap file path should be added to `.gitignore` and `.dockerignore` as a matter of policy, even though it lives outside the project root by convention.

### Logging guidance

- Token values, passwords, and secret values must never appear in log output
- The `ApiTokenAuditor` logs token IDs and labels, never the secret value itself
- `UserAuthManager` stores only hashed passwords; plaintext passwords are never retained after hashing
- Structured error responses from the daemon expose route names and scope names but not internal state or credential values


## Hosted gate judgment input

The gate's judgment request is an outward transmission in its own right. Before
permission analysis, hooks, request recording, or any judgment-port request,
`gate/judgment-input.ts` checks the complete argument tree and complete strings.
It refuses protected input locally with the `judgment-input` boundary check and
`boundary_judgment_input` reason. This refusal cannot be cleared by auto-approve,
a preset, a remembered grant, an owner prompt, or the background-agent exemption.
Direct gate readers, MCP capability readings and execution-ledger observers share
the check. A refused ledger event keeps its lifecycle identifiers/status and a
value-free reason, with argument and command previews withheld.

The deterministic classes are deliberately bounded:

- Credential config/store names declared by the platform registry, including
  nested config paths, registered environment names and prefix families
- Literal values in `credentials.set` envelopes; standard credential wire fields
  (password/API key/OAuth token/private key) and HTTP authentication headers
- `payments.cards.create` envelopes, declared card fields, CardMaterial fields,
  field/value pairs, and explicit HTML payment/password descriptors or CSS
  attribute-equality selectors paired with a value/text
- Existing local PAN shapes (13–19 digits passing Luhn, with the existing space
  and hyphen/group-window rules), including numeric JSON values; private-key PEM
  headers; URL password userinfo and declared credential query fields; declared credential assignments/headers in
  shell strings and JSON-encoded bodies

These checks do not ask a remote model to discover a secret. They do not read the
secret store, process environment, user files or live card material. The browser's
page-scoped CardMaterialRedactor remains a separate downstream containment layer;
it is not a global secret registry and cannot protect an earlier gate request.

Protected material belongs in the existing secure credential/card setup surfaces.
Those direct authenticated setup routes and daemon-side card fills are unchanged.
Stored `goodvibes://secrets/…` references, card ids/field targets, metadata such as
last4, empty credential fields, and value-free scalar schema declarations remain
usable. Normal calls retain their semantic arguments and all Jev stakes,
catastrophic, card-context, surface-authority and taint checks. The privacy scan
precedes the existing 4,000-character reading display cap; it does not mutate the
original execution/approval arguments. Malformed/non-JSON, cyclic, accessor-bearing
or oversized inputs are refused rather than partially inspected.

If a gate taint source contains a protected class, that source is withheld from
derivation judgment. The outward call needs the owner's existing exact-content
approval, bound to the original full strings, including text beyond the judgment
cap. This never synthesizes a clean taint reading. Ordinary unprotected sources
still receive the semantic derivation reading. Judgment errors propagate without
an allow or heuristic fallback.

This is not general PII/secret detection. Arbitrary secrets under unknown names,
encoded/obfuscated payloads and unrecognized card spellings are outside these
structural guarantees. Text illustrating populated credential syntax may also be
refused; the gate cannot safely prove that an apparent example is not a real
credential. Ordinary explanations and value-free schema descriptions are not
blanket-censored. The deterministic PAN check can refuse a Luhn-valid identifier
that is not a card; protecting the hosted request takes precedence over classifying
that value remotely.

## Browser Content Security Policy

Optional host integrations for OpenTelemetry, Node worker threads and Sharp use
guarded dynamic imports. These paths are unavailable in browser windows and
workers; browser embeddings must not enable `unsafe-eval` for them. Regex
isolation uses a Blob worker and fails closed if the embedding policy blocks
that worker source. Configure worker permissions for the browser capabilities
you enable.
