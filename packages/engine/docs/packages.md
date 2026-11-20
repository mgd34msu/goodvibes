# Entry point guide

Install the `@goodvibes/engine` package. Its explicit import subpaths include
`@goodvibes/engine/platform` for client factories and runtime services,
`@goodvibes/engine/contracts` for contracts, and
`@goodvibes/engine/errors` for errors. These are modules of one engine
package, rather than separately installed packages. The entry-point column
below is an import path; the install column always names the package root.

See the [Published Surface Matrix](./surfaces.md) for the two-tier model: full surface (Bun) vs. companion surface (Hermes / browser / Workers). For the internal runtime-boundary model, see [Runtime Surfaces](./runtime-surfaces.md).

## Consumer decision matrix

| Consumer | Entry point (import path) | Install | Read |
|---|---|---|---|
| Bun service (TUI, daemon) | `@goodvibes/engine/platform` | `bun add @goodvibes/engine` | [Getting started](./getting-started.md) |
| Bun CLI app | `@goodvibes/engine/platform` | `bun add @goodvibes/engine` | [Getting started](./getting-started.md) |
| Bun server host (daemon routes) | `@goodvibes/engine/platform/daemon` | `bun add @goodvibes/engine` | [Daemon embedding](./daemon-embedding.md) |
| React Native app (Hermes) | `@goodvibes/engine/platform/react-native` | `npm install @goodvibes/engine` | [React Native integration](./react-native-integration.md) |
| Expo app | `@goodvibes/engine/platform/expo` | `npm install @goodvibes/engine` | [Expo integration](./expo-integration.md) |
| Browser SPA needing all operator methods | `@goodvibes/engine/platform/browser` | `npm install @goodvibes/engine` | [Browser integration](./browser-integration.md) |
| Base knowledge/wiki WebUI | `@goodvibes/engine/platform/browser/knowledge` | `npm install @goodvibes/engine` | [Web UI integration](./web-ui-integration.md) |
| Home Assistant panel | `@goodvibes/engine/platform/browser/homeassistant` | `npm install @goodvibes/engine` | [Browser integration](./browser-integration.md) |
| Agent knowledge browser panel | `@goodvibes/engine/platform/browser/agent` | `npm install @goodvibes/engine` | [Web UI integration](./web-ui-integration.md) |
| Web app needing the full operator contract | `@goodvibes/engine/platform/web` | `npm install @goodvibes/engine` | [Web UI integration](./web-ui-integration.md) |
| Cloudflare Worker batch bridge and provisioning routes | `@goodvibes/engine/platform/workers` plus daemon `/api/cloudflare/*` | `npm install @goodvibes/engine` | [Daemon batch processing](./daemon-batch-processing.md) |
| iOS native | JSON contracts via `/contracts/operator-contract.json` and `/contracts/peer-contract.json` | N/A | [iOS integration](./ios-integration.md) |
| Android native | JSON contracts via `/contracts/operator-contract.json` and `/contracts/peer-contract.json` | N/A | [Android integration](./android-integration.md) |

`/browser` and `/web` are both companion-safe browser runtime entrypoints. Use
`/browser` for generic browser applications and `/web` for web UI hosts.

## Advanced platform entry points

| Entry point | Use it when |
|---|---|
| `@goodvibes/engine/platform/platform/node` | You need runtime capability metadata or Node-like runtime-boundary checks before loading server-side modules |
| `@goodvibes/engine/platform/platform/runtime` | You are wiring runtime bootstrap, observability, operations, security, shell, state, transport, or UI behavior |
| `@goodvibes/engine/platform/platform/knowledge` | You are using the base self-improving knowledge/wiki system directly |
| `@goodvibes/engine/platform/platform/knowledge/home-graph` | You are extending the knowledge system for Home Assistant Home Graph behavior |
| `@goodvibes/engine/platform/platform/providers` | You are working with provider registries, model catalogs, capabilities, or provider-specific runtime helpers |
| `@goodvibes/engine/platform/platform/tools` | You are registering or executing runtime tools from a full platform host |
| `@goodvibes/engine/platform/platform/pairing` | You need QR code generation, companion token management, and connection info formatting |
| `@goodvibes/engine/platform/platform/daemon` | You need daemon HTTP host helpers, including port-in-use checking |

The platform surface is explicit. There is no root
`@goodvibes/engine/platform/platform` entry and no public
`@goodvibes/engine/platform/platform/*` wildcard export. Import only subpaths listed
in `package.json` and the canonical [Public surface](./public-surface.md) reference.

Treat `platform/...` modules as full-platform/server-side unless a specific
document marks the entry point as companion-safe. Today the full surface is
Bun-oriented; `platform/node` exposes capability metadata and runtime-boundary
helpers without aggregating the full platform. Do not
bypass the package export map from applications; repository file layout is not
the consumer contract.

## Companion-safe entry points

These entry points contain no Bun globals and bundle cleanly with Metro, Vite, webpack, and esbuild:

