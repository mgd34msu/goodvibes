# Daemon CLI and package contracts

The private `@goodvibes-jev/daemon` package exposes an import-inert `./cli`
barrel and a separate executable entrypoint. Source and emitted modules support
its Bun and ESM export conditions. Product identity/version comes from the
actual private manifest, with an exact synchronized compiled fallback; the
binary display name is `goodvibes-daemon`. Unrelated package manifests cannot
supply its version.

## Command grammar and dispatch

The command vocabulary, aliases, flag arities, refusal statuses, `provider:model`
registry-key syntax, passthrough arguments and platform service wording are
exact program grammar. Bash, zsh and fish completion generation returns scripts;
it does not install them into a shell.

`src/cli/entrypoint.ts` is the side-effectful Bun process entry reached by the
checked-in `bin/goodvibes-daemon`. It supplies `createProductionDaemonRuntime()`
to the dispatcher. The production inbox represents actual unconfigured members
and requires trusted account admission for configured providers.
An embedded dispatcher without an inbox factory refuses serve before acquisition.
Do not recreate the superseded claim that the shipped entrypoint has no factory,
or substitute an empty set for required provider membership.

The dispatcher awaits asynchronous config and one-shot adapters without creating
a second host graph. Canonical tree/identity homes, daemon tier and the historical
`tui` surface remain explicit. Flags override a copied environment, never the
embedding process environment or cwd. Provisioning resolves ownership without
opening or migrating unrelated settings. Serve model, endpoint, config and
feature overrides are runtime-only; refused feature overrides must not be ignored.
Explicit provider flags take precedence over the provider in a qualified model
argument. Completion, help and parse failures occur before configuration access;
provisioning help must not reach a download adapter. OSC-52 output is emitted once.

Serve wires config, event bus, store and an explicitly composed inbox through
`runDaemonProcess`/`createDaemonHost`. Canonical owners retain restart fences,
startup rollback, boot drainage, signal admission and the 15-second terminal
deadline. Capability opt-ins remain explicit. Service activation additionally
requires an explicitly composed installed executable path. Systemd definitions
preserve the selected daemon identity in argv, a relocated tree in
`GOODVIBES_HOME`, and the workspace in `WorkingDirectory`; unit paths use the
login home. Start/restart with selected homes or an explicit workspace check the
persisted definition against the selected executable and all directories before
activation. A mismatch
refuses without a platform mutation. Other platforms refuse selected-home
activation before dispatch. The shipped entrypoint does not implicitly grant
service activation.

The checked-in launcher exists before dist emission so frozen installation can
create the actual Agent/TUI consumer bin links. The root need not be a daemon
dependency consumer. Preserve manifest/lock/bin metadata agreement and shebangs.
The tarball is built from the owned workspace, not an unrequested registry release.

Service and strict wake-provisioning state receipts stay on stdout even with a
nonzero status. `service-status --json` remains consumable at exit 3 (installed
but stopped) and exit 4 (not installed), rather than being moved to stderr.
`install-service` exits 3 when the unit was written but the daemon is not running,
and `uninstall-service` exits 4 when nothing was installed.

## Status, sessions and config

Status and update reporting preserve HTTP endpoint/envelope selection, the
shared remote-target convention, operator-token handling, partial-failure
reporting, local-only receipt/lifecycle reads and the honest absence of an
early update-check verb. Hosted session list/kill retains the named ws-only
method contract, argument checks, request bodies and daemon error rendering.
The transport helpers are the public terminal-shell exports already hoisted
from the daemon. This product does not maintain a second implementation.

Lifecycle marker bounds, field types, closed status values, argument grammar,
schema-key equality and duration formatting remain structural program contracts.
Config sensitivity remains the canonical terminal-shell decision: declared
schema keys use their schema declaration and unknown nested paths use the
registered credential-key reader. The command helpers return promises,
and every current caller awaits them. The executable dispatcher must await them as well.

### Recursive config output

Object rendering calls the same recursive `redactConfig` used for
JSON output. Scalar rendering, unset/empty/false/zero handling and recognized
secret references retain their original behavior. No lexical sensitivity
fallback or duplicate classifier is permitted.

## Selected-config HTTPS trust

