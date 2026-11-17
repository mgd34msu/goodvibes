import { statSync } from 'node:fs';

/**
 * A status list a store changed while it was being read is not published: the
 * caller reads it again. The message names the store and that next step.
 */
export class SecurityReadSourceRetiredError extends Error {
  constructor(store = 'source') {
    super(`The ${store} changed while it was being read; read it again.`);
    this.name = 'SecurityReadSourceRetiredError';
  }
}

export function assertSecurityReadSource(current: boolean, store?: string): asserts current {
  if (!current) throw new SecurityReadSourceRetiredError(store);
}

/**
 * A check that a store has not changed since a read began: the store's own
 * revision (it moves on every change the store makes) compared as an integer,
 * plus anything else the store says must still hold. No reads, no walks.
 */
export function captureRevisionReadSource(store: string, revision: () => number, usable: () => boolean = () => true): () => void {
  assertSecurityReadSource(usable(), store);
  const captured = revision();
  return () => assertSecurityReadSource(usable() && revision() === captured, store);
}

/**
 * The identity of a file another process may rewrite (device, inode, size,
 * change times; 'absent' when it does not exist): one `stat`, no read. For a
 * store with no watch of its own, a check compares these.
 */
export function fileIdentity(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'absent';
    return `unreadable:${error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error'}`;
  }
}

/** A check that each file keeps the identity it had when the read began. */
export function captureFileIdentities(store: string, paths: readonly string[]): () => void {
  const captured = paths.map(fileIdentity);
  return () => assertSecurityReadSource(paths.every((path, index) => fileIdentity(path) === captured[index]), store);
}
