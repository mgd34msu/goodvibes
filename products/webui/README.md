# GoodVibes web UI

The GoodVibes web UI is the browser app for GoodVibes. The daemon serves it, so
there is nothing separate to run. In it you chat with the agent, see what is
running and what is waiting for you, browse what GoodVibes remembers, and use
your mail and calendar. It works at phone size and can be installed on a phone's
home screen as an app.

## Open it

The [suite installer](../../docs/installation.md) installs the built web UI and
has the daemon serve it, by default at `http://127.0.0.1:3421`; the installer
prints the address. `goodvibes-daemon webui status` shows where it is served
and who can reach it. It needs no separate WebUI service.

To use it from a phone or another computer, run
`goodvibes-daemon webui enable --lan` so other devices on your network can
reach it, then run `goodvibes pair` and open the QR code's link on the device
or scan it with the sign-in page's camera scanner. Pairing, sign-in and every
part of the app are described in the [operator guide](docs/operator-guide.md).
Updates come with the rest of the suite; the development server below is for
source work.

## About this source

The app, responsive shell, PWA, assets and behavior tests originate at upstream
`goodvibes-webui` revision `dadf57700668fe4500b17b0b0b4520715ab25ef4` (WebUI
2.0.0).

The app consumes the engine's contract inspection, session gate presets and
authenticated browser judgment transport. Declared status catalogs remain exact
producer facts; unknown metadata requires its canonical reader or stays held.
Native requests use daemon-owned Jev admission and execution, with cancellation
and recorded outcomes visible in Work.

Source integration and tests with scripted responses do not establish full
connected-daemon parity or live-provider accuracy. The default browser matrix
uses a synthetic daemon. Connected runtime and provider qualification require
their own receipts for the tested source and configuration.

## Development

Install dependencies from the monorepo root and build the workspace with
`bun run build`. This product uses only declared `@goodvibes/engine` exports;
its production browser build consumes compiled engine artifacts. Standalone platform
overlays and independent package pins are not supported.

From `products/webui`:

- `bun run dev`: local Vite server, with daemon binding discovery
- `bun run build`: verify engine-derived snapshots, then compile the browser app
- `bun run typecheck`: browser, tooling and Playwright TypeScript programs
- `bun run e2e` (or `bun run test`): the browser journeys against a synthetic daemon, on the phone and desktop projects (`e2e:phone`, `e2e:desktop` for one)
- `bun run test:live`: the web UI's own client against one real daemon in an isolated home
- `bun run lint`: source and tooling lint
- `bun run release:gate`: shared engine workspace dependency/export checks
- `bun run release:prepare`: regenerate engine data snapshots and versioned assets
- `bun run pack:bundle`: deterministic archive of the built `dist/`

Use `GOODVIBES_DAEMON_BASE_URL` to point the development proxy at an intended
local daemon. Playwright uses its own 503 stub and in-browser mocks, and must not
be pointed at live providers, mail, payment or credential services. Live smoke
commands are opt-in and are not part of the default test suite.

The monorepo owns installation, versions, release workflows, tagging and
publication. Product-level preparation only writes generated browser data and
asset cache stamps. Existing legacy URLs continue to map into Chat, Work,
Library, Personal and Settings while preserving deep-link fragments.

See [known limitations](docs/known-limitations.md) for the remaining
integration work, and the [3.3.2 release notes](../../docs/releases/3.3.2.md)
for what changed in this release.
