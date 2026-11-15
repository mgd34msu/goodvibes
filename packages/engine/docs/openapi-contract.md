# Published OpenAPI operator contract

The operator contract is published as a real OpenAPI 3.1 document, generated
from the committed contract artifact and kept honest by a drift gate.

## Where to fetch it

- **Package export:** `@goodvibes-jev/engine/contracts/operator-openapi.json` and
  `@goodvibes-jev/engine/platform/contracts/operator-openapi.json`
- **In the repository:** `contracts/artifacts/operator-openapi.json`, the only
  tracked copy. A second byte-identical file under `docs/` was removed; link to
  this one. Agents that only need sessions, tasks, contracts, approvals and
  events should start from the [small agent-facing spec](#small-agent-facing-spec).

## What it contains

- Every cataloged operator method. The paragraph between the markers is written
  by `scripts/generate-openapi-contract.ts` from the contract, so its counts
  cannot drift from the document.
  <!-- openapi-counts:start -->
  Methods with a dedicated REST binding appear as path operations (497 operations, one per
  method's declared HTTP verb and path); methods without one are reachable only through the
  generic invoke endpoint (`POST /api/control/gateway-methods/{methodId}/invoke`, operation 498,
  75 methods) and are listed on it under `x-invoke-only-methods`.
  `x-operator-methods` is a flat index of all 572 cataloged methods, REST-bound
  or invoke-only, each with its category, access level, resolved REST route (or
  `null` for invoke-only), and schema/typed-IO coverage.
  <!-- openapi-counts:end -->
  `x-operator-methods` in the document is authoritative.
- Real JSON Schemas for request/response bodies, embedded directly from the
  contract (OpenAPI 3.1 uses full JSON Schema, so they transfer unmodified).
  A method whose contract schema is absent or a bare object with no declared
  properties is marked `x-schema-coverage: schema-less` instead of being given
  an invented schema.
- **Honest typed-IO marking.** A method lacks typed platform client IO when its id
  has no entry in the generated `OperatorMethodInputMap`/`OperatorMethodOutputMap`.
  That untyped set is currently empty: every cataloged method carries a
  rendered map entry, so every operation carries `x-typed-client-io: true` and
  `x-untyped-client-io-count` reads `0`. The marking mechanism stays in the
  generator (and in this document) because the ratchet is enforced, not fixed;
  a future method that ships without a map entry would surface here as
  `x-typed-client-io: false` and a nonzero count, not silently.
- For GET and DELETE methods, top-level input-schema properties that are not
  already path parameters are emitted as query parameters instead of a request
  body, since those HTTP verbs carry no body in this contract.
- The auth scheme from the contract's auth block: `bearerAuth` (HTTP bearer) and
  `sessionCookie` (the login-issued cookie), with `access: public` methods
  opting out via an empty `security` array on their own operation (the document
  level still requires one of `bearerAuth`/`sessionCookie` by default). The full
  contract auth block rides along as `x-auth-contract`.

## Regeneration and drift (the generated-artifact idiom)

```
bun run openapi:generate   # regenerate the document and the counts above
bun run openapi:check      # exit 1 on drift
```

`contracts:check` (part of `validate`) runs the drift check, so a change to the
operator contract that is not reflected in the committed OpenAPI document, or a
hand-edit to the document, fails gates. The generator's inputs are themselves
committed artifacts (`operator-contract.json` plus the typed-client-IO ratchet
inputs), so generation is deterministic.

## Streams and replay

- The two server-sent event routes (`control.events.stream`, `companion.chat.events.stream`)
  declare a `text/event-stream` 200 response, not a JSON body.
- Operations that already replay safely name their replay key in an
  `x-replay-key` extension (`in: body`, `name`, `behavior`) and in their
  description: `sessions.register` (`sessionId`), `workLedger.submit`,
  `workLedger.intake.capture` and `workLedger.importLegacy` (`requestId`). There
  is no `Idempotency-Key` header; the key is a field of the request body.

## Small agent-facing spec

The full document is large. For an agent or script that only needs sessions,
tasks, contracts, approvals and the event stream there is a generated slice:

- `docs/agent-api.openapi.json`: those operations only, with repeated schemas
  shared under `components.schemas`, the real error body, and the error
  responses each operation can return (`400`, `401`, `403` with the missing
  scopes, `404`, `409`, and `default`).
- `docs/agent-api-index.md`: one line per operation (id, route, scopes, replay
  key, what it does), the event ids and domains, the replay keys, and the error
  codes with their status.

```
bun run agent-spec:generate   # write both files from the committed contract
bun run agent-spec:check      # exit 1 when they are stale
```

No build, test or gate writes these files; run the generate command after a
change to the sessions, tasks, contracts or approvals methods (or their events)
and commit the result. They are derived from the same
`contracts/artifacts/operator-contract.json` as the full document.
