/** Local source observations for optional calibration attribution. These are
 * native file versions, not portable content IDs, signatures or authority. No
 * source contents or secret values belong in the serialized report. */
import { execFileSync } from 'node:child_process';
import { lstatSync, statSync, type BigIntStats } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface ProjectSourceFileObservation {
  readonly path: string;
  /** Null records an absent tracked file, rather than omitting it. */
  readonly entry: string | null;
  /** Follow a source symlink too: its target can change without editing the link. */
  readonly target?: string | null;
}
export interface ProjectSourceObservation {
  readonly version: 2;
  readonly sha: string;
  readonly trackedChanges: string;
  readonly files: readonly ProjectSourceFileObservation[];
}

function git(root: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('Project source observation could not read Git state');
  }
}
function absent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink,
    stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}
function readFileVersion(root: string, path: string): ProjectSourceFileObservation {
  const absolute = resolve(root, path), local = relative(root, absolute);
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Project source path is outside the repository');
  try {
    const selected = lstatSync(absolute, { bigint: true });
    if (!selected.isFile() && !selected.isSymbolicLink()) throw new Error('Project source is not a file');
    const entry = stamp(selected);
    let target: string | null | undefined;
    if (selected.isSymbolicLink()) {
      try {
        const actual = statSync(absolute, { bigint: true });
        if (!actual.isFile()) throw new Error('Project source link target is not a file');
        target = stamp(actual);
      }
      catch (error) { if (!absent(error)) throw error; target = null; }
      if (stamp(lstatSync(absolute, { bigint: true })) !== entry) throw new Error('Project source link changed while observing');
    }
    return Object.freeze({ path, entry, ...(target === undefined ? {} : { target }) });
  } catch (error) {
    if (absent(error)) return Object.freeze({ path, entry: null });
    throw error;
  }
}

/** Observe the actual selected working tree before and after a run. Changes
 * and replacements remain changes even if bytes/mtime are later restored.
 * This does not archive dirty source or certify a snapshot throughout an
 * interval; the report retains the commit and observed local file versions. */
export function observeProjectSource(root: string, paths: readonly string[], extraFiles: readonly string[] = []): ProjectSourceObservation {
  root = resolve(root);
  const head = (): string => git(root, 'rev-parse', 'HEAD').trim();
  const changes = (): string => git(root, 'status', '--porcelain=v1', '--untracked-files=no').trim();
  const listing = (): string[] => [...new Set([
    ...git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths).split('\0').filter(Boolean),
    ...extraFiles,
  ])].sort();
  const sha = head(), trackedChanges = changes(), names = listing();
  const files = names.map(path => readFileVersion(root, path));
  if (head() !== sha || changes() !== trackedChanges || !isDeepStrictEqual(names, listing())) {
    throw new Error('Project source changed while observing');
  }
  return Object.freeze({ version: 2, sha, trackedChanges, files: Object.freeze(files) });
}

/** Native observations compare directly; no repository/content digest. */
export function sameProjectSource(before: ProjectSourceObservation, after: ProjectSourceObservation): boolean {
  return isDeepStrictEqual(before, after);
}
