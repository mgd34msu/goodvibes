/** Private default-project bindings. Exact local workspace tuples are not wire
 * identifiers or permissions; the configured native owner still decides scope.
 */
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { captureExistingDirectory, confirmFileDurable } from '../../utils/atomic-json-store.js';
import { readFileObservation, fileObservationIdentity } from '../../utils/file-observation.js';
import { assertCrossProcessLockCurrent, tryAcquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';
import type { NativeDataWriteOwner } from '../../runtime/native-reader-compatibility.js';
const MAX_PROJECT_BINDINGS = 4096;
const nativeApply = Reflect.apply, weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
const confirmations = new WeakMap<RegisteredProjectIdentity, () => void>();
export class ProjectIdentityUnavailableError extends Error {
  override readonly name = 'ProjectIdentityUnavailableError';
  constructor() { super('Project identity is unavailable or conflicts with saved state; preserve the existing bindings and project data before repairing it.'); }
}
interface ProjectBinding { readonly version: 1; readonly role: 'configured-default'; readonly workspace: string; readonly projectId: string }
export interface RegisteredProjectIdentity { readonly projectId: string; assertCurrent(): void }
function sameFile(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.birthtimeNs === right.birthtimeNs; }
function exactFile(stat: BigIntStats): string { return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].join(':'); }
function invokeGuard(guard: () => void): void { const result: unknown = guard(); if (result !== undefined) { drainOwned(result); throw new ProjectIdentityUnavailableError(); } }
function opaqueId(): string { return `project-${randomUUID().replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16)))}`; }
function binding(value: unknown): ProjectBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectIdentityUnavailableError();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || row['version'] !== 1 || row['role'] !== 'configured-default' || typeof row['workspace'] !== 'string'
    || !row['workspace'] || resolve(row['workspace']) !== row['workspace'] || typeof row['projectId'] !== 'string' || !row['projectId'] || row['projectId'].length > 4096) throw new ProjectIdentityUnavailableError();
  return row as unknown as ProjectBinding;
}
/** Capture without mkdir, lock file, chmod or eager UUID allocation. */
export class ProjectIdentityRegistry {
  private readonly directory: string;
  private readonly ancestors: Array<ReturnType<typeof captureExistingDirectory>> = [];
  private readonly missing: string[] = [];
  constructor(directory: string, private readonly ownerCurrent: () => void) {
    this.directory = resolve(directory); let parent = this.directory;
    while (!lstatSync(parent, { throwIfNoEntry: false })) { this.missing.unshift(parent); const next = dirname(parent); if (next === parent) throw new ProjectIdentityUnavailableError(); parent = next; }
    this.ancestors.push(captureExistingDirectory(parent, { allowPrivatePermissionTightening: true })); this.assertCurrent();
  }
  private assertCurrent(): void { invokeGuard(this.ownerCurrent); for (const parent of this.ancestors) parent.assertCurrent(); }
  /** Only adopt real private directories under the original checked parent.
   * Parent metadata ignores ordinary child publications; path identity does not.
   */
  private adoptDirectories(create: boolean): boolean {
    this.assertCurrent();
    while (this.missing.length > 0) {
      const path = this.missing[0]!; this.assertCurrent(); let entry = lstatSync(path, { bigint: true, throwIfNoEntry: false }); let created = false;
      if (!entry) {
        if (!create) return false;
        try { mkdirSync(path, { mode: 0o700 }); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        entry = lstatSync(path, { bigint: true });
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || (process.geteuid && entry.uid !== BigInt(process.geteuid()))) throw new ProjectIdentityUnavailableError();
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (!sameFile(entry, opened)) throw new ProjectIdentityUnavailableError();
        // Correct our own umask only; an existing foreign mode is never changed.
        if (created) { fchmodSync(fd, 0o700); if (!sameFile(opened, lstatSync(path, { bigint: true }))) throw new ProjectIdentityUnavailableError(); }
        const captured = captureExistingDirectory(path, { allowPrivatePermissionTightening: true });
        if (!sameFile(opened, lstatSync(path, { bigint: true }))) throw new ProjectIdentityUnavailableError();
        this.ancestors.push(captured); this.missing.shift(); this.assertCurrent();
      } finally { closeSync(fd); }
    }
    const entry = lstatSync(this.directory, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777n) !== 0o700n || (process.geteuid && entry.uid !== BigInt(process.geteuid()))) throw new ProjectIdentityUnavailableError();
    return true;
  }
  private inspectDirectory(): boolean { return this.adoptDirectories(false); }
  private ensure(): void { if (!this.adoptDirectories(true)) throw new ProjectIdentityUnavailableError(); }
  inspect(workspace: string): RegisteredProjectIdentity | null {
    if (workspace !== resolve(workspace)) throw new ProjectIdentityUnavailableError();
    if (!this.inspectDirectory()) return null;
    const names = readdirSync(this.directory).filter(name => name.endsWith('.json'));
    if (names.length > MAX_PROJECT_BINDINGS) throw new ProjectIdentityUnavailableError();
    let selected: RegisteredProjectIdentity | null = null;
    for (const name of names) {
      if (!/^binding-[a-p-]+\.json$/.test(name) || basename(name) !== name) throw new ProjectIdentityUnavailableError();
      this.assertCurrent(); const path = join(this.directory, name), source = readFileObservation(path), entry = lstatSync(path, { bigint: true });
      if ((entry.mode & 0o777n) !== 0o600n || (process.geteuid && entry.uid !== BigInt(process.geteuid()))) throw new ProjectIdentityUnavailableError();
      let value: unknown; try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(source.bytes)); } catch { throw new ProjectIdentityUnavailableError(); }
      const record = binding(value); this.assertCurrent(); if (fileObservationIdentity(path) !== source.physical) throw new ProjectIdentityUnavailableError();
      if (record.workspace !== workspace) continue;
      if (selected) throw new ProjectIdentityUnavailableError();
      const original = Object.freeze({ projectId: record.projectId, assertCurrent: () => { this.assertCurrent(); if (fileObservationIdentity(path) !== source.physical) throw new ProjectIdentityUnavailableError(); } });
      nativeApply(weakSet, confirmations, [original, () => { original.assertCurrent(); confirmFileDurable(path); original.assertCurrent(); }]); selected = original;
    }
    this.assertCurrent(); return selected;
  }
  /** This is the explicit native project-context mutation. Concurrent first
   * activations adopt one fully published winner before freezing any consumer.
   */
  async activate(workspace: string, previousId: string | null, nativeWriter: NativeDataWriteOwner | undefined, sourceCurrent: () => void): Promise<RegisteredProjectIdentity> {
    invokeGuard(sourceCurrent); this.ensure();
    const started = performance.now(); let release: (() => void) | null = null;
    while (!release) {
      invokeGuard(sourceCurrent); this.assertCurrent();
      release = tryAcquireCrossProcessLock(join(this.directory, 'bindings.lock'), { assertCurrent: () => this.assertCurrent() });
      if (!release) {
        if (performance.now() - started >= 15_000) throw new ProjectIdentityUnavailableError();
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
    }
    const heldRelease = release;
    const current = () => { invokeGuard(sourceCurrent); this.assertCurrent(); assertCrossProcessLockCurrent(heldRelease); };
    try {
      current(); const existing = this.inspect(workspace);
      if (existing) { if (previousId !== null && existing.projectId !== previousId) throw new ProjectIdentityUnavailableError(); existing.assertCurrent(); invokeGuard(() => nativeWriter?.declare('project-default-bindings-v1')); current(); (nativeApply(weakGet, confirmations, [existing]) as () => void)(); current(); return existing; }
      const projectId = previousId ?? opaqueId();
      invokeGuard(() => nativeWriter?.declare('project-default-bindings-v1')); current();
      const suffix = randomUUID().replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
      const target = join(this.directory, `binding-${suffix}.json`), temporary = join(this.directory, `.binding-${suffix}.stage`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), original = fstatSync(fd, { bigint: true });
      try {
        fchmodSync(fd, 0o600); writeFileSync(fd, `${JSON.stringify({ version: 1, role: 'configured-default', workspace, projectId } satisfies ProjectBinding)}\n`); fsyncSync(fd);
        const prepared = exactFile(fstatSync(fd, { bigint: true })); current();
        if (exactFile(fstatSync(fd, { bigint: true })) !== prepared) throw new ProjectIdentityUnavailableError();
        const staged = lstatSync(temporary, { bigint: true }); if (!sameFile(staged, original) || !staged.isFile() || exactFile(staged) !== prepared || staged.nlink !== 1n) throw new ProjectIdentityUnavailableError();
        linkSync(temporary, target);
        const actual = lstatSync(target, { bigint: true }); if (!sameFile(actual, original) || !sameFile(lstatSync(temporary, { bigint: true }), original)) throw new ProjectIdentityUnavailableError();
        unlinkSync(temporary);
        const published = exactFile(fstatSync(fd, { bigint: true }));
        const assertPublished = () => { current(); if (exactFile(fstatSync(fd, { bigint: true })) !== published || exactFile(lstatSync(target, { bigint: true })) !== published) throw new ProjectIdentityUnavailableError(); };
        assertPublished(); confirmFileDurable(target); assertPublished();
        const registered = this.inspect(workspace); if (!registered || registered.projectId !== projectId) throw new ProjectIdentityUnavailableError(); return registered;
      } finally {
        try { this.assertCurrent(); const actual = lstatSync(temporary, { bigint: true, throwIfNoEntry: false }); if (actual && sameFile(actual, original)) unlinkSync(temporary); }
        catch { /* Foreign/uncertain stage entries remain untouched. */ }
        closeSync(fd);
        // A populated target is never removed after a lost publication ack.
        // The next owned activation re-reads its explicit workspace binding.
      }
    } finally { heldRelease(); }
  }
}
