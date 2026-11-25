# Reference HTTP client

The smallest remote client of a running GoodVibes daemon. It imports only public engine entry points, `@goodvibes/engine/operator-client`, `@goodvibes/engine/peer-client` and `@goodvibes/engine/transport-core`, resolved here through the terminal app's workspace dependency, so `index.ts` works in any package that depends on `@goodvibes/engine` ([how to get it](../../../../packages/engine/README.md#getting-it)).

It demonstrates:

- creating the operator client (`createOperatorApiClient`) and the peer client (`createPeerApiClient`) against a daemon with a bearer token
- typed operator reads: the configured providers (`providers.list`), the control plane's active clients (`control.snapshot`) and the node-host contract a peer pairs against (`remote.node_host.contract`)
- the peer surface's operator read of the distributed runtime (`operator.snapshot`): pending pair requests and paired peers. A paired peer uses its own token for heartbeat and work; see `packages/engine/examples/peer-http-quickstart.mjs` for that journey
- passing a `fetch` of your own, which is how the test answers the same calls from recorded responses

Every response is checked against the operator or peer contract before the call returns, so a daemon of another version is reported by method and field.

Required environment:

- `GOODVIBES_BASE_URL`, the daemon's base URL, for example `http://127.0.0.1:3421`
- `GOODVIBES_TOKEN`, an operator bearer token (the shared token or a session token)

Run it with:

```bash
GOODVIBES_BASE_URL=http://127.0.0.1:3421 \
GOODVIBES_TOKEN=your-token \
bun examples/reference-http-client/index.ts
```

It prints a JSON summary: `providerCount`, `activeClients`, `peerContractBasePath`, `peerContractTransport`, `pendingPairRequests` and `pairedPeers`. A missing variable or a failed request is printed on stderr and the exit code is 1.

To try the same calls with no daemon, use [`reference-operator-client`](../reference-operator-client/README.md).
