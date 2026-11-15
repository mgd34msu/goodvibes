# Reference node host

This is a Bun/TypeScript reference client for the GoodVibes distributed remote contract.

It demonstrates the full node-host lifecycle against the existing `/api/remote` surface. Each step below maps to one HTTP call the client makes against the daemon.

- pair request, `POST /api/remote/pair/request`, registers this node host and receives a pairing challenge back
- operator approval, `POST /api/remote/pair/requests/<id>/approve`, the step an operator (or, for local testing, this client itself when given an `operatorToken`) takes to approve the pending request
- pair verification, `POST /api/remote/pair/verify`, exchanges the challenge for a peer token once approval has happened
- heartbeat, `POST /api/remote/heartbeat`, keeps the peer record alive and reports its capabilities and commands
- work pull, `POST /api/remote/work/pull`, claims pending work items up to a configured lease and batch size
- work completion, `POST /api/remote/work/<id>/complete`, reports each claimed item's outcome back to the daemon
- reconnect and backoff, an exponential backoff with jitter that resets after every successful pass and lengthens after every failed one, so a client that loses its peer token or its network connection recovers on its own

It answers three work types itself, from facts it already has:
`status.request` reports the client's uptime and configured heartbeat/work-pull
intervals, `location.request` reports the host's hostname, platform,
architecture, and working directory, and `session.message` echoes the received
message back as acknowledged.

`automation.run` and `invoke` (the generic command path used when no other
type matches) need real execution. The reference host reports them `failed`,
with an error naming the work type and the handler to supply, unless you pass
one to the client:

```ts
const client = new ReferenceNodeHostClient(config, {
  'automation.run': async (work) => ({ status: 'completed', result: await runAutomation(work) }),
  invoke: async (work, command) => ({ status: 'completed', result: await runCommand(command, work.payload) }),
});
```

A handler that throws reports the item `failed` with its message. Every type
is subject to the same allowlist.

## Usage

```bash
cd examples/reference-node-host
bun src/cli.ts --config ./config.example.json start
```

`start` runs the full lifecycle in a loop until the process is stopped. The
CLI also accepts single-step commands for exercising one part of the flow at
a time. `contract` fetches and prints the node-host contract, `pair` sends
only the pair request, `verify` attempts pairing verification against
whatever state was already saved, and `once` runs a single
heartbeat-and-work-pull pass and prints its summary.

The client dials the local daemon's control plane: `baseUrl` in the config
when set, else `GOODVIBES_DAEMON_URL`, else `http://127.0.0.1:<controlPlane.port>`
from `~/.goodvibes/tui/settings.json` (under `GOODVIBES_HOME` when that is
set), else port 3421.

For a first pairing run, the daemon must approve the pair request before verification succeeds. If you supply an `operatorToken` in your config, the reference client can approve its own request through the operator endpoint for local testing.

The `requestedId` is fixed per host, so pairing again (lost state, revoked token) names the peer the daemon already holds, and the daemon refuses to approve it with `REMOTE_PAIR_REPLACES_PEER` unless the approval carries `confirmReplace: true`. The client retries once with `confirmReplace: true` after that refusal; set `confirmReplace` to `false` in the config to leave such approvals to an operator.

## State

The client persists token and pairing state to the configured `statePath`. The sample config stores it under:

`~/.goodvibes/reference-node-host/state.json`

## Notes

- Command allowlisting is enforced before any work item is handled, not
  just `invoke` items. Every work type resolves to a command string first,
  and an unlisted command fails the item instead of reaching a handler.
- The client does not execute arbitrary shell commands. The built-in handlers
  answer from facts the host has; work that needs execution fails until you
  supply a handler for it.
