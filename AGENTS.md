# Working in this repository

Bun 1.3.14 and TypeScript (strict). `exactOptionalPropertyTypes` is on for `packages/engine` and `packages/judgment`; the product projects under `products/` are strict without it, so write optional fields in product code the way the surrounding file does. One version for every package.

## Layout

- `packages/engine/` - the platform: `platform/` (runtime, tools, daemon services), `terminal-shell/` (code shared by the terminal products), `contracts/`, `errors/`, `operator-client/`, `transport-*`. Tests sit flat in `packages/engine/test/`, scripts in `packages/engine/scripts/`.
- `packages/judgment/` - the Jev decision layer.
- `products/tui/` (`goodvibes`), `products/agent/` (`goodvibes-agent`), `products/daemon/`, `products/webui/`. Product tests live in `products/<name>/src/test/`.
- `scripts/` at the root - the installer and its tests.

## Running tests

Never run plain `bun test`: it skips the runner's isolated home, temp directory and network block. Never run `bun run test` to check one change: its `pretest` runs the full typecheck first.

```sh
# one engine test (path relative to packages/engine, or to where you are)
bun run test:one test/<name>.test.ts
bun packages/engine/scripts/test.ts test/<name>.test.ts

# one product test (--cwd is relative to packages/engine)
bun packages/engine/scripts/test.ts --cwd ../../products/agent ./src/test/<path>.test.ts
bun packages/engine/scripts/test.ts --cwd ../../products/tui ./src/test/<path>.test.ts

# judgment and installer tests
bun run test:judgment
bun run test:installer
```

`--jobs=auto` runs files in parallel, each in its own process. When nothing matches, the runner names the directory it searched.

## Typecheck

`bun run typecheck` builds the whole solution with `tsc -b --force` (16 GB heap) plus every product. It takes many minutes; run it once before you finish, not after each edit, and it is what CI runs.

While editing, check one project without `--force` (an unchanged project is skipped, so a second run is fast):

```sh
bun packages/engine/scripts/typecheck.ts --project engine        # packages/engine sources
bun packages/engine/scripts/typecheck.ts --project engine-tests  # packages/engine/test and scripts
bun packages/engine/scripts/typecheck.ts --project agent         # also tui, daemon, webui
```

The other names are `judgment`, `judgment-tests`, `type-tests` and `integration-tests`; an unknown name lists them. A scoped run trusts file times, so it can report nothing for a tree whose times were restored; it is not a substitute for the full run before a merge.

## Gates: if you touch X, run Y

`bun run validate` runs all of these in order. When a step fails it prints the step and the command; continue with `bun run validate --from <step>` or repeat one with `bun run validate --only <step>`.

| If you touch | Run | When it fails |
| --- | --- | --- |
| Any engine `.ts` (source, scripts or tests) | `bun run any:check` | Replace the `any` with a real type. |
| `products/daemon/src` or `packages/engine/terminal-shell/src` imports | `bun run architecture:check` | Move the import to the allowed layer. |
| `packages/engine/platform/src/platform` | `bun run platform-console:check` | Use the platform logger, not `console.*`. |
| Engine code, docs or JSON (planning ids such as `W1.2`, `WO-12`, `DEBT-3`; `TODO`/`FIXME`/`XXX`/`HACK` comments) | `bun run internal-id:check` | Remove the id or marker. |
| A Jev decision (`define*Decision`, `askAs`, a judgment registry or fixture) | `bun run judgment:lint` | Register the decision and give every answer a fixture. |
| A runtime event in `packages/engine/platform/src/events/*.ts` | `bun run events:check` | `bun run events:generate`, then commit `events/contracts/event-rules.generated.ts`. |
| An exported symbol of the engine entry points or any `package.json` subpath | `bun run build` then `bun run api:check` | Intended change: `bun run api:extract` and `bun run api:subpath`, then commit `packages/engine/etc/`. |
| A new directory with `index.ts` under `packages/engine/platform/src/platform` | `bun run exports:check` | Add it to the `exports` map in `packages/engine/package.json`, or list it as internal in `INTENTIONALLY_INTERNAL` in `packages/engine/scripts/engine-package-lists.ts` with a reason. |
| Operator or peer methods, their schemas, or anything feeding the contract | `bun run contracts:check` | `bun run refresh:contracts`, then commit the regenerated files. |
| Engine entry-point size | `bun run build` then `bun run bundle:check` | Advisory; explain a large increase. |
| `packages/engine/errors/src`, `packages/engine/platform/src/platform/types/errors.ts`, `packages/engine/transport-http/src/retry.ts` | `bun run error:check` | Keep every error kind and its mapping in step. |
| A secret-store write in `packages/engine/platform/src` | `bun run credential-scope:check` | Classify the key in `packages/engine/platform/src/platform/config/credential-scope-registry.ts`. The pre-commit hook runs this one. |

## Generated files: never open or grep

They are megabytes each and some are single lines of hundreds of kilobytes. The root `.ignore` hides them from `rg` and `fd`. Change their sources and regenerate instead.

- `packages/engine/etc/subpath-api-surface*.json`, `packages/engine/etc/*.api.md`
- `packages/engine/contracts/artifacts/operator-contract.json`, `packages/engine/contracts/src/generated/operator-contract.ts`
- `packages/engine/contracts/artifacts/operator-openapi.json` (the only tracked OpenAPI copy)
- `packages/engine/docs/reference-operator.md`, `products/tui/docs/foundation-artifacts/operator-contract.json`
- `.goodvibes/` (local state and worktrees)

To look up one operator method, query the JSON: `jq '.["x-operator-methods"][] | select(.id=="<method>")' packages/engine/contracts/artifacts/operator-openapi.json`.

For sessions, tasks, contracts, approvals and events, read the small generated slice instead: `packages/engine/docs/agent-api-index.md` (one line per operation) and `packages/engine/docs/agent-api.openapi.json`. Regenerate both with `bun run agent-spec:generate` after changing those methods.

## Agent and TUI are twins

`products/agent/src` and `products/tui/src` share hundreds of relative paths; many files are identical or nearly so. When you fix or change a file in one, open the same path in the other and make the matching change, then run both products' tests. Code that should be shared belongs in `packages/engine/terminal-shell/src`.

## Headless runs

`goodvibes run` and `goodvibes-agent run` are the scriptable entry points: `--output json|stream-json`, `--timeout`, `--max-turns`, and exit codes are documented in `products/tui/docs/cli-flags.md` and `products/agent/docs/headless-run.md`. One table of exit codes for every program: `docs/exit-codes.md`.

## Commits

- The author is the repository owner. Add no `Co-authored-by`, `Signed-off-by` or other trailers.
- Write the message in plain product terms: what changed for a user or operator.
- Commit only when asked.
