# GoodVibes engine

[![CI](https://github.com/mgd34msu/goodvibes/actions/workflows/ci.yml/badge.svg)](https://github.com/mgd34msu/goodvibes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The engine is the typed TypeScript platform layer behind the GoodVibes Jev products: sessions, provider/model routing, in-process agents, a knowledge and memory store, a control-plane HTTP and realtime API, and the transports that carry it all. The daemon is its own product, built on the engine. Full-surface consumers embed runtime behavior in a Bun process and connect to daemon services as clients. Companion consumers, including the WebUI and mobile clients, use HTTP, SSE and WebSocket. The workspace package `@goodvibes-jev/engine` carries the platform through explicit subpaths such as `@goodvibes-jev/engine/platform`, `@goodvibes-jev/engine/contracts` and `@goodvibes-jev/engine/errors`.

Use the [monorepo installation guide](../../docs/installation.md) to install the
application suite. Engine integration and product acceptance remain in progress;
earlier release history does not certify this checkout. Current behavior for
[completion verification](docs/runtime-orchestration.md#completion-verification),
[project review inventory](docs/contract-criteria.md#project-review-inventory) and
[owner-configured tool access](docs/tool-safety.md#owner-configured-access) lives
in the engine.

Public contract, config keys, route paths, event shapes, and file layouts follow the semver policy in `docs/semver-policy.md`. Pin exact versions and read `CHANGELOG.md` before upgrading.

**Hosted-turn cancellation is scoped to owned execution.**
Its settlement boundary covers the turn's owned provider, tool, hook, and hook-Agent
work. Independent workflow-trigger automations may continue; `TURN_CANCEL` is not a
global “all side effects stopped” receipt. Uncooperative owned work must stay pending
rather than be reported drained. See the [cancellation contract and platform limits](docs/hosted-turn-cancellation.md)
and the retained review evidence.

```mermaid
flowchart LR
    subgraph pkg["packages/engine (one workspace package)"]
        platform["@goodvibes-jev/engine/platform<br/>facade: platform runtime + daemon + clients"]
        contracts["@goodvibes-jev/engine/contracts"]
        siblings["errors, transport-core/-http/-realtime,<br/>daemon-api, operator-client, peer-client"]
        toolchain["@goodvibes-jev/engine/toolchain<br/>CI/CD tools"]
    end
    platform --> contracts
    platform --> siblings

    tui["GoodVibes terminal app<br/>(Bun runtime and daemon client)"]
    agent["GoodVibes agent<br/>(Bun runtime and daemon client)"]
    daemon["GoodVibes daemon<br/>(standalone runtime and API host)"]
    webui["GoodVibes web UI<br/>(companion surface, browser)"]
    ha["Home Assistant integration<br/>(separate project, talks to the daemon)"]

    platform --> tui
    platform --> agent
    platform --> daemon
    platform --> webui
    tui -. HTTP/SSE/WebSocket .-> daemon
    agent -. HTTP/SSE/WebSocket .-> daemon
    webui -. HTTP/SSE/WebSocket .-> daemon
    ha -. HTTP/SSE/WebSocket .-> daemon
    toolchain -. workspace tooling .-> tui
    toolchain -. workspace tooling .-> agent
```

---

## Install

Prepare the engine through the monorepo workspace:

```bash
# From the goodvibes-jev repository root:
bun install
bun run build
```

Products depend on `@goodvibes-jev/engine` through `workspace:*`; import only
declared entry points. For a Bun host (terminal app, agent, CLI, daemon), the platform
client factory talks to a reachable GoodVibes daemon:

```ts
import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';
import { createMemoryTokenStore } from '@goodvibes-jev/engine/platform/auth';

const platformClient = createGoodVibesPlatform({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

const snapshot = await platformClient.operator.control.snapshot();
```

Building a browser or web UI client instead, the companion entry point carries no Bun globals and bundles cleanly with Vite, webpack, and esbuild:

```ts
import { createBrowserGoodVibesPlatform } from '@goodvibes-jev/engine/platform/browser';
import { createBrowserTokenStore } from '@goodvibes-jev/engine/platform/auth';

const platformClient = createBrowserGoodVibesPlatform({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createBrowserTokenStore(),
});

const stop = platformClient.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});
```

React Native, Expo, and Cloudflare Worker bridges follow the same pattern from their own subpaths. The canonical walkthrough for every runtime is [docs/getting-started.md](./docs/getting-started.md), and runnable versions of each are in [examples/](./examples/README.md).

---

## Entry point map

| Entry point | What it is |
| --- | --- |
| [`@goodvibes-jev/engine/platform`](./platform) | The full platform runtime (sessions, agents, providers, knowledge, control plane, daemon route handlers) plus thin client factories for Bun, browser, React Native, Expo, and Cloudflare Workers. |
| [`@goodvibes-jev/engine/toolchain`](./toolchain) | The CI/CD toolchain: release cut, npm publish, per-job-green verification, and coverage checks. Invoked as `bunx @goodvibes-jev/engine/toolchain <tool>` from every GoodVibes repo's release workflow. |
| [`@goodvibes-jev/engine/contracts`](./contracts) | Runtime-neutral operator and peer contract artifacts, generated method IDs, and lookup helpers that the `platform` entry points and every client surface share. |

The same install also carries `errors`, `transport-core`, `transport-http`, `transport-realtime`, `daemon-api`, `operator-client`, `peer-client`, and `terminal-shell`, each imported as `@goodvibes-jev/engine/<name>`; none is a separate install step. The full entry-point matrix is [docs/packages.md](./docs/packages.md).

### Entry points at a glance

| Entry point | Use it for |
| --- | --- |
| `@goodvibes-jev/engine/platform` | Full Bun platform: client factory plus contracts, daemon, auth, operator, peer, and transports |
| `@goodvibes-jev/engine/platform/daemon` | Daemon route dispatch and embedding helpers for a Bun server host |
| `@goodvibes-jev/engine/platform/browser`, `/web` | Full browser and web UI client factories with the complete operator contract |
| `@goodvibes-jev/engine/platform/react-native`, `/expo` | React Native and Expo client factories with mobile secure token stores |
| `@goodvibes-jev/engine/platform/workers` | Cloudflare Worker bridge for daemon batch endpoints |
| `@goodvibes-jev/engine/platform/contracts` | Runtime-neutral contract types, schemas, and method IDs |
| `@goodvibes-jev/engine/platform/auth` | Token stores, login, and OAuth helpers, shared by every surface |

This is a starting point, not the full list. There is no root `@goodvibes-jev/engine/platform/platform` entry and no `platform/*` wildcard export. The canonical, stability-leveled reference for every entry point is [docs/public-surface.md](./docs/public-surface.md).

---

## Key concepts

- **Two runtime surfaces.** Full (Bun: TUI, agent, daemon hosts) vs. companion (browser, React Native, Expo, Workers). See [docs/getting-started.md](./docs/getting-started.md) and [docs/surfaces.md](./docs/surfaces.md).
- **Public entry points.** The single canonical, stability-leveled list of every importable subpath: [docs/public-surface.md](./docs/public-surface.md).
- **Contracts.** The typed vocabulary (method IDs, endpoint IDs, event maps) every client and the daemon share: [docs/packages.md](./docs/packages.md).
- **Authentication.** Login, bearer tokens, and platform-specific secure token stores: [docs/authentication.md](./docs/authentication.md).
- **Realtime transports.** SSE and WebSocket with reconnect and typed, session-filtered event domains: [docs/realtime-and-telemetry.md](./docs/realtime-and-telemetry.md).
- **Knowledge and memory.** The SQLite-backed knowledge/wiki system, ingestion, retrieval, and project planning artifacts: [docs/knowledge.md](./docs/knowledge.md).
- **Provider and model runtime.** Daemon-side routing, failover, and catalogs across model providers: [docs/providers.md](./docs/providers.md).
- **Errors.** A typed `EngineErrorKind` model. Match on `err.kind`, never on `err.message`: [docs/error-kinds.md](./docs/error-kinds.md).

Full index: [docs/README.md](./docs/README.md).

---

## Development

```bash
git clone https://github.com/mgd34msu/goodvibes.git
cd goodvibes-jev
bun install
bun run build
```

| Command | Does |
| --- | --- |
| `bun run build` | Build judgment, engine and all four products from the monorepo root |
| `bun run test` | Run the installer, judgment, engine and product test suites |
| `bun run validate` | Run the local integration gate: build/types, API/contracts, exports, packaging and runtime checks |
| `bun run api:extract` / `bun run api:check` | Regenerate / verify the API Extractor reports under `etc/*.api.md` |
| `bun run refresh:contracts` | Regenerate shared contract artifacts and product snapshots after a contract change |
| `bun run docs:generate` / `bun run docs:check` | Regenerate / verify API reference docs; the check also verifies required docs and examples exist |

### Running tests

Every suite runs through one runner, `packages/engine/scripts/test.ts`, which
wraps `bun test`. For each run it creates a temporary directory under the
system temp directory, exports it as `TMPDIR`, and removes it when the run
ends. Tests run with provider credentials and `HOME` removed from the
environment, and a run fails if a test attempts outbound network access. The
default per-test timeout is 60 seconds; set `GOODVIBES_TEST_TIMEOUT_MS` or pass
`--timeout=<ms>` to change it. Any other flag is passed to `bun test` unchanged.

```bash
# The whole engine suite
bun packages/engine/scripts/test.ts

# One file, or several (paths are relative to packages/engine)
bun packages/engine/scripts/test.ts test/lifecycle-machine.test.ts

# One slice of the engine suite: partition INDEX of COUNT
bun packages/engine/scripts/test.ts --partition=3/9

# Another workspace: --cwd is relative to packages/engine
bun packages/engine/scripts/test.ts --cwd ../../products/agent src/test
```

`--partition` selects its own files and cannot be combined with `--cwd` or
explicit files. Each product's `bun run test` script calls the same runner with
its own `--cwd`. TUI and Agent tests create their working directories under
`<product>/.test-tmp/run-*`, which is ignored by Git.

Plain `bun test <file>` also works for a quick run of one file. It skips the
runner's environment and network isolation, and the tests that start daemon
fixture processes refuse to run without the runner.

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request
against it. One `build` job produces the workspace output and the test jobs
restore it instead of rebuilding.

| Job | Runs |
| --- | --- |
| `validate` | `bun run validate` |
| `eval-gate` | The standing eval suite, scored against a checked-in baseline |
| `security-audit` | Dependency audit and secret scan |
| `build` | The single workspace build |
| `platform-matrix` | Nine engine test partitions, plus the companion-bundle (`rn-bundle`), Workers and Wrangler legs |
| `product-tests` | The daemon, TUI and WebUI test suites |
| `daemon-native`, `daemon-native-produce`, `daemon-native-execution` | The native daemon artifact on isolated Linux, then built and executed on Linux ARM and macOS |
| `agent-tests` | The Agent suite in eight shards |
| `tui-host-pair-terminal` | TUI host pairing against the compiled binary in a real terminal |
| `webui-browser` | The WebUI Playwright suite in two shards |
| `exec-containment-proof` | Live bubblewrap containment fixtures in two lanes |
| `artifact-lane` | Packaged-artifact conformance (`bun run release:artifact-lane`) |

Workflows install the Bun version named by `engines.bun` in the root
`package.json` through the `.github/actions/bun` action; change the version
there. Release workflows derive the previous release tag from Git history.

---

## Release and stability

The monorepo owns versioning and release workflows. The root version governs
the engine, judgment and daemon; the other product manifests retain their own
versions. The application products are private workspaces and the suite is
installed from this checkout. Export and compatibility rules are recorded in
[the semver policy](./docs/semver-policy.md); release machinery and its explicit
gates are described in release and publishing.
Update an installed suite with the [repository installer](../../docs/installation.md#update-and-check-the-installation).

## Security

Report vulnerabilities through the repository [security policy](../../SECURITY.md).
Engine security boundaries and dependency posture are described in
[docs/security.md](./docs/security.md). Updating the installed suite rebuilds
the selected repository commit and its locked dependencies.

## License

MIT. See [LICENSE](./LICENSE).
