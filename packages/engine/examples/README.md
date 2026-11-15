# GoodVibes platform examples

Small runnable examples for the published platform entry points. Run all commands
from the **repository root** (not from `examples/`), because `examples/tsconfig.json`
extends `../tsconfig.base.json`. Build the platform first:

```bash
bun run build
bun run --cwd packages/engine/examples typecheck
```

Most examples read environment variables at startup:

| Variable | Description |
| --- | --- |
| `GOODVIBES_BASE_URL` | HTTP base URL of the running GoodVibes daemon (defaults to `http://127.0.0.1:3421`). |
| `GOODVIBES_TOKEN` | Operator bearer token issued by the daemon. Copy from the TUI settings or daemon log on first boot. Optional for `peer-http-quickstart.mjs`, which pairs without it. |
| `GOODVIBES_USERNAME` | Operator account username. Required only by `auth-login-and-token-store.ts`. |
| `GOODVIBES_PASSWORD` | Operator account password. Required only by `auth-login-and-token-store.ts`. |

Keep example tokens local and never commit real credentials,
tokens, cookies, or screenshots containing them.
See the repository [security policy](../../../SECURITY.md) before adapting examples
that handle credentials, pairing tokens, or daemon URLs.

## Quickstarts

| File | Runner | Purpose |
| --- | --- | --- |
| `auth-login-and-token-store.ts` | `bun examples/auth-login-and-token-store.ts` | Login and token-store lifecycle. Requires `GOODVIBES_USERNAME` + `GOODVIBES_PASSWORD` (in addition to `GOODVIBES_BASE_URL`). |
| `browser-web-ui-quickstart.ts` | typecheck only | Browser/web UI client setup. |
| `companion-approvals-feed.ts` | `bun examples/companion-approvals-feed.ts` | Approval feed via realtime events. |
| `daemon-fetch-handler-quickstart.ts` | `bun examples/daemon-fetch-handler-quickstart.ts` | Daemon route handler composition skeleton: a status route and a telemetry route, the generated operator contract, and minimal host callbacks. The handlers authenticate through the host's `resolveAuthenticatedPrincipal`, which here accepts one bearer token, `GOODVIBES_DAEMON_TOKEN`, as an admin (401 while it is unset). Replace it with real principal resolution before exposing a host built from it. To run a real daemon host, provide gateway-method invocations, login/session handling, and a real session manager. See [Daemon embedding](../docs/daemon-embedding.md). |
| `direct-transport-quickstart.ts` | `bun examples/direct-transport-quickstart.ts` | In-process direct transport usage. |
| `embed-session-quickstart.ts` | typecheck only | platform embedding API 1.0 shape: create an embedded session against a workspace, answer permission asks through the callback seam, subscribe to typed events, send input, shut down. Not executed because it would boot a real daemon. |
| `expo-quickstart.tsx` | typecheck only | Expo client setup; run inside an Expo app. |
| `operator-http-quickstart.mjs` | `bun examples/operator-http-quickstart.mjs` | Operator HTTP client calls. Requires `GOODVIBES_TOKEN`. |
| `peer-http-quickstart.mjs` | `bun examples/peer-http-quickstart.mjs` | A peer's first connection: `pair.request` (no token), operator approval (`remote.pair.requests.approve`, operator token with admin access), `pair.verify` polled until approved (no token; returns the peer token), one `peer.heartbeat` and one `work.pull` (peer token). Prints the approval step for the operator; with `GOODVIBES_TOKEN` set to an admin operator token it approves its own request, for a local test. For a long-running peer host, see `products/tui/examples/reference-node-host`. |
| `react-native-quickstart.ts` | typecheck only | React Native client setup; run inside a React Native app. Requires `GOODVIBES_TOKEN` at runtime. |
| `realtime-events-quickstart.mjs` | `bun examples/realtime-events-quickstart.mjs` | Runtime event streaming. Requires `GOODVIBES_TOKEN`. |
| `retry-and-reconnect.mjs` | `bun examples/retry-and-reconnect.mjs` | Retry and reconnect policy configuration. Requires `GOODVIBES_TOKEN`. |
| `submit-turn-quickstart.mjs` | `bun examples/submit-turn-quickstart.mjs` | Submit a conversation turn. Requires `GOODVIBES_TOKEN`. |
| `android-kotlin-quickstart.kt` | not runnable by Bun | Android integration sketch; copy into an Android project. |
| `ios-swift-quickstart.swift` | not runnable by Bun | iOS integration sketch; copy into an iOS project. |

The `.tsx`, `.kt`, and `.swift` sketches are included for integration shape and
type/API review. They are not standalone `bun examples/...` scripts.

`react-expo-shims.d.ts` provides minimal ambient type declarations for `react`
(`useEffect`) and `expo-secure-store` (`getItemAsync`). It predates the
`@types/react` and `expo-secure-store` devDependencies now declared in
`examples/package.json`, which supply the real types for the examples typecheck,
so the shim is currently vestigial. It is not a runnable example.

Examples that use TypeScript JSON import attributes, such as
`daemon-fetch-handler-quickstart.ts`, expect the repository's pinned Bun runtime
or Node 22.6+ with import-attributes support enabled.
