# Working in this repository

Bun 1.3.14 and TypeScript (strict). `exactOptionalPropertyTypes` is on for `packages/engine` and `packages/judgment`; the product projects under `products/` are strict without it, so write optional fields in product code the way the surrounding file does. One version for every package.

## Layout

- `packages/engine/` - the platform: `platform/` (runtime, tools, daemon services), `terminal-shell/` (code shared by the terminal products), `contracts/`, `errors/`, `operator-client/`, `transport-*`. Tests sit flat in `packages/engine/test/`, scripts in `packages/engine/scripts/`.
- `packages/judgment/` - the Jev decision layer.
- `products/tui/` (`goodvibes`), `products/agent/` (`goodvibes-agent`), `products/daemon/`, `products/webui/`. Product tests live in `products/<name>/src/test/`.
- `scripts/` at the root - the installer and its tests.

## Running tests

Never run plain `bun test`: it skips the runner's isolated home, temp directory, network block, limits and admission scan. `bun run test` runs every default-suite file in the repository (engine, judgment, installer, products) from one pool of workers (cores minus one), one process per file, and does not typecheck or build.

```sh
# one file (path relative to where you are, else to packages/engine)
bun run test:one test/<name>.test.ts
bun run test:one products/agent/src/test/<path>.test.ts

# the default-suite files under a folder; -t runs only matching test names
bun packages/engine/scripts/test.ts products/tui/src/test
bun packages/engine/scripts/test.ts test/<name>.test.ts -t '<test name>'

# judgment, installer, and the folders outside the default suite
bun run test:judgment
bun run test:installer
bun run test:live   # files under test/live/ (the sandbox and real-browser proofs)
bun run test:e2e    # files under src/test/e2e/ (the built binaries)
```

The limits are fixed: 5 seconds per test, 10 seconds per file (30 under `test/live/` and `src/test/e2e/`), 600 file-seconds for the default suite. A file past its limit is killed and fails. Measured 2026-11-17 on 12 cores (11 workers) with other work running (load average 11 to 28): the default suite, 142 files and 475 cases, took 19.6 to 25.4 s and 174 to 220 file-seconds over fifteen runs in a row, its slowest file 4.6 to 6.8 s. By group (files, cases, file-seconds): engine 125, 397, 155 to 184; judgment 4, 30, 0.5 to 1.3; installer 6, 29, 6.5 to 11.7; Agent 3, 12, 7.0 to 12.6; terminal 3, 5, 4.5 to 8.4; daemon 1, 2, 1.1 to 2.3. `test:live`, 5 files, 3.3 s and 5.6 file-seconds; `test:e2e`, 2 files, 8.6 s and 16.4 file-seconds.

Before anything runs, the runner parses every selected file and refuses the whole run, naming file, line and rule, on:

- a wait on the clock: `Bun.sleep` or `Bun.sleepSync`, a promise resolved by `setTimeout`, or `setTimeout`/`scheduler` imported from `timers/promises`;
- a snapshot matcher, `mock.module`, `jest.mock` or `vi.mock`;
- a skipped test: `.skip`, `.todo`, `.skipIf`, `.todoIf`, `xit`, `xtest`, `xdescribe`;
- a raised limit or a retry: a timeout or retry argument on a test or a hook, `setDefaultTimeout`, `jest.setTimeout`, or `timeout`, `retry` or `rerunEach` under `[test]` in the package's `bunfig.toml` (a limit flag on the command line is an error);
- a missing or malformed header: the file does not open (after a `#!` line) with its `// Proves: ` / `// Red when: ` pairs, or another `//` comment follows the last pair without a blank line between;
- an empty header line (fewer than six words, or ending in an ellipsis), a `Red when` that repeats its `Proves`, or two identical `Proves` lines in one file;
- a file that disagrees with `packages/engine/docs/test-risks.md`: a `Proves` line that is not the risk of its rows, a row whose risk is not one of the file's `Proves` lines, a case (each `test`/`it` title, a template's `${...}` as written) with no row, or a row naming a case the file does not have;
- on a whole-suite run (no file or folder named), a row naming a file that does not exist.

