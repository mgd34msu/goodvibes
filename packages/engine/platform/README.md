# @goodvibes-jev/engine/platform

TypeScript platform for building GoodVibes operator, peer, web, mobile, and daemon-connected apps with typed contracts, auth, realtime events, and transport layers.

> **What this platform is:** a client for the GoodVibes daemon. Not a direct provider SDK.
> See [Getting Started](../docs/getting-started.md) for the full walkthrough.

Install:

```bash
npm install @goodvibes-jev/engine
```

Quick example (Bun):

```ts
import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';
import { createMemoryTokenStore } from '@goodvibes-jev/engine/platform/auth';

const platformClient = createGoodVibesPlatform({
  baseUrl: 'http://127.0.0.1:3421',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

console.log(await platformClient.operator.control.snapshot());
```

Every supported import is an explicit subpath in the package `exports` map. The
table below covers the primary ones; the complete, stability-leveled list is
[public-surface.md](../docs/public-surface.md).

| Entry point | Use it for |
| --- | --- |
| `@goodvibes-jev/engine/platform` | The Bun client factory plus re-exported contracts, auth, operator, peer, and transport pieces |
| `/auth` | Token stores, login, and OAuth helpers for every surface |
| `/client-auth` | Session and permission management with auto-refresh middleware |
| `/operator`, `/peer` | The typed operator and peer clients on their own |
| `/contracts`, `/contracts/node` | Runtime-neutral contract types, schemas, and method IDs; the `/node` variant adds Node-only helpers |
| `/errors` | The typed error model (`EngineErrorKind`) |
| `/events` | Runtime event types and typeguards, with per-domain subpaths such as `/events/agents` and `/events/session` |
| `/observer` | The `PlatformObserver` interface for first-class observability hooks on client factories |
| `/transport-core`, `/transport-http`, `/transport-realtime`, `/transport-direct` | Transport primitives, the HTTP transport, SSE and WebSocket realtime, and the in-process direct transport |
| `/browser`, `/web` | Browser client factories free of Bun globals; `/browser/agent`, `/browser/knowledge`, and `/browser/homeassistant` are scoped browser clients |
| `/workers` | The Cloudflare Worker bridge for daemon batch endpoints |
| `/react-native`, `/expo` | Mobile client factories with secure token stores |
| `/daemon` | Daemon route dispatch and embedding helpers for a Bun server host |
| `/embed` | Platform embedding API 1.0, the stability-marked surface for hosting a GoodVibes session inside another app |

Cloudflare batch provisioning is exposed through daemon `/api/cloudflare/*`
routes. The `/workers` entry is for manual Worker deployments.

Advanced server/runtime consumers can use explicit `platform/...` subpaths such
as `@goodvibes-jev/engine/platform/platform/node`,
`@goodvibes-jev/engine/platform/platform/runtime`, and
`@goodvibes-jev/engine/platform/platform/knowledge`. The package does not expose a
`platform/*` wildcard contract; only listed subpaths are supported.

The platform is a directory and public import namespace inside the
`@goodvibes-jev/engine` package. Its client facade composes the contract, error,
transport, daemon API, operator-client and peer-client modules maintained in
that same package. Install the engine package and select the explicit import
subpath for your runtime.
