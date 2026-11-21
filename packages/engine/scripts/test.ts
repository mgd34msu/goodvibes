/**
 * The repository's test runner. Every test file runs in its own `bun test`
 * process with its own home and temp directory and the network blocked, from
 * one pool of workers (cores minus one).
 *
 *   bun packages/engine/scripts/test.ts                  every default-suite file in the repository
 *   bun packages/engine/scripts/test.ts --live           the files under a test/live/ folder
 *   bun packages/engine/scripts/test.ts --e2e            the files under a src/test/e2e/ folder
 *   bun packages/engine/scripts/test.ts <file|dir>...    the named files, and the default-suite files under the named folders
 *
 * Paths are relative to `--cwd` (itself relative to packages/engine) when given,
 * else to the current directory, else to packages/engine. `-t <pattern>` passes
 * a test-name filter to bun; `--jobs <n>` sets the pool size.
 *
 * The runner sets no time limit of any kind: no test or file is stopped or
 * fails for its duration (bun gets `--timeout=0`, which turns its own per-test
 * timeout off), and a file that never finishes keeps running. The run reports
 * the slowest files and the file-seconds per kind as information. Before any file starts, every selected file is scanned (test-scan.ts) and the
 * whole run is refused if one waits on a clock, uses a snapshot, replaces a
 * module, skips a test or raises a limit, lacks its `// Proves:` / `// Red when:`
 * header, or disagrees with the risk table (packages/engine/docs/test-risks.md):
 * a case with no row, a row naming a case the file does not have, a `Proves`
 * line that is not the risk of its rows. A whole-suite run also refuses a row
 * naming a file that does not exist. A file that runs no test, skips a
 * test, tries the network, or leaves a process running is a failure.
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isolatedTestEnvironment } from '../toolchain/src/test-runner/test-isolation.ts';
import { RUN_TMP_PREFIX, STALE_RUN_MS, sweepStaleTmpDirs, TEMP_ROOT_OWNER_FILE, tempRootOwnerAlive, TEST_TMP_ROOT_ENV } from '../toolchain/src/test-runner/temp.ts';
import { missingProofFiles, readRiskTable, scanBunfig, scanTestFiles, type ScanFinding } from './test-scan.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(ENGINE_ROOT, '../..');
const NETWORK_PRELOAD = join(ENGINE_ROOT, 'toolchain/src/test-runner/test-network-preload.ts');
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/** bun's per-test timeout: 0 turns it off (bun's documented "no timeout"), so its own 5-second default never acts as a limit. */
const BUN_NO_TIMEOUT = '--timeout=0';

/** Set for files under test/live/: a host without the sandbox fails them instead of letting them pass. */
const EXEC_CONTAINMENT_REQUIRED_ENV = 'GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT';
/**
 * Set for files under test/live/: the browser cache the driver's own install
 * (`playwright-core/cli.js install chromium`) fills on this machine. Each file
 * gets an isolated HOME, so it cannot work the location out itself; the runner
 * reads it from the driver, with the account's own environment, before isolating.
 */
const LIVE_BROWSER_CACHE_ENV = 'GOODVIBES_LIVE_BROWSER_CACHE';

/** Where the driver installs and finds its browsers for this account: the parent of its chromium-<revision> directory. */
function driverBrowserCache(): string {
  const driver = createRequire(join(ENGINE_ROOT, 'package.json'))('playwright-core') as { readonly chromium: { executablePath(): string } };
  const executable = driver.chromium.executablePath();
  const parts = executable.split(sep);
  const build = parts.findIndex((part) => part.startsWith('chromium-'));
  if (build <= 0) throw new Error(`The browser driver names no chromium-<revision> directory in ${executable}.`);
  return parts.slice(0, build).join(sep) || sep;
}

export type TestKind = 'default' | 'live' | 'e2e';

export interface TestFile {
  /** Absolute path. */
  readonly path: string;
  /** The package directory bun runs in (its bunfig.toml applies). */
  readonly cwd: string;
  /** Path from the repository root, for output. */
  readonly name: string;
  readonly kind: TestKind;
}

