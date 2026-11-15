import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolatedTestEnvironment } from '../toolchain/src/test-runner/test-isolation.ts';
import { RUN_TMP_PREFIX, sweepStaleTmpDirs, TEST_TMP_ROOT_ENV } from '../toolchain/src/test-runner/temp.ts';
import { staleDistNote } from './dist-freshness.ts';
import { defaultTestArgs, discoverTestFiles } from './test-discovery.ts';
import { partitionTestFiles, selectPartition } from './test-partitions.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK_PRELOAD = join(ENGINE_ROOT, 'toolchain/src/test-runner/test-network-preload.ts');
// Packages whose compiled output some tests import instead of the source.
const DIST_PACKAGES = ['platform', 'errors', 'contracts', 'daemon-api', 'operator-client', 'peer-client', 'terminal-shell', 'transport-core', 'transport-http', 'transport-realtime'] as const;
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

/**
 * The longest one test file may run in its own process before its process
 * group is killed and the file reported as failed. Per-test timeouts cover a
 * test that hangs inside bun's runner; this covers a file that never exits
 * (a leaked server or poller keeping its event loop alive).
 */
function fileDeadlineMs(): number {
  const env = Number(process.env.GOODVIBES_TEST_FILE_TIMEOUT_MS);
  return Number.isFinite(env) && env >= 1 ? Math.floor(env) : 600_000;
}

/** Files run side by side by default: one per core, leaving one for the runner and the host. */
function defaultJobs(): number {
  return Math.max(1, availableParallelism() - 1);
}

export interface BunTestRun {
  /** Everything after `bun test`: flags and test files or filters. */
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Variables the isolation allowlist would otherwise strip. */
  readonly fixtureEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * With more than 1, each test file runs in its own `bun test` process (its
   * own home and temp root), this many at a time. Omitted, every file runs in
   * one process; the command line defaults to one file per core.
   */
  readonly jobs?: number;
}

interface SplitArgs { flags: string[]; filters: string[]; cwd?: string | undefined; partition?: string | undefined; jobs?: string | undefined; liveSandbox?: boolean }

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
    else if (name === '--live-sandbox') out.liveSandbox = true;
    else if (!arg.startsWith('-')) out.filters.push(arg);
    else if (value === undefined) out.flags.push(arg);
    else out.flags.push(...(name.startsWith('--') ? [`${name}=${value}`] : [name, value]));
  }
  return out;
}

/**
 * A path that does not exist under `cwd` but does from the caller's directory
 * (`packages/engine/test/x.test.ts` typed at the repo root) becomes the exact
 * `./` path under `cwd`. Anything else is left for bun to match.
 */
function resolveFilters(cwd: string, filters: readonly string[]): string[] {
  return filters.map((filter) => {
    const fromCaller = resolve(filter);
    if (existsSync(resolve(cwd, filter)) || !existsSync(fromCaller)) return filter;
    const inside = relative(cwd, fromCaller);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`${filter} is outside the test directory ${cwd}; pass --cwd <its package>, relative to ${ENGINE_ROOT}`);
    }
    return `./${inside}`;
  });
}

/** An exact file, or a directory (bun runs every test under a directory prefix). */
function matchesPath(file: string, rel: string): boolean {
  return file === rel || file.startsWith(`${rel.replace(/\/$/, '')}/`);
}

/** bun's own selection: an exact `./` or absolute path, otherwise a substring of the path. */
function selects(cwd: string, file: string, filter: string): boolean {
  return filter.startsWith('./') || filter.startsWith('/') ? matchesPath(file, relative(cwd, resolve(cwd, filter))) : file.includes(filter);
}

/** A filter that names a file (`./x`, an absolute path, or a `*.test.ts` name) rather than a substring such as `src/`. */
const PATH_FILTER = /^(?:\.\/|\/)|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Filters that select no test file. A renamed or deleted file in an explicit
 * list would otherwise drop out of the run while the rest still pass, so a
 * filter that names a path and matches nothing is an error; a bare substring
 * that matches nothing is reported but may be intentional.
 */
export function checkFilters(cwd: string, files: readonly string[], filters: readonly string[]): string[] {
  const unmatched = filters.filter((filter) => !files.some((file) => selects(cwd, file, filter)));
  const missing = unmatched.filter((filter) => PATH_FILTER.test(filter));
  if (missing.length > 0) {
    throw new Error(`Test path(s) not found under ${cwd}: ${missing.join(' ')}. Rename or remove them from the list that names them (paths are relative to that directory, or to the current directory).`);
  }
  return unmatched;
}

function noMatch(cwd: string, filters: readonly string[]): string {
  return `No test files under ${cwd} matched ${filters.join(' ')}. Paths are relative to that directory (or to the current directory).`;
}

