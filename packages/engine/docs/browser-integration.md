# Browser integration

This is the **companion surface** for browser runtimes. See [Runtime Surfaces](./surfaces.md).

Browser apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP). Those require Bun. This guide is the shared foundation for every browser entrypoint: auth, transport, realtime events, error handling, and observability. For web-UI-application patterns built on this foundation, entrypoint selection, companion chat, attachments, and voice playback, see [Web UI integration](./web-ui-integration.md).

Use `@goodvibes-jev/engine/platform/browser` when a browser app needs the complete
operator route contract. Use scoped browser entrypoints when an app owns one
extension surface:

- `@goodvibes-jev/engine/platform/browser/knowledge` for the base knowledge/wiki WebUI.
- `@goodvibes-jev/engine/platform/browser/homeassistant` for Home Assistant panels.
- `@goodvibes-jev/engine/platform/browser/agent` (`createBrowserAgentPlatform`) for the GoodVibes Agent surface: the agent's own knowledge/wiki space under `/api/goodvibes-agent/knowledge`, plus work-plan, artifact, and companion-chat routes.

```ts
import { createBrowserGoodVibesPlatform } from '@goodvibes-jev/engine/platform/browser';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
});
```

Scoped entrypoints expose the same auth/token options and shared session routes
without loading unrelated route metadata:

```ts
import { createBrowserKnowledgePlatform } from '@goodvibes-jev/engine/platform/browser/knowledge';

const platformClient = createBrowserKnowledgePlatform({
  baseUrl: 'https://goodvibes.example.com',
});

await platformClient.knowledge.status();
```

## Auth

Preferred browser auth modes:
- same-origin cookie session
- bearer token when operating cross-origin or inside a custom shell

The HTTP transport always uses `credentials: 'include'`, so same-origin cookie-backed sessions work without additional wiring.

If you are using bearer tokens in the browser, pair the platform with `createBrowserTokenStore()` or your own `tokenStore` implementation.

## Realtime

For browser UIs:
- use `platformClient.realtime.viaSse()` for operator dashboards and status views
- use `platformClient.realtime.viaWebSocket()` when you need a persistent duplex connection model

The browser entrypoint also enables conservative defaults for:
- HTTP retry on safe/idempotent requests
- SSE reconnect
- WebSocket reconnect

## Example

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
- use bearer tokens
- validate CORS explicitly
- prefer WebSocket if the deployment path is hostile to SSE

## Error handling

All platform errors extend `GoodVibesError`. See [Error Kinds](./error-kinds.md) for the full taxonomy.

```ts
import { GoodVibesError } from '@goodvibes-jev/engine/platform/errors';

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
import { createConsoleObserver } from '@goodvibes-jev/engine/platform/observer';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
  observer: createConsoleObserver({ level: 'debug' }),
});
```