/**
 * Where test files live: each package directory, and the folders in it that
 * hold tests. bun runs each file from its package directory so that package's
 * bunfig.toml (preloads) applies.
 */
const TEST_ROOTS: readonly { readonly cwd: string; readonly dirs: readonly string[] }[] = [
  { cwd: 'packages/engine', dirs: ['test'] },
  { cwd: 'packages/judgment', dirs: ['test'] },
  { cwd: '.', dirs: ['scripts'] },
  { cwd: 'products/agent', dirs: ['src'] },
  { cwd: 'products/tui', dirs: ['src', 'examples'] },
  { cwd: 'products/daemon', dirs: ['src', 'scripts'] },
  { cwd: 'products/webui', dirs: ['src', 'scripts'] },
];
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Data and build output, never test suites. `test/types` holds type-level checks run by `types:check`.
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.test-tmp', 'coverage', 'fixtures']);
const SKIPPED_PATHS = new Set([join(REPO_ROOT, 'packages/engine/test/types')]);

function kindOf(name: string): TestKind {
  const path = `/${name}`;
  if (path.includes('/test/live/')) return 'live';
  if (path.includes('/src/test/e2e/')) return 'e2e';
  return 'default';
}

/** Every test file in the repository, sorted by name. */
export function discoverTestFiles(): TestFile[] {
  const found: TestFile[] = [];
  for (const root of TEST_ROOTS) {
    const cwd = resolve(REPO_ROOT, root.cwd);
    const visit = (directory: string): void => {
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name) && !SKIPPED_PATHS.has(path)) visit(path);
        } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
          const name = relative(REPO_ROOT, path).split(sep).join('/');
          found.push({ path, cwd, name, kind: kindOf(name) });
        }
      }
    };
    for (const dir of root.dirs) visit(join(cwd, dir));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export interface Selection {
  /** Files or folders; empty selects every file of `kinds`. */
  readonly paths: readonly string[];
  /** Kinds selected by folder or by default. Named files run whatever their kind. */
  readonly kinds: ReadonlySet<TestKind>;
  /** Directories relative paths are tried against, in order. */
  readonly bases: readonly string[];
}