`products/daemon/src/cli/run.ts` passes an explicit `fetchImpl` through the
existing `RemoteCommandDeps` seam for status/update. It uses the canonical
`createNetworkFetch` and the command's selected `ConfigManager`. Existing
bundled/custom trust modes, relative CA resolution, token/target selection,
HTTP documents, exit statuses and local update receipts are unchanged.
`update` reads the daemon's `update.status` verb and `update --check` runs its
`update.check` verb; neither installs anything.

The relative CA root remains `ConfigManager.getControlPlaneConfigDir()`, rather
than the working directory or selected daemon identity directory. No new flag,
configuration key, certificate store or global fetch installation is introduced.

### Request ownership

The shared helper carries its explicit reader in an asynchronous context for
the fetch invocation. Product-global wrappers in that call chain read the
explicit scope. The ambient fetch function and middleware remain intact; the
implementation never unwraps them or mutates the installed manager. Asynchronous
middleware and nested work inside that invocation inherit the selected scope;
independent concurrent calls and later unscoped calls retain their own policy.
Caller-provided TLS fields retain their existing precedence. Strict bundled
requests still use Bun's ordinary default trust instead of a synthesized CA set.

The scope is private to the canonical outbound transport module shared by the
public runtime/transport exports. No public API is added. This is HTTPS fetch
ownership; WebSocket, proxy and unrelated transport policy are not changed.

### Trust scope

Status/update HTTPS uses selected-config trust. This does not grant unrelated
WebSocket or proxy callers the same policy or alter system trust.

## Companion identity and startup pairing

- Call the existing `getOrCreateCompanionToken('tui', ...)` owner using the
  canonical, already-resolved `daemonHomeDirectory`. The historical surface
  argument and `<daemonHomeDirectory>/operator-tokens.json` identity stay intact.
- An explicit `GOODVIBES_DAEMON_TOKEN` takes precedence over that stored token;
  `GOODVIBES_HTTP_TOKEN` takes precedence over the effective daemon token for the
  optional HTTP listener. Overrides affect this process and do not replace the
  persisted companion identity. Clients using an override must use that same
  override; a different stored token does not authenticate the running server.
- Reuse the existing token record byte-for-byte on restart. Never search another
  daemon home or adopt workspace-scoped token files.
- Keep acquisition inside the process owner's admitted `start` operation.
  Invalid CLI/default-uncomposed serving and shutdown before startup admission
  create no token. Once acquisition is admitted, the persistent identity remains
  even if a later bind/start fails or shutdown is requested.
- Preserve the actual host's signal fences, restart ownership and awaited drain.
  Generic `createDaemonHost` embedding semantics are unchanged.

Do not use the separate adoption helper `resolveDaemonCompanionToken` for this
boot seam: it persists explicit overrides and would change runtime-only override
semantics.

### Atomic token publication and recovery

The existing engine companion-token owner publishes a complete sibling file
through the shared atomic JSON writer, with mode `0600` and the existing JSON
format. The shared writer rejects short writes before rename in both modes.
Default mode retains its existing file flush, chmod and atomic rename behavior;
this is not a new claim of complete pathname-ancestry durability on every OS.
Pre-publication errors fail startup without replacing an existing complete
record. No separate token persistence or generation implementation is added.

The existing unreadable-store quarantine behavior is retained. The CLI reports
that a new identity was created and paired clients must pair again, and states
whether the previous bytes were preserved. The warning contains neither token
bytes nor the unreadable file's body. Shutdown requested synchronously by that
reporting port prevents graph acquisition. This is not a cross-process token
creation lock: concurrent first boots may still publish distinct complete
records, with the last rename winning.

### Effective token and served origin

Startup renders the effective daemon token;
the secondary HTTP listener token is never substituted. Local `pair` honors its
explicit token, then the process daemon-token override, then the existing stored
identity. Only the stored-file fallback is decoded as a token record. Overrides
remain literal credential bytes and are never adopted into persistent identity.

The control-plane router serves the bundle. The shared engine origin resolver
derives bundled fallback from that binding. An optional
settled binding lets startup use the actual observed host/port after restart
settlement, rather than its intended configuration. The pre-bind diagnostic and
bound receipt retain their separate meanings. Explicit public URLs remain
authoritative, including separately hosted WebUIs with local serving disabled.
Direct TLS uses HTTPS at the actual listener port; proxy mode retains the plain
local HTTP binding unless an external public URL is explicitly configured.
Startup reads the listener owner's captured `boundScheme`, so a TLS setting
changed during held boot cannot relabel a socket that already bound. This adds
no TLS live-restart policy. Offline pair uses the declared configuration.
The exact shipped `http://127.0.0.1:3423` placeholder follows the webui command's
existing equality rule; this is not evidence about who set a stored value.

