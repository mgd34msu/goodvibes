/** Owner-residue protection for scoped commits. Original bytes stay private to
 * the actual launch snapshot; public values describe states, never content. */
import { resolve } from 'node:path';
import { captureDirtyFile, captureDirtyTreeRoot, equalDirtyFiles, type CapturedDirtyFile, type DirtyTreeRoot } from './dirty-file-observation.js';

const INTERNAL_STATE_PREFIX = '.goodvibes/';
export interface DirtyPathState { readonly kind: CapturedDirtyFile['kind'] }
export type DirtyLaunchSnapshot = ReadonlyMap<string, DirtyPathState>;
interface NativeSnapshot { readonly root: string; readonly selection: DirtyTreeRoot | undefined; readonly entries: ReadonlyMap<string, CapturedDirtyFile>; readonly available: boolean; readonly latest: Map<string, CapturedDirtyFile> }
const snapshots = new WeakMap<DirtyLaunchSnapshot, NativeSnapshot>();

/**
 * Parse `git status --porcelain -z --untracked-files=all` output into a set of
 * paths. The `-z` (NUL-terminated) format is used deliberately because it emits
 * paths VERBATIM: git's default porcelain C-quotes any path containing
 * non-ASCII or special bytes (core.quotePath defaults to true), rendering
 * `café.txt` as `"caf\303\251.txt"`. Keying the launch snapshot on that quoted
 * string while scoped commits and evidence readers receive the
 * RAW path would silently bypass exclusion (residue leaks into scoped commits)
 * and make the original read select the wrong (nonexistent, quoted) filename. With
 * `-z` there is no quoting, so snapshot keys match the raw paths used
 * everywhere else.
 *
 * Record shape: each NUL-terminated record is `XY<space><path>`. A rename or
 * copy (X or Y is 'R'/'C') is split across TWO NUL-terminated fields, the
 * destination first, then the origin. We keep the destination (the actual
 * scoped-commit candidate, already in this record) and consume the following
 * origin field so it is never mis-parsed as its own dirty path.
 */
function parsePorcelainPaths(output: string): Set<string> {
  const paths = new Set<string>();
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    // Skips the trailing empty field left by the final NUL, plus any record too
    // short to hold a 2-char status pair + separator + a 1-char path.
    if (record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    // A rename/copy record is followed by a second NUL-separated field (the
    // origin path). Consume it so the next iteration does not treat it as a
    // standalone status record, done before any early-continue below.
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') i++;
    const path = record.slice(3);
    if (path.startsWith(INTERNAL_STATE_PREFIX)) continue;
    paths.add(path);
  }
  return paths;
}

/** Enumerate only. Phase checks that need paths do not read file content. A
 * failed status/ambiguous path cannot silently disable owner-residue protection. */
function dirtyPaths(cwd: string, selection = captureDirtyTreeRoot(cwd)): { readonly paths: readonly string[]; readonly available: boolean } {
  selection.assertCurrent();
  const result = Bun.spawnSync(['git', '-C', selection.resolvedPath, 'status', '--porcelain', '-z', '--untracked-files=all'], { env: { ...process.env, LC_ALL: 'C' } });
  selection.assertCurrent();
  if (result.exitCode !== 0) {
    const error = new TextDecoder('utf-8', { fatal: true }).decode(result.stderr);
    // Ordinary non-Git work remains supported, but this observation cannot
    // authorize an automatic scoped commit if a repository appears later.
    if (error.trim() === 'fatal: not a git repository (or any of the parent directories): .git') return { paths: [], available: false };
    throw new Error('Could not enumerate the original dirty working tree');
  }
  const output = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  return { paths: [...parsePorcelainPaths(output)], available: true };
}
export function listDirtyTreePaths(cwd: string): readonly string[] { return dirtyPaths(cwd).paths; }
/** Snapshot once, synchronously before an engine can launch its first phase.
 * No SHA is required for local exact equality; no bytes are put on this map. */
export function snapshotDirtyTree(cwd: string): DirtyLaunchSnapshot {
  let available = true, selection: DirtyTreeRoot | undefined, entries: ReadonlyMap<string, CapturedDirtyFile>;
  try {
    selection = captureDirtyTreeRoot(cwd); const selected = dirtyPaths(cwd, selection); available = selected.available;
    entries = new Map(selected.paths.map(path => [path, captureDirtyFile(cwd, path, selection)] as const)); selection.assertCurrent();
  }
  catch { available = false; entries = new Map(); }
  const snapshot = new Map([...entries].map(([path, value]) => [path, Object.freeze({ kind: value.kind })] as const));
  snapshots.set(snapshot, { root: resolve(cwd), selection, entries, available, latest: new Map(entries) }); return snapshot;
}
/** Internal native baseline seam. Only an original snapshot of this root can
 * supply its own captures; copied maps or JSON cannot mint byte provenance. */
export function nativeDirtySnapshotEntries(snapshot: DirtyLaunchSnapshot, cwd: string): ReadonlyMap<string, CapturedDirtyFile> {
  const original = snapshots.get(snapshot);
  if (!original || !original.available || !original.selection || original.root !== resolve(cwd)) throw new Error('Original dirty snapshot is unavailable');
  original.selection.assertCurrent(); return original.entries;
}
/** The same original root selection used by a native baseline capture. */
export function nativeDirtySnapshotRoot(snapshot: DirtyLaunchSnapshot, cwd: string): DirtyTreeRoot {
  const original = snapshots.get(snapshot), selected = original?.selection;
  if (!selected || original?.root !== resolve(cwd)) throw new Error('Original dirty snapshot root is unavailable');
  selected.assertCurrent(); return selected;
}
export interface ScopedCommitExclusion {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
  /** Unavailable original/current reads are preserved, never swept into work. */
  readonly uncertain: readonly string[];
}
function currentDirtyFile(owner: NativeSnapshot, cwd: string, path: string): CapturedDirtyFile {
  const previous = owner.latest.get(path);
  if (previous && previous.kind !== 'unavailable') {
    try { previous.assertCurrent(); return previous; }
    catch { /* Observe the actual new version; keep the original comparison bytes. */ }
  }
  const file = captureDirtyFile(cwd, path, owner.selection); owner.latest.set(path, file); return file;
}
export function excludeUntouchedLaunchResidue(cwd: string, candidatePaths: readonly string[], launchSnapshot: DirtyLaunchSnapshot): ScopedCommitExclusion {
  const original = nativeDirtySnapshotEntries(launchSnapshot, cwd), owner = snapshots.get(launchSnapshot);
  if (!owner) throw new Error('Original dirty snapshot is unavailable');
  const included: string[] = [], excluded: string[] = [], uncertain: string[] = [];
  for (const path of candidatePaths) {
    const initial = original.get(path);
    if (initial === undefined) { included.push(path); continue; }
    const equal = equalDirtyFiles(initial, currentDirtyFile(owner, cwd, path));
    if (equal === false) included.push(path);
    else { excluded.push(path); if (equal === undefined) uncertain.push(path); }
  }
  return { included, excluded, uncertain };
}
