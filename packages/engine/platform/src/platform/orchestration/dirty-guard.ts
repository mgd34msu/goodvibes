/**
 * Owner-residue protection for scoped commits. The paths that were uncommitted
 * when work started, and what each held, are recorded as git object ids
 * (dirty-file-observation.ts): one `git status` and one `git hash-object`,
 * run as child processes, with no file bytes kept. A later commit compares
 * the ids of its candidate paths with the recorded ones and leaves out the
 * paths the work did not change.
 *
 * A capture is started at once and read when first needed; captures of one
 * root that overlap share one run, so an engine and the contract it serves
 * take one capture between them.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dirtyPathIds, dirtyPathIdsSync, sameDirtyPathId, type DirtyPathId } from './dirty-file-observation.js';

const INTERNAL_STATE_PREFIX = '.goodvibes/';

/** What `git status` listed as uncommitted, and the id of each such path then. */
export interface DirtyTreeIds {
  /** False outside a git repository: nothing is known, so nothing may be excluded or committed on its strength. */
  readonly available: boolean;
  readonly ids: ReadonlyMap<string, DirtyPathId>;
}

/** The uncommitted tree as it was when an engine launched; `ready` settles once its ids are read. */
export interface DirtyLaunchSnapshot {
  readonly root: string;
  readonly ready: Promise<DirtyTreeIds>;
  /** The ids once `ready` settled (at once outside a repository), so a caller need not wait again. */
  readonly current: DirtyTreeIds | undefined;
}

/**
 * Parse `git status --porcelain -z --untracked-files=all` output into a set of
 * paths. `-z` emits paths verbatim (the default porcelain C-quotes non-ASCII
 * names, which would never match the raw paths commits receive). Each record
 * is `XY<space><path>`; a rename or copy is followed by a second field (the
 * origin), which is consumed so it is not read as its own record.
 */
function parsePorcelainPaths(output: string): Set<string> {
  const paths = new Set<string>();
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') i++;
    const path = record.slice(3);
    if (path.startsWith(INTERNAL_STATE_PREFIX)) continue;
    paths.add(path);
  }
  return paths;
}

const STATUS_ARGS = ['status', '--porcelain', '-z', '--untracked-files=all'] as const;
const NOT_A_REPOSITORY = /not a git repository/;

function readStatus(cwd: string, code: number, stdout: Uint8Array, stderr: Uint8Array): { readonly paths: readonly string[]; readonly available: boolean } {
  if (code !== 0) {
    // Ordinary non-Git work remains supported, but this observation cannot
    // authorize an automatic scoped commit if a repository appears later.
    if (NOT_A_REPOSITORY.test(new TextDecoder().decode(stderr))) return { paths: [], available: false };
    throw new Error(`The uncommitted files of ${cwd} could not be listed (git status failed)`);
  }
  return { paths: [...parsePorcelainPaths(new TextDecoder('utf-8', { fatal: true }).decode(stdout))], available: true };
}

/** The uncommitted paths under `cwd`, from one `git status` run as a child process. */
export async function readDirtyTreePaths(cwd: string): Promise<{ readonly paths: readonly string[]; readonly available: boolean }> {
  if (!mayBeGitRepository(resolve(cwd))) return { paths: [], available: false };
  const proc = Bun.spawn(['git', '-C', cwd, ...STATUS_ARGS], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).arrayBuffer()]);
  return readStatus(cwd, code, new Uint8Array(stdout), new Uint8Array(stderr));
}

/** The same list, synchronously; kept for callers outside a running engine. */
export function listDirtyTreePaths(cwd: string): readonly string[] {
  const result = Bun.spawnSync(['git', '-C', cwd, ...STATUS_ARGS], { env: { ...process.env, LC_ALL: 'C' } });
  return readStatus(cwd, result.exitCode, result.stdout, result.stderr).paths;
}

/**
 * Whether `root` can be inside a git repository: a `.git` in it or in an
 * ancestor, or a GIT_DIR naming one. A few `stat` calls, so work outside any
 * repository settles at once instead of waiting on a git process to say so.
 */
