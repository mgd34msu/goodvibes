# Authentication

> Consumer guidance. For internal auth architecture see [Auth Architecture](./auth.md).

Auth is available on both full and companion surfaces. See [Runtime Surfaces](./surfaces.md).

GoodVibes currently exposes two auth modes through the operator contract:
- `shared-bearer`
- `session-login`

## Shared bearer token

Use a bearer token when:
- you are building a server-side integration
- you are calling the daemon/operator API cross-origin
- you are embedding the platform in automation or service processes
- you are building native mobile clients
- you are building React Native or Expo companion apps

Header shape:

```http
Authorization: Bearer <token>
```

For a mobile or companion client, the bearer token is normally obtained by pairing rather
than by configuring a static value. Pairing mints a token individually scoped to that one
device. See [Companion app pairing](./pairing.md) for how a token is provisioned, and
[Security best practices](./security.md) for the daemon's full set of accepted token shapes.

## Session login

Login route from the current contract:

```http
POST /login
```

Request body:

```json
{
  "username": "alice",
  "password": "secret"
}
```

Current-auth route:

```http
GET /api/control-plane/auth
```

Session cookie:
- name: `goodvibes_session`
- `HttpOnly`
- `SameSite=Strict`, and a request on the cookie is held to the page's `Origin` (the daemon's own or one in `controlPlane.cors.allowedOrigins`)
- path: `/`
- beside it the readable marker `goodvibes_identity` (a generation and who is signed in, no credential), cleared with it by `POST /logout`

## OAuth (daemon-side)

GoodVibes also ships an OAuth flow used for daemon-side token acquisition (for example, authorizing third-party providers). The flow itself runs on the server side: `OAuthClient` and the core helpers (`platform/runtime/auth/oauth-core.ts`, `oauth-client.ts`) depend on Node runtime facilities and are **not** part of the consumer client surface. Clients do not run the OAuth handshake directly; they receive acquired tokens through a `TokenStore`.

The OAuth *payload types*, `OAuthStartState` and `OAuthTokenPayload`, are exported from `@goodvibes/engine/platform/client-auth` (and re-exported from `@goodvibes/engine/platform/auth`) for typing the values you persist. `PermissionResolver`, also exported from `@goodvibes/engine/platform/client-auth`, resolves the permissions carried by an acquired token.

## platform auth helpers

The umbrella platform exposes an auth client plus token-store helpers:

```ts
import {
  createGoodVibesPlatform,
  createMemoryTokenStore,
} from '@goodvibes/engine/platform';

const platformClient = createGoodVibesPlatform({
  baseUrl: 'http://127.0.0.1:3421',
  tokenStore: createMemoryTokenStore(),
});

await platformClient.auth.login({
  username: 'alice',
  password: 'secret',
});

console.log(await platformClient.auth.current());
```

Useful auth helpers:
- `createMemoryTokenStore()`
- `createBrowserTokenStore()`
- `platformClient.auth.login(...)`
- `platformClient.auth.current()`
- `platformClient.auth.getToken()`
- `platformClient.auth.setToken(...)`
- `platformClient.auth.clearToken()`

## Recommended auth by environment

- Bun services: bearer token
- Browser web UI on same origin: session cookie or bearer token
- React Native / Expo: bearer token
- Native Android / iOS: bearer token

## Browser token persistence

Use `createBrowserTokenStore()` when you want local-storage-backed bearer token persistence in a browser app:

```ts
import { createBrowserGoodVibesPlatform } from '@goodvibes/engine/platform/browser';
import { createBrowserTokenStore } from '@goodvibes/engine/platform/auth';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createBrowserTokenStore(),
});
```

For same-origin web UIs, cookie-backed session auth is often simpler than token persistence.

## Automatic token refresh

When you provide a `tokenStore`, the platform wires a built-in `AutoRefreshCoordinator` that handles proactive token refresh and reactive 401 retry automatically. No custom middleware is needed.

**Proactive refresh.** Each request reads the token store once; that read gives the token for the `Authorization` header and its `expiresAt`. If the token expires within `refreshLeewayMs` (default: 60 seconds), a refresh call is issued before the request proceeds and the request carries the new token.

**Failed refresh.** When the `refresh` callback throws, the error's HTTP `status` decides what happens to the stored token: a status a retry cannot clear (for example 400, 401 or 403 from your auth server) clears it, and the platform reports `onAuthTransition` to anonymous. Any other failure (a 429 or 5xx, a network fault, a timeout, an error with no `status`) keeps the token, which stays valid until it expires, and the next request tries the refresh again. Either way the error reaches `observer.onError`. To have a rejection clear the token, throw an error that carries the auth server's `status`.

**Reactive 401 retry.** When the server returns 401, the coordinator attempts one refresh and retries the original request with the new token, transparently to the caller.

Configure via the `autoRefresh` option in `createGoodVibesPlatform`:

```ts
import { createGoodVibesPlatform } from '@goodvibes/engine/platform';
import { createMemoryTokenStore } from '@goodvibes/engine/platform/auth';

const platformClient = createGoodVibesPlatform({
  baseUrl: 'http://127.0.0.1:3421',
  tokenStore: createMemoryTokenStore(),
  autoRefresh: {
    autoRefresh: true,         // default; set { autoRefresh: false } to disable
    refreshLeewayMs: 60_000,   // refresh this many ms before expiry (default: 60s)
    refresh: async () => {
      // Call your token refresh endpoint; the platform stores what you return.
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      if (!res.ok) throw Object.assign(new Error('refresh refused'), { status: res.status });
      const { token, expiresAt } = await res.json();
      return { token, expiresAt };
    },
  },
});
```

Auto-refresh is enabled by default when `tokenStore` is present. Set `autoRefresh: { autoRefresh: false }` to disable it entirely. The `refresh` callback is required for proactive refresh to work; without it, only the reactive 401 retry path is active.

The `AutoRefreshCoordinator` class is also available directly from `@goodvibes/engine/platform/client-auth` for advanced use cases where you need to manage the coordinator lifecycle yourself.

## Read-only token resolvers

If you pass `getAuthToken`, the platform can read tokens dynamically for requests and reconnects, but it cannot persist or mutate them unless you also pass `tokenStore`.

That matters for:
- refreshing tokens from an external auth system
- React Native secure storage adapters
- browser apps where another layer owns token persistence

## Scope handling

The platform preserves structured authorization failures. When a token is missing required scopes, you will receive a structured platform error with:
- `status`
- `category`
- `source`
- `hint`

For the typed `err.kind` values returned on auth failures (invalid session, expired token, permission denied), see [Error kinds](./error-kinds.md).

Do not rely on message parsing to detect authorization problems.

## Session vs bearer tradeoff

Use session login when:
- the app is same-origin with the daemon
- you want browser cookie/session semantics
- you do not want token persistence logic in the UI

Use bearer auth when:
- the client is cross-origin
- the client is mobile
- the client is a server-side integration
- you need explicit token rotation/storage control