/** The files a selection names. A path that names no test file is an error, never a silent drop. */
export function selectTestFiles(all: readonly TestFile[], selection: Selection): TestFile[] {
  if (selection.paths.length === 0) return all.filter((file) => selection.kinds.has(file.kind));
  const chosen = new Map<string, TestFile>();
  for (const given of selection.paths) {
    const candidates = [...new Set(selection.bases.map((base) => resolve(base, given)))];
    const path = candidates.find((candidate) => existsSync(candidate));
    if (path === undefined) throw new Error(`${given} does not exist (looked in ${selection.bases.join(', ')})`);
    if (statSync(path).isDirectory()) {
      const inside = all.filter((file) => file.path.startsWith(`${path}${sep}`) && selection.kinds.has(file.kind));
      if (inside.length === 0) throw new Error(`no ${[...selection.kinds].join(' or ')} test files under ${relative(REPO_ROOT, path) || '.'}`);
      for (const file of inside) chosen.set(file.path, file);
    } else {
      const file = all.find((candidate) => candidate.path === path);
      if (file === undefined) throw new Error(`${relative(REPO_ROOT, path)} is not a test file in a test folder (${TEST_ROOTS.map((root) => root.dirs.map((dir) => join(root.cwd, dir)).join(', ')).join(', ')})`);
      chosen.set(file.path, file);
    }
  }
  return [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The admission scan of the selected files and the bunfig.toml of each package
 * they run in, against the risk table read once. `wholeSuite` adds the table's
 * own check that every row names a file that exists.
 */
export function admissionFindings(files: readonly TestFile[], wholeSuite = false): ScanFinding[] {
  const names = new Map(files.map((file) => [file.path, file.name]));
  const label = (path: string): string => names.get(path) ?? relative(REPO_ROOT, path).split(sep).join('/');
  const bunfigs = [...new Set(files.map((file) => join(file.cwd, 'bunfig.toml')))].filter((path) => existsSync(path));
  const table = readRiskTable();
  return [
    ...table.findings,
    ...(wholeSuite ? missingProofFiles(table, REPO_ROOT) : []),
    ...bunfigs.flatMap((path) => scanBunfig(label(path), readFileSync(path, 'utf8'))),
    ...scanTestFiles(files.map((file) => file.path), label, table),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

interface JunitResult { readonly tests: number; readonly skipped: number }

const XML_ENTITIES: Readonly<Record<string, string>> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
function attributes(tag: string): Map<string, string> {
  return new Map([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!.replace(/&(?:quot|apos|lt|gt|amp);/g, (entity) => XML_ENTITIES[entity]!)]));
}

/** bun's JUnit report of one file: its test and skip counts. */
function readJunit(path: string): JunitResult | undefined {
  let xml: string;
  try { xml = readFileSync(path, 'utf8'); } catch { return undefined; }
  const top = /<testsuites\b([^>]*)>/.exec(xml);
  if (!top) return undefined;
  const totals = attributes(top[1]!);
  return { tests: Number(totals.get('tests') ?? 0), skipped: Number(totals.get('skipped') ?? 0) };
}

/**
 * Processes that outlived the file that started them in another process group
 * (a detached daemon, a browser). Each carries the file's temp root in its
 * environment, and is named by its program and, for a browser's helpers, its
 * role, so a killed file's log says what it left running. Linux only;
 * elsewhere the group kill is the whole clean-up.
 */
function strayProcesses(ownRoot: string, group: number): { readonly pid: number; readonly what: string }[] {
  if (process.platform !== 'linux') return [];
  const marker = `${TEST_TMP_ROOT_ENV}=${ownRoot}\0`;
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return []; }
  return entries.filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try {
      // Field 5 of stat is the process group; members of the killed group are already going.
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) === group) return [];
      if (!readFileSync(`/proc/${name}/environ`, 'latin1').includes(marker)) return [];
      const argv = readFileSync(`/proc/${name}/cmdline`, 'latin1').split('\0').filter(Boolean);
      const role = argv.find((arg) => arg.startsWith('--type='));
      const what = [argv[0] ?? stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), ...(role ? [role] : [])].join(' ');
      return [{ pid: Number(name), what: what.length > 160 ? `${what.slice(0, 160)}...` : what }];
    } catch { return []; }
  });
}

