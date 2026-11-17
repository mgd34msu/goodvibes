import { lstatSync, type Stats } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import { executeFileOperations } from './file-ops.js';
import type { ExecFileOp } from './schema.js';
import { CapturedBoundaryRefusal } from './captured-exec-refusal.js';

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * Run the existing file-operation implementation in a member's own captured
 * view (its worktree, written in place like any captured command's writes).
 * Every path an operation touches, each directory on the way included, passes
 * the owner's read authority once per call; reserved directories, links and
 * special files are refused with the path named.
 */
export async function executeCapturedFileOperations(
  capturedRoot: string,
  fileOps: ExecFileOp[] | undefined,
  authorize: (path: string) => Promise<string>,
  /** Called just before an operation that changes files is applied (its paths passed). */
  onApply?: () => void,
): ReturnType<typeof executeFileOperations> {
  if (!fileOps?.length) return { fileOpResults: [] };
  // Snapshot caller-owned operations before any asynchronous boundary.
  fileOps = structuredClone(fileOps);
  const root = resolve(capturedRoot);
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
  const operations = fileOps.map((op) => ({
    ...op,
    source: logicalPath(op.source),
    ...(op.destination !== undefined ? { destination: logicalPath(op.destination) } : {}),
  }));
  const authorized = new Set<string>();
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
    const rel = relative(root, logicalPath(path));
    let current = '';
    let stat: Stats | undefined;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      const logical = join(root, current);
      if (!authorized.has(logical)) {
        if (await authorize(logical) !== logical)
          throw new CapturedBoundaryRefusal('authority', current, `authorization redirected ${current}`);
        authorized.add(logical);
      }
      stat = inspectPath(logical, current);
      if (current !== rel && stat && !stat.isDirectory())
        throw new CapturedBoundaryRefusal('conflict', current, `${current} is a file, so it cannot hold ${rel}`);
    }
    return stat;
  };
  // A moved or copied tree is checked entry by entry, with its destination.
  const checkTree = async (path: string, destination?: string): Promise<void> => {
    const stat = await checkPath(path);
    if (destination !== undefined) await checkPath(destination);
    if (!stat?.isDirectory() || destination === undefined) return;
    for (const entry of await readdir(path)) await checkTree(join(path, entry), join(destination, entry));
  };
  return executeFileOperations(operations, root, {
    beforeOperation: async (op) => {
      await checkTree(op.source, op.op === 'delete' ? undefined : op.destination);
      if (!(op.op === 'delete' && op.dry_run)) onApply?.();
    },
    beforeImportUpdates: async () => {},
    // The import rewrite reads and changes only files the owner lets this run read.
    importFile: async (path) => {
      if (!within(root, path) || relative(root, path).split(sep).some((part) =>
        CONTRACT_INPUT_EXCLUSIONS.includes(part as typeof CONTRACT_INPUT_EXCLUSIONS[number]))) return false;
      try { return await authorize(path) === path; } catch { return false; }
    },
  });
}
