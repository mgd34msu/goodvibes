import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');
// npm scripts live in the repo root package.json.
const REPO_ROOT = resolve(ENGINE_ROOT, '../..');

interface Step {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

const script = (name: string): Step => ({ label: name, command: 'bun', args: ['run', name] });

// Editorial checks remain opt-in (`docs-completeness-check`, `changelog:check`).
// Required validation exercises code, contracts, types, the reference documents
// generated from the contract, and installable artifacts.
const STEPS: readonly Step[] = [
  script('error:check'),
  script('products:check'),
  // Check credential classification in CI as well as the local pre-commit hook.
  // This source-only scan has no build dependency. It once ran only in the hook,
  // so a push that bypassed the hook reached CI with an unclassified credential
  // write and CI stayed green.
  script('credential-scope:check'),
  // Every answer of every registered judgment decision has a fixture, and
  // engine source asks Jev only through registered decisions. Source and
  // fixtures only, no model call and no build.
  script('judgment:lint'),
  // The event validator's rules are generated from the event unions; source
  // only, no build. Fails when a field's type or an enum's values moved.
  script('events:check'),
  script('version:check'),
  // Source-only: fails when a flag's graduation state blocks a release. It once ran
  // only by hand through release:verify, so CI never judged it.
  script('flags:graduation'),
  script('internal-id:check'),
  script('architecture:check'),
  script('platform-console:check'),
  // build is the one forced compile of the engine sources (judgment and every
  // engine package), judged by its output as well as its exit code.
  script('build'),
  // typecheck checks only what build did not compile: the test, type-test,
  // integration and product projects, against the declarations build just
  // wrote. Its source step is an up-to-date check here, and a refresh when a
  // run resumes at this step.
  { label: 'typecheck', command: 'bun', args: ['packages/engine/scripts/typecheck.ts', '--after-build'] },
  script('api:check'),
  // Beside api:check rather than inside it, because they ask opposite questions.
  // api:check iterates FROM the exports map and compares what each DECLARED
  // subpath exposes, so a module the map omits is never examined. This asks
  // whether every module with a public face is reachable from a published package
  // at all, the check that would have caught platform/owner-profile shipping
  // unreachable while every other gate stayed green.
  script('exports:check'),
  // examples typecheck also runs locally so `bun run validate` catches type
  // errors without a separate CI step.
  { label: 'examples:typecheck', command: 'bun', args: ['run', '--cwd', 'packages/engine/examples', 'typecheck'] },
  { label: 'browser-compat:check', command: 'bun', args: ['packages/engine/scripts/browser-compat-check.ts'] },
  { label: 'package-metadata:check', command: 'bun', args: ['packages/engine/scripts/package-metadata-check.ts'] },
  script('any:check'),
  // Test execution is owned by the CI platform-matrix (bun) and product-tests jobs; removing it
  // from validate eliminates the duplicate test run that used to execute on
  // every push. Local callers can still run `bun run test` explicitly.
  script('pack:check'),
  script('publint:check'),
  script('install:smoke'),
  // Also judges the reference documents generated from the contracts (docs/reference-*.md).
  script('contracts:check'),
  script('bundle:check'),
];

const USAGE = `Usage: bun run validate [--from <step>] [--only <step>]\nSteps: ${STEPS.map((step) => step.label).join(', ')}`;

/** Steps to run: all, everything from `--from`, or exactly `--only`. */
function selectSteps(argv: readonly string[]): readonly Step[] {
  let from: string | undefined;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (name === '--help' || name === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (name !== '--from' && name !== '--only') throw new Error(`Unknown argument ${arg}.`);
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${name} requires a step name.`);
    if (!STEPS.some((step) => step.label === value)) throw new Error(`Unknown step "${value}".`);
    if (name === '--from') from = value;
    else only = value;
  }
  if (from !== undefined && only !== undefined) throw new Error('Use --from or --only, not both.');
  if (only !== undefined) return STEPS.filter((step) => step.label === only);
  return from === undefined ? STEPS : STEPS.slice(STEPS.findIndex((step) => step.label === from));
}

let steps: readonly Step[];
try {
  steps = selectSteps(process.argv.slice(2));
} catch (error) {
  console.error(`[validate] ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}

for (const [index, step] of steps.entries()) {
  console.log(`[validate] ${step.label} ...`);
  const result = spawnSync(step.command, step.args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.status === 0) continue;
  const reason = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
  console.error([
    '',
    `[validate] FAILED at step ${index + 1}/${steps.length}: ${step.label} (${reason})`,
    `[validate]   command:      ${[step.command, ...step.args].join(' ')}`,
    `[validate]   re-run it:    bun run validate --only ${step.label}`,
    `[validate]   resume here:  bun run validate --from ${step.label}`,
  ].join('\n'));
  process.exit(result.status && result.status > 0 ? result.status : 1);
}
console.log(`[validate] ${steps.length} step(s) passed.`);