A local reprint can carry its declared nonzero `--port`, but cannot observe
another process's ephemeral endpoint. Zero or invalid local ports refuse before
credential reads. Public-URL persistence follows the maintenance policy below.

### Trusted output and lifecycle

Automatic credential-bearing output is restricted to an actual interactive stdout
TTY or a composed caller's explicit trusted local `pairingOutput` port.
Ordinary redirected/service diagnostic stdout, stderr, logs and fatal errors
receive no token. Explicit `pair` remains the intentional one-shot reveal.
The shared renderer produces both the QR and its copyable fragment-bearing link.

The startup pairing port is invoked only after the existing host admission,
boot and config-restart settlement fences. Its failure, synchronous shutdown,
or listener loss prevents later readiness and uses the existing complete graph
drain and terminal exit owner. No lifecycle or token owner is duplicated.
The bundled fallback requires the same configured bundle precedence and a
readable app shell. Disabled/missing bundles and malformed credential-bearing,
query/fragment, non-HTTP(S), or wildcard URLs yield a value-free unavailable
notice. Explicit external URLs are configuration authority, not a claim that
this process verified a remote deployment.

## Startup maintenance

The admitted CLI calls `pruneStaleOperatorTokens` after acquiring its
canonical companion identity. Both original workspace candidates come from
`workspaceOperatorTokenCandidates`; the selected daemon-home token is never a
pruning candidate when it aliases either location. The shared pruning owner
compares resolved paths and filesystem device/inode identity, including directory
symlinks in either direction and hard links. Unresolvable or unavailable identity
fails closed. Missing candidates are noops; failed removals produce a
credential-free warning. Token overrides remain runtime-only and do not replace
persistent identity.

After listener boot and restart settlement, Linux startup invokes the existing
`reconcileRedundantLegacyUnit`. It reads a fresh, read-only client configuration
from the selected home/surface, excluding runtime overrides, honors the configured
service name and uses the login home for unit paths. Relocated GoodVibes homes
never enter automatic host service reconciliation. Existing canonical-active,
live-mainpid, self-supervision, running-legacy, configured-endpoint, installer
marker, timeout and retirement-outcome guards remain authoritative. The process
owner aborts reconciliation on close; a late async endpoint probe cannot admit
retirement. The process lifecycle awaits startup settlement and graph drainage.
Refusals/failures have structural receipts; reconciliation failure is non-fatal.

### Empty-only stable public URL

The original shared helper's **empty-only, stable-name-only** policy is retained.
An explicit URL and the shipped nonempty placeholder are not overwritten. The
separate explicit `webui enable` placeholder/posture policy is unchanged.
Persistence requires an enabled readable served bundle and a settled binding
matching declared host/port/TLS configuration. Runtime-origin endpoint/bundle
inputs and ephemeral/drifted ports are not frozen into settings. The shared
helper accepts the observed binding, including its actual HTTPS scheme.
The existing ConfigManager persistence owner writes the selected daemon tier;
failed writes retain its rollback behavior and produce a non-fatal warning.
This happens independently of interactive pairing output. Loopback/IP fallbacks
remain unpersisted because the canonical host resolver does not call them stable.

## Pair, WebUI and wake commands

Local pairing reprints the existing token without mutating settings. Remote
pairing preserves the explicit confirmation flag, dry-run plan and named
handoff verb; it renders the returned link or reports missing-origin output.
The shared banner preserves QR, offer and posture rendering. Fixed address
equality, declared offer kinds and link grammar remain code as exact program contracts.

Web serving preserves its explicit posture flags, bundle validation, configured
origin, caller-selected URL and reported restart requirement. Enabling serving
does not change listener posture unless the caller supplies that flag. The
module composes neither a listener nor the WebUI product. Wake provisioning
continues to delegate model identity/checksums and managed-root derivation to
the engine, preserving opt-out and strict/degraded exit behavior.

### IPv6 origins

