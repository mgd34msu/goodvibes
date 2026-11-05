# @goodvibes-jev/engine/transport-core

Public GoodVibes transport-core package for shared transport, event-feed, observer, and middleware primitives.

Most applications should install `@goodvibes-jev/engine` and import `@goodvibes-jev/engine/sdk/transport-core`. These modules are subpath exports of the engine package.

Use this surface only when you are composing your own transport/client abstraction.

Key exports:
- Event envelopes: `createEventEnvelope` (with the `EventEnvelope` / `EventEnvelopeContext` types).
- Client transport: `createClientTransport`, `createDirectClientTransport`.
- Middleware: `composeMiddleware` (with the `TransportMiddleware` / `TransportContext` types).
- Transport error helpers: `transportErrorFromUnknown`, `isAbortError`, `describeUnknownTransportError`.
- Runtime event feeds: `createRuntimeEventFeed`, `createRuntimeEventFeeds`.
- Transport observer: `invokeTransportObserver` (with the `TransportObserver` / `TransportActivityInfo` types), the error-isolated call wrapper behind the SDK's pluggable telemetry hooks.
- W3C trace propagation: `injectTraceparent` (sync, `require`-based OTel detection) and `injectTraceparentAsync` (async, dynamic `import`). Both are no-ops without `@opentelemetry/api` installed or an active span.
- Utilities: `createUuidV4`.

A `./relay` subpath (`@goodvibes-jev/engine/sdk/transport-core/relay`) exports the runtime-neutral building blocks for the zero-knowledge, self-hostable relay, including ECDH key exchange, AEAD framing, handshake, pairing payload encoding, and the secure channel used by the relay client (`transport-realtime`), the relay server, and daemon-side termination. It is kept out of the main entry point on purpose, so most consumers never pull in the crypto primitives; import it directly only when implementing relay transport or tooling.

```ts
import {
  createEventEnvelope,
  createUuidV4,
} from '@goodvibes-jev/engine/sdk/transport-core';

const envelope = createEventEnvelope(
  'TURN_SUBMITTED',
  { turnId: createUuidV4(), prompt: 'Hello' },
  { sessionId: 'sess_abc', source: 'orchestrator' },
);
```

Most consumers should use `@goodvibes-jev/engine/sdk`, `@goodvibes-jev/engine/sdk/operator`, or `@goodvibes-jev/engine/sdk/peer` instead.
