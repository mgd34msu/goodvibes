import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolatedTestEnvironment } from '../toolchain/src/test-runner/test-isolation.ts';
import { RUN_TMP_PREFIX, sweepStaleTmpDirs, TEST_PROJECT_TMP_ENV, TEST_TMP_ROOT_ENV } from '../toolchain/src/test-runner/temp.ts';
import { defaultTestArgs, discoverTestFiles } from './test-discovery.ts';
import { selectPartition } from './test-partitions.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK_PRELOAD = join(ENGINE_ROOT, 'toolchain/src/test-runner/test-network-preload.ts');
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
// bun test flags whose value may be given as the next argument.
const VALUE_FLAGS = new Set(['--timeout', '--preload', '--path-ignore-patterns', '-t', '--test-name-pattern', '--rerun-each', '--retry',
  '--seed', '--reporter', '--reporter-outfile', '--coverage-reporter', '--coverage-dir', '--max-concurrency', '--shard']);

/**
 * Per-test timeout. bun's default is 5 000 ms, an idle machine's number: this
 * suite boots real daemons, opens real sockets, shells out to real `git` and
 * signs real crypto, work whose cost is set by how busy the host is. Under
 * load the daemon-backed files failed with "timed out after 5000ms" while the
 * daemon was still coming up normally. It is a ceiling, not a delay: a fast
 * host finishes as quickly as before. A test's own timeout still wins, and so
 * does an explicit `--timeout`.
 */
function defaultTimeoutMs(): number {
  const env = Number(process.env.GOODVIBES_TEST_TIMEOUT_MS);
  return Number.isFinite(env) && env >= 1 ? Math.floor(env) : 60_000;
}

export interface BunTestRun {
  /** Everything after `bun test`: flags and test files or filters. */
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Variables the isolation allowlist would otherwise strip. */
  readonly fixtureEnv?: Readonly<Record<string, string | undefined>>;
  /** With more than 1, each test file runs in its own `bun test` process, this many at a time. */
  readonly jobs?: number;
}

interface SplitArgs { flags: string[]; filters: string[]; cwd?: string | undefined; partition?: string | undefined; jobs?: string | undefined }

/** Separate runner options, bun flags (with their values) and file filters. */
function splitArgs(argv: readonly string[]): SplitArgs {
  const out: SplitArgs = { flags: [], filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const takesValue = VALUE_FLAGS.has(name) || ['--cwd', '--partition', '--jobs', '--manifest'].includes(name);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined && takesValue) {
      value = argv[++i];
      if (value === undefined) throw new Error(`${name} requires a value`);
    }
    if (name === '--cwd') out.cwd = value;
    else if (name === '--partition') out.partition = value;
    else if (name === '--jobs') out.jobs = value;
    else if (name === '--manifest') continue; // accepted for old workflow lines, ignored
    else if (!arg.startsWith('-')) out.filters.push(arg);
    else if (value === undefined) out.flags.push(arg);
    else out.flags.push(...(name.startsWith('--') ? [`${name}=${value}`] : [name, value]));
  }
  return out;
}