function mayBeGitRepository(root: string): boolean {
  if (process.env['GIT_DIR'] !== undefined) return true;
  for (let current = root; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}

/** Captures of one root still running, so overlapping callers share one. */
const inflight = new Map<string, Promise<DirtyTreeIds>>();

/** The uncommitted paths of `cwd` and their ids now. Callers that overlap on one root share the run. */
export function captureDirtyTreeIds(cwd: string): Promise<DirtyTreeIds> {
  const root = resolve(cwd);
  if (!mayBeGitRepository(root)) return Promise.resolve({ available: false, ids: new Map() });
  const running = inflight.get(root);
  if (running !== undefined) return running;
  const capture = (async (): Promise<DirtyTreeIds> => {
    const listed = await readDirtyTreePaths(root);
    if (!listed.available) return { available: false, ids: new Map() };
    return { available: true, ids: await dirtyPathIds(root, listed.paths) };
  })();
  inflight.set(root, capture);
  const done = () => { if (inflight.get(root) === capture) inflight.delete(root); };
  capture.then(done, done);
  return capture;
}

/** The same capture, synchronously, for a caller that cannot wait. */
export function captureDirtyTreeIdsSync(cwd: string): DirtyTreeIds {
  const root = resolve(cwd);
  const result = Bun.spawnSync(['git', '-C', root, ...STATUS_ARGS], { env: { ...process.env, LC_ALL: 'C' } });
  const listed = readStatus(root, result.exitCode, result.stdout, result.stderr);
  return listed.available ? { available: true, ids: dirtyPathIdsSync(root, listed.paths) } : { available: false, ids: new Map() };
}

/**
 * Starts the launch capture and returns at once; nothing blocks the process.
 * A phase reads `ready` before its agent starts, so the capture always
 * precedes the work it is compared with.
 */
export function snapshotDirtyTree(cwd: string): DirtyLaunchSnapshot {
  const root = resolve(cwd);
  if (!mayBeGitRepository(root)) {
    const unavailable: DirtyTreeIds = { available: false, ids: new Map() };
    return { root, ready: Promise.resolve(unavailable), current: unavailable };
  }
  const snapshot: { root: string; ready: Promise<DirtyTreeIds>; current: DirtyTreeIds | undefined } = { root, ready: Promise.resolve({ available: false, ids: new Map() }), current: undefined };
  snapshot.ready = captureDirtyTreeIds(root)
    .catch((): DirtyTreeIds => ({ available: false, ids: new Map() }))
    .then((ids) => { snapshot.current = ids; return ids; });
  return snapshot;
}

/** @deprecated The launch snapshot holds object ids now; nothing produces this shape. Kept for the package index. */
export interface DirtyPathState { readonly kind: 'file' | 'symlink' | 'missing' | 'unavailable' }

export interface ScopedCommitExclusion {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
  /** Paths whose launch or current content cannot be named; preserved, never swept into work. */
  readonly uncertain: readonly string[];
}

/**
 * Splits candidate paths into the work's changes (included) and launch
 * residue the work left as it was (excluded). A path that was clean at launch
 * is the work's. One `hash-object` run covers every launch-dirty candidate.
 */
export async function excludeUntouchedLaunchResidue(cwd: string, candidatePaths: readonly string[], launchSnapshot: DirtyLaunchSnapshot): Promise<ScopedCommitExclusion> {
  if (launchSnapshot.root !== resolve(cwd)) throw new Error('The launch snapshot belongs to another working tree');
  const launch = await launchSnapshot.ready;
  if (!launch.available) throw new Error('The uncommitted files at launch could not be listed; owner edits remain uncommitted');
  const residue = candidatePaths.filter((path) => launch.ids.has(path));
  const now = await dirtyPathIds(cwd, residue);
  const included: string[] = [], excluded: string[] = [], uncertain: string[] = [];
  for (const path of candidatePaths) {
    if (!launch.ids.has(path)) { included.push(path); continue; }
    const same = sameDirtyPathId(launch.ids.get(path), now.get(path));
    if (same === false) included.push(path);
    else { excluded.push(path); if (same === undefined) uncertain.push(path); }
  }
  return { included, excluded, uncertain };
}
