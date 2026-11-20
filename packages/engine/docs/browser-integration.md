# Browser integration

This is the **companion surface** for browser runtimes. See [Runtime Surfaces](./surfaces.md).

Browser apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP). Those require Bun. This guide is the shared foundation for every browser entrypoint: auth, transport, realtime events, error handling, and observability. For web-UI-application patterns built on this foundation, entrypoint selection, companion chat, attachments, and voice playback, see [Web UI integration](./web-ui-integration.md).

Use `@goodvibes/engine/platform/browser` when a browser app needs the complete
operator route contract. Use scoped browser entrypoints when an app owns one
extension surface:

- `@goodvibes/engine/platform/browser/knowledge` for the base knowledge/wiki WebUI.
- `@goodvibes/engine/platform/browser/homeassistant` for Home Assistant panels.
- `@goodvibes/engine/platform/browser/agent` (`createBrowserAgentPlatform`) for the GoodVibes Agent surface: the agent's own knowledge/wiki space under `/api/goodvibes-agent/knowledge`, plus work-plan, artifact, and companion-chat routes.

```ts
import { createBrowserGoodVibesPlatform } from '@goodvibes/engine/platform/browser';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
});
```

Scoped entrypoints expose the same auth/token options and shared session routes
without loading unrelated route metadata:

```ts
import { createBrowserKnowledgePlatform } from '@goodvibes/engine/platform/browser/knowledge';

const platformClient = createBrowserKnowledgePlatform({
  baseUrl: 'https://goodvibes.example.com',
});

await platformClient.knowledge.status();
```

The sections below (Auth, Realtime, Error handling, Observability) describe the
full `@goodvibes/engine/platform/browser` entrypoint. A scoped platform
exposes `operator.invoke(methodId, input)` instead of the typed
`operator.control.*` helpers, and `realtime.viaSse()` only: it has no
`realtime.viaWebSocket()`. The error classes work the same on every entrypoint.

## Auth

Preferred browser auth modes:
- same-origin cookie session
- bearer token when operating cross-origin or inside a custom shell

The HTTP transport always uses `credentials: 'include'`, so same-origin cookie-backed sessions work without additional wiring.

If you are using bearer tokens in the browser, pair the platform with `createBrowserTokenStore()` or your own `tokenStore` implementation. `createBrowserTokenStore` is not exported from the browser entrypoints; import it from `@goodvibes/engine/platform/auth` (or the package root, `@goodvibes/engine/platform`).

```ts
import { createBrowserTokenStore } from '@goodvibes/engine/platform/auth';
import { createBrowserGoodVibesPlatform } from '@goodvibes/engine/platform/browser';

const platformClient = createBrowserGoodVibesPlatform({
  tokenStore: createBrowserTokenStore(),
});
```

## Realtime

For browser UIs:
- use `platformClient.realtime.viaSse()` for operator dashboards and status views (every browser entrypoint)
- use `platformClient.realtime.viaWebSocket()` when you need a persistent duplex connection model (full `platform/browser` entrypoint only; the scoped entrypoints do not have it)

The browser entrypoint also enables conservative defaults for:
- HTTP retry on safe/idempotent requests
- SSE reconnect
- WebSocket reconnect

## Example

Works on every browser entrypoint, scoped or full:

```ts
const events = platformClient.realtime.viaSse();
const unsubscribe = events.agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

## Same-origin recommendation

If the web UI is hosted with the daemon:
- prefer same-origin routing
- prefer cookie-backed session auth
- use SSE for live operator dashboards

If the app is cross-origin:
- use bearer tokens with SSE (`realtime.viaSse()`); a browser WebSocket cannot send an `Authorization` header, so `realtime.viaWebSocket()` connects only when the upgrade carries the operator session cookie (same-origin, or an allowlisted CORS origin whose cookie the browser sends)
- validate CORS explicitly

## Error handling

All platform errors extend `GoodVibesError`. See [Error Kinds](./error-kinds.md) for the full taxonomy. The snippet calls `operator.control.snapshot()`, which exists on the full `platform/browser` entrypoint; on a scoped entrypoint use `operator.invoke('control.snapshot', {})`.

```ts
import { GoodVibesError } from '@goodvibes/engine/platform/errors';

try {
  await platformClient.operator.control.snapshot();
} catch (err) {
  if (err instanceof GoodVibesError) {
    switch (err.kind) {
      case 'auth':
        // session expired, redirect to login or refresh token
        break;
      case 'network':
        // transport failure, reconnect SSE/WS or retry
        break;
      case 'service':
        // daemon or upstream service returned 5xx, log and degrade gracefully
        break;
      case 'protocol':
        // client and daemon disagreed about the wire contract
        break;
      default:
        throw err;
    }
  }
}
```

## Observability

`PlatformObserver` is the right mechanism for dev-time logging in browser consoles. `createConsoleObserver()` logs auth transitions (`console.log`) and errors (`console.error`) by default; pass `createConsoleObserver({ level: 'debug' })` to also trace transport activity and every runtime event via `console.debug`. See [Observability](./observability.md) for the full observer API.

```ts
import { createConsoleObserver } from '@goodvibes/engine/platform/observer';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
  observer: createConsoleObserver({ level: 'debug' }),
});
```
