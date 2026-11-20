# Reference operator client (no daemon)

The same client calls as the [reference HTTP client](../reference-http-client/README.md), answered by a fixture daemon instead of a running one. Use it to try the client API offline, or as the pattern for testing a client of your own without starting a daemon. Like the HTTP example it imports only published `@goodvibes/engine/*` entry points, so `index.ts` can be copied out of this repository.

It demonstrates:

- `createFixtureDaemonFetch()`: a `fetch` that answers every operator route from the schema-valid sample responses the contracts package generates (`@goodvibes/engine/contracts/generated/mock-daemon-fixtures`). Routes with path parameters match too; an unknown route answers 404. Pass an array to record each request's method, path, operator method id and `Authorization` header
- handing that `fetch` to `createOperatorApiClient` and `createPeerApiClient`; the clients validate the fixture responses against the contract exactly as they validate a daemon's
- creating a session (`sessions.create`), then reading providers, the control plane, the node-host contract and the distributed runtime snapshot

Run it with:

```bash
bun examples/reference-operator-client/index.ts
```

It prints a JSON summary: `sessionId`, `providerCount`, `activeClients`, `peerContractBasePath` and `pairedPeers`. The values are the generated samples (`"sample"`, `0`, one-item lists), not real daemon state. Nothing is written to disk and no network request is made.

`bun run test` in `products/tui` runs it once.
