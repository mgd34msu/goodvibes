/**
 * One spelling for one file: the real path of its directory (symlinks
 * resolved, `..` and relative parts gone) plus its name. Two spellings of the
 * same project folder give the same string, so a path used as an identity (a
 * session's saved file) compares equal however it was reached.
 *
 * The directory need not exist yet: the nearest existing ancestor is resolved
 * and the missing part appended as written. Each directory is resolved once
 * per process and remembered (a bounded map), so comparing paths later costs a
 * map lookup and no file system call.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_REMEMBERED = 256;
const remembered = new Map<string, string>();

function remember(key: string, value: string): string {
  if (remembered.size >= MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  remembered.set(key, value);
  return value;
}

/** The real path of `dir`, resolving its nearest existing ancestor when it does not exist yet. */
export function canonicalDirectory(dir: string): string {
  const absolute = resolve(dir);
  const known = remembered.get(absolute);
  if (known !== undefined) return known;
  const missing: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      const real = realpathSync.native(existing);
      return remember(absolute, missing.length > 0 ? join(real, ...missing.reverse()) : real);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return remember(absolute, absolute);
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** `path` with its directory in canonical form ({@link canonicalDirectory}); the file itself need not exist. */
export function canonicalFilePath(path: string): string {
  return join(canonicalDirectory(dirname(path)), basename(path));
}