Web commands and pairing origin construction use the shared `formatHttpOrigin` formatter, exported by the
pairing subpath. Bare and already-bracketed IPv6 inputs produce one valid
authority; hostname and IPv4 formatting retain their existing form. Explicit
public URLs remain authoritative. Web command posture uses the existing origin-posture function,
and custom bindings are not described as necessarily using all interfaces.

### Complete settings transitions

To prevent enabling a network binding before a managed lock can refuse requested
narrowing, the command requires the
canonical `setDaemonValues` capability. It prepares the bundle, listener
posture, serving flags and derived URL together, validates every field and
managed lock, and replaces their single daemon settings file atomically. Live
values and observers are updated only after the complete write. This does not
add transactions across files or concurrent processes. Credential-bearing keys
are outside this batch capability.

The public URL is also prepared before writing. An explicit posture change
continues the default URL when it exactly matches the previously computed
serving origin (ignoring a trailing slash). This is an equality-based command
rule, not proof of who set the old value. A distinct custom URL is preserved;
without an explicit posture change, an existing non-placeholder URL is kept.
This corrects the ordinary enable-then-LAN sequence that otherwise left pairing
links pointing to loopback. Failure to update a required generated URL now
refuses the whole transition instead of enabling with mismatched links.

## Service commands and recovery

Canonical `PlatformServiceManager` owns service operations. Preserve all seven
subcommand grammars, structured status codes, local service definitions,
login-home versus state-home boundaries, legacy detection and explicit migration
consent. A new unit must be healthy before retiring the old one; unsuccessful
startup rolls back only the newly attempted target. An unidentified process
occupying a port is reported without being killed. Unattended reconciliation
retains canonical liveness, self-supervision, legacy-running, configured-endpoint
and installer-marker guards, plus per-call and cumulative deadlines.

Compiled binary recognition compares the exact declared basename. An interpreter
inside a daemon-named directory or similarly named helper executable is not the
binary. Explicit environment override and packaged-launcher precedence remain.

### Incomplete retirement

Retirement stops when either command does not positively
report success, including timeout or missing status. It retains the old
definition, reports the new healthy unit and the unconfirmed legacy state,
and asks the operator to verify before retrying. No diagnostic text is parsed
to infer that an unsuccessful command meant the unit was already stopped.

Failed/unknown stop or disable, thrown values including undefined, removal
exceptions with empty/absent messages, and reload failures produce nonzero
incomplete receipts. Preserve the healthy new unit once legacy retirement has
begun; do not roll it back after completed retirement steps. A reload exception
after removal must disclose that removal already completed. For unattended
reconciliation, removal exceptions are `failed` / `remove-failed`; failed or
thrown reload is `failed` / `reload-failed`, with completed removal explicit.
No prose parsing may reinterpret an unsuccessful command as a successful stop.

### Read-only preparation and rollback

Service manager construction uses the canonical `ConfigManager` with an
explicit read-only option. The same defaults, layer order and pure migration
transformations are applied in memory; configuration files, migration receipts
and quarantine state are not written. Mutating config methods refuse in this
mode. The product must not eagerly run persistent config migration before a
dry run, rejected endpoint flags or status request; actual daemon boot retains
the separate migration entrypoint.

The service status query does not delete a stale PID file. Explicit stop and
uninstall still own that cleanup. Migration refuses a managed target that already has a definition or reports
an active runtime, before installation or rollback. The one exception is a
resume: when the managed unit is installed, running and identical to the
definition this tool renders while the legacy unit still exists, migration
skips installation and the health check and runs only the retirement steps.
Incomplete-retirement messages print `goodvibes-daemon migrate-service -y` as
the retry command. Failed setup cleans up
only the newly attempted target and retains recovery state when stop/disable
cannot be confirmed. 
### Ordinary uninstall

Ordinary uninstall requires both an error-free
stop result and no observed running service before calling uninstall. A
nonzero, missing, timed-out or thrown result returns a nonzero incomplete
receipt and does not remove the recovery definition. Empty error text is not
treated as success, and no diagnostic text is interpreted as proof that a
service was already stopped.

The same command also reports an incomplete outcome if the final returned
status is still installed or running. Injected adapter exceptions during
uninstall have a separate receipt: removal may already have happened, and the
included status is explicitly the last confirmed pre-removal observation.
This is bounded adapter-exception hardening, not evidence of a routine
default-runner failure. It performs no automatic retry or additional removal.

## Standalone send

