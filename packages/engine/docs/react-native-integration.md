# React Native integration

This is the **companion surface** for React Native (Hermes). See [Published Surface Matrix](./surfaces.md).

React Native apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP). Those require Bun. This guide covers auth, transport, realtime events, and error handling for the companion surface.

Use `@goodvibes-jev/engine/platform/react-native` for Android and iOS apps.

```ts
import { createReactNativeGoodVibesPlatform } from '@goodvibes-jev/engine/platform/react-native';

const platformClient = createReactNativeGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});
```

## Installation

```bash
npm install @goodvibes-jev/engine
```

See [Getting started](./getting-started.md#install) for the canonical install command and version. For persistent secure token storage on bare React Native, also install the optional peer dependency [`react-native-keychain`](https://github.com/oblador/react-native-keychain) (`>=8.0.0`); it is only needed when you use `createIOSKeychainTokenStore` / `createAndroidKeystoreTokenStore`.

## Realtime

The React Native realtime surface is WebSocket-only. `platformClient.realtime` exposes `runtime()` and `viaWebSocket()`. There is no `viaSse()`. SSE is unavailable on this surface, so the inherited `realtime.sseReconnect` option is a no-op here. Only `webSocketReconnect` applies.

The daemon authenticates the WebSocket upgrade request itself and answers 401
when it carries neither an `Authorization` header nor an operator session
cookie. The platform builds every socket with React Native's
`(url, protocols, { headers })` constructor form and sends
`Authorization: Bearer <token>` with the token it resolved for that connect
(one token-store read, refreshed first when it is inside the refresh window).
A reconnect after the token was refreshed or replaced presents the new token,
so nothing needs wrapping:

```ts
const events = platformClient.realtime.runtime();
const unsubscribe = events.agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

`viaWebSocket(impl)` uses another WebSocket class the same way; it must accept
React Native's third constructor argument.

The factory applies React-Native-tuned defaults that you can override through `GoodVibesPlatformOptions`:

- `realtime.webSocketReconnect`: `{ enabled: true, baseDelayMs: 500, maxDelayMs: 5000 }`
- `retry` (HTTP): `{ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2000 }`
- `realtime.onError`: called when the realtime transport hits an unrecoverable error

To scope a feed to a single session, wrap it with `forSession` (re-exported from `@goodvibes-jev/engine/platform/react-native`):

```ts
import { createReactNativeGoodVibesPlatform, forSession } from '@goodvibes-jev/engine/platform/react-native';

const sessionEvents = forSession(platformClient.realtime.runtime(), sessionId);
sessionEvents.agents.on('AGENT_COMPLETED', (event) => console.log(event));
```

## Token storage

Pass a `tokenStore` to persist and rotate the bearer token. `tokenStore` is the highest-precedence auth option. It overrides both `getAuthToken` and the static `authToken`. Use `createIOSKeychainTokenStore` (iOS Keychain) or `createAndroidKeystoreTokenStore` (Android Keystore), both exported from `@goodvibes-jev/engine/platform/react-native`, rather than rolling a custom `GoodVibesTokenStore`:

```ts
import {
  createReactNativeGoodVibesPlatform,
  createIOSKeychainTokenStore,
} from '@goodvibes-jev/engine/platform/react-native';

const platformClient = createReactNativeGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createIOSKeychainTokenStore(),
});
```

On Android, use `createAndroidKeystoreTokenStore()` in place of the Keychain store.

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
        // token expired, refresh and retry
        break;
      case 'network':
        // transport failure, reconnect or surface to user
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

`PlatformObserver` and `createConsoleObserver` work from React Native exactly like from the full surface. They are imported from `@goodvibes-jev/engine/platform` root, which is companion-safe. See [Observability](./observability.md) for the full observer API.

```ts
import { createConsoleObserver } from '@goodvibes-jev/engine/platform';

const platformClient = createReactNativeGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
  observer: createConsoleObserver(),
});
```

## Example

See [react-native-quickstart.ts](../examples/react-native-quickstart.ts) for a runnable end-to-end example.

## Notes

- `fetch` can come from the React Native runtime or be injected explicitly.
- `WebSocket` can come from the runtime or be passed through `WebSocketImpl`.
- The React Native entrypoint is WebSocket-only; SSE (`viaSse`) is not exposed and `sseReconnect` is a no-op.
- Provide a token store or `getAuthToken` when token state can rotate during the app session. See [Token storage](#token-storage).
- Reconnect after foreground/resume and network transitions.
- Use HTTP for snapshots/mutations and WebSocket for live updates.
- For Expo-managed apps, use [expo-integration.md](./expo-integration.md).
- For native Kotlin or Swift apps, use [android-integration.md](./android-integration.md) and [ios-integration.md](./ios-integration.md).
