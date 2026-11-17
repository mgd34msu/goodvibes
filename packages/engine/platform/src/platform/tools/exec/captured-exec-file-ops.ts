import { lstatSync, type Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import { executeFileOperations } from './file-ops.js';
import type { ExecFileOp } from './schema.js';
import { CapturedBoundaryRefusal } from './captured-exec-refusal.js';

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Run the existing file-operation implementation only inside a disposable
 * projection. Authorization always receives logical captured paths, never the
 * temporary aliases. The caller owns initial projection and final apply-back
 * authorization; boundary failures here must discard the projection.
 *
 * `admitted` holds the logical paths the caller already authorized while it
 * built the projection (every copied file and directory). A path in it is not
 * authorized again; any other path an operation touches (a new destination)
 * is authorized once per call. The projection's contents were admitted on the
 * way in and are compared again at publication, so nothing here re-walks it.
 */
export async function executeCapturedFileOperations(
  capturedRoot: string,
  projectionDirectory: string,
  fileOps: ExecFileOp[] | undefined,
  authorize: (path: string) => Promise<string>,
  admitted: ReadonlySet<string> = new Set(),
): ReturnType<typeof executeFileOperations> {
  if (!fileOps?.length) return { fileOpResults: [] };
  // Snapshot caller-owned operations before any asynchronous boundary.
  fileOps = structuredClone(fileOps);
  const root = resolve(capturedRoot);
  const projection = resolve(projectionDirectory);
  if (within(root, projection) || within(projection, root))
    throw new CapturedBoundaryRefusal('authority', projection, 'file operations need a separate disposable projection of the project');
  const initial = await lstat(projection);
  if (!initial.isDirectory() || initial.isSymbolicLink() || await realpath(projection) !== projection)
    throw new CapturedBoundaryRefusal('authority', projection, 'the file operation projection was redirected');

  const logicalPath = (path: string): string => {
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!rel || !within(root, absolute))
      throw new CapturedBoundaryRefusal('authority', path, `the file operation path ${path} is outside the project`);
    const reserved = rel.split(sep).find((part) =>
      CONTRACT_INPUT_EXCLUSIONS.includes(part as typeof CONTRACT_INPUT_EXCLUSIONS[number]));
    if (reserved !== undefined)
      throw new CapturedBoundaryRefusal('reserved', rel, `the file operation path ${rel} is inside the reserved directory ${reserved}`);
    return absolute;
  };
  const projectPath = (path: string): string => join(projection, relative(root, logicalPath(path)));
  const projected = fileOps.map((op) => ({
    ...op,
    source: projectPath(op.source),
    ...(op.destination !== undefined ? { destination: projectPath(op.destination) } : {}),
  }));
  // The one structural guard: the projection directory is still the one this call checked.
  const assertProjection = async (): Promise<void> => {
    const stat = await lstat(projection);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== initial.dev || stat.ino !== initial.ino ||
      await realpath(projection) !== projection)
      throw new CapturedBoundaryRefusal('authority', projection, 'the file operation projection changed during the operation');
  };
  const authorized = new Set<string>(admitted);
  const inspectPath = (path: string, rel: string): Stats | undefined => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1))
        throw new CapturedBoundaryRefusal('alias', rel, `${rel} is a link or special file; captured file operations work on regular files and directories only`);
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
  };
  const checkPath = async (path: string): Promise<Stats | undefined> => {
    if (!within(projection, path) || path === projection)
      throw new CapturedBoundaryRefusal('authority', path, 'a file operation path escaped the projection');
    const rel = relative(projection, path);
    let current = '';
    let stat: Stats | undefined;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      const logical = logicalPath(join(root, current));
      if (!authorized.has(logical)) {
        if (await authorize(logical) !== logical)
          throw new CapturedBoundaryRefusal('authority', current, `authorization redirected ${current}`);
        authorized.add(logical);
      }
      stat = inspectPath(join(projection, current), current);
      if (current !== rel && stat && !stat.isDirectory())
        throw new CapturedBoundaryRefusal('conflict', current, `${current} is a file, so it cannot hold ${rel}`);
    }
    return stat;
  };
  // A source tree was admitted entry by entry when the projection was built;
  // only the destination of each entry can be new.
  const checkTree = async (path: string, destination?: string): Promise<void> => {
    const stat = await checkPath(path);
    if (destination !== undefined) await checkPath(destination);
    if (!stat?.isDirectory() || destination === undefined) return;
    for (const entry of await readdir(path)) await checkTree(join(path, entry), join(destination, entry));
  };
  const result = await executeFileOperations(projected, projection, {
    beforeOperation: async (op) => {
      await assertProjection();
      await checkTree(op.source, op.op === 'delete' ? undefined : op.destination);
      await assertProjection();
    },
    // Import rewriting scans the projection after the moves; its files were
    // admitted on the way in or as a destination above.
    beforeImportUpdates: assertProjection,
  });
  const restore = (value: string): string => value.replaceAll(projection, root);
  return {
    fileOpResults: result.fileOpResults.map((op) => ({
      ...op,
      source: restore(op.source),
      ...(op.destination !== undefined ? { destination: restore(op.destination) } : {}),
      ...(op.would_delete !== undefined ? { would_delete: op.would_delete.map(restore) } : {}),
      ...(op.updated_imports !== undefined ? { updated_imports: op.updated_imports.map(restore) } : {}),
      ...(op.warnings !== undefined ? { warnings: op.warnings.map(restore) } : {}),
    })),
    ...(result.fileOpError !== undefined ? { fileOpError: restore(result.fileOpError) } : {}),
    ...(result.fileOpFailedIndex !== undefined ? { fileOpFailedIndex: result.fileOpFailedIndex } : {}),
    ...(result.fileOpWarnings !== undefined ? { fileOpWarnings: result.fileOpWarnings.map(restore) } : {}),
  };
}
