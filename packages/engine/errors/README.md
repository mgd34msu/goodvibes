# @goodvibes-jev/engine/errors

Public GoodVibes error module for structured platform, transport, and daemon failures.

Most applications should install `@goodvibes-jev/engine` and import `@goodvibes-jev/engine/platform/errors`. These modules are subpath exports of the engine package.

## Install

```sh
npm install @goodvibes-jev/engine
```

## The error model

Every error thrown from the platform's public surface is a `GoodVibesError`. The `kind` field is the primary discriminant. Switch on it instead of `instanceof` chains or message parsing:

```ts
import { GoodVibesError } from '@goodvibes-jev/engine/errors';

try {
  await callIntegration();
} catch (err) {
  if (err instanceof GoodVibesError) {
    switch (err.kind) {
      case 'auth':       /* re-authenticate */ break;
      case 'rate-limit': await delay(err.retryAfterMs ?? 1000); break;
      case 'network':
      case 'service':    if (err.recoverable) { /* retry with backoff */ } break;
      default:           /* log and surface */ break;
    }
  } else {
    throw err;
  }
}
```

Concrete subclasses (`ConfigurationError`, `ContractError`, `HttpStatusError`) remain available for class-specific handling:

```ts
import { HttpStatusError } from '@goodvibes-jev/engine/errors';

try {
  // integration code
} catch (error) {
  if (error instanceof HttpStatusError && error.status === 401) {
    // re-authenticate
  }
}
```

The same symbols are re-exported from the platform facade, so platform consumers can import them from `@goodvibes-jev/engine/platform/errors` instead:

```ts
import { HttpStatusError } from '@goodvibes-jev/engine/platform/errors';
```

## Branch on structured fields

Use the structured fields instead of fragile message parsing:

- HTTP status (`status`)
- error category (`category`) and source (`source`)
- recovery hints (`recoverable`, `hint`, `retryAfterMs`)
- request correlation (`requestId`)
- typed code (`code`): match it with `isErrorCode(err, EngineErrorCodes.RATE_LIMITED)`

## Daemon wire contract

The `./daemon-error-contract` subpath exports the daemon-side wire types, independent of the runtime error classes:

```ts
import {
  DaemonErrorCategory,
  type DaemonErrorSource,
  type StructuredDaemonErrorBody,
} from '@goodvibes-jev/engine/errors/daemon-error-contract';
```

`DaemonErrorCategory` is both a string-literal union and a runtime const; `StructuredDaemonErrorBody` is the JSON shape the daemon returns in HTTP error responses.

The exported fields are intended to replace fragile message parsing in client and daemon integrations.

## Documentation

- [platform Error Kinds](../docs/error-kinds.md): per-kind consumer reference
- [Error Handling](../docs/error-handling.md): handling patterns
- [Error Architecture](../docs/errors.md): internal source map
