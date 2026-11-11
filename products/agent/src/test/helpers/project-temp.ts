import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { trackTempDir } from './temp-registry.ts';
import { RUN_TMP_PREFIX } from '@goodvibes-jev/engine/toolchain/test-runner';

const PROJECT_TMP_PARENT = join(process.cwd(), '.test-tmp');
let projectTmpRoot: {
  readonly path: string;
  readonly parent: string;
  readonly dev: number;
  readonly ino: number;
  readonly parentDev: number;
  readonly parentIno: number;
  readonly parentOwned: boolean;
} | undefined;

// Directories created by makeProjectTempDir since the last sweep (see
// sweepCreatedProjectTempDirs below). Directories created via
// makeLongLivedProjectTempDir are deliberately NEVER pushed here, they go to
// the shared temp registry instead, which is swept once at end of run.
interface CreatedProjectDir {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly uid: number;
  drain?: () => void | Promise<void>;
  closing?: Promise<void>;
}
const _createdDirs: CreatedProjectDir[] = [];

/** One checkout-contained root for this process, shared by creation and final cleanup. */
export function projectTestTmpRoot(): string {
  if (projectTmpRoot === undefined) {
    const parent = PROJECT_TMP_PARENT;
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const parentIdentity = lstatSync(parent);
    if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('Refusing a replaced Agent project test parent');
    const supplied = process.env.GOODVIBES_TEST_PROJECT_TMP_ROOT;
    let root: string;
    if (supplied) {
      root = resolve(supplied);
      const identity = lstatSync(root);
      const owner: unknown = JSON.parse(readFileSync(join(root, '.goodvibes-test-owner.json'), 'utf8'));
      if (dirname(root) !== realpathSync(parent) || !basename(root).startsWith(RUN_TMP_PREFIX)
        || identity.isSymbolicLink() || realpathSync(root) !== root
        || !owner || typeof owner !== 'object' || !('version' in owner) || owner.version !== 1
        || !('pid' in owner) || owner.pid !== process.ppid
        || !('dev' in owner) || owner.dev !== identity.dev || !('ino' in owner) || owner.ino !== identity.ino) {
        throw new Error('Refusing an unowned Agent project test root');
      }
    } else root = mkdtempSync(join(parent, 'gv-agent-project-run-'));
    const identity = lstatSync(root);
    projectTmpRoot = { path: root, parent, dev: identity.dev, ino: identity.ino,
      parentDev: parentIdentity.dev, parentIno: parentIdentity.ino, parentOwned: Boolean(supplied) };
  }
  if (!assertProjectTestTmpCurrent()) throw new Error('The owned Agent project test root no longer exists');
  // The canonical runner supplies this boundary at process start too. Retain
  // it for Git clients that explicitly read the live environment, including
  // raw local test invocations that create their own original project root.
  const ceilings = process.env.GIT_CEILING_DIRECTORIES?.split(delimiter).filter(Boolean) ?? [];
  if (!ceilings.includes(projectTmpRoot.path)) ceilings.push(projectTmpRoot.path);
  process.env.GIT_CEILING_DIRECTORIES = ceilings.join(delimiter);
  return projectTmpRoot.path;
}

/** Cleanup may touch only the originally captured physical root and parent. */
export function assertProjectTestTmpCurrent(): boolean {
  if (!projectTmpRoot) return false;
  const original = projectTmpRoot;
  const parent = lstatSync(original.parent);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== original.parentDev || parent.ino !== original.parentIno
    || realpathSync(original.parent) !== original.parent) throw new Error('Refusing cleanup through a replaced Agent project test parent');
  let current: Stats;
  try { current = lstatSync(original.path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('The owned Agent project test root no longer exists', { cause: error });
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino
    || realpathSync(original.path) !== original.path) throw new Error('Refusing cleanup of a replaced Agent project test root');
  return true;
}

/** The native parent removes its issued root only after complete child drainage. */
export async function sweepProjectTestTmpRoot(): Promise<void> {
  await sweepCreatedProjectTempDirs();
  if (assertProjectTestTmpCurrent() && projectTmpRoot && !projectTmpRoot.parentOwned) rmSync(projectTmpRoot.path, { recursive: true, force: true });
}

function assertCreatedDirCurrent(entry: CreatedProjectDir): void {
  if (!assertProjectTestTmpCurrent()) throw new Error('The owned Agent project test root no longer exists');
  const current = lstatSync(entry.path);
  if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(entry.path) !== entry.path
    || current.dev !== entry.dev || current.ino !== entry.ino || current.birthtimeMs !== entry.birthtimeMs || current.uid !== entry.uid) {
    const identity = {
      path: entry.path,
      expected: { dev: entry.dev, ino: entry.ino, birthtimeMs: entry.birthtimeMs, uid: entry.uid },
      observed: { dev: current.dev, ino: current.ino, birthtimeMs: current.birthtimeMs, uid: current.uid,
        directory: current.isDirectory(), symlink: current.isSymbolicLink() },
    };
    // Bun's aggregate-error renderer omits nested causes in CI. Keep the
    // original custody evidence in the visible refusal as well as its cause.
    throw new Error(`Refusing cleanup of a replaced Agent fixture root: ${JSON.stringify(identity)}`, { cause: identity });
  }
}