### Admission and selected ownership

The canonical emitted `goodvibes-daemon` executable accepts `send [message]`,
`--channel`, `--to`, `--title` and `--list`. It awaits stdin when no argument is
provided. Parsing/help failures happen before configuration acquisition. A named
channel is selected exactly, and an unnamed channel requires exactly one enabled
configured destination. Canonical gateway, service, routing, delivery and surface
feature gates still apply. Disabled/ambiguous destinations do not fall back.

Send remains a first-token command. Relocated homes are supplied through
`GOODVIBES_HOME` and `GOODVIBES_DAEMON_HOME`, with `GOODVIBES_WORKING_DIR` selecting
the workspace. It uses the same selected ConfigManager and daemon tier as the
other adapters, passing that identity into SecretsManager. Configuration retains
its existing migration and refusal rules. Only an admitted actual delivery
constructs SecretsManager, SubscriptionManager, ServiceRegistry, ArtifactStore
and ChannelDeliveryRouter. No host graph, listener, inbox, discovery task or
notification queue starts. The unused subscription service does not perform its
legacy-store fold during this one-shot acquisition.

Thirteen upstream surfaces are supported: Telegram, ntfy, Discord, Slack,
Google Chat, Signal, WhatsApp, iMessage, Microsoft Teams, BlueBubbles, Mattermost,
Matrix and generic webhooks. Shared canonical owners resolve their declared
credential references. Registry credentials retain precedence; a configured but
unresolved surface fallback cannot silently become an environment credential.
Absent optional bridge authentication remains distinct from failed configured
credentials. No credentials are created or provisioned by the command.

### Message, receipt and lifetime

The explicit command supplies outbound authority for its body. It does not grant
inbound-source processing authority or route arbitrary text through automatic
notification metadata-only policies. Per-surface transformations preserve the
upstream explicit-send markup contract. Telegram stays plain text without a
parse mode; Discord/Slack markup and mentions are escaped. Existing channel
length limits remain. Client URL auto-linking and cosmetic formatting behavior
are not claimed eliminated. No artifacts or control-plane links are synthesized.

Success means the send owner accepted the request. It does not prove arrival or
reading at a recipient. Telegram and Slack bot requests require literal protocol
acknowledgement; response URL HTTP rejection is unsuccessful. Other
HTTP-based owners retain their documented transport-level acknowledgement.
Missing response IDs are valid success; arbitrary provider IDs and capability
URLs never appear in CLI output. Failure says delivery was not confirmed,
publishes only structural status evidence, and adds no command or notification-queue retry.
The existing checked-address connection fallback for pinned webhooks remains.

Explicit sends opt into the existing ntfy duplicate override, so repeated calls
and a repeat after a failed attempt still reach transport. Ordinary notification
deduplication is unchanged. The command awaits the actual credential, fetch and
body owner. Successful transports that do not need their body cancel and await
the retirement attempt. A rejected cleanup is reported structurally without
reversing received acceptance or triggering a duplicate send. No detached timeout race is introduced; the existing per-provider
deadlines remain, and no universal cancellation/deadline guarantee is claimed.

### Diagnostic publication

The preceding channel diagnostic prerequisite withholds credential-bearing URLs
and known capability-derived receipt IDs without changing actual requests. Send
additionally selects structural diagnostics before loading configuration, where
parser errors could echo a
credential through migration logs, ingestion logs and direct stderr. The selected
mode withholds borrowed parse text and malformed-reference descriptors. A
quarantined declared credential holds a one-shot send before fallback resolution,
so a skipped setting cannot silently select another account. It retains
file/key identifiers and the
original private ConfigError for its owner. Existing default diagnostics and
configuration semantics remain available to other callers.

Secret-reference, registry and secret-store read owners have the same additive
structural mode. Delivery credential resolution selects it; the send stack also
selects it on its concrete registry and secret store. Provider error/reference
text, malformed-reference hostnames and unvalidated store-envelope fields remain
private. Resolution results and private errors retain their original semantics.
This command does not classify or
republish arbitrary provider error wording or query values at all. The shared
structural status projection supplies its public diagnostic, while original
private failures remain with existing semantic retry owners. No keyword-based
redaction or substitute semantic guess is added.

These modes are projections at known publication sites, not semantic classifiers,
global logger suppression, or a claim that every application log is public-safe.
