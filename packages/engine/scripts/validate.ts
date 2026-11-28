/**
 * validate.ts, every check CI runs on a pull request, in CI's order.
 *
 * Each step belongs to one CI job, and each job in .github/workflows/ci.yml runs
 * `bun run validate --job <job>`, so the two cannot drift: a local
 * `bun run validate` runs the same commands in the same order, and a green run
 * predicts a green pull request. What CI adds around these steps is host
 * set-up (Bun, dependencies, bubblewrap, ripgrep, Chromium), passing the build between
 * jobs, the dependency audit and secret scan (they need the network and the
 * repository's history), and the daemon on other platforms on pushes to main.
 *
 *   bun run validate                    every step
 *   bun run validate --job <job>        one CI job's steps
 *   bun run validate --from <step>      everything from a step on
 *   bun run validate --only <step>      one step
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupStage, createPackedReleaseStage, SHARED_RELEASE_STAGE_ENV, type PackedReleaseStage } from './release-shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');
// npm scripts live in the repo root package.json.
const REPO_ROOT = resolve(ENGINE_ROOT, '../..');

/** The CI jobs, in the order a full run takes them. */
const JOBS = ['gates', 'build', 'typecheck', 'proofs', 'live-sandbox', 'package'] as const;
type Job = typeof JOBS[number];

interface Step {
  readonly label: string;
  readonly job: Job;
  readonly command: string;
  readonly args: readonly string[];
}

const script = (job: Job, name: string): Step => ({ label: name, job, command: 'bun', args: ['run', name] });
const inPackage = (job: Job, label: string, dir: string, name: string): Step => ({ label, job, command: 'bun', args: ['run', '--cwd', dir, name] });

/** Compares the working tree with the one this run started from; see the end of this file. */
const WORKTREE_STEP = 'worktree:unchanged';

// Only real error/contract/security gates live here; prose checks and advisory reports are opt-in.
const STEPS: readonly Step[] = [
  // gates: source only, no build.
  script('gates', 'products:check'),
  script('gates', 'credential-scope:check'),
  // No tracked file holds a literal in a real credential's shape (the
  // repository is public).
  script('gates', 'credential-literals:check'),
  // Every answer of every registered judgment decision has a fixture, and
  // engine source asks Jev only through registered decisions.
  script('gates', 'judgment:lint'),
  // The event validator's rules are generated from the event unions.
  script('gates', 'events:check'),
  script('gates', 'version:check'),
  script('gates', 'architecture:check'),
  // Structural safety, reachability, twin-parity and parse checks on commands.
  script('gates', 'commands:check'),
  script('gates', 'platform-console:check'),
  script('gates', 'any:check'),
  // Refuses flaky sleeps, snapshots, module mocks, and skipped tests in Playwright journeys.
  { label: 'test:scan', job: 'gates', command: 'bun', args: ['packages/engine/scripts/test-scan.ts'] },
  // The committed contracts and generated consumer facades stay in step with source.
  script('gates', 'contracts:check'),
  // The release workflow's asset pinning, collection and CI gate scripts.
  script('gates', 'release-assets:test'),

  // build: the one forced compile of the engine sources, judged by its output
  // as well as its exit code, then every product's build.
  script('build', 'build'),

  // typecheck: what build did not compile (test, type-test, installer and
  // product projects) against the declarations build wrote, then the checks
  // that read the build output.
  { label: 'typecheck', job: 'typecheck', command: 'bun', args: ['packages/engine/scripts/typecheck.ts', '--after-build'] },
  script('typecheck', 'exports:check'),
  inPackage('typecheck', 'examples:typecheck', 'packages/engine/examples', 'typecheck'),
  script('typecheck', 'check:browser'),
  script('typecheck', 'check:metadata'),

  // proofs: the default test suite. It reads source only (the companion-bundle
  // guard and the Workers bundle included), so CI runs it without the build.
  script('proofs', 'test'),

  // live-sandbox: the test/live files inside real bubblewrap, where a skip fails.
  script('live-sandbox', 'test:live'),

  // package: the packages as released, then the three Linux programs as built
  // and run. The four release-stage readers share one packed stage.
  script('package', 'pack:check'),
  script('package', 'publint:check'),
  script('package', 'install:smoke'),
  script('package', 'release:artifact-lane'),
  // The terminal program was built for this host by `build`; the other two here.
  inPackage('package', 'agent:build-binary', 'products/agent', 'build:binary'),
  inPackage('package', 'daemon:build-binary', 'products/daemon', 'build:binary'),
  // The terminal and Agent programs start and finish a turn against a scripted model.
  script('package', 'test:e2e'),
  // The web UI's browser journeys against its production build.
  inPackage('package', 'webui:e2e', 'products/webui', 'e2e'),
  // The daemon program inside bubblewrap: commands, a synthetic send, a hosted session.
  inPackage('package', 'daemon:verify-binary', 'products/daemon', 'verify:binary'),
  // The web UI's own client against one real daemon.
  inPackage('package', 'webui:test-live', 'products/webui', 'test:live'),
  // No step above wrote into a tracked or unignored file.
  { label: WORKTREE_STEP, job: 'package', command: 'git', args: [] },
];

