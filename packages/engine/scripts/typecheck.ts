/**
 * typecheck.ts, the typecheck gate, wrapped so a failure fails.
 *
 * Every TypeScript project this repository owns is compiled once per run and
 * judged by its OUTPUT as well as its exit code (typecheck-output-rule.ts).
 *
 * The engine sources (judgment and every engine package) are the one build.
 * Everything else, the test, type-test and product projects,
 * reads the declarations that build wrote through its project references and
 * is checked with `tsc --project`, which never rebuilds a referenced project
 * and so never checks engine source a second time.
 *
 *   bun packages/engine/scripts/typecheck.ts                the gate: a forced source build, then every other project
 *   bun packages/engine/scripts/typecheck.ts --after-build  the same after `build` forced the sources (validate)
 *   bun packages/engine/scripts/typecheck.ts --project X    one project, incremental, for the edit loop
 */
import { spawnSync } from 'node:child_process';

import { PRODUCT_NAMES } from './product-workspace-contract.ts';
import { engineSourcesBuild, REPO_ROOT, runTscStep, type TscStep } from './tsc-run.ts';

// Checked against the declarations of the projects they reference. `tsc
// --project` writes nothing into dist, so these need no build lock.
const CHECK_ONLY: readonly TscStep[] = [
  { label: 'tsc -p packages/judgment/tsconfig.tests.json', args: ['--project', 'packages/judgment/tsconfig.tests.json'], emits: false },
  { label: 'tsc -p packages/engine/tsconfig.tests.json (test/ and scripts/)', args: ['--project', 'packages/engine/tsconfig.tests.json'], emits: false },
  { label: 'tsc -p packages/engine/tsconfig.type-tests.json', args: ['--project', 'packages/engine/tsconfig.type-tests.json'], emits: false },
  // The installer scripts and their tests at the repository root.
  { label: 'tsc -p scripts/tsconfig.json (installer)', args: ['--project', 'scripts/tsconfig.json'], emits: false },
];

// Scoped iteration: `--project <name>` runs one `tsc -b` WITHOUT `--force`, so a
// second run after a small edit rebuilds only what changed. An incremental
// `tsc -b` trusts input mtimes, so it can print nothing for a tree whose mtimes
// were restored; a scoped pass is not evidence for a merge.
const SCOPED_PROJECTS: Readonly<Record<string, TscStep>> = {
  judgment: { label: 'tsc -b packages/judgment', args: ['-b', 'packages/judgment'], emits: true },
  'judgment-tests': { label: 'tsc -b packages/judgment/tsconfig.tests.json', args: ['-b', 'packages/judgment/tsconfig.tests.json'], emits: true },
  engine: engineSourcesBuild(false),
  'engine-tests': { label: 'tsc -b packages/engine/tsconfig.tests.json (test/ and scripts/)', args: ['-b', 'packages/engine/tsconfig.tests.json'], emits: true },
  'type-tests': { label: 'tsc -b packages/engine/tsconfig.type-tests.json', args: ['-b', 'packages/engine/tsconfig.type-tests.json'], emits: true },
  installer: CHECK_ONLY[3]!,
};
const PROJECT_NAMES: readonly string[] = [...Object.keys(SCOPED_PROJECTS), ...PRODUCT_NAMES];

interface Selection { readonly project?: string; readonly afterBuild: boolean }

function parseArgs(argv: readonly string[]): Selection {
  let project: string | undefined;
  let afterBuild = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--project') project = argv[++i] ?? '';
    else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
    else if (arg === '--after-build') afterBuild = true;
    else throw new Error(`unknown argument "${arg}". Use --project <name> or --after-build.`);
  }
  if (project !== undefined && afterBuild) throw new Error('use --project or --after-build, not both.');
  if (project !== undefined && !PROJECT_NAMES.includes(project)) {
    throw new Error(`unknown project "${project}". Use one of: ${PROJECT_NAMES.join(', ')}. Without --project the whole forced run executes.`);
  }
  return project === undefined ? { afterBuild } : { project, afterBuild };
}

/** Products run through their own runner, which owns their project list. */
function runProducts(args: readonly string[]): string[] {
  const label = `product typecheck ${args.join(' ')}`.trim();
  console.log(`[typecheck] ${label} ...`);
  const run = spawnSync('bun', ['packages/engine/scripts/product-workspaces.ts', 'typecheck', ...args], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (run.error) return [`${label}: could not run, ${run.error.message}`];
  return run.status === 0 ? [] : [`${label}: exited ${run.status ?? `by signal ${run.signal}`}`];
}

let selection: Selection;
try {
  selection = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[typecheck] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const failures: string[] = [];
let ran = 0;
if (selection.project !== undefined) {
  console.log(`[typecheck] scoped run of "${selection.project}", incremental (no --force). Not a substitute for the full run CI performs.`);
  const step = SCOPED_PROJECTS[selection.project];
  // A product brings the engine declarations it reads up to date itself.
  failures.push(...(step === undefined ? runProducts([selection.project]) : await runTscStep(step)));
  ran = 1;
} else {
  // After `build` forced the sources this is an up-to-date check, and it
  // refreshes them when validate resumes at this step.
  const steps = [engineSourcesBuild(!selection.afterBuild), ...CHECK_ONLY];
  for (const step of steps) failures.push(...await runTscStep(step));
  failures.push(...runProducts(['--declarations-current']));
  ran = steps.length + 1;
}

if (failures.length > 0) {
  console.error('');
  console.error('typecheck FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`[typecheck] OK, ${ran} step(s), no diagnostics, all exited 0.`);
