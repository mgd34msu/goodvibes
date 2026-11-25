# Error handling

All public client packages normalize transport failures into structured platform errors. Every error type, code and helper is imported from `@goodvibes/engine/errors` (or `@goodvibes/engine/platform/errors`); there is one taxonomy, so an extension should not define its own.

## Typed error discrimination

Consumers should switch on `err.kind` rather than `instanceof` chains or message parsing. Every error thrown from the public API surface is a `GoodVibesError` with a stable `kind` discriminant.

```ts
import { GoodVibesError } from '@goodvibes/engine/platform/errors';

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
import type { GoodVibesPlatform } from '@goodvibes/engine/platform';
import { GoodVibesError } from '@goodvibes/engine/platform/errors';
import type { OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';

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
import { HttpStatusError } from '@goodvibes/engine/platform/errors';

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

## Refusals

A daemon that will not carry out a request says three things: the `state` things are in, the reason (`error`) and the `next` steps that would get past it, with `hint` set to the first step for clients that read only `hint`. A terminal shows `<reason>. <first next step>`. The same shape is `Refusal` in the errors package; `RefusalError` throws it, and a command returns `{ ok: true, lines }` or `{ ok: false, refusal }`. `formatRefusal(r)` gives the one line, and `readRefusal` reads it back from a caught error (its own refusal, or the daemon error body it carries).

## Not found, and a verb the daemon does not serve

A 404 whose body carries `code: 'MEMORY_RECORD_NOT_FOUND'` means the memory record you asked for does not exist. Any other 404 (a route the daemon does not have, or a bare 404 with no code) means the daemon does not serve that call, usually because it is older than your client: treat it as unsupported, not as an empty result.

## Building, serializing and checking errors

- `createHttpStatusError(status, url, method, body, fallbackHint?)` builds an `HttpStatusError` from a response. When the body is a structured daemon error body its fields win; the `code` comes from the body's `code`, then from its `category`, then from the status.
- `toJSON()` gives the structured fields with `undefined` entries left out; the `cause` chain is kept (through `cause`, `originalError` and `error`, up to 32 levels, safe against cycles).
- `instanceof` works across realms and after a serialize and parse round trip: an error carrying the matching `code` (or, for `HttpStatusError`, its own mark) passes the check for its class. Compare `Object.getPrototypeOf(err)` with `<Class>.prototype` when you need strict prototype identity.
- An unknown thrown value is normalized into a `GoodVibesError` without losing the original as its `cause`.
- Whether a failure is retried, and which statuses count, is in [Retries and reconnect](./retries-and-reconnect.md).

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
