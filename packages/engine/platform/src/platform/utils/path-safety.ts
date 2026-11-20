import { assertCapturedInputPathContext } from '../contract/input-authority.js';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { GoodVibesError } from '@goodvibes/engine/errors';

function pathOutsideRootError(inputPath: string): GoodVibesError {
  return new GoodVibesError(`Path '${inputPath}' is outside the project root`, {
    category: 'contract',
    source: 'runtime',
    recoverable: false,
    operation: 'resolveAndValidatePath',
  });
}

/** True when `rel` (from `relative`) climbs out of its base. A name that merely starts with dots, like `..data`, stays inside. */
function escapesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('..') || isAbsolute(rel);
}

function isInsideRoot(root: string, candidate: string): boolean {
  return !escapesRoot(relative(root, candidate));
}

/** The nearest ancestor that exists on disk. A symbolic link counts as existing even when its target does not. */
function nearestExistingPath(path: string): string {
  let current = path;
  while (!lstatExists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const MAX_LINK_HOPS = 40;

/**
 * Where a write to `path` would really land: the real path of its nearest
 * existing ancestor, following a dangling link to the place it points at,
 * since creating the file through that link creates it there.
 */
export function landingPath(path: string, hops = 0): string {
  const existing = nearestExistingPath(path);
  try {
    return realpathSync(existing, 'utf8');
  } catch (error) {
    if (hops >= MAX_LINK_HOPS) throw error;
    return landingPath(resolve(dirname(existing), readlinkSync(existing)), hops + 1);
  }
}

/**
 * Resolves an input path against the provided project root and validates it is
 * contained within the project root. Throws if the resolved path escapes the
 * root unless the owner has enabled access outside it.
 */
export function resolveAndValidatePath(inputPath: string, projectRoot: string, allowOutsideProject = false): string {
  const root = realpathSync(resolve(projectRoot), 'utf8');
  const resolved = resolve(root, inputPath);
  assertCapturedInputPathContext(resolved);
  const rel = relative(root, resolved);
  if (!allowOutsideProject && escapesRoot(rel)) {
    throw pathOutsideRootError(inputPath);
  }
  const realExistingPath = landingPath(resolved);
  assertCapturedInputPathContext(realExistingPath);
  if (!allowOutsideProject && !isInsideRoot(root, realExistingPath)) {
    throw pathOutsideRootError(inputPath);
  }
  if (existsSync(resolved)) {
    const realTargetPath = realpathSync(resolved, 'utf8');
    assertCapturedInputPathContext(realTargetPath);
    if (!allowOutsideProject && !isInsideRoot(root, realTargetPath)) {
      throw pathOutsideRootError(inputPath);
    }
  }
  return resolved;
}

/**
 * `resolveAndValidatePath` for a path the agent is about to change. The
 * verification journal under `.goodvibes/verification` is the daemon's own record
 * of what was checked; a model that could rewrite it could forge the evidence.
 * Deleting or moving a directory that contains the journals (`.goodvibes`) would
 * destroy them just as well, so those directories are refused too.
 */
export function resolveWritablePath(inputPath: string, projectRoot: string): string {
  const resolved = resolveAndValidatePath(inputPath, projectRoot);
  const journals = resolve(realpathSync(resolve(projectRoot), 'utf8'), '.goodvibes', 'verification');
  for (const candidate of [resolved, landingPath(resolved)]) {
    const insideJournals = !escapesRoot(relative(journals, candidate));
    // The landing path of a path that does not exist is its nearest existing
    // parent, which would wrongly "contain" the journals: only the path itself
    // (or the real path of an existing one) can.
    const containsJournals = existsSync(resolved) && [resolved, realpathSync(resolved, 'utf8')].some(path => !escapesRoot(relative(path, journals)));
    if (insideJournals || containsJournals) {
      throw new GoodVibesError(`Path '${inputPath}' ${insideJournals ? 'is inside' : 'contains'} .goodvibes/verification, which holds the daemon's verification journals and cannot be changed by a tool. Nothing was changed.`, {
        category: 'contract',
        source: 'runtime',
        recoverable: false,
        operation: 'resolveWritablePath',
      });
    }
  }
  return resolved;
}
