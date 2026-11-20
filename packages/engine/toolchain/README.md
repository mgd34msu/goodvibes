# @goodvibes/engine/toolchain

Shared GoodVibes build and packaging toolchain for the products in this
monorepo. Each product keeps its values in its own `toolchain.config.json`; the
behavior lives here, so every product uses one implementation. Releases are cut
from the repository root (`bun run release:publish`, `bun run release:tag`).

## Tools

Each tool ships as a library policy function (with injectable I/O for testing)
and a thin CLI (`bin` entry):

- **engine-pin-gate.** The product depends on the engine as a workspace
  dependency that is installed and locked, plus a non-npm import sweep and an
  optional exports-map check.
- **build-binaries.** `bun build --compile` across a target matrix, with an
  optional daemon leg and native-addon copy/cross-fetch, all config-driven.
- **post-build-smoke.** Boots a compiled binary and checks its version protocol and emitted module initialization.
- **package-install-check.** Static `npm pack` tarball policy check, plus a check of each bin shim listed under `publish.bins` (present, executable, expected shebang).
- **sha256sums.** Generate or verify a `SHA256SUMS` manifest over release assets.
  `--out <manifest> <asset...>` writes one; `--verify <manifest>` checks every
  listed asset beside the manifest, and `--exact <payload...>` or `--exact-dir`
  also fails on a payload the manifest does not list. Records use the coreutils
  form `<64 lowercase hex>  <name>`.

`runPostBuildSmoke` returns `Promise<SmokeResult>`. It reads the binary once,
runs `--version` once, and passes only when the process exits 0 and prints
exactly the configured banner with a semver version. Any other output fails the
smoke and is printed, since a module or native-addon load failure shows up
there. It then scans the binary for top-level eager namespace reads. No model is
asked anything.

## Config

The `toolchain.config.json` contract is the `ToolchainConfig` type in
`src/config.ts`; each product's own config is the working example. Import the
type from `@goodvibes/engine/toolchain` for editor help.

## Usage

```ts
import { runEnginePinGate, realFsReader, loadToolchainConfig } from '@goodvibes/engine/toolchain';

const config = loadToolchainConfig();
const results = runEnginePinGate(realFsReader(process.cwd()), config.enginePin);
```

Every function accepts its effects (exec, fs, http, sleep, logger) as
parameters, so unit tests drive them with in-memory stubs, with no network and
no real git mutations.
