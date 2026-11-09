/** Native local dirty-file reads. No content hash, pathname-keyed byte cache or
 * following a dirty symlink into another file. Callers retain only their own
 * original observations for the lifetime of the launch/baseline owner. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type CapturedDirtyFile =
  | { readonly kind: 'file' | 'symlink'; readonly root: string; readonly bytes: Buffer; readonly executable: boolean; readonly revision: string; readonly assertCurrent: () => void }
  | { readonly kind: 'missing'; readonly root: string; readonly revision: string; readonly assertCurrent: () => void }
  | { readonly kind: 'unavailable'; readonly revision: null };
const facts = (value: BigIntStats): string => [value.dev, value.ino, value.mode, value.uid, value.gid,
  value.nlink, value.size, value.mtimeNs, value.ctimeNs, value.birthtimeNs].join(':');
function directory(path: string): string | null {
  try {
    const value = lstatSync(path, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('Dirty snapshot parent is not an ordinary directory');
    return [value.dev, value.ino, value.mode, value.uid, value.gid, value.birthtimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function leaf(path: string): BigIntStats | null {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function selectedPath(cwd: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split('/').some(part => part === '' || part === '.' || part === '..' || part === '.git' || part === '.goodvibes'))
    throw new Error('Dirty snapshot path is not an ordinary project path');
  return join(resolve(cwd), path);
}
/** Original lexical selection plus its actual physical directory tree. Root
 * aliases such as Darwin /tmp -> /private/tmp are supported, but neither later
 * retargets nor a copied token can select a different root after an await. */
export interface DirtyTreeRoot { readonly path: string; readonly resolvedPath: string; assertCurrent(): void }
const nativeRoots = new WeakSet<DirtyTreeRoot>();
function rootSlot(path: string): string {
  const value = lstatSync(path, { bigint: true });
  if (value.isSymbolicLink()) return 'link:' + facts(value) + ':' + readlinkSync(path, { encoding: 'buffer' }).toString('base64');
  if (!value.isDirectory()) throw new Error('Dirty snapshot root path is not a directory');
  return 'directory:' + [value.dev, value.ino, value.mode, value.uid, value.gid, value.birthtimeNs].join(':');
}
export function captureDirtyTreeRoot(cwd: string): DirtyTreeRoot {
  const path = resolve(cwd), resolvedPath = realpathSync(path), lexical: Array<{ readonly path: string; readonly value: string }> = [];
  for (let current = path;; current = dirname(current)) {
    lexical.push({ path: current, value: rootSlot(current) }); if (current === dirname(current)) break;
  }
  const physical: Array<{ readonly path: string; readonly value: string }> = [];
  for (let current = resolvedPath;; current = dirname(current)) {
    const value = directory(current); if (value === null) throw new Error('Dirty snapshot physical root is unavailable');
    physical.push({ path: current, value }); if (current === dirname(current)) break;
  }
  const assertCurrent = () => {
    for (const entry of lexical) if (rootSlot(entry.path) !== entry.value) throw new Error('Dirty snapshot root alias changed');
    if (realpathSync(path) !== resolvedPath) throw new Error('Dirty snapshot root target changed');
    for (const entry of physical) if (directory(entry.path) !== entry.value) throw new Error('Dirty snapshot physical root changed');
  };
  assertCurrent(); const selected = Object.freeze({ path, resolvedPath, assertCurrent }); nativeRoots.add(selected); return selected;
}
/** A synchronous detached source read, or explicit unavailable. A read failure
 * cannot become the missing-file state used for a real working-tree deletion. */
export function captureDirtyFile(cwd: string, path: string, selectedRoot?: DirtyTreeRoot): CapturedDirtyFile {
  try {
    const root = selectedRoot ?? captureDirtyTreeRoot(cwd);
    if (!nativeRoots.has(root) || root.path !== resolve(cwd)) throw new Error('Original dirty snapshot root is unavailable');
    root.assertCurrent();
    const absolute = selectedPath(root.resolvedPath, path), parents: Array<{ readonly path: string; readonly original: string | null }> = [];
    for (let current = dirname(absolute); current !== root.resolvedPath; current = dirname(current)) {
      parents.push({ path: current, original: directory(current) });
    }
    const before = leaf(absolute), original = before === null ? null : facts(before);
    const assertCurrent = () => {
      root.assertCurrent();
      for (const parent of parents) if (directory(parent.path) !== parent.original) throw new Error('Dirty snapshot parent changed');
      const current = leaf(absolute);
      if ((current === null ? null : facts(current)) !== original) throw new Error('Dirty snapshot file changed');
      root.assertCurrent();
    };
    assertCurrent();
    const revision = JSON.stringify([parents.map(parent => [parent.path, parent.original]), original]);
    if (before === null) return Object.freeze({ kind: 'missing', root: resolve(cwd), revision, assertCurrent });
    if (before.isSymbolicLink()) {
      const bytes = readlinkSync(absolute, { encoding: 'buffer' }); assertCurrent();
      return Object.freeze({ kind: 'symlink', root: resolve(cwd), bytes, executable: false, revision, assertCurrent });
    }
    if (!before.isFile()) return Object.freeze({ kind: 'unavailable', revision: null });
    const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      assertCurrent(); if (facts(fstatSync(descriptor, { bigint: true })) !== original) throw new Error('Dirty snapshot descriptor changed');
      const bytes = readFileSync(descriptor);
      if (BigInt(bytes.length) !== before.size || facts(fstatSync(descriptor, { bigint: true })) !== original) throw new Error('Dirty snapshot bytes changed');
      assertCurrent(); return Object.freeze({ kind: 'file', root: resolve(cwd), bytes, executable: (before.mode & 0o111n) !== 0n, revision, assertCurrent });
    } finally { closeSync(descriptor); }
  } catch { return Object.freeze({ kind: 'unavailable', revision: null }); }
}
export function equalDirtyFiles(left: CapturedDirtyFile, right: CapturedDirtyFile): boolean | undefined {
  if (left.kind === 'unavailable' || right.kind === 'unavailable') return undefined;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'missing' || right.kind === 'missing') return true;
  return left.executable === right.executable && left.bytes.equals(right.bytes);
}
