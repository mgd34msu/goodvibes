# Error handling

> Consumer guidance. For internal error architecture see [Error Architecture](./errors.md).

All public client packages normalize transport failures into structured platform errors.

## Typed error discrimination

Consumers should switch on `err.kind` rather than `instanceof` chains or message parsing. Every error thrown from the public API surface is a `GoodVibesError` with a stable `kind` discriminant.

```ts
import { GoodVibesError } from '@goodvibes-jev/engine/platform/errors';

try {
  await platformClient.operator.control.snapshot();
} catch (err) {
  if (err instanceof GoodVibesError) {
    switch (err.kind) {
      case 'auth':
        // Redirect to login or surface auth UI
        break;
      case 'rate-limit':
        // Wait retryAfterMs then retry
        await delay(err.retryAfterMs ?? 1000);
        break;
      case 'network':
      case 'service':
        if (err.recoverable) {
          // Retry with backoff
        }
        break;
      case 'config':
        // Fix platform initialization options, do not retry
        break;
      case 'contract':
      case 'protocol':
      case 'internal':
      case 'tool':
      case 'validation':
      case 'not-found':
      case 'unknown':
        // Log and surface to the user
        break;
    }
  } else {
    throw err;
  }
}
```

See [error-kinds.md](./error-kinds.md) for the full reference on each kind.

## TUI and consumer example

```ts
import type { GoodVibesPlatform } from '@goodvibes-jev/engine/platform';
import { GoodVibesError } from '@goodvibes-jev/engine/platform/errors';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';

async function safeSnapshot(platformClient: GoodVibesPlatform): Promise<OperatorMethodOutput<'control.snapshot'> | null> {
  try {
    return await platformClient.operator.control.snapshot();
  } catch (err) {
    if (!(err instanceof GoodVibesError)) throw err;
    if (err.kind === 'auth') {
      // surface login prompt in TUI
      return null;
    }
    if (err.kind === 'network' && err.recoverable) {
      // schedule reconnect
      return null;
    }
    throw err;
  }
}
```

## Class-specific handling

The `HttpStatusError`, `ConfigurationError`, and `ContractError` subclasses remain available when callers need class-specific handling. Prefer `err.kind` for broad control flow.

```ts
import { HttpStatusError } from '@goodvibes-jev/engine/platform/errors';

try {
  await platformClient.operator.accounts.snapshot();
} catch (error) {
  if (error instanceof HttpStatusError) {
    if (error.status === 401) {
      // redirect to login, refresh token, or surface auth UI
    }
    console.error(error.status, error.category, error.hint);
  }
  throw error;
}
```

## Useful fields

Every error exposes the full set of 18 structured fields. See the canonical [Useful fields on every `GoodVibesError`](./error-kinds.md#useful-fields-on-every-goodvibeserror) table for the complete list and types.

Do not parse `message` strings when the structured fields are available.

## Core error classes

Four classes cover everything the platform throws; the three specialized classes
extend the base, so an `instanceof GoodVibesError` check catches them all.

| Class | When you get it |
| --- | --- |
| `GoodVibesError` | The base class for every platform error; carries the structured fields above |
| `ConfigurationError` | The platform was constructed or configured incorrectly (`ENGINE_CONFIGURATION_ERROR`, kind `config`) |
| `ContractError` | Client and daemon disagree about the contract (`ENGINE_CONTRACT_ERROR`, kind `contract`) |
| `HttpStatusError` | An HTTP failure with no more specific mapping (`ENGINE_HTTP_STATUS_ERROR`, source `transport`) |

## Category guidance

`ErrorCategory` has 16 values: the 15 daemon wire categories plus `contract`, which is added by the platform and is never marshalled over the wire.

- `authentication`
  Missing or invalid credentials.
- `authorization`
  Valid credentials, insufficient scopes/roles.
- `billing`
  Payment required or quota/billing failure.
- `rate_limit`
  Retry after backoff.
- `timeout`
  Remote timeout or transport timeout.
- `network`
  Connectivity failure before a response was received.
- `bad_request`
  Malformed or schema-invalid request payload.
- `not_found`
  Remote resource does not exist.
- `permission`
  Operation denied due to insufficient permissions.
- `tool`
  Tool execution failure.
- `config`
  Local platform misconfiguration.
- `protocol`
  Wire-format or protocol-level failure.
- `service`
  Remote failure or server instability.
- `internal`
  Daemon or platform internal failure.
- `unknown`
  Unclassified error.
- `contract`
  Contract drift or invalid method/endpoint usage (platform-local; not a wire category).
