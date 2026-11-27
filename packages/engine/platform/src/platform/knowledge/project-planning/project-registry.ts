/** Private default-project bindings. Exact local workspace tuples are not wire
 * identifiers or permissions; the configured native owner still decides scope.
 */
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { captureExistingDirectory, confirmFileDurable } from '../../utils/atomic-json-store.js';
import { readFileObservation, fileObservationIdentity } from '../../utils/file-observation.js';
import { assertCrossProcessLockCurrent, tryAcquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';
import type { NativeDataWriteOwner } from '../../runtime/native-reader-compatibility.js';
import { folderReach } from '../../workspace/folder-reach.js';
const nativeApply = Reflect.apply, weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
const confirmations = new WeakMap<RegisteredProjectIdentity, () => void>();
export class ProjectIdentityUnavailableError extends Error {
  override readonly name = 'ProjectIdentityUnavailableError';
  constructor(words?: string) { super(words ?? 'Project identity is unavailable or conflicts with saved state; preserve the existing bindings and project data before repairing it.'); }
}
/**
 * A true conflict: this folder has two different project identities, so its saved work could belong to either. The
 * refusal names both, where each is kept, and the one move that settles it; nothing is chosen or changed for the owner.
 */
export function projectIdentityConflict(workspace: string, first: { readonly id: string; readonly where: string }, second: { readonly id: string; readonly where: string }, next: string): ProjectIdentityUnavailableError {
  return new ProjectIdentityUnavailableError(`${workspace} has two project identities, ${first.id} (${first.where}) and ${second.id} (${second.where}), `
    + `so it cannot be told which saved work is this folder's; nothing was opened or changed. ${next}`);
}
interface ProjectBinding { readonly version: 1; readonly role: 'configured-default'; readonly workspace: string; readonly projectId: string }
export interface RegisteredProjectIdentity {
  readonly projectId: string;
  /** The binding file that names it, for a refusal that has to say where the identity is kept. */
  readonly file: string;
  assertCurrent(): void;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.birthtimeNs === right.birthtimeNs; }
function exactFile(stat: BigIntStats): string { return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].join(':'); }
function invokeGuard(guard: () => void): void { assertSynchronousJudgmentGuard(guard, () => new ProjectIdentityUnavailableError()); }
function opaqueId(): string { return `project-${randomUUID()}`; }
function binding(value: unknown): ProjectBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectIdentityUnavailableError();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || row['version'] !== 1 || row['role'] !== 'configured-default' || typeof row['workspace'] !== 'string'
    || !row['workspace'] || resolve(row['workspace']) !== row['workspace'] || typeof row['projectId'] !== 'string' || !row['projectId'] || row['projectId'].length > 4096) throw new ProjectIdentityUnavailableError();
  return row as unknown as ProjectBinding;
}
/**
 * The folder a binding names was really deleted: it is gone and the folder that held it is there. A folder gone with
 * the folder that held it (a disk not mounted, a parent renamed) is only out of reach: its binding is kept, and the
 * folder is the same project when it is back.
 */
function folderGone(workspace: string): boolean { return folderReach(workspace) === 'deleted'; }

/**
 * The bindings of one register folder, held in memory so a lookup reads no file but the one binding it returns.
 *
 * Built once per process on the first lookup (every file read and checked as before), then kept in step with the
 * folder: each lookup compares the folder's own identity and times with the ones the index was read at, and when they
 * differ (a binding written or removed here or by another program, or the register's lock taken) reads the folder's
 * names again and only the files that are new. A file that changed under a name already read is found when that
 * binding is used (its identity is checked on every lookup that returns it) and read again then.
 *
 * There is no bound on how many projects are kept: an entry is a few hundred bytes, and a binding goes when its folder
 * was really deleted (gone while the folder that held it is there; seen when the index is built and when a lookup names
 * that folder) or when the owner removes the project (`releaseProjectIdentity`), never by age. A folder out of reach
 * (its parent missing too: a disk not mounted, a parent renamed) keeps its binding.
 */
interface IndexedBinding { readonly name: string; readonly path: string; readonly record: ProjectBinding; readonly physical: string }
interface BindingIndex {
  /** The folder's device, inode, modification and change times the names were read at; null when they must be read again. */
  stamp: string | null;
  /** The folder's device and inode: another folder put at the same path is indexed from nothing. */
  folder: string | null;
  /** Every name of the folder was read once (the build); until then the next lookup goes on building. */
  complete: boolean;
  readonly byName: Map<string, IndexedBinding>;
  readonly byWorkspace: Map<string, IndexedBinding[]>;
  /** Bindings found, when the index was built, whose folder no longer exists: let go at the next lookup that can take the lock. */
  readonly gone: IndexedBinding[];
}
const indexes = new Map<string, BindingIndex>();
/**
 * A folder's times are kept by the file system at its clock's step: a change in the same step as the read that took
 * them can leave them equal. Times this close to now are not trusted to mean "unchanged", so the names are read again
 * until the folder has been still for longer than any file system's step.
 */