/** Test files of `cwd` selected by bun-style filters, minus `--path-ignore-patterns`. */
function expandFiles(cwd: string, filters: readonly string[], flags: readonly string[]): string[] {
  const ignores = flags.filter((flag) => flag.startsWith('--path-ignore-patterns=')).flatMap((flag) => flag.slice(23).split(','))
    .map((pattern) => new Bun.Glob(pattern.replace(/^\.\//, '')));
  const files = discoverTestFiles(cwd).filter((file) => !ignores.some((glob) => glob.match(file))
    && (filters.length === 0 || filters.some((filter) => selects(cwd, file, filter))));
  if (files.length === 0) throw new Error(noMatch(cwd, filters));
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
  const cwd = run.cwd ?? ENGINE_ROOT;
  const split = splitArgs(run.args);
  const flags = split.flags;
  const filters = resolveFilters(cwd, split.filters);
  // Checked before anything is created, so a bad list leaves no temp directory behind.
  if (filters.length > 0) {
    const files = discoverTestFiles(cwd);
    for (const filter of checkFilters(cwd, files, filters)) process.stderr.write(`goodvibes: warning: ${noMatch(cwd, [filter])}\n`);
    if (cwd === ENGINE_ROOT) {
      const selected = files.filter((file) => filters.some((filter) => selects(cwd, file, filter)));
      if (selected.length <= 200) {
        // A test often reaches dist through a helper it imports or spawns (the
        // dist path is spelled there, sometimes escaped in a regex), so the
        // text of the helpers it names counts too.
        const sources = selected.flatMap((file) => {
          const text = readFileSync(join(cwd, file), 'utf8');
          const helpers = [...text.matchAll(/['"`]((?:\.{1,2}\/|[^'"`]*\/)?_helpers\/[^'"`]+\.(?:ts|mts|mjs|js))['"`]/g)].flatMap((match) => {
            const path = resolve(dirname(join(cwd, file)), (match[1] ?? '').replace(/^.*?(?=_helpers\/)/, ''));
            return existsSync(path) ? [readFileSync(path, 'utf8')] : [];
          });
          return [text, ...helpers];
        });
        for (const pkg of DIST_PACKAGES) {
          if (!sources.some((text) => text.includes(`${pkg}/dist`) || text.includes(`${pkg}\\/dist`))) continue;
          const note = staleDistNote(join(cwd, pkg, 'src'), join(cwd, pkg, 'dist'), 'bun run build');
          if (note) process.stderr.write(`goodvibes: warning: ${note}\n`);
        }
      }
    }
  }
  sweepStaleTmpDirs(tmpdir(), RUN_TMP_PREFIX);
  const root = realpathSync(mkdtempSync(join(tmpdir(), RUN_TMP_PREFIX)));
  const violations = join(root, 'network-violations');
  const env = isolatedTestEnvironment({ ...(run.env ?? process.env) }, join(root, 'isolated'), run.fixtureEnv);
  // Set before Bun starts: native spawns keep the startup environment, so a later
  // assignment inside a test never reaches a `git` it launches. In-checkout test
  // dirs (`<cwd>/.test-tmp`) and the run root must both stop git's upward search.
  const ceilings = new Set([root, ...(cwd === ENGINE_ROOT ? [] : [join(cwd, '.test-tmp')]), ...(env.GIT_CEILING_DIRECTORIES?.split(delimiter).filter(Boolean) ?? [])]);
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
  // `own` is a child's private temp root and HOME: files run side by side must
  // not share a home directory.
  const spawnBun = async (testArgs: readonly string[], capture: boolean, own?: string, deadlineMs?: number): Promise<{ code: number; output: string; timedOut: boolean }> => {
    const tmp = own ?? root;
    if (own) mkdirSync(own);
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', '--preload', NETWORK_PRELOAD, ...testArgs], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['inherit', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
      env: {
        ...(own === undefined ? env : isolatedTestEnvironment({ ...(run.env ?? process.env) }, join(tmp, 'isolated'), run.fixtureEnv)),
        TMPDIR: tmp, TMP: tmp, TEMP: tmp,
        [TEST_TMP_ROOT_ENV]: tmp,
        GIT_CEILING_DIRECTORIES: [...ceilings].join(delimiter),
        GOODVIBES_ENGINE_TEST_RUNNER: '1',
        GOODVIBES_TEST_NETWORK_VIOLATIONS: violations,
      },
    });
    children.add(child);
    let timedOut = false;
    const deadline = deadlineMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    }, deadlineMs);
    try {
      const [stdout, stderr, code] = capture
        ? await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited])
        : ['', '', await child.exited];
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* nothing left in the group */ }
      return { code: code ?? 1, output: stdout + stderr, timedOut };
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      children.delete(child);
    }
  };
  try {
    let exitCode: number;
    const files = (run.jobs ?? 1) <= 1 ? [] : expandFiles(cwd, filters, flags);
    if (files.length <= 1) {
      // One process, output streamed as it comes: the whole selection when jobs is 1, or the one selected file.
      exitCode = (await spawnBun([...flags, ...filters], false)).code;
    } else {
      // One child per file, at most `jobs` at a time. Each file prints a line when it starts and one when it
      // ends; a failing file's output follows its line, and a file that outlives its deadline is killed.
      const failed: string[] = [];
      const deadlineMs = fileDeadlineMs();
      let next = 0;
      const worker = async (): Promise<void> => {
        while (!signalled && next < files.length) {
          const index = next++, file = files[index]!;
          const started = Date.now();
          process.stdout.write(`==> start ${file}\n`);
          const { code, output, timedOut } = await spawnBun([...flags, `./${file}`], true, join(root, `${basename(root)}-f${index}`), deadlineMs);
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          if (code !== 0 || timedOut || signalled) {
            failed.push(file);
            const why = timedOut ? `still running after ${String(deadlineMs / 1000)}s, killed` : `exit ${code}`;
            process.stdout.write(`==> FAIL ${file} (${seconds}s, ${why})\n${output}\n`);
          } else {
            process.stdout.write(`==> ok ${file} (${seconds}s)\n`);
          }
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
      const projectTmp = cwd === ENGINE_ROOT ? undefined : join(cwd, '.test-tmp');
      const projectRuns = projectTmp && existsSync(projectTmp) ? readdirSync(projectTmp).filter((name) => name.startsWith(`run-${basename(root)}`)).map((name) => join(projectTmp, name)) : [];
      for (const path of [root, ...projectRuns]) {
        try { rmSync(path, { recursive: true, force: true }); } catch (error) { if (pass === 1) console.error(`goodvibes: could not remove ${path}: ${String(error)}`); }
      }
    }
  }
}

/** The variable that turns a live-sandbox test's skip on a host without the capability into a failure. */
const EXEC_CONTAINMENT_REQUIRED_ENV = 'GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT';

/**
 * Engine tests that depend on a live sandbox: the ones that read the containment requirement, directly or
 * through the shared proof helper. That reading is what lets them skip on an unsupported host, so it is also
 * what selects them; a list kept elsewhere could not follow a new test.
 */
export function liveSandboxTestFiles(engineRoot: string): readonly string[] {
  return defaultTestArgs(engineRoot).filter((file) => {
    const text = readFileSync(join(engineRoot, file), 'utf8');
    return text.includes(EXEC_CONTAINMENT_REQUIRED_ENV) || /_helpers\/exec-containment-proof(?:\.ts)?['"]/.test(text);
  });
}

/**
 * CLI: `bun scripts/test.ts [--cwd DIR] [--partition=I/N] [--live-sandbox] [--jobs=N|auto] [bun test flags] [files]`.
 * `--cwd` is relative to the engine package. Files run one per process, cores - 1 at a time (`--jobs=auto`, the
 * default); `--jobs=1` runs the whole selection in one process. `--live-sandbox` runs the live-sandbox tests with
 * their skip turned into a failure (with `--partition`, that part of them). `--manifest=` is accepted and ignored.
 */
function parseCli(argv: readonly string[]): BunTestRun {
  const { flags, filters, cwd, partition, jobs, liveSandbox } = splitArgs(argv);
  const jobCount = jobs === undefined || jobs === 'auto' ? defaultJobs() : Number(jobs);
  if (!Number.isInteger(jobCount) || jobCount < 1) throw new Error('--jobs expects a positive integer or "auto"');
  if (liveSandbox) {
    if (cwd !== undefined || filters.length > 0) throw new Error('--live-sandbox selects engine test files itself; do not combine it with --cwd or test files');
    let files = liveSandboxTestFiles(ENGINE_ROOT);
    if (files.length === 0) throw new Error(`No engine test reads ${EXEC_CONTAINMENT_REQUIRED_ENV}`);
    if (partition !== undefined) {
      const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(partition);
      if (!match || Number(match[1]) > Number(match[2])) throw new Error('Invalid test partition; expected --partition=INDEX/COUNT');
      files = partitionTestFiles(files, Number(match[2]))[Number(match[1]) - 1]!;
    }
    console.log(`[engine-tests] live sandbox: ${files.length} files`);
    return { args: [...flags, ...files.map((file) => `./${file}`)], jobs: jobCount, env: { ...process.env, [EXEC_CONTAINMENT_REQUIRED_ENV]: '1' } };
  }
  if (partition !== undefined) {
    if (cwd !== undefined || filters.length > 0) throw new Error('--partition selects engine test files itself; do not combine it with --cwd or test files');
    return { args: [...flags, ...selectPartition(ENGINE_ROOT, partition)], jobs: jobCount };
  }
  if (cwd === undefined && filters.length === 0) return { args: [...flags, ...defaultTestArgs(ENGINE_ROOT)], jobs: jobCount };
  return { args: [...flags, ...filters], cwd: resolve(ENGINE_ROOT, cwd ?? '.'), jobs: jobCount };
}

if (import.meta.main) {
  try {
    process.exitCode = await runBunTest(parseCli(process.argv.slice(2)));
  } catch (error) {
    // A usage mistake gets its message, not a stack trace.
    console.error(`goodvibes: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
