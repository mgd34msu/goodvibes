/** Trigger snapshot/report physical custody. No snapshot body is retained here
 * and no digest grants ownership. Native callbacks may only restrict writes.
 */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs';
import { assertCrossProcessLockCurrent, tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { captureExistingDirectory, confirmFileDurable, createAtomicTempPath, writeFileAtomic } from '../utils/atomic-json-store.js';
export class TriggerStoreError extends Error {
  override readonly name = 'TriggerStoreError';
  constructor(readonly kind: 'unavailable' | 'invalid' | 'quarantine-failed' | 'publication-failed') { super(`Trigger store ${kind}`); }
}
export class TriggerStoreOwnershipError extends Error {
  override readonly name = 'TriggerStoreOwnershipError';
  constructor() { super('Another process owns trigger execution for this surface; this window can inspect it read-only.'); }
}
function revision(stat: BigIntStats | undefined): string | null {
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (process.geteuid && stat.uid !== BigInt(process.geteuid()))) throw new TriggerStoreError('unavailable');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}
function sameOwner(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.birthtimeNs === right.birthtimeNs;
}
export interface OriginalTriggerFile { readonly fd: number; readonly stat: BigIntStats; readonly bytes: Buffer; close(): void }
export class TriggerFileOwner {
  private readonly selectedDirectory: string;
  private readonly directories: Array<ReturnType<typeof captureExistingDirectory>> = [];
  private readonly missing: string[] = [];
  private readonly expected = new Map<string, string | null>();
  private lease: { assertCurrent(): void; release(): void } | null = null;
  private provisional: { name: string; revision: string | null } | null = null;
  constructor(storePath: string, reportName: string, additional: readonly string[] = []) {
    const absolute = isAbsolute(storePath) ? storePath : `${process.cwd()}${sep}${storePath}`;
    this.selectedDirectory = dirname(absolute);
    let parent = this.selectedDirectory;
    while (!lstatSync(parent, { throwIfNoEntry: false })) {
      this.missing.unshift(parent); const next = dirname(parent); if (next === parent) throw new TriggerStoreError('unavailable'); parent = next;
    }
    this.directories.push(captureExistingDirectory(parent));
    for (const name of [basename(absolute), reportName, ...additional]) {
      if (!name || basename(name) !== name) throw new TriggerStoreError('unavailable');
      this.expected.set(name, this.observe(name));
    }
    this.assertCurrent();
  }
  private path(name: string): string { return join(this.selectedDirectory, name); }
  private observe(name: string): string | null { return revision(lstatSync(this.path(name), { bigint: true, throwIfNoEntry: false })); }
  private assertDirectories(): void {
    for (const directory of this.directories) directory.assertCurrent();
    for (const path of this.missing) if (lstatSync(path, { throwIfNoEntry: false })) throw new TriggerStoreError('unavailable');
  }
  assertCurrent(): void {
    this.assertDirectories();
    this.lease?.assertCurrent();
    for (const [name, expected] of this.expected) {
      const selected = this.provisional?.name === name ? this.provisional.revision : expected;
      if (this.observe(name) !== selected) throw new TriggerStoreError('unavailable');
    }
  }
  private ensure(): void {
    this.assertCurrent();
    while (this.missing.length > 0) {
      const path = this.missing[0]!; this.assertCurrent(); mkdirSync(path, { mode: 0o700 });
      const original = lstatSync(path, { bigint: true }), fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd, { bigint: true }); if (!opened.isDirectory() || !sameOwner(original, opened)) throw new TriggerStoreError('unavailable');
        fchmodSync(fd, 0o700); const current = lstatSync(path, { bigint: true }); if (!sameOwner(current, opened) || current.isSymbolicLink()) throw new TriggerStoreError('unavailable');
      } finally { closeSync(fd); }
      this.missing.shift(); this.directories.push(captureExistingDirectory(path)); this.assertCurrent();
    }
  }
  acquire(name: string): void {
    if (this.lease) { this.assertCurrent(); return; }
    this.ensure();
    const path = this.path(`${name}.owner.lock`), release = tryAcquireCrossProcessLock(path, { assertCurrent: () => this.assertDirectories() });
    if (!release) throw new TriggerStoreOwnershipError();
    try {
      assertCrossProcessLockCurrent(release);
      this.lease = { assertCurrent: () => assertCrossProcessLockCurrent(release), release };
    } catch (error) { release(); throw error; }
  }

  get acquired(): boolean { return this.lease !== null; }
  release(): void { const lease = this.lease; this.lease = null; lease?.release(); }
  private withLease<T>(name: string, work: () => T): T {
    const owned = this.lease !== null; if (!owned) this.acquire(name);
    try { return work(); } finally { if (!owned) this.release(); }
  }
  read(name: string): OriginalTriggerFile | null {
    if (!this.expected.has(name)) throw new TriggerStoreError('unavailable');
    this.assertCurrent(); if (this.expected.get(name) === null) return null;
    const fd = openSync(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd, { bigint: true });
      const before = revision(stat); if (before !== this.expected.get(name)) throw new TriggerStoreError('unavailable');
      const bytes = readFileSync(fd); this.assertCurrent(); if (revision(fstatSync(fd, { bigint: true })) !== before) throw new TriggerStoreError('unavailable');
      let open = true; return { fd, stat, bytes, close() { if (open) { open = false; closeSync(fd); } } };
    } catch (error) { closeSync(fd); throw error; }
  }
  write(name: string, contents: string, beforeWrite?: (() => void) | undefined): void {
    this.withLease(name, () => this.writeOwned(name, contents, beforeWrite));
  }
  private writeOwned(name: string, contents: string, beforeWrite?: (() => void) | undefined): void {
    if (!this.expected.has(name)) throw new TriggerStoreError('unavailable');
    this.assertCurrent();
    if (beforeWrite) { const result: unknown = beforeWrite(); if (result !== undefined) { drainOwned(result); throw new TriggerStoreError('unavailable'); } this.assertCurrent(); }
    this.ensure();
    try {
      writeFileAtomic(this.path(name), contents, { mkdirp: false, mode: 0o600, durable: true, cleanupStaleTemps: false,
        assertCurrent: () => this.assertCurrent(), onEffect: published => {
          if (published) this.provisional = { name, revision: this.observe(name) };
        },
      });
      this.assertCurrent();
      // Reuse only a fully confirmed publication, not a failed durable effect.
      if (!this.provisional || this.provisional.name !== name) throw new TriggerStoreError('publication-failed');
      this.expected.set(name, this.provisional.revision);
    } finally { this.provisional = null; }
  }
  quarantine(name: string, source: OriginalTriggerFile): string {
    return this.withLease(name, () => this.quarantineOwned(name, source));
  }
  private quarantineOwned(name: string, source: OriginalTriggerFile): string {
    this.assertCurrent();
    if (revision(fstatSync(source.fd, { bigint: true })) !== this.expected.get(name)) throw new TriggerStoreError('unavailable');
    const directory = this.directories.at(-1); if (!directory || this.missing.length > 0) throw new TriggerStoreError('unavailable');
    const target = createAtomicTempPath(join(directory.canonical, `${name}.corrupt-${Date.now()}`));
    const destination = openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const placeholder = fstatSync(destination, { bigint: true }); let moved = false;
    try {
      fchmodSync(destination, 0o600); this.assertCurrent();
      if (!sameOwner(lstatSync(target, { bigint: true }), placeholder)) throw new TriggerStoreError('unavailable');
      try { renameSync(this.path(name), target); }
      catch {
        const actual = lstatSync(target, { bigint: true, throwIfNoEntry: false });
        if (!actual || !sameOwner(actual, fstatSync(source.fd, { bigint: true }))) throw new TriggerStoreError('quarantine-failed');
      }
      const after = fstatSync(source.fd, { bigint: true });
      if (!sameOwner(after, source.stat) || after.mode !== source.stat.mode || after.size !== source.stat.size || after.mtimeNs !== source.stat.mtimeNs) throw new TriggerStoreError('quarantine-failed');
      fchmodSync(source.fd, 0o600);
      const published = revision(fstatSync(source.fd, { bigint: true }));
      if (revision(lstatSync(target, { bigint: true })) !== published) throw new TriggerStoreError('quarantine-failed');
      this.provisional = { name, revision: null }; this.assertCurrent();
      confirmFileDurable(target);
      this.assertCurrent(); if (revision(lstatSync(target, { bigint: true })) !== published) throw new TriggerStoreError('quarantine-failed');
      this.expected.set(name, null); moved = true; return target;
    } finally {
      this.provisional = null;
      // Never unlink the store on a failed rename, nor a colliding/replaced
      // quarantine slot. Only our still-owned empty placeholder may disappear.
      if (!moved) {
        try { directory.assertPhysicalCurrent(); const current = lstatSync(target, { bigint: true, throwIfNoEntry: false }); if (current && sameOwner(current, placeholder)) unlinkSync(target); } catch { /* Foreign/uncertain entries are preserved. */ }
      }
      closeSync(destination);
    }
  }
}