export interface RunOptions {
  readonly files: readonly TestFile[];
  /** Every file of the selected kinds, not named ones: the risk table's rows are checked for missing files too. */
  readonly wholeSuite?: boolean | undefined;
  readonly jobs: number;
  /** bun's `-t`: only tests whose name matches run; files with none matching fail. */
  readonly namePattern?: string | undefined;
  /** The environment the isolated one is built from (defaults to this process's). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface FileOutcome { readonly file: TestFile; readonly seconds: number; readonly failure?: string; readonly output: string; readonly ran: number }

/** Run the run's temp root, signal relays and clean-up around `body`. */
async function withRunRoot<T>(cwds: readonly string[], body: (root: string, signalled: () => keyof typeof SIGNAL_NUMBERS | undefined, children: Set<ReturnType<typeof Bun.spawn>>) => Promise<T>): Promise<T> {
  // A run root carries its runner's pid, so a run whose last files take longer than the sweep age keeps its root.
  sweepStaleTmpDirs(tmpdir(), RUN_TMP_PREFIX, STALE_RUN_MS, { preserve: tempRootOwnerAlive });
  const root = realpathSync(mkdtempSync(join(tmpdir(), RUN_TMP_PREFIX)));
  writeFileSync(join(root, TEMP_ROOT_OWNER_FILE), String(process.pid));
  let signalled: keyof typeof SIGNAL_NUMBERS | undefined;
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const relays = (Object.keys(SIGNAL_NUMBERS) as (keyof typeof SIGNAL_NUMBERS)[]).map((name) => {
    const relay = (): void => {
      // A second signal kills outright.
      for (const child of children) { try { process.kill(-child.pid, signalled ? 'SIGKILL' : name); } catch { /* group already gone */ } }
      signalled ??= name;
    };
    process.on(name, relay);
    return () => process.off(name, relay);
  });
  try {
    return await body(root, () => signalled, children);
  } finally {
    for (const remove of relays) remove();
    // Every child's process group was killed when it exited and every stray was
    // killed by pid, so nothing is left to write here: one removal is enough.
    // A failure is reported, never allowed to replace the run's exit code.
    const projectRuns = cwds.filter((cwd) => cwd !== ENGINE_ROOT).flatMap((cwd) => {
      const projectTmp = join(cwd, '.test-tmp');
      try { return readdirSync(projectTmp).filter((name) => name.startsWith(`run-${basename(root)}`)).map((name) => join(projectTmp, name)); } catch { return []; }
    });
    for (const path of [root, ...projectRuns]) {
      try { rmSync(path, { recursive: true, force: true }); } catch (error) { console.error(`goodvibes: could not remove ${path}: ${String(error)}`); }
    }
  }
}

/** The environment of one child: isolated, with its own temp root, and git kept out of the checkout above. */
function childEnvironment(base: Readonly<Record<string, string | undefined>>, own: string, root: string, cwd: string, extra: Readonly<Record<string, string>>): Record<string, string | undefined> {
  const env = isolatedTestEnvironment({ ...base }, join(own, 'isolated'));
  // Set before Bun starts: native spawns keep the startup environment, so a later
  // assignment inside a test never reaches a `git` it launches. In-checkout test
  // dirs (`<cwd>/.test-tmp`) and the run root must both stop git's upward search.
  const ceilings = new Set([root, ...(cwd === ENGINE_ROOT ? [] : [join(cwd, '.test-tmp')]), ...(base.GIT_CEILING_DIRECTORIES?.split(delimiter).filter(Boolean) ?? [])]);
  return {
    ...env,
    TMPDIR: own, TMP: own, TEMP: own,
    [TEST_TMP_ROOT_ENV]: own,
    GIT_CEILING_DIRECTORIES: [...ceilings].join(delimiter),
    GOODVIBES_ENGINE_TEST_RUNNER: '1',
    GOODVIBES_TEST_NETWORK_VIOLATIONS: join(own, 'network-violations'),
    ...extra,
  };
}

/** Run one file in its own process and judge it. */
async function runFile(file: TestFile, index: number, root: string, options: RunOptions, children: Set<ReturnType<typeof Bun.spawn>>): Promise<FileOutcome> {
  // Named after the run root: product helpers name their in-checkout directory `.test-tmp/run-<this name>`.
  const own = join(root, `${basename(root)}-f${index}`);
  mkdirSync(own);
  const junit = join(own, 'junit.xml');
  const outputPath = join(own, 'output.txt');
  // Output goes to a file, not a pipe: a process the file leaves behind could hold a pipe open and stall the read.
  const outputFd = openSync(outputPath, 'a');
  const started = performance.now();
  const child = Bun.spawn([process.execPath, '--no-env-file', 'test', '--preload', NETWORK_PRELOAD, BUN_NO_TIMEOUT,
    '--reporter=junit', `--reporter-outfile=${junit}`, ...(options.namePattern === undefined ? [] : ['-t', options.namePattern]),
    `./${relative(file.cwd, file.path)}`], {
    cwd: file.cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', outputFd, outputFd],
    env: childEnvironment(options.env ?? process.env, own, root, file.cwd, file.kind === 'live' ? { [EXEC_CONTAINMENT_REQUIRED_ENV]: '1', [LIVE_BROWSER_CACHE_ENV]: driverBrowserCache() } : {}),
  });
  closeSync(outputFd);
  children.add(child);
  let code: number;
  try {
    code = await child.exited;
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* nothing left in the group */ }
    children.delete(child);
  }
  const seconds = (performance.now() - started) / 1000;
  const strays = strayProcesses(own, child.pid);
  for (const { pid } of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  const output = readFileSync(outputPath, 'utf8');
  const result = readJunit(junit);
  const ran = result === undefined ? 0 : result.tests - result.skipped;
  let blocked = '';
  try { blocked = readFileSync(join(own, 'network-violations'), 'utf8'); } catch { /* none were blocked */ }
  const failures: string[] = [];
  if (code !== 0) failures.push(`exit ${code}`);
  if (ran === 0) failures.push(options.namePattern === undefined ? 'no tests ran' : `no test matched -t ${options.namePattern}`);
  if (options.namePattern === undefined && result !== undefined && result.skipped > 0) failures.push(`${result.skipped} test(s) skipped or marked todo`);
  if (blocked) failures.push(`tried the network:\n${blocked.trimEnd()}`);
  if (strays.length > 0) failures.push(`left ${strays.length} process(es) running after it ended (${strays.map(({ pid, what }) => `pid ${pid} ${what}`).join(', ')}), killed`);
  return failures.length > 0 ? { file, seconds, failure: failures.join('; '), output, ran } : { file, seconds, output, ran };
}

const KIND_LABEL: Readonly<Record<TestKind, string>> = { default: 'Default suite', live: 'Live (test/live/)', e2e: 'End to end (src/test/e2e/)' };

/**
 * Scan, then run `files` from one pool of `jobs` workers, one process per file.
 * Prints a line per file, the ten slowest files, the file-seconds per kind and
 * a summary. Resolves with the exit code: 0 all passed, 1 a failure or a
 * refusal, 128+n when a signal ended the run.
 */
export async function runTests(options: RunOptions): Promise<number> {
  const started = performance.now();
  const { files } = options;
  const findings = admissionFindings(files, options.wholeSuite === true);
  if (findings.length > 0) {
    const refused = new Set(findings.map((finding) => finding.file));
    console.log('Refused: no sleeps or timer waits, snapshots, module mocks, skips or raised limits; every file opens with its Proves and Red when header, and every case has its row in packages/engine/docs/test-risks.md:');
    for (const finding of findings) console.log(`  ${finding.file}:${finding.line}  ${finding.rule}`);
    console.log(`\nFiles: 0 run, 0 passed, 0 failed, ${refused.size} refused; nothing ran. ${((performance.now() - started) / 1000).toFixed(1)}s`);
    return 1;
  }
  const cwds = [...new Set(files.map((file) => file.cwd))];
  return withRunRoot(cwds, async (root, signalled, children) => {
    const outcomes: FileOutcome[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!signalled() && next < files.length) {
        const index = next++;
        const outcome = await runFile(files[index]!, index, root, options, children);
        outcomes.push(outcome);
        const time = `${outcome.seconds.toFixed(1)}s`.padStart(6);
        if (outcome.failure === undefined) console.log(`ok   ${time}  ${outcome.file.name}  (${outcome.ran} test${outcome.ran === 1 ? '' : 's'})`);
        else console.log(`FAIL ${time}  ${outcome.file.name}  ${outcome.failure}\n${outcome.output.trimEnd()}\n`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.jobs, files.length)) }, worker));