`bun run validate` applies the same scan to the test files the runner does not start (the web UI's Playwright journeys) with `bun packages/engine/scripts/test-scan.ts`. A file that runs no test, skips one, has a test over 5 seconds, tries the network or leaves a process running fails. The run ends with the ten slowest files, the file-seconds per group, and a line of files run, passed, failed and refused.

## Tests

1. A test exists to prove one risk. Its failure must mean lost data, money or messages; a broken security or permission boundary; or a broken contract other code or clients depend on.
2. Add one only when you can state the breakage, who loses what, why a later change could cause it unnoticed, and that nothing already turns red for it: no kept case, gate script, type check, measurement budget, smoke run or run-through journey.
3. Never a reason for a test: a fix you just made, coverage, a second level of a proof that exists, another input of the same kind, a control on its own, a test of a test or of a stand-in.
4. Five questions, asked of every proposed case: (1) would its failure mean one of the three losses; (2) can it fail for a reason other than the product being wrong; (3) does it contain a timing assertion, a wait, a snapshot, a mock that checks itself or a copy of the code under test; (4) does it take more than 5 seconds, or its file more than 10; (5) have you broken the guarded line and watched it go red. A no on 1 or 5, or a yes on 2 to 4, and it is not written.
5. One proof per risk, at the lowest level where the real components that hold the risk all run. Several inputs to one component are rows of one case. A control that stops a proof passing on a blanket failure goes inside that case.
6. Stand-ins only for what is outside the product: the model at the HTTP wire, a remote server on loopback that records what arrived, the clock, the decision model. Never stores, locks, the gate, settings, the tool registry, the daemon router or the session broker.
7. The runner refuses the whole run, naming file and line, on `Bun.sleep`, a promise resolved by `setTimeout`, a snapshot, `mock.module`, `.skip`/`.todo`/`.skipIf`, a retry or a timeout argument, a missing or empty header, and a case with no row in the risk table.
8. Every test file begins with its header: for each risk the file proves, `// Proves: <the risk in one sentence>` followed by `// Red when: <the breakage that turns it red>`. A header whose Red when repeats its Proves, or two identical Proves lines in one file, is refused.
9. `packages/engine/docs/test-risks.md` is the record: one row per case (area, risk, file, case, red when). A new proof adds its rows in the same change, and the row's risk is the file's `Proves` line word for word.
10. A real browser, sandbox or built binary is used only where the risk lives in it; those files go under `test/live/` or `src/test/e2e/` (30 seconds a file). What only a whole product run can show is a step in a journey under `packages/engine/scripts/runthrough/`, not a test.
11. Speed and request counts are measured by `bun run measure`, never asserted in a test.
12. When the code a risk lives in is removed, its cases and rows go in the same change.

## Typecheck

`bun run typecheck` compiles the engine sources once with `tsc -b --force` (16 GB heap), then checks the test, type-test and integration projects and every product against the declarations that build wrote, so no program checks engine source a second time. It takes many minutes; run it once before you finish, not after each edit. CI runs it inside `bun run validate`, right after `build`.

While editing, check one project without `--force` (an unchanged project is skipped, so a second run is fast):

```sh
bun packages/engine/scripts/typecheck.ts --project engine        # packages/engine sources
bun packages/engine/scripts/typecheck.ts --project engine-tests  # packages/engine/test and scripts
bun packages/engine/scripts/typecheck.ts --project agent         # also tui, daemon, webui; refreshes stale engine declarations first
```

The other names are `judgment`, `judgment-tests`, `type-tests` and `installer`; an unknown name lists them. A scoped run trusts file times, so it can report nothing for a tree whose times were restored; it is not a substitute for the full run before a merge.

## Speed budgets

`packages/engine/scripts/measure/` measures what each product path costs: decision-model and model requests, file reads, writes, fsyncs, bytes written and SQL statements per scenario, and start-up time. Every scenario checks that its operation succeeded; a failed one reports why instead of numbers.

```sh
bun run measure                              # every scenario, as a table; add -- --only <name>[,<name>] for some
bun run measure:check                        # the same, compared with packages/engine/scripts/measure/budgets.json
MEASURE_TRACE=stats,fileWrites bun run measure -- --only <name>   # each counted call; MEASURE_TRACE_STACK=1 adds its callers
```

`measure:check` fails on a count above its budget, bytes written more than 10% above, slow reads adding more than twice the slowest read to `turn-8-slow-reads` (its time minus `turn-8-reads`), a start-up over 1.5 times its recorded multiple of `startup-bun-floor`, a failed scenario, a scenario without a budget, or a budget without a scenario. Wall time is never compared as an absolute number. A count that grew is a regression to fix, not a budget to raise. When a change costs more on purpose, a cost falls, or a scenario is added, rewrite the budgets from a run and commit the diff with the reason: `bun run measure -- --write-budgets packages/engine/scripts/measure/budgets.json` (with `--only <names>`, only those entries change). The start-up scenarios run the products from source with bun, so nothing needs building first.

## Gates: if you touch X, run Y

`bun run validate` runs all of these, and every other check CI runs on a pull request, in CI's order: each CI job is `bun run validate --job <job>` (`gates`, `build`, `typecheck`, `proofs`, `live-sandbox`, `measure`, `package`; `--help` lists the steps of each). When a step fails it prints the step and the command; continue with `bun run validate --from <step>` or repeat one with `bun run validate --only <step>`.

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
| A setting key, its type, default or allowed values (`packages/engine/platform/src/platform/config` schema, feature settings) | `bun run --cwd products/webui generated:check` (also run by the web UI build inside `bun run build`) | Intended change: `bun run --cwd products/webui release:prepare`, then commit the diff under `products/webui/src/lib/generated/`; a removed or renamed key shows there. |
| A secret-store write in `packages/engine/platform/src` | `bun run credential-scope:check` | Classify the key in `packages/engine/platform/src/platform/config/credential-scope-registry.ts`. The pre-commit hook runs this one. |
| Any tracked file (source, fixtures, tests, docs, workflows, config) | `bun run credential-literals:check` | Never write a value in a real credential's shape (bot token, API key, JWT, key block, card number): build it at run time with `packages/engine/platform/src/platform/utils/fixture-credentials.ts`. The pre-commit hook runs this one on staged files. |

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