const USAGE = [
  'Usage: bun run validate [--job <job> | --from <step> | --only <step>]',
  ...JOBS.map((job) => `  ${job}: ${STEPS.filter((step) => step.job === job).map((step) => step.label).join(', ')}`),
].join('\n');

/** Steps to run: all, one job's, everything from `--from`, or exactly `--only`. */
function selectSteps(argv: readonly string[]): readonly Step[] {
  const chosen = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (name === '--help' || name === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (name !== '--from' && name !== '--only' && name !== '--job') throw new Error(`Unknown argument ${arg}.`);
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${name} requires a ${name === '--job' ? 'job' : 'step'} name.`);
    if (name === '--job' ? !(JOBS as readonly string[]).includes(value) : !STEPS.some((step) => step.label === value)) {
      throw new Error(`Unknown ${name === '--job' ? 'job' : 'step'} "${value}".`);
    }
    if (chosen.has(name)) throw new Error(`${name} given twice.`);
    chosen.set(name, value);
  }
  if (chosen.size > 1) throw new Error('Use one of --job, --from or --only.');
  const job = chosen.get('--job');
  if (job !== undefined) return STEPS.filter((step) => step.job === job);
  const only = chosen.get('--only');
  if (only !== undefined) return STEPS.filter((step) => step.label === only);
  const from = chosen.get('--from');
  return from === undefined ? STEPS : STEPS.slice(STEPS.findIndex((step) => step.label === from));
}

let steps: readonly Step[];
try {
  steps = selectSteps(process.argv.slice(2));
} catch (error) {
  console.error(`[validate] ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}

/** Tracked and unignored files that differ from HEAD, with their state. */
function worktreeState(): string {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  return result.stdout;
}

// In CI the run starts from a clean checkout, so "unchanged" means `git status`
// is empty; locally it means the run changed nothing that was not already changed.
const worktreeAtStart = steps.some((step) => step.label === WORKTREE_STEP) ? worktreeState() : '';

/** The lines of `now` not in `before`, and of `before` not in `now`. */
function worktreeChanges(before: string, now: string): string[] {
  const was = new Set(before.split('\n').filter(Boolean));
  const is = new Set(now.split('\n').filter(Boolean));
  return [...[...is].filter((line) => !was.has(line)), ...[...was].filter((line) => !is.has(line)).map((line) => `${line} (no longer)`)];
}

// The steps that read the packages as released. When more than one of them
// runs, the packages are staged and packed once and every one of them reads
// that stage (GOODVIBES_RELEASE_STAGE) instead of making its own.
const STAGE_READERS = new Set(['pack:check', 'publint:check', 'install:smoke', 'release:artifact-lane']);
const stageReaders = steps.filter((step) => STAGE_READERS.has(step.label));
let sharedStage: PackedReleaseStage | undefined;
const releaseSharedStage = (): void => {
  if (sharedStage) cleanupStage(sharedStage.tempRoot);
  sharedStage = undefined;
};

function fail(index: number, step: Step, reason: string, status: number | null): never {
  releaseSharedStage();
  console.error([
    '',
    `[validate] FAILED at step ${index + 1}/${steps.length}: ${step.label} (${reason})`,
    ...(step.label === WORKTREE_STEP ? [] : [`[validate]   command:      ${[step.command, ...step.args].join(' ')}`]),
    `[validate]   re-run it:    bun run validate --only ${step.label}`,
    `[validate]   resume here:  bun run validate --from ${step.label}`,
  ].join('\n'));
  process.exit(status && status > 0 ? status : 1);
}

for (const [index, step] of steps.entries()) {
  console.log(`[validate] ${step.label} ...`);
  if (step.label === WORKTREE_STEP) {
    const changes = worktreeChanges(worktreeAtStart, worktreeState());
    if (changes.length === 0) continue;
    console.error(`[validate] these files changed during the run:\n${changes.map((line) => `  ${line}`).join('\n')}`);
    fail(index, step, `${changes.length} file(s) changed; a check must not write into the repository`, 1);
  }
  let env: NodeJS.ProcessEnv = process.env;
  if (stageReaders.length > 1 && STAGE_READERS.has(step.label)) {
    try {
      sharedStage ??= await createPackedReleaseStage();
      env = { ...process.env, [SHARED_RELEASE_STAGE_ENV]: sharedStage.tempRoot };
    } catch (error) {
      fail(index, step, `staging the packages failed: ${error instanceof Error ? error.message : String(error)}`, 1);
    }
  }
  const result = spawnSync(step.command, step.args, { cwd: REPO_ROOT, stdio: 'inherit', env });
  if (step === stageReaders.at(-1)) releaseSharedStage();
  if (result.status === 0) continue;
  fail(index, step, result.error ? result.error.message : result.signal ? `signal ${result.signal}` : `exit ${result.status}`, result.status);
}
console.log(`[validate] ${steps.length} step(s) passed.`);