    const failed = outcomes.filter((outcome) => outcome.failure !== undefined);
    console.log('\nSlowest files:');
    for (const outcome of [...outcomes].sort((a, b) => b.seconds - a.seconds).slice(0, 10)) console.log(`  ${outcome.seconds.toFixed(1).padStart(5)}s  ${outcome.file.name}`);
    // Information only: no file or run fails for its duration.
    for (const kind of ['default', 'live', 'e2e'] as const) {
      const ofKind = outcomes.filter((outcome) => outcome.file.kind === kind);
      if (ofKind.length === 0) continue;
      const total = ofKind.reduce((sum, outcome) => sum + outcome.seconds, 0);
      console.log(`${KIND_LABEL[kind]}: ${ofKind.length} files, ${total.toFixed(1)} file-seconds`);
    }
    const notRun = files.length - outcomes.length;
    console.log(`\nFiles: ${outcomes.length} run, ${outcomes.length - failed.length} passed, ${failed.length} failed, 0 refused${notRun > 0 ? `, ${notRun} not started (interrupted)` : ''}. ${((performance.now() - started) / 1000).toFixed(1)}s`);
    for (const outcome of failed.sort((a, b) => a.file.name.localeCompare(b.file.name))) console.log(`  FAIL ${outcome.file.name}`);
    const stop = signalled();
    if (stop !== undefined) return 128 + SIGNAL_NUMBERS[stop];
    return failed.length > 0 ? 1 : 0;
  });
}

