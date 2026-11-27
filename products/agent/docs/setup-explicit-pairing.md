# Explicit Agent pairing

On the daemon's own machine the Agent needs no pairing: the operator token file
it already reads is reported by the daemon as the `local` credential, which has
native intake, submission and execution authority. The daemon grants `local`
only to a direct loopback connection: a request that arrives through a proxy or
tunnel (it carries a forwarding header such as `X-Forwarded-For` or
`CF-Connecting-IP`, or is addressed to a non-loopback name) is the operator
token from another machine, and while `controlPlane.publicBaseUrl`,
`web.publicBaseUrl` or `cloudflare.daemonHostname` is set no loopback request
counts as `local`, so on a published daemon the Agent pairs here too. Pairing is
for an Agent on another machine (attribution and revocation per device).

The selected host is the daemon on this machine, or the origin stated in
`daemon.connectedHost.url` (for one run, `--runtime-url`). A host on another
machine must be stated with its scheme, `https://` or `http://`. This machine's
daemon token is never sent to another machine, and that includes
`GOODVIBES_DAEMON_TOKEN`; the environment credential sent there is
`GOODVIBES_CONNECTED_HOST_TOKEN`.

The owner pairs this Agent as their own device with a sign-in code they start
in person, where they are signed in as themselves: in that daemon's web UI (or
their terminal app on that machine), Devices and network, Pair something, "Show the
sign-in code once". Then, in a terminal on this machine:

```sh
goodvibes-agent setup pair --with-code              # type or paste the code when asked
goodvibes-agent setup pair --name laptop --with-code
```

The code is read from the terminal, never from an argument (other processes can
read those), and the host must confirm it as a device of the owner's; nothing else is
asked. `--name <name>` is the device label (default `GoodVibes Agent`). Without
`--with-code` the command prints its one usage line and exits `2`; without an
interactive terminal it says the code is typed in a terminal and exits `2`;
Enter alone cancels (`2`). It exits `0` when paired and `1` when the host did
not take the code (already used, older than 15 minutes, or never one: make a
new one) or could not be reached; every outcome is one sentence saying what to
do. Inside the interactive Agent the same is Pair something, "This program with
its daemon", in the Devices and network place (or "Pair with a host" on the
Setup tab of System), with the code typed into its field.

When the host's answer to an earlier pairing was lost, the result says so
(`unknown`): a key made for it was never received, cannot sign in and stops
working within 15 minutes. `goodvibes-agent setup unpair` forgets that attempt;
then pair with a new code. When the host no longer accepts the stored device
credential (revoked there, or the daemon was reset), pairing again says
`credential-rejected`. `goodvibes-agent setup unpair` (or "forget its daemon
pairing", `U` on the Paired tab of Devices and network) forgets the stored
credential for the selected host at any time; nothing is sent to the host, and
the key stays valid there until it is revoked there. It exits 0 when something
was forgotten and 1 otherwise. A pairing store that cannot be used names the
cause, the path and the fix. Pairing does not establish provider, workspace,
Jev or execution readiness.

## Storage and uncertain outcomes

Credentials are stored under the selected Agent home in
`.goodvibes/agent/connected-host-pairings/pairings.json`. The dedicated directory
is 0700 and the file is 0600. Entries are bound to a canonical HTTP(S) origin;
userinfo, paths, query and fragment components are refused. No host aliases are
inferred. The daemon-global `.goodvibes/daemon/operator-tokens.json` is not
changed. Secret values and remote/parser errors are never returned by the
pairing command or preview.

A cross-process-locked, durable unknown-outcome marker is written before the
single pairing request. The request has no automatic retry and rejects
redirects. A lost, malformed, overlarge or interrupted response leaves that
marker in place, including after a process restart, until `setup unpair`
forgets it.

A valid returned secret is durably saved before live verification. This avoids
losing the only copy when verification is interrupted. The final check verifies
the expected newly minted principal. Changed configuration or failed verification
is reported as stored but unverified and never causes another mint.

## Effective credentials and scope

Agent's outgoing host connections resolve credentials in this order:
1. `GOODVIBES_CONNECTED_HOST_TOKEN`
2. `GOODVIBES_DAEMON_TOKEN`, only when the selected host address is this
   machine (it is this machine's daemon token and is never sent elsewhere)
3. Agent-owned pairing for the exact selected origin
4. Existing daemon-global shared-token file, only when no host pairing exists
   and the selected host address is this machine (loopback or one of its own
   interface addresses)

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

## The delegated credential

The calls the Agent makes on the owner's behalf (schedule changes, channel
drafts and routing, profile and occasions writes) are sent with a second
credential, the Agent's delegated credential: a pairing the host marks
`client: "agent"` and reports as credential `agent`. The host judges every call
made with it (recorded native admission) and never lets it claim that a person
asked; nothing in the request body selects that. It is made automatically, the
first time it is needed, with the Agent's ordinary credential
(`pairing.tokens.create` with `client: "agent"`), saved in
`~/.goodvibes/agent/connected-host-pairings/delegations.json` (owner-only), and
reused. Its attempt id is saved before the request leaves, so a lost reply is
settled by repeating the same request. The host lists it with the paired devices
(it does not count toward `device.nodes.maxPaired`); revoking it makes the next
delegated call make a new one, and revoking the Agent's own pairing revokes it
too.

## Native intake setup readiness

Setup status is a read-only observation, never an authority grant. Agent uses the
same selected-host resolver and effective token precedence as native intake:
`GOODVIBES_CONNECTED_HOST_TOKEN`, `GOODVIBES_DAEMON_TOKEN` (for this machine's
daemon only), the Agent-owned pairing for the exact selected origin, then the existing daemon operator token
file (only when no host pairing exists). A fresh `control.auth.current` response must report an
authenticated admin whose `credential` is `local` (the operator token on the
daemon's own machine) or `device-token` (a paired device), with
`read:work-ledger` and `write:work-ledger` (or `*`). The daemon states the
credential kind; nothing is inferred from the principal's name. Intake and setup
share this predicate.

The request is bounded to 1.5 seconds. Disabled connected-host dialing performs
neither the auth request nor setup's TCP service probes. After the response, the
selected host and effective credential are resolved again; any final change
invalidates that observation. No success is cached or restored from setup
receipts, checkpoints, or onboarding markers. Errors are fixed descriptions;
remote error bodies and credential-file parser diagnostics are never displayed.

The synchronous setup snapshot cannot perform this live check and labels
host/auth readiness unverified. Historical setup receipts remain available as
history and durable evidence, but cannot promote those rows to ready or bypass
an unresolved critical closeout check. Asynchronous setup status can report
current readiness only after its live verification.

Provider/model selection, workspace configuration, Jev availability, execution
scope (`write:fleet`), and a successful assistant turn remain separate checks.
A ready auth row does not prove any of them. Execution still revalidates its own
host-issued authority; setup output never authorizes execution.
