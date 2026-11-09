/** Local file custody, not content identity. Cleanup is limited to leaves this
 * operation exclusively created in its original directory. No hashes. */
import { constants, fchmodSync, fstatSync, lstatSync, openSync, realpathSync, statSync, unlinkSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';

interface Parent {
  readonly path: string;
  readonly target: string;
  readonly identity: string;
}
const unavailable = () => new Error('Artifact storage owner changed or became unavailable.');
const directoryIdentity = (entry: BigIntStats): string => {
  if (!entry.isDirectory()) throw unavailable();
  return [entry.dev, entry.ino, entry.mode, entry.uid, entry.gid].join(':');
};
const leafIdentity = (entry: BigIntStats): string => {
  if (!entry.isFile() || entry.nlink !== 1n || (entry.mode & 0o077n) !== 0n) throw unavailable();
  return [entry.dev, entry.ino, entry.mode, entry.uid, entry.gid, entry.nlink, entry.birthtimeNs].join(':');
};
const leafStamp = (entry: BigIntStats): string => [leafIdentity(entry), entry.size, entry.mtimeNs, entry.ctimeNs, entry.birthtimeNs].join(':');
function captureParents(path: string): readonly Parent[] {
  const parents: Parent[] = [];
  for (let part = path; ; part = dirname(part)) {
    const link = lstatSync(part, { bigint: true }), target = statSync(part, { bigint: true });
    parents.push(Object.freeze({ path: part, target: realpathSync(part), identity: [directoryIdentity(target), link.dev, link.ino,
      ...(link.isSymbolicLink() ? [link.mtimeNs, link.ctimeNs] : [])].join(':') }));
    if (dirname(part) === part) break;
  }
  return Object.freeze(parents);
}
function assertParents(parents: readonly Parent[]): void {
  for (const before of parents) {
    const link = lstatSync(before.path, { bigint: true }), target = statSync(before.path, { bigint: true });
    if (realpathSync(before.path) !== before.target || [directoryIdentity(target), link.dev, link.ino,
      ...(link.isSymbolicLink() ? [link.mtimeNs, link.ctimeNs] : [])].join(':') !== before.identity) throw unavailable();
  }
}

export class ArtifactStorageOwner {
  private readonly resolved: string;
  private readonly parents: readonly Parent[];
  private readonly actualParents: readonly Parent[];
  constructor(readonly configured: string) {
    this.resolved = realpathSync(configured);
    this.parents = captureParents(configured);
    this.actualParents = captureParents(this.resolved);
    this.assertCurrent();
  }
  assertCurrent(): void { assertParents(this.parents); assertParents(this.actualParents); }
  /** Cleanup may still remove our original leaf after an alias changes, but
   * never walks that alias or adopts a replacement physical directory. */
  assertOriginalDirectory(): void { assertParents(this.actualParents); }
  leaf(name: string): ArtifactCreatedLeaf {
    if (!name || name !== name.replace(/[\\/]/g, '') || name === '.' || name === '..') throw unavailable();
    this.assertCurrent(); return new ArtifactCreatedLeaf(this, join(this.resolved, name));
  }
  importedStamp(path: string): string { this.assertCurrent(); return leafStamp(lstatSync(path, { bigint: true })); }
  assertImported(path: string, stamp: string): void {
    this.assertCurrent(); if (leafStamp(lstatSync(path, { bigint: true })) !== stamp) throw unavailable();
  }
}

export class ArtifactCreatedLeaf {
  private identity: string | undefined;
  private sealed: string | undefined;
  constructor(private readonly root: ArtifactStorageOwner, readonly path: string) {}
  open(): number {
    this.root.assertCurrent();
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    // claim() is deliberately separate: an open failure never confers cleanup
    // ownership of an existing filename.
    return fd;
  }
  claim(fd: number): void {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) throw unavailable();
    // Record exclusive creation before chmod/currentness can fail. A zero
    // permission umask cannot leave a successfully published unreadable file.
    this.identity = leafIdentity(opened);
    fchmodSync(fd, 0o600);
    this.identity = leafIdentity(fstatSync(fd, { bigint: true }));
    this.assertWriting(fd);
  }
  assertWriting(fd: number): void {
    this.root.assertCurrent();
    if (!this.identity || leafIdentity(fstatSync(fd, { bigint: true })) !== this.identity
      || leafIdentity(lstatSync(this.path, { bigint: true })) !== this.identity) throw unavailable();
  }
  seal(fd: number): void {
    this.assertWriting(fd);
    const stamp = leafStamp(fstatSync(fd, { bigint: true }));
    if (leafStamp(lstatSync(this.path, { bigint: true })) !== stamp) throw unavailable();
    this.sealed = stamp;
  }
  assertSealed(): void {
    this.root.assertCurrent();
    if (!this.sealed || leafStamp(lstatSync(this.path, { bigint: true })) !== this.sealed) throw unavailable();
  }
  cleanup(): void {
    if (!this.identity) return;
    try {
      this.root.assertOriginalDirectory();
      const entry = lstatSync(this.path, { bigint: true });
      if (leafIdentity(entry) !== this.identity || this.sealed !== undefined && leafStamp(entry) !== this.sealed) return;
      unlinkSync(this.path);
    } catch { /* Unconfirmed or replaced evidence is preserved, never adopted. */ }
  }
}