/**
 * Every file of `files` in ONE `bun test` process, with `preload` loaded first,
 * under the same isolation. For the leak scans only: a poller one file forgets
 * to stop keeps firing in the files after it, which per-file processes would
 * hide.
 */
export async function runInOneProcess(cwd: string, files: readonly TestFile[], preload: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  return withRunRoot([cwd], async (root, _signalled, children) => {
    const own = join(root, `${basename(root)}-one`);
    mkdirSync(own);
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', '--preload', NETWORK_PRELOAD, '--preload', preload, BUN_NO_TIMEOUT,
      ...files.map((file) => `./${relative(cwd, file.path)}`)], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit'],
      env: childEnvironment(env, own, root, cwd, {}),
    });
    children.add(child);
    try {
      return await child.exited;
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* nothing left in the group */ }
      children.delete(child);
    }
  });
}

/** Files run side by side by default: one per core, leaving one for the runner and the host. */
function defaultJobs(): number {
  return Math.max(1, availableParallelism() - 1);
}

const LIMIT_FLAGS = new Set(['--timeout', '--retry', '--rerun-each', '--bail', '--preload', '--only', '--todo']);
const USAGE = 'usage: test.ts [--live] [--e2e] [--jobs <n>|auto] [--cwd <dir>] [-t <pattern>] [file|dir ...]';

export interface Cli { readonly selection: Selection; readonly jobs: number; readonly namePattern?: string | undefined }

/** Parse the command line. Limits have no options: a flag that would change them is an error. */
export function parseCli(argv: readonly string[], callerDir: string = process.cwd()): Cli {
  const paths: string[] = [];
  const kinds = new Set<TestKind>();
  let cwd: string | undefined;
  let jobs: string | undefined;
  let namePattern: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) { paths.push(arg); continue; }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string => {
      const given = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (given === undefined || given === '') throw new Error(`${name} requires a value. ${USAGE}`);
      return given;
    };
    if (name === '--live') kinds.add('live');
    else if (name === '--e2e') kinds.add('e2e');
    else if (name === '--cwd') cwd = value();
    else if (name === '--jobs') jobs = value();
    else if (name === '-t' || name === '--test-name-pattern') namePattern = value();
    else if (LIMIT_FLAGS.has(name)) throw new Error(`${name} is not accepted: the runner sets no time limit and retries nothing.`);
    else throw new Error(`unknown option ${arg}. ${USAGE}`);
  }
  const jobCount = jobs === undefined || jobs === 'auto' ? defaultJobs() : Number(jobs);
  if (!Number.isInteger(jobCount) || jobCount < 1) throw new Error('--jobs expects a positive integer or "auto"');
  if (kinds.size === 0) kinds.add('default');
  const bases = cwd === undefined ? [callerDir, ENGINE_ROOT] : [resolve(ENGINE_ROOT, cwd), callerDir];
  return { selection: { paths, kinds, bases }, jobs: jobCount, namePattern };
}

if (import.meta.main) {
  let cli: Cli;
  let files: TestFile[];
  try {
    cli = parseCli(process.argv.slice(2));
    files = selectTestFiles(discoverTestFiles(), cli.selection);
    if (files.length === 0) throw new Error(`no ${[...cli.selection.kinds].join(' or ')} test files found under ${TEST_ROOTS.map((root) => root.cwd).join(', ')}`);
  } catch (error) {
    // A usage mistake gets its message, not a stack trace.
    console.error(`goodvibes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  process.exitCode = await runTests({ files, jobs: cli.jobs, namePattern: cli.namePattern, wholeSuite: cli.selection.paths.length === 0 });
}