| Entry point | Purpose |
|---|---|
| `@goodvibes/engine/platform/react-native` | React Native (Hermes) defaults |
| `@goodvibes/engine/platform/expo` | Expo companion defaults and Expo secure token stores |
| `@goodvibes/engine/platform/browser` | Full browser defaults and complete operator contract |
| `@goodvibes/engine/platform/browser/knowledge` | Scoped base knowledge/wiki browser client |
| `@goodvibes/engine/platform/browser/homeassistant` | Scoped Home Assistant Home Graph browser client |
| `@goodvibes/engine/platform/browser/agent` | Scoped browser client for the Agent-owned knowledge environment; routes Knowledge/Wiki calls to the agent knowledge routes |
| `@goodvibes/engine/platform/web` | Full web UI companion defaults |
| `@goodvibes/engine/platform/workers` | Manual Cloudflare Worker bridge for optional daemon batch queue/tick integration; platform-owned provisioning is done through daemon `/api/cloudflare/*` routes |
| `@goodvibes/engine/platform/auth` | Token storage and auth flows |
| `@goodvibes/engine/platform/client-auth` | Low-level auth primitives: `AutoRefreshCoordinator`, platform-specific token stores, and auto-refresh options. Use `@goodvibes/engine/platform/auth` for most use cases. |
| `@goodvibes/engine/platform/observer` | Observability helpers (`createConsoleObserver`, `createOpenTelemetryObserver`). Also re-exported from root. |
| `@goodvibes/engine/platform/errors` | Typed error classes |
| `@goodvibes/engine/platform/contracts` | Runtime-neutral contract types and method IDs |
| `@goodvibes/engine/platform/operator` | Operator/control-plane client |
| `@goodvibes/engine/platform/peer` | Peer/distributed-runtime client |
| `@goodvibes/engine/platform/transport-core` | Transport/event-feed primitives |
| `@goodvibes/engine/platform/transport-http` | HTTP/SSE/auth/retry primitives |
| `@goodvibes/engine/platform/transport-realtime` | Runtime-event connectors over SSE and WebSocket |
| `@goodvibes/engine/platform/transport-direct` | In-process direct transport facade subpath; see [Transports](./transports.md) |

The default test suite (`test/rn-bundle-node-imports.test.ts`, CI job `proofs`) enforces that nothing a companion entry point imports, followed from source through the exports maps, uses a Node built-in module or calls a `Bun.*` API.


## Transport middleware

The platform supports Koa-style transport middleware via `platformClient.use()`. Middleware wraps every HTTP request/response cycle through the operator and peer transports.

```ts
import { createGoodVibesPlatform } from '@goodvibes/engine/platform';
import type { TransportMiddleware } from '@goodvibes/engine/platform/transport-core';

const platformClient = createGoodVibesPlatform({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

// Append middleware at construction time via options.middleware:
// const platformClient = createGoodVibesPlatform({ ..., middleware: [myMiddleware] });

// Or append after construction:
platformClient.use(async (ctx, next) => {
  const start = Date.now();
  console.log('->', ctx.method, ctx.url);
  await next();
  console.log('<-', ctx.response?.status, Date.now() - start, 'ms');
  if (ctx.error) {
    console.error('transport error', ctx.error);
  }
});
```

Middleware runs in order. Each middleware receives a mutable `TransportContext` and a `next()` function. Calling `next()` executes the remainder of the chain (including the real fetch). After `await next()` returns:
- `ctx.response`: the `Response` object (on success)
- `ctx.durationMs`: round-trip time in milliseconds
- `ctx.error`: the thrown error (on failure)

Middleware can:
- inspect or mutate request headers (`ctx.headers`) before the fetch
- inspect the response after `next()` resolves
- short-circuit by not calling `next()` (returns without a response)
- access `ctx.signal`, `ctx.body`, `ctx.options` for per-request data

`TransportMiddleware` and `TransportContext` are exported from `@goodvibes/engine/platform/transport-core`.

`composeMiddleware` is also exported for building standalone composed chains outside the platform:

```ts
import { composeMiddleware } from '@goodvibes/engine/platform/transport-core';

const executor = composeMiddleware([loggingMiddleware, retryMiddleware], innerFetch);
```

## Contracts

The `@goodvibes/engine/platform/contracts` entry is runtime-neutral. Raw JSON artifacts are available at:
- `@goodvibes/engine/platform/contracts/operator-contract.json`
- `@goodvibes/engine/platform/contracts/peer-contract.json`

`@goodvibes/engine/platform/contracts/node` exports filesystem path helpers for locating JSON contract artifacts on disk. It is a build/tooling convenience, not a runtime surface.

## Entry point relationships

- `@goodvibes/engine/platform/auth` adds token storage and login/current-auth helpers.
- `@goodvibes/engine/platform/contracts` is the typed vocabulary layer (method IDs, endpoint IDs, event maps).
- `@goodvibes/engine/platform/errors` defines the shared error model (`GoodVibesError`, `EngineErrorKind`).
- `@goodvibes/engine/platform/transport-*` subpaths carry low-level transport behavior.
- `@goodvibes/engine/platform/operator` and `/peer` build contract-driven clients on top of transport.
- `@goodvibes/engine/platform` (client facade) composes those pieces into a Bun-optimized full-surface platform.
- `@goodvibes/engine/platform/daemon` is the reusable server/daemon route layer for Bun hosts.

## Implementation module subpaths

The engine modules (`@goodvibes/engine/contracts`, `@goodvibes/engine/daemon-api`,
`@goodvibes/engine/transport-core`, `@goodvibes/engine/transport-http`, `@goodvibes/engine/operator-client`,
`@goodvibes/engine/peer-client`, and `@goodvibes/engine/errors`) also expose additional deep subpaths,
for example `contracts/generated/*`, `contracts/zod-schemas/*`, `daemon-api/*` route helpers,
`transport-core/*`, `transport-http/*`, the operator/peer `client*` entries, and
`errors/daemon-error-contract`. These back the `@goodvibes/engine/platform` facade and are not part of the
supported consumer contract; import the matching `@goodvibes/engine/platform/...` subpath instead. See
[Public exports](./exports.md) for the same guidance.
