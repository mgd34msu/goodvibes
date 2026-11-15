# Explicit Agent pairing

`goodvibes-agent setup pair` previews migration of the selected host's existing
legacy shared operator credential into a named per-device Agent credential.
`--name <name>` selects the device label (default `GoodVibes Agent`). Preview is
read-only. It displays the exact host, label, administrative scope and current
environment-override posture.

`goodvibes-agent setup pair --apply` performs the same fresh preview, then asks
for an exact one-time phrase on an interactive terminal. `--yes`, scripted stdin
and JSON apply cannot bypass that prompt. The phrase is bound in memory to the
host, effective source credential, Agent home, name and observed local pairing
state. Before mutation, the source must still be verified by `auth.current` as
an admin legacy shared-token principal with `write:control-plane` or `*`.
Changed selection, credentials, local state, revocation or cancellation aborts
before the migration request.

Inside the interactive Agent, `/setup pair` remains read-only. The owner can type
`/setup pair --apply` (optionally `--name "Device name"`) to preview the selected
host and administrative scope, then enter the displayed fresh exact phrase.
Only direct terminal command input opens that operation. Model/harness calls,
including `confirm:true`, nested commands, `--yes` and inline phrases cannot
create or replace a credential. No confirmation answer enters normal chat,
input history or model submission. The disclosure and phrase remain in the
display-only transcript; PageUp/PageDown and the mouse wheel can review them
without giving up the operation.

The interactive shell owns cancellation from the beginning of preview through
verification. Escape, Ctrl-C and Ctrl-D cancel even after the answer is submitted;
terminal EOF/close, SIGTERM and shell exit dispose the operation. A typed slash
command replaces it and invalidates its old answer and callbacks. Starting a
new line prompt or modal cancels it; a pending permission/recovery prompt cannot
consume its confirmation. When another surface takes focus or replaces the
visible draft, the abandoned pairing line is drained through Enter/Escape
before that surface can accept an answer. Cancellation suppresses late preview and success
messages. The durable pairing state remains authoritative: an unknown migration
outcome remains unknown, and a stored credential survives interrupted verification.
Run `/setup pair` or `goodvibes-agent setup status` to inspect/reverify rather than
retrying or revoking. Pairing success does not establish provider, workspace,
Jev or execution readiness.

Two outcomes are the exception to "remains unknown". When the host answers the
migration request with a definite refusal (a 4xx other than a timeout or a
conflict) or is not listening at all, nothing was created: the attempt is
cleared, the result says `rejected`, and the next preview pairs normally. An
unknown outcome that stays after a lost reply is cleared only by the owner:
`/setup pair --apply` (or `goodvibes-agent setup pair --apply`) on an unknown
host offers a `CLEAR ...` phrase that forgets the local marker. Do that only
after checking on the host that no pairing token exists for the attempt; a
token that does exist stays valid until you revoke it there.

In the standalone command, Enter or an incorrect phrase cancels with exit code 2.
From the confirmation
prompt onward, Ctrl-C and terminal EOF (Ctrl-D) interrupt with exit code 130,
including while awaiting a request or verification reply. Process SIGINT and
SIGTERM also interrupt the earlier preview with exit code 130. Before the
migration request there is no new credential. Once a request may have reached
the daemon, interruption preserves the durable unknown-outcome marker; after
the returned secret is stored, interruption preserves that secret for a fresh
`setup status` check. Closing the command's own terminal reader after successful
completion does not turn success into cancellation.

The action creates persistent **administrative operator access**. It is not a
restricted read-only or ledger-only token. The current daemon migration method
uses its migration-specific mint path, does not revoke the shared token, and
does not replace a same-name record at the ordinary new-device cap. Agent calls
only `pairing.tokens.migrate`, never `create`, `delete` or `revokeShared`.

## Storage and uncertain outcomes

Credentials are stored under the selected Agent home in
`.goodvibes/agent/connected-host-pairings/pairings.json`. The dedicated directory
is 0700 and the file is 0600. Entries are bound to a canonical HTTP(S) origin;
userinfo, paths, query and fragment components are refused. No host aliases are
inferred. The daemon-global `.goodvibes/daemon/operator-tokens.json` is not
changed. Secret values and remote/parser errors are never returned by the
pairing command or preview.

A cross-process-locked, durable unknown-outcome marker is written before the
single migration request. The request has no automatic retry and rejects
redirects. A lost, rejected, malformed, overlarge or interrupted response leaves
that marker in place, including after a process restart. It blocks automatic
reminting. The host's token list may need operator review; the server does not
provide idempotent recovery of the one-time secret. This increment deliberately
provides no implicit reset/revoke/replace operation.

A valid returned secret is durably saved before live verification. This avoids
losing the only copy when verification is interrupted. The final check verifies
the expected newly minted principal. Changed configuration or failed verification
is reported as stored but unverified and never causes another mint.

## Effective credentials and scope

Agent's outgoing host connections resolve credentials in this order:
1. `GOODVIBES_CONNECTED_HOST_TOKEN`
2. `GOODVIBES_DAEMON_TOKEN`
3. Agent-owned pairing for the exact selected origin
4. Existing daemon-global shared-token file, only when no host pairing exists

Corrupt/unavailable or unresolved host-bound storage fails closed instead of
falling back. Symlinked or insecure home/store ancestry is refused, even when a
legacy token is readable; the command does not silently adopt or repair those paths. Environment overrides keep their existing precedence and are never
changed. A newly stored credential shadowed by an environment token is disclosed;
remove or update that override deliberately before expecting native readiness.
Companion QR/manual export is a separate existing bootstrap route, not an export
of the Agent-owned credential.

A verified pair establishes native intake identity only. Provider, workspace,
Jev availability and execution remain separate checks, and pairing does not
establish hosted, inbound or derived-continuation authority.

## Native intake setup readiness

Setup status is a read-only observation, never an authority grant. Agent uses the
same selected-host resolver and effective token precedence as native intake:
`GOODVIBES_CONNECTED_HOST_TOKEN`, `GOODVIBES_DAEMON_TOKEN`, the Agent-owned
pairing for the exact selected origin, then the existing daemon operator token
file (only when no host pairing exists). A fresh `control.auth.current` response must identify an
authenticated admin token principal other than `shared-token`, with
`read:work-ledger` and `write:work-ledger` (or `*`). The coarse `authMode` is not
pairing evidence. Intake and setup share this predicate.

The request is bounded to 1.5 seconds. Disabled connected-host dialing performs
neither the auth request nor setup's TCP service probes. After the response, the
selected host and effective credential are resolved again; any final change
invalidates that observation. No success is cached or restored from setup
receipts, checkpoints, or onboarding markers. Errors are fixed descriptions;
remote error bodies and credential-file parser diagnostics are never displayed.

The synchronous workspace snapshot cannot perform this live check and labels
host/auth readiness unverified. Historical setup receipts remain available as
history and durable evidence, but cannot promote those rows to ready or bypass
an unresolved critical closeout check. Asynchronous setup status can report
current readiness only after its live verification.

Provider/model selection, workspace configuration, Jev availability, execution
scope (`write:fleet`), and a successful assistant turn remain separate checks.
A ready auth row does not prove any of them. Execution still revalidates its own
host-issued authority; setup output never authorizes execution.