function closeCreatedDir(entry: CreatedProjectDir): Promise<void> {
  if (entry.closing) return entry.closing;
  let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
  const closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
  entry.closing = closing;
  // Older fixture callers do not await cleanup. The preload still awaits this
  // exact promise and reports any failure instead of deleting failed evidence.
  void closing.catch(() => {});
  try {
    let originalGuardFailure: unknown;
    try { assertCreatedDirCurrent(entry); } catch (error) { originalGuardFailure = error; }
    // Retired physical custody forbids removal, but does not excuse leaving the
    // original process/admission owner running. Its own cleanup guards remain.
    const drained = entry.drain?.();
    if (drained === closing) throw new Error('An Agent fixture drain cannot await its own cleanup');
    void Promise.resolve(drained).then(() => {
      if (originalGuardFailure) throw originalGuardFailure;
      assertCreatedDirCurrent(entry);
      rmSync(entry.path, { recursive: true, force: true });
      const index = _createdDirs.indexOf(entry);
      if (index !== -1) _createdDirs.splice(index, 1);
    }).then(resolveClose, rejectClose);
  } catch (error) { rejectClose(error); }
  return closing;
}

/** Bind cleanup to an actual newly created root, without registering test hooks.
 * The callback must stop admission synchronously and join its original work.
 * Repeated explicit cleanup and the global sweep share one original promise.
 */
export function registerProjectTempDrain(path: string, drain: () => void | Promise<void>): () => Promise<void> {
  const entry = _createdDirs.find(candidate => candidate.path === path);
  if (!entry || entry.drain || entry.closing) throw new Error('Agent fixture root is not available for drain registration');
  assertCreatedDirCurrent(entry);
  entry.drain = drain;
  return () => closeCreatedDir(entry);
}

/**
 * A temp directory under `<repo>/.test-tmp` rather than the OS temp dir, for
 * tests whose workspace must sit inside this git checkout.
 *
 * Removed after the CURRENTLY RUNNING test finishes, by the global `afterEach`
 * in src/test/helpers/preload.ts (see sweepCreatedProjectTempDirs). Use this
 * for the common case: a directory created fresh per test (or per file) that
 * nothing else needs once that test/file is done, which is true of nearly
 * every call site in this repo.
 *
 * Do NOT use this for a directory meant to be created once and reused across
 * MANY tests or MANY files (a module-level memoized singleton, e.g. a
 * `let cached: string | null; if (cached) return cached;` pattern), the
 * per-test sweep would delete it out from under every later test that still
 * needs it. Use makeLongLivedProjectTempDir for that instead.
 *
 * Cleanup used to be a `process.on('exit', …)` handler, which `bun test` never
 * runs, so nothing was ever removed and a fully green run left every
 * directory behind.
 */
export function makeProjectTempDir(prefix: string): string {
  const dir = mkdtempSync(join(projectTestTmpRoot(), `${prefix}-`));
  const owner = lstatSync(dir);
  _createdDirs.push({ path: dir, dev: owner.dev, ino: owner.ino, birthtimeMs: owner.birthtimeMs, uid: owner.uid });
  return dir;
}

/**
 * Same as makeProjectTempDir, but for a directory deliberately meant to
 * outlive any single test, a module-level singleton created once (guarded
 * by the caller's own `if (cached) return cached`) and reused across many
 * tests, possibly across many test files sharing this cached module (e.g.
 * src/test/helpers/runtime-services.ts's getTestRoots()).
 *
 * Never swept by sweepCreatedProjectTempDirs, which would delete it out from
 * under every later test. Removal is registered with the shared temp registry
 * instead, which the test preload sweeps from a top-level `afterAll`, the one
 * hook bun actually runs, once, after the last test file, pass or fail.
 */
export function makeLongLivedProjectTempDir(prefix: string): string {
  return trackTempDir(mkdtempSync(join(projectTestTmpRoot(), `${prefix}-`)));
}

/**
 * Removes every directory created by makeProjectTempDir since the last call
 * to this function, then clears the tracking list.
 *
 * Wired to a single global `afterEach`, registered ONCE at the top level of
 * src/test/helpers/preload.ts (which runs before any test file is
 * registered, at Bun's preload phase), confirmed empirically that a hook
 * registered there fires after EVERY test in EVERY file, in this order:
 * a test file's own locally-registered afterEach hooks fire first
 * (inner-to-outer), and this global one fires last of all. That ordering is
 * exactly what makes this safe: by the time this runs for a given test, any
 * file-local cleanup logic that still needed the directory (writing a final
 * fixture, asserting on it, etc.) has already run.
 *
 * This is NOT registered lazily inside makeProjectTempDir itself, an
 * earlier version of this fix tried exactly that with `afterAll` and broke
 * a real test file (src/test/input/model-picker.test.ts, whose outer
 * describe's beforeEach calls makeProjectTempDir fresh for every one of its
 * ~115 tests): registering a lifecycle hook dynamically from deep inside an
 * already-executing beforeEach, many times over, across nested describes,
 * does not reliably scope to "this test" or "this file" the way registering
 * a single hook once, at module load time before any test runs, does.
 * Exporting one sweep function and calling it from exactly one place (the
 * preload's afterEach) avoids that whole class of bug.
 */
export async function sweepCreatedProjectTempDirs(): Promise<void> {
  const failures: unknown[] = [];
  const results = await Promise.allSettled([..._createdDirs].map(async entry => {
    if (entry.drain || entry.closing) return closeCreatedDir(entry);
    // Existing simple roots have no accepted async owner. Keep their original
    // best-effort cleanup while registered roots require proven complete drain.
    try { assertCreatedDirCurrent(entry); rmSync(entry.path, { recursive: true, force: true }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const index = _createdDirs.indexOf(entry);
    if (index !== -1) _createdDirs.splice(index, 1);
    return Promise.resolve();
  }));
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, 'Agent fixture cleanup did not complete; original roots were preserved');
}