const UNSETTLED_FOLDER_NS = 100_000_000n;
function remember(index: BindingIndex, entry: IndexedBinding): void {
  index.byName.set(entry.name, entry);
  const list = [...(index.byWorkspace.get(entry.record.workspace) ?? []).filter(other => other.name !== entry.name), entry]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  index.byWorkspace.set(entry.record.workspace, list);
}
function forget(index: BindingIndex, name: string): void {
  const entry = index.byName.get(name); if (!entry) return;
  index.byName.delete(name);
  const list = (index.byWorkspace.get(entry.record.workspace) ?? []).filter(other => other.name !== name);
  if (list.length > 0) index.byWorkspace.set(entry.record.workspace, list); else index.byWorkspace.delete(entry.record.workspace);
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
  /** One binding file, read and checked: its name, its owner and mode, its bytes, and that it was not replaced while read. */
  private readBinding(name: string): IndexedBinding {
    if (!/^binding-[0-9a-p-]+\.json$/.test(name) || basename(name) !== name) throw new ProjectIdentityUnavailableError();
    this.assertCurrent(); const path = join(this.directory, name), source = readFileObservation(path), entry = lstatSync(path, { bigint: true });
    if ((entry.mode & 0o777n) !== 0o600n || (process.geteuid && entry.uid !== BigInt(process.geteuid()))) throw new ProjectIdentityUnavailableError();
    let value: unknown; try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(source.bytes)); } catch { throw new ProjectIdentityUnavailableError(); }
    const record = binding(value); this.assertCurrent(); if (fileObservationIdentity(path) !== source.physical) throw new ProjectIdentityUnavailableError();
    return Object.freeze({ name, path, record, physical: source.physical });
  }
  /** The index of this register folder, brought in step with the folder (see {@link BindingIndex}). */
  private index(): BindingIndex {
    let index = indexes.get(this.directory);
    if (!index) { index = { stamp: null, folder: null, complete: false, byName: new Map(), byWorkspace: new Map(), gone: [] }; indexes.set(this.directory, index); }
    const stat = lstatSync(this.directory, { bigint: true });
    const stamp = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (index.stamp === stamp) return index;
    const folder = `${stat.dev}:${stat.ino}`;
    if (index.folder !== folder) { index.byName.clear(); index.byWorkspace.clear(); index.gone.length = 0; index.folder = folder; index.complete = false; }
    // Building: the first full read of this folder in this process (again after one that stopped part way).
    const built = !index.complete;
    index.stamp = null;
    const names = readdirSync(this.directory).filter(name => name.endsWith('.json')).sort(), present = new Set(names);
    for (const name of [...index.byName.keys()]) if (!present.has(name)) forget(index, name);
    for (const name of names) if (!index.byName.has(name)) remember(index, this.readBinding(name));
    const settled = BigInt(Date.now()) * 1_000_000n - (stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs) > UNSETTLED_FOLDER_NS;
    index.stamp = settled ? stamp : null;
    if (built) {
      for (const entry of index.byName.values()) if (folderGone(entry.record.workspace)) index.gone.push(entry);
      index.complete = true;
    }
    return index;
  }
  /**
   * Lets go of bindings whose folder no longer exists, each checked again under the register's lock: its folder still
   * gone and its file still the one read. `held` when the caller holds the lock; otherwise it is taken without waiting,
   * and a binding not let go now is let go by a later lookup.
   */
  private release(index: BindingIndex, entries: readonly IndexedBinding[], held: boolean): void {
    if (entries.length === 0) return;
    const unlock = held ? null : tryAcquireCrossProcessLock(join(this.directory, 'bindings.lock'), { assertCurrent: () => this.assertCurrent() });
    if (!held && !unlock) return;
    try {
      for (const entry of [...entries]) {
        this.assertCurrent();
        const at = index.gone.indexOf(entry); if (at >= 0) index.gone.splice(at, 1);
        if (!folderGone(entry.record.workspace)) continue;
        let physical: string | null = null; try { physical = fileObservationIdentity(entry.path); } catch { /* already gone */ }
        if (physical !== null && physical !== entry.physical) continue;
        if (physical !== null) unlinkSync(entry.path);
        forget(index, entry.name);
      }
    } finally { unlock?.(); }
  }
  inspect(workspace: string): RegisteredProjectIdentity | null { return this.lookup(workspace, false, true); }
  private lookup(workspace: string, held: boolean, again: boolean): RegisteredProjectIdentity | null {
    if (workspace !== resolve(workspace)) throw new ProjectIdentityUnavailableError();
    if (!this.inspectDirectory()) return null;
    const index = this.index();
    if (index.gone.length > 0) this.release(index, index.gone, held);
    const found = index.byWorkspace.get(workspace) ?? [];
    if (found.length > 0 && folderGone(workspace)) { this.release(index, found, held); this.assertCurrent(); return null; }
    let selected: IndexedBinding | null = null;
    for (const entry of found) {
      if (selected) {
        // A second file naming the same identity is the same project: the first one read stays the one used.
        if (selected.record.projectId === entry.record.projectId) continue;
        throw projectIdentityConflict(workspace, { id: selected.record.projectId, where: selected.path }, { id: entry.record.projectId, where: entry.path },
          `Keep the identity this folder's work is saved under: move the other binding file out of ${this.directory}, then start again.`);
      }
      selected = entry;
    }
    if (!selected) { this.assertCurrent(); return null; }
    // The binding returned is checked on disk: its owner, mode and identity as read. One changed since is read again.
    let current: string | null = null, stat: BigIntStats | undefined;
    try { stat = lstatSync(selected.path, { bigint: true, throwIfNoEntry: false }); current = stat ? fileObservationIdentity(selected.path) : null; } catch { current = null; }
    if (current !== selected.physical || !stat || (stat.mode & 0o777n) !== 0o600n || (process.geteuid && stat.uid !== BigInt(process.geteuid()))) {
      if (!again) throw new ProjectIdentityUnavailableError();
      forget(index, selected.name); index.stamp = null;
      if (stat) remember(index, this.readBinding(selected.name));
      return this.lookup(workspace, held, false);
    }
    const path = selected.path, physical = selected.physical;
    const original = Object.freeze({ projectId: selected.record.projectId, file: path, assertCurrent: () => { this.assertCurrent(); if (fileObservationIdentity(path) !== physical) throw new ProjectIdentityUnavailableError(); } });
    nativeApply(weakSet, confirmations, [original, () => { original.assertCurrent(); confirmFileDurable(path); original.assertCurrent(); }]);
    this.assertCurrent(); return original;
  }
  /** The register's lock, waited for as every writer of it waits. */
  private async hold(current: () => void): Promise<() => void> {
    const started = performance.now(); let release: (() => void) | null = null;
    while (!release) {
      current();
      release = tryAcquireCrossProcessLock(join(this.directory, 'bindings.lock'), { assertCurrent: () => this.assertCurrent() });
      if (!release) {
        if (performance.now() - started >= 15_000) throw new ProjectIdentityUnavailableError();
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
    }
    return release;
  }
  /**
   * The owner removed the project at this folder: its binding is let go, so a folder made there later is a new project.
   * Returns how many binding files were removed (a folder may have more than one naming the same identity).
   */
  async releaseWorkspace(workspace: string): Promise<number> {
    if (workspace !== resolve(workspace) || !this.inspectDirectory()) return 0;
    const heldRelease = await this.hold(() => this.assertCurrent());
    try {
      const index = this.index(); let removed = 0;
      for (const entry of [...(index.byWorkspace.get(workspace) ?? [])]) {
        this.assertCurrent(); assertCrossProcessLockCurrent(heldRelease);
        let physical: string | null = null; try { physical = fileObservationIdentity(entry.path); } catch { /* already gone */ }
        if (physical !== null && physical !== entry.physical) throw new ProjectIdentityUnavailableError();
        if (physical !== null) { unlinkSync(entry.path); removed += 1; }
        forget(index, entry.name);
      }
      return removed;
    } finally { heldRelease(); }
  }
  /** This is the explicit native project-context mutation. Concurrent first
   * activations adopt one fully published winner before freezing any consumer.
   */
  async activate(workspace: string, previousId: string | null, nativeWriter: NativeDataWriteOwner | undefined, sourceCurrent: () => void): Promise<RegisteredProjectIdentity> {
    invokeGuard(sourceCurrent); this.ensure();
    const heldRelease = await this.hold(() => { invokeGuard(sourceCurrent); this.assertCurrent(); });
    const current = () => { invokeGuard(sourceCurrent); this.assertCurrent(); assertCrossProcessLockCurrent(heldRelease); };
    try {
      current(); const existing = this.lookup(workspace, true, true);
      if (existing) {
        if (previousId !== null && existing.projectId !== previousId) {
          throw projectIdentityConflict(workspace, { id: previousId, where: 'the work saved for this folder' }, { id: existing.projectId, where: existing.file },
            `To keep the saved work, move ${existing.file} out of ${this.directory} and start again: the folder is then given the identity its saved work has.`);
        }
        existing.assertCurrent(); invokeGuard(() => nativeWriter?.declare('project-default-bindings-v1')); current(); (nativeApply(weakGet, confirmations, [existing]) as () => void)(); current(); return existing; }
      const projectId = previousId ?? opaqueId();
      invokeGuard(() => nativeWriter?.declare('project-default-bindings-v1')); current();
      const suffix = randomUUID();
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
        // The index takes the new binding as it reads the folder's changed names: only this file is read.
        const registered = this.lookup(workspace, true, true); if (!registered || registered.projectId !== projectId) throw new ProjectIdentityUnavailableError(); return registered;
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

/**
 * The owner removed the project at `workspace` (unregistered it): its identity binding in this home's register is let
 * go, so the register keeps only projects that are still the owner's. Nothing when the register does not exist.
 */
export async function releaseProjectIdentity(homeDirectory: string, workspace: string): Promise<number> {
  const directory = join(homeDirectory, '.goodvibes', 'project-identities');
  if (!lstatSync(directory, { throwIfNoEntry: false })) return 0;
  return new ProjectIdentityRegistry(directory, () => {}).releaseWorkspace(resolve(workspace));
}
