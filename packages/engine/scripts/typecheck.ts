/**
 * typecheck.ts, the typecheck gate, wrapped so a failure fails.
 *
 * Runs every TypeScript project this repository owns and judges each run by its
 * OUTPUT as well as its exit code. See typecheck-output-rule.ts for why the
 * exit code alone is not evidence.
 *
 * Output is captured rather than piped. `tsc -b 2>&1 | head`, the shape that
 * makes this easy to get wrong by accident, reports `head`'s exit status, so
 * the compiler's verdict is discarded before anyone reads it.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { typecheckFailures, type CommandResult } from './typecheck-output-rule.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');
// The composite solution is the repo root tsconfig.json (judgment and engine).
const REPO_ROOT = resolve(ENGINE_ROOT, '../..');

interface Project {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

const PROJECTS: readonly Project[] = [
  // Cross-product fixtures import Agent, daemon and engine implementations. Check
  // their complete compositions under Agent's module aliases, separately from the
  // engine-only composite project. It remains in the engine test runner.
  {
    label: 'cross-product integration test typecheck',
    command: 'bunx',
    args: ['tsc', '--project', 'packages/engine/tsconfig.integration-tests.json', '--pretty', 'false'],
  },
  // The composite solution. tsconfig.json references every package AND
  // tsconfig.tests.json, so this is the run that covers test/ and scripts/,
  // it did not before, because the root is `files: []` and the tests project
  // was not a reference.
  // `--force` is load-bearing, not belt-and-braces. `tsc -b` skips a project it
  // considers up to date, and up-to-date-ness is decided from input mtimes:
  // reproduced in a scratch solution, editing a source to introduce a TS2322
  // and then restoring its mtime makes `tsc -b` exit 0 AND PRINT NOTHING, while
  // `tsc -p` on the same tree reports the error and exits 1. A restored CI
  // cache, a checkout that preserves mtimes, or a worktree switch all produce
  // that state. `tsc -b --force` reports it and exits 2.
  // The engine's test project sits beside the repo solution rather than inside
  // it, so both are named in the one build.
  {
    label: 'tsc -b --force (solution, incl. test/ and scripts/)',
    command: 'bunx',
    args: ['tsc', '-b', '--force', 'tsconfig.json', 'packages/engine/tsconfig.tests.json', '--pretty', 'false'],
  },
  // The type-test project is standalone (it uses `paths` remapping and emits
  // nothing), so `tsc -b` does not reach it.
  {
    label: 'tsc -p tsconfig.type-tests.json',
    command: 'node',
    args: ['node_modules/typescript/bin/tsc', '--project', 'packages/engine/tsconfig.type-tests.json', '--pretty', 'false'],
  },
];

// Products join the gate as soon as their real workspace appears. Inspection
// covers every authored file, then each source/test/tooling project runs once.
const ALL_PROJECTS: readonly Project[] = [...PROJECTS, {
  label: 'product workspace typechecks', command: 'bun', args: ['run', 'products:typecheck'],
}];

// Scoped iteration: `--project <name>` checks one project WITHOUT `--force`, so a
// second run after a small edit only rebuilds what changed. It is for the edit
// loop. The forced run above stays the default and is what CI runs: an
// incremental `tsc -b` trusts input mtimes (see the comment on `--force`), so it
// can print nothing for a tree whose mtimes were restored, and a scoped pass is
// not evidence for a merge.
const SCOPED_PROJECTS: Readonly<Record<string, Project>> = {
  judgment: { label: 'tsc -b packages/judgment', command: 'bunx', args: ['tsc', '-b', 'packages/judgment', '--pretty', 'false'] },
  'judgment-tests': { label: 'tsc -b packages/judgment/tsconfig.tests.json', command: 'bunx', args: ['tsc', '-b', 'packages/judgment/tsconfig.tests.json', '--pretty', 'false'] },
  engine: { label: 'tsc -b packages/engine', command: 'bunx', args: ['tsc', '-b', 'packages/engine', '--pretty', 'false'] },
  'engine-tests': { label: 'tsc -b packages/engine/tsconfig.tests.json (test/ and scripts/)', command: 'bunx', args: ['tsc', '-b', 'packages/engine/tsconfig.tests.json', '--pretty', 'false'] },
  'type-tests': PROJECTS[2]!,
  'integration-tests': PROJECTS[0]!,
  ...Object.fromEntries(['agent', 'tui', 'daemon', 'webui'].map((name): [string, Project] => [name, {
    label: `product ${name}`, command: 'bun', args: ['packages/engine/scripts/product-workspaces.ts', 'typecheck', name],
  }])),
};

function scopedSelection(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--project') return argv[i + 1] ?? '';
    if (arg.startsWith('--project=')) return arg.slice('--project='.length);
  }
  return undefined;
}

const scoped = scopedSelection(process.argv.slice(2));
if (scoped !== undefined && !Object.hasOwn(SCOPED_PROJECTS, scoped)) {
  console.error(`[typecheck] unknown project "${scoped}". Use one of: ${Object.keys(SCOPED_PROJECTS).join(', ')}. Without --project the whole forced run executes.`);
  process.exit(2);
}
const SELECTED_PROJECTS: readonly Project[] = scoped === undefined ? ALL_PROJECTS : [SCOPED_PROJECTS[scoped]!];
if (scoped !== undefined) {
  console.log(`[typecheck] scoped run of "${scoped}", incremental (no --force). Not a substitute for the full run CI performs.`);
}

const results: CommandResult[] = [];
for (const project of SELECTED_PROJECTS) {
  console.log(`[typecheck] ${project.label} ...`);
  const run = spawnSync(project.command, [...project.args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // Node's default old-space ceiling is ~4 GB regardless of how much the host
    // has. The contract surface passed that: with 464 operator methods rendered
    // into OperatorMethodInputMap / OperatorMethodOutputMap, `tsc -b --force`
    // dies with "Ineffective mark-compacts near heap limit", a SIGNAL, not a
    // diagnostic, so a caller reading only the exit code sees a failure with no
    // errors and has nothing to act on. Raised rather than worked around,
    // because the type surface is legitimately this large and the machine has
    // the memory; capping the surface instead would mean deleting checks.
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=16384`.trim() },
  });
  if (run.error) {
    console.error(`[typecheck] ${project.label}: could not run, ${run.error.message}`);
    process.exit(1);
  }
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (output.trim().length > 0) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  results.push({ label: project.label, exitCode: run.status, output });
}

const failures = results.flatMap((result) => typecheckFailures(result));
if (failures.length > 0) {
  console.error('');
  console.error('typecheck FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`[typecheck] OK, ${results.length} project(s), no diagnostics, all exited 0.`);