/** Test files of `cwd` selected by bun-style filters, minus `--path-ignore-patterns`. */
function expandFiles(cwd: string, filters: readonly string[], flags: readonly string[]): string[] {
  const ignores = flags.filter((flag) => flag.startsWith('--path-ignore-patterns=')).flatMap((flag) => flag.slice(23).split(','))
    .map((pattern) => new Bun.Glob(pattern.replace(/^\.\//, '')));
  const exact = (filter: string) => (filter.startsWith('./') || filter.startsWith('/') ? relative(cwd, resolve(cwd, filter)) : undefined);
  const files = discoverTestFiles(cwd).filter((file) => !ignores.some((glob) => glob.match(file))
    && (filters.length === 0 || filters.some((filter) => exact(filter) === undefined ? file.includes(filter) : file === exact(filter))));
  if (files.length === 0) throw new Error('No test files matched');
  return files;
}

/**
 * Run `bun test` in an isolated environment inside a per-run temp directory.
 *
 * The directory is exported as TMPDIR (and GOODVIBES_TEST_TMP_ROOT) and removed
 * in a `finally`; an older leftover of a killed run is reclaimed at start.
 * SIGINT/SIGTERM/SIGHUP are relayed to every child's process group (a second
 * one kills it), and whatever is left in a group is killed when its child exits.
 * Resolves with the exit code (128+n when a signal ended the run).
 */
export async function runBunTest(run: BunTestRun): Promise<number> {
  sweepStaleTmpDirs(tmpdir(), RUN_TMP_PREFIX);
  const root = realpathSync(mkdtempSync(join(tmpdir(), RUN_TMP_PREFIX)));
  const cwd = run.cwd ?? ENGINE_ROOT;
  const violations = join(root, 'network-violations');
  const env = isolatedTestEnvironment({ ...(run.env ?? process.env) }, join(root, 'isolated'), run.fixtureEnv);
  // Set before Bun starts: native spawns keep the startup environment, so a later
  // assignment inside a test never reaches a `git` it launches. In-checkout test
  // dirs (`<cwd>/.test-tmp`) and the run root must both stop git's upward search.
  const ceilings = new Set([root, ...(cwd === ENGINE_ROOT ? [] : [join(cwd, '.test-tmp')]), ...(env.GIT_CEILING_DIRECTORIES?.split(delimiter).filter(Boolean) ?? [])]);
  const { flags, filters } = splitArgs(run.args);
  if (!flags.some((flag) => flag.startsWith('--timeout='))) flags.unshift(`--timeout=${defaultTimeoutMs()}`);
  let signalled: keyof typeof SIGNAL_NUMBERS | undefined;
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const killGroups = (signal: NodeJS.Signals): void => {
    for (const child of children) { try { process.kill(-child.pid, signal); } catch { /* group already gone */ } }
  };
  const relays = (Object.keys(SIGNAL_NUMBERS) as (keyof typeof SIGNAL_NUMBERS)[]).map((name) => {
    const relay = (): void => { killGroups(signalled ? 'SIGKILL' : name); signalled ??= name; };
    process.on(name, relay);
    return () => process.off(name, relay);
  });
  /** One `bun test` child; with `capture`, its output is returned instead of inherited. */
  // `own` gives a child its own temp root, HOME and in-checkout temp directory.
  // Files run side by side must not create entries in a directory another file's
  // code is watching: a store that observes its ancestor directories treats a
  // neighbour's new directory as its own source changing.
  const spawnBun = async (testArgs: readonly string[], capture: boolean, own?: { tmp: string; projectTmp?: string }): Promise<{ code: number; output: string }> => {
    const tmp = own?.tmp ?? root;
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', '--preload', NETWORK_PRELOAD, ...testArgs], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['inherit', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
      env: {
        ...(own === undefined ? env : isolatedTestEnvironment({ ...(run.env ?? process.env) }, join(tmp, 'isolated'), run.fixtureEnv)),
        TMPDIR: tmp, TMP: tmp, TEMP: tmp,
        [TEST_TMP_ROOT_ENV]: tmp,
        ...(own?.projectTmp ? { [TEST_PROJECT_TMP_ENV]: own.projectTmp } : {}),
        GIT_CEILING_DIRECTORIES: [...ceilings].join(delimiter),
        GOODVIBES_ENGINE_TEST_RUNNER: '1',
        GOODVIBES_TEST_NETWORK_VIOLATIONS: violations,
      },
    });
    children.add(child);
    try {
      const [stdout, stderr, code] = capture
        ? await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited])
        : ['', '', await child.exited];
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* nothing left in the group */ }
      return { code: code ?? 1, output: stdout + stderr };
    } finally { children.delete(child); }
  };
  try {
    let exitCode: number;
    if ((run.jobs ?? 1) <= 1) exitCode = (await spawnBun([...flags, ...filters], false)).code;
    else {
      // One child per file, at most `jobs` at a time; output is printed as each finishes.
      const files = expandFiles(cwd, filters, flags);
      const failed: string[] = [];
      // Every file's directories exist before the first file starts.
      const projectRun = cwd === ENGINE_ROOT ? undefined : join(cwd, '.test-tmp', `run-${basename(root)}`);
      const own = files.map((_, index) => {
        const tmp = join(root, `f${index}`), projectTmp = projectRun && join(projectRun, `f${index}`);
        mkdirSync(tmp); if (projectTmp) mkdirSync(projectTmp, { recursive: true });
        return projectTmp ? { tmp, projectTmp } : { tmp };
      });
      let next = 0;
      const worker = async (): Promise<void> => {
        while (!signalled && next < files.length) {
          const index = next++, file = files[index]!;
          const started = Date.now();
          const { code, output } = await spawnBun([...flags, `./${file}`], true, own[index]);
          if (code !== 0 || signalled) failed.push(file);
          process.stdout.write(`\n==> ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)${code !== 0 ? `  [FAIL: exit ${code}]` : ''}\n${output}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(run.jobs!, files.length) }, worker));
      console.log(`\nTest files: ${files.length}, failed: ${failed.length}${failed.length ? `\n${failed.map((file) => `  FAIL ${file}`).join('\n')}` : ''}`);
      exitCode = failed.length > 0 ? 1 : 0;
    }
    let blocked = '';
    try { blocked = readFileSync(violations, 'utf8'); } catch { /* none were blocked */ }
    if (blocked) { process.stderr.write(`goodvibes: ordinary tests attempted blocked network access:\n${blocked}`); return 1; }
    return signalled ? 128 + SIGNAL_NUMBERS[signalled] : exitCode;
  } finally {
    for (const remove of relays) remove();
    // A failed removal (a daemon still writing) must not replace the run's exit code.
    // Twice, a moment apart: a detached daemon may still flush into the directory it just lost.
    for (const pass of [0, 1]) {
      if (pass === 1) await new Promise((done) => setTimeout(done, 300));
      for (const path of [root, ...(cwd === ENGINE_ROOT ? [] : [join(cwd, '.test-tmp', `run-${basename(root)}`)])]) {
        try { rmSync(path, { recursive: true, force: true }); } catch (error) { if (pass === 1) console.error(`goodvibes: could not remove ${path}: ${String(error)}`); }
      }
    }
  }
}

/**
 * CLI: `bun scripts/test.ts [--cwd DIR] [--partition=I/N] [--jobs=N|auto] [bun test flags] [files]`.
 * `--cwd` is relative to the engine package. `--jobs=auto` is min(4, cores - 1). `--manifest=` is accepted and ignored.
 */
function parseCli(argv: readonly string[]): BunTestRun {
  const { flags, filters, cwd, partition, jobs } = splitArgs(argv);
  const jobCount = jobs === undefined ? 1 : jobs === 'auto' ? Math.max(1, Math.min(4, availableParallelism() - 1)) : Number(jobs);
  if (!Number.isInteger(jobCount) || jobCount < 1) throw new Error('--jobs expects a positive integer or "auto"');
  if (partition !== undefined) {
    if (cwd !== undefined || filters.length > 0) throw new Error('--partition selects engine test files itself; do not combine it with --cwd or test files');
    return { args: [...flags, ...selectPartition(ENGINE_ROOT, partition)], jobs: jobCount };
  }
  if (cwd === undefined && filters.length === 0) return { args: [...flags, ...defaultTestArgs(ENGINE_ROOT)], jobs: jobCount };
  return { args: [...flags, ...filters], cwd: resolve(ENGINE_ROOT, cwd ?? '.'), jobs: jobCount };
}

if (import.meta.main) process.exitCode = await runBunTest(parseCli(process.argv.slice(2)));
