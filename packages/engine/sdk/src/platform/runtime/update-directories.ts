/**
 * Owned, reversible native directory publication. Preparation owns a distinct
 * cross-process target claim before staging; every tree remains bound to its
 * original physical entries. Several renames are not process-crash atomic.
 */
import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readTarGzEntries, type TarEntry } from '../browser/browser-driver-archive.js';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { retainNativeUpdateDirectory } from './update-file-io.js';

export interface NativeDirectoryPreparationOptions {
  readonly stripComponents?: number;
  readonly sourceVersion?: string;
  readonly expectedRoot?: string;
  readonly retainedTarget?: NativeUpdateTreeObservation;
  readonly requiredFiles?: readonly string[];
  readonly maxArchiveBytes?: number;
  /** Live admission only. Compensation/cleanup retain physical custody independently. */
  readonly assertCurrent?: (() => void) | undefined;
}
export interface NativeUpdateTreeObservation { readonly targetPath: string; assertCurrent(): void }
interface RetainedTree { readonly targetPath: string; readonly parent: ReturnType<typeof retainNativeUpdateDirectory>; readonly original: Tree | undefined }
const retainedTrees = new WeakMap<NativeUpdateTreeObservation, RetainedTree>();
export interface NativeDirectoryFinishResult { readonly preservedPaths: readonly string[] }
export interface PreparedNativeUpdateDirectory {
  readonly targetPath: string;
  readonly previousVersion?: string;
  readonly committed: boolean;
  readonly recoveryRequired: boolean;
  assertCurrent(): void;
  commit(): void;
  /** Reverse only this handle's completed renames, including a partial commit. */
  restore(): void;
  /** Keep the outgoing live tree at .previous. Unknown older trees are preserved. */
  finish(): NativeDirectoryFinishResult;
  /** Discard owned staging after restoration. Never silently undo a committed update. */
  dispose(): NativeDirectoryFinishResult;
  /** Leave original claims/stages intact when the enclosing file cohort needs recovery. */
  preserve(): NativeDirectoryFinishResult;
}
export type NativeUpdateDirectory = PreparedNativeUpdateDirectory;
export const NATIVE_UPDATE_DIRECTORY_RELEASE_FILE = '.goodvibes-release.json';
const releaseVersionSyntax = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
export class NativeDirectoryUpdateError extends Error {
  constructor(readonly recoveryRequired: boolean, readonly preservedPaths: readonly string[], options?: ErrorOptions) {
    super(recoveryRequired ? 'Native directory update requires recovery; original claims and trees are retained'
      : 'Native directory update did not complete; preserved paths remain available', options);
    this.name = 'NativeDirectoryUpdateError';
  }
}
interface Entry { readonly path: string; readonly kind: 'file' | 'directory'; readonly identity: string }
interface Tree { path: string; readonly entries: Map<string, Entry>; active: boolean }
interface Move { readonly tree: Tree; readonly from: string; readonly to: string }
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const existing = (path: string) => { try { return fs.lstatSync(path, { bigint: true }); } catch (error) { if (missing(error)) return undefined; throw error; } };
function creationIdentity(stat: fs.BigIntStats): string { return [stat.dev, stat.ino, stat.birthtimeNs, stat.uid, stat.gid].join(':'); }
function physical(stat: fs.BigIntStats): string { return [stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.uid, stat.gid].join(':'); }
function identity(stat: fs.BigIntStats): string {
  return stat.isDirectory() ? physical(stat) : `${physical(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function entry(path: string, relative: string): Entry {
  const stat = fs.lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Native update trees require ordinary files and directories');
  return { path: relative, kind: stat.isDirectory() ? 'directory' : 'file', identity: identity(stat) };
}
function inventory(path: string): Map<string, Entry> {
  const entries = new Map<string, Entry>(), pending = [''];
  while (pending.length) {
    const relative = pending.pop()!;
    const value = entry(join(path, relative), relative); entries.set(relative, value);
    if (entries.size > 100_000) throw new Error('Native update tree exceeds its entry limit');
    if (value.kind === 'directory') for (const name of fs.readdirSync(join(path, relative))) pending.push(join(relative, name));
  }
  if (entries.get('')?.kind !== 'directory') throw new Error('Native update target is not a directory');
  return entries;
}
function tree(path: string): Tree | undefined { return existing(path) ? { path, entries: inventory(path), active: true } : undefined; }
function assertTree(value: Tree): void {
  if (!value.active) return;
  const now = inventory(value.path);
  if (now.size !== value.entries.size || [...value.entries].some(([name, before]) => {
    const current = now.get(name); return !current || before.kind !== current.kind || before.identity !== current.identity;
  })) throw new Error('Native update tree changed');
}
/** Retain the actually selected live tree (including absence) before network work. */
export function retainNativeUpdateTree(selected: string): NativeUpdateTreeObservation {
  const targetPath = resolve(selected), parent = retainNativeUpdateDirectory(dirname(targetPath));
  parent.assertCurrent(); const original = tree(targetPath); parent.assertCurrent();
  const observation = Object.freeze({ targetPath, assertCurrent() {
    parent.assertCurrent();
    if (original) assertTree(original); else if (existing(targetPath)) throw new Error('Originally absent native update tree appeared');
    parent.assertCurrent();
  } });
  observation.assertCurrent(); retainedTrees.set(observation, { targetPath, parent, original }); return observation;
}
function relativePath(value: string): string[] {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\ufffd')) throw new Error('Invalid native archive path');
  const parts = value.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Native archive path escapes or aliases its tree');
  return parts;
}
function archiveEntries(archive: Buffer | Uint8Array, options: NativeDirectoryPreparationOptions): readonly TarEntry[] {
  const count = options.stripComponents ?? 0, limit = options.maxArchiveBytes ?? 256 * 1024 * 1024;
  if (!Number.isInteger(count) || count < 0 || count > 32 || !Number.isSafeInteger(limit) || limit < 1024) throw new Error('Invalid native archive bounds');
  const root = options.expectedRoot === undefined ? undefined : relativePath(options.expectedRoot).join('/');
  if (root !== undefined && (root.includes('/') || count !== 1)) throw new Error('A native archive root requires exactly one stripped component');
  if (options.sourceVersion !== undefined && !releaseVersionSyntax(options.sourceVersion)) throw new Error('Invalid native directory source version');
  const files = new Map<string, TarEntry>(), originalPaths = new Set<string>();
  for (const member of readTarGzEntries(archive, { strict: true, maxOutputLength: limit })) {
    if (member.kind === 'other') throw new Error('Native archives cannot contain links or special entries');
    if (!member.path && member.kind === 'directory') { if (originalPaths.has('')) throw new Error('Native archive contains duplicate root entries'); originalPaths.add(''); continue; }
    const parts = relativePath(member.path);
    const originalPath = parts.join('/');
    if (originalPaths.has(originalPath)) throw new Error('Native archive contains duplicate entries');
    originalPaths.add(originalPath);
    if (root !== undefined && parts[0] !== root) throw new Error('Native archive has an unexpected root');
    const selected = parts.slice(count);
    if (!selected.length) { if (member.kind !== 'directory') throw new Error('Native archive strips a regular file to its root'); continue; }
    const path = selected.join('/');
    if (path === NATIVE_UPDATE_DIRECTORY_RELEASE_FILE || path.startsWith(NATIVE_UPDATE_DIRECTORY_RELEASE_FILE + '/')) throw new Error('Native archive collides with reserved release bookkeeping');
    if (files.has(path)) throw new Error('Native archive contains duplicate entries');
    if (files.size >= 100_000) throw new Error('Native archive exceeds its entry limit');
    files.set(path, { ...member, path });
  }
  for (const member of files.values()) {
    const parts = member.path.split('/');
    for (let i = 1; i < parts.length; i++) if (files.get(parts.slice(0, i).join('/'))?.kind === 'file') throw new Error('Native archive uses a file as a directory');
  }
  if (![...files.values()].some(member => member.kind === 'file')) throw new Error('Native archive has no regular files');
  for (const required of options.requiredFiles ?? []) {
    const path = relativePath(required).join('/');
    if (files.get(path)?.kind !== 'file') throw new Error('Native archive is missing a required file');
  }
  return [...files.values()];
}
function previousReleaseVersion(value: Tree | undefined): string | undefined {
  if (!value || value.entries.get(NATIVE_UPDATE_DIRECTORY_RELEASE_FILE)?.kind !== 'file') return undefined;
  assertTree(value); const path = join(value.path, NATIVE_UPDATE_DIRECTORY_RELEASE_FILE);
  if (fs.lstatSync(path).size > 4096) return undefined;
  let marker: unknown;
  try { marker = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { assertTree(value); return undefined; }
  assertTree(value);
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return undefined;
  const row = marker as Record<string, unknown>;
  return row['schema'] === 1 && releaseVersionSyntax(row['version']) && Object.keys(row).every(key => ['schema', 'version', 'kind'].includes(key))
    && (row['kind'] === undefined || typeof row['kind'] === 'string') ? row['version'] : undefined;
}
function synchronous(check: (() => void) | undefined): void {
  const result: unknown = check?.();
  if (result !== undefined) { drainOwned(result); throw new Error('Native directory admission must be synchronous'); }
}

/** New release tree. All archive validation completes before taking filesystem ownership. */
export function prepareNativeUpdateDirectory(targetPath: string, archive: Buffer | Uint8Array,
  options: NativeDirectoryPreparationOptions = {}): PreparedNativeUpdateDirectory {
  options = Object.freeze({ ...options, ...(options.requiredFiles === undefined ? {} : { requiredFiles: Object.freeze([...options.requiredFiles]) }) });
  const members = archiveEntries(archive, options);
  return prepare(targetPath, members, options);
}
/** Explicit exchange with the selected existing .previous directory. */
export function prepareNativeDirectoryRollback(targetPath: string,
  options: Omit<NativeDirectoryPreparationOptions, 'stripComponents' | 'sourceVersion' | 'expectedRoot' | 'requiredFiles' | 'maxArchiveBytes'> = {}): PreparedNativeUpdateDirectory {
  return prepare(targetPath, undefined, Object.freeze({ ...options }));
}
function prepare(selected: string, members: readonly TarEntry[] | undefined, options: NativeDirectoryPreparationOptions): PreparedNativeUpdateDirectory {
  const targetPath = resolve(selected), previousPath = `${targetPath}.previous`, parent = dirname(targetPath);
  const retained = options.retainedTarget ?? retainNativeUpdateTree(targetPath), proof = retainedTrees.get(retained);
  if (!proof || proof.targetPath !== targetPath) throw new Error('Native directory target observation does not match');
  retained.assertCurrent();
  const parentOwner = proof.parent;
  const admission = options.assertCurrent?.bind(options);
  synchronous(admission); parentOwner.assertCurrent(); parentOwner.ensure(); parentOwner.assertCurrent();
  const claimPath = `${targetPath}.directory-update.lock`;
  const release = tryAcquireCrossProcessLock(claimPath, { assertCurrent: () => parentOwner.assertCurrent() });
  if (!release) throw new Error('Another native directory update owns this target');
  const claim = identity(fs.lstatSync(claimPath, { bigint: true }));
  let work: string | undefined, workOwner: ReturnType<typeof retainNativeUpdateDirectory> | undefined;
  const refs: Tree[] = [], moves: Move[] = [], created: { path: string; identity: string; directory: boolean }[] = [];
  const createdDirectories = new Map<string, string>(), sealedFiles = new Map<string, string>();
  let incoming: Tree | undefined, original: Tree | undefined, previous: Tree | undefined;
  let previousVersion: string | undefined;
  let completed = false, recoveryRequired = false, closed = false, committed = false;
  const preservedPaths: string[] = [];
  const physicalCurrent = () => {
    parentOwner.assertCurrent();
    if (identity(fs.lstatSync(claimPath, { bigint: true })) !== claim) throw new Error('Native directory update claim changed');
    workOwner?.assertCurrent();
  };
  const createdParentCurrent = (path: string) => {
    physicalCurrent();
    for (let currentPath = dirname(path); currentPath !== work; currentPath = dirname(currentPath)) {
      const own = createdDirectories.get(currentPath), stat = existing(currentPath);
      if (!own || !stat?.isDirectory() || stat.isSymbolicLink() || creationIdentity(stat) !== own) throw new Error('Original native staging parent changed');
      if (dirname(currentPath) === currentPath) throw new Error('Native staging path escaped its owned root');
    }
    physicalCurrent();
  };
  const paths = () => [targetPath, previousPath, ...(work ? [join(work, 'incoming'), join(work, 'superseded'), join(work, 'exchange')] : [])];
  const current = () => {
    if (closed) throw new Error('Native directory update handle is closed');
    physicalCurrent(); for (const ref of refs) assertTree(ref);
    for (const path of paths()) if (!refs.some(ref => ref.active && ref.path === path) && existing(path)) throw new Error('Native directory update slot changed');
    physicalCurrent();
  };
  const live = () => { synchronous(admission); current(); };
  const originalLiveSlots = () => {
    physicalCurrent();
    for (const [path, ref] of [[targetPath, original], [previousPath, previous]] as const) {
      if (ref) { if (!ref.active || ref.path !== path) throw new Error('Original live directory has not been restored'); assertTree(ref); }
      else if (existing(path)) throw new Error('Originally absent live directory appeared');
    }
    physicalCurrent();
  };
  const move = (ref: Tree, to: string) => {
    current(); if (existing(to)) throw new Error('Native directory update destination is occupied');
    const from = ref.path;
    fs.renameSync(from, to); ref.path = to;
    moves.push({ tree: ref, from, to }); current();
  };
  const undo = () => {
    // Compensation is bookkeeping under original physical ownership, independent
    // of a cancelled caller. Each completed move is retired only after reversal.
    while (moves.length) {
      current(); const last = moves[moves.length - 1]!;
      if (last.tree.path !== last.to || existing(last.from)) throw new Error('Native directory compensation is blocked');
      fs.renameSync(last.to, last.from); last.tree.path = last.from; moves.pop(); current();
    }
    committed = false; recoveryRequired = false;
  };
  const removeTree = (ref: Tree) => {
    current();
    // One complete admission, then original leaf + ancestor checks. Rebuilding
    // the whole inventory per unlink would make driver cleanup quadratic.
    for (const [relative, value] of [...ref.entries].sort(([a], [b]) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
      physicalCurrent();
      for (let ancestor = relative;; ancestor = dirname(ancestor) === '.' ? '' : dirname(ancestor)) {
        const expected = ref.entries.get(ancestor), actual = entry(join(ref.path, ancestor), ancestor);
        if (!expected || expected.kind !== actual.kind || expected.identity !== actual.identity) throw new Error('Original native cleanup entry changed');
        if (!ancestor) break;
      }
      physicalCurrent(); const path = join(ref.path, relative);
      if (value.kind === 'file') fs.unlinkSync(path); else fs.rmdirSync(path);
      // An inserted unknown child makes rmdir fail; it is never enumerated and
      // deleted to force a directory removal through.
      ref.entries.delete(relative);
      if (relative === '') ref.active = false;
    }
    physicalCurrent();
  };
  const removeEmptyWork = () => {
    if (!work) return;
    physicalCurrent();
    if (fs.readdirSync(work).length) { if (!preservedPaths.some(path => path === work || path.startsWith(work! + '/'))) preservedPaths.push(work); return; }
    fs.rmdirSync(work); work = undefined; workOwner = undefined;
  };
  const result = () => Object.freeze({ preservedPaths: Object.freeze([...preservedPaths]) });
  try {
    retained.assertCurrent();
    original = proof.original ? { path: targetPath, entries: new Map(proof.original.entries), active: true } : undefined; previous = tree(previousPath);
    if (original) refs.push(original); if (previous) refs.push(previous);
    previousVersion = previousReleaseVersion(previous);
    if (!members && (!original || !previous)) throw new Error('Native directory rollback requires live and previous trees');
    work = fs.mkdtempSync(join(parent, `.${basename(targetPath)}.update-`)); fs.chmodSync(work, 0o700);
    workOwner = retainNativeUpdateDirectory(work); physicalCurrent();
    if (members) {
      const destination = join(work, 'incoming');
      fs.mkdirSync(destination, { mode: 0o700 }); created.push({ path: destination, identity: creationIdentity(fs.lstatSync(destination, { bigint: true })), directory: true });
      createdDirectories.set(destination, created[created.length - 1]!.identity);
      createdParentCurrent(join(destination, '.custody')); fs.chmodSync(destination, 0o755);
      const ensure = (path: string) => {
        const parts = path.slice(destination.length + 1).split('/'); let currentPath = destination;
        for (const part of parts) {
          if (!part) continue; currentPath = join(currentPath, part); createdParentCurrent(currentPath);
          const stat = existing(currentPath);
          if (stat) {
            if (createdDirectories.get(currentPath) !== creationIdentity(stat) || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native staging directory changed');
          } else {
            fs.mkdirSync(currentPath, { mode: 0o755 }); fs.chmodSync(currentPath, 0o755);
            created.push({ path: currentPath, identity: creationIdentity(fs.lstatSync(currentPath, { bigint: true })), directory: true });
            createdDirectories.set(currentPath, created[created.length - 1]!.identity);
          }
        }
      };
      const write = (path: string, data: Buffer, mode: number) => {
        ensure(dirname(path)); createdParentCurrent(path);
        const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        const original = creationIdentity(fs.fstatSync(fd, { bigint: true }));
        created.push({ path, identity: original, directory: false });
        const originalFile = (expectedMode?: number) => {
          createdParentCurrent(path);
          const opened = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(path, { bigint: true });
          if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || creationIdentity(opened) !== original || creationIdentity(named) !== original || (expectedMode !== undefined && Number(opened.mode & 0o7777n) !== expectedMode)) throw new Error('Original native staging file changed');
          physicalCurrent();
        };
        try {
          originalFile(); fs.fchmodSync(fd, mode); originalFile(mode);
          fs.writeFileSync(fd, data); originalFile(mode); fs.fsyncSync(fd); originalFile(mode);
          sealedFiles.set(path, identity(fs.fstatSync(fd, { bigint: true })));
        } finally { fs.closeSync(fd); }
      };
      for (const member of members) {
        physicalCurrent(); synchronous(admission); physicalCurrent();
        const path = join(destination, member.path);
        if (member.kind === 'directory') { ensure(path); continue; }
        write(path, member.data, member.mode & 0o111 ? 0o755 : 0o644);
      }
      if (options.sourceVersion !== undefined) write(join(destination, NATIVE_UPDATE_DIRECTORY_RELEASE_FILE), Buffer.from(JSON.stringify({ schema: 1, version: options.sourceVersion }) + '\n'), 0o644);
      createdParentCurrent(join(destination, '.custody')); incoming = tree(destination)!;
      if (incoming.entries.size !== created.length) throw new Error('Native staging acquired unknown entries');
      for (const node of created) {
        createdParentCurrent(node.path); const stat = fs.lstatSync(node.path, { bigint: true });
        if (creationIdentity(stat) !== node.identity || stat.isSymbolicLink() || (node.directory
          ? !stat.isDirectory() || Number(stat.mode & 0o7777n) !== 0o755
          : !stat.isFile() || identity(stat) !== sealedFiles.get(node.path))) throw new Error('Original native staged entry changed before admission');
      }
      refs.push(incoming);
    }
    live();
  } catch (error) {
    // A failed exclusive open never owns the conflicting leaf. Never recursively
    // delete a pathname just because it resembles our staging namespace.
    for (const node of [...created].reverse()) {
      try {
        createdParentCurrent(node.path); const stat = existing(node.path); if (!stat || creationIdentity(stat) !== node.identity) continue;
        if (node.directory) fs.rmdirSync(node.path); else fs.unlinkSync(node.path);
      } catch { /* Preserve replaced/unknown children and retired parents. */ }
    }
    try { removeEmptyWork(); } catch { if (work) preservedPaths.push(work); }
    try { release(); } catch { preservedPaths.push(claimPath); }
    throw new NativeDirectoryUpdateError(false, Object.freeze([...new Set(preservedPaths)]), { cause: error });
  }
  return {
    targetPath, ...(previousVersion === undefined ? {} : { previousVersion }),
    get committed() { return committed; }, get recoveryRequired() { return recoveryRequired; },
    assertCurrent: live,
    commit() {
      if (completed) { live(); return; }
      if (recoveryRequired) throw new NativeDirectoryUpdateError(true, [work!, claimPath]);
      live(); retained.assertCurrent();
      try {
        if (members) {
          if (previous) move(previous, join(work!, 'superseded'));
          if (original) move(original, previousPath);
          move(incoming!, targetPath);
        } else {
          move(original!, join(work!, 'exchange')); move(previous!, targetPath); move(original!, previousPath);
        }
        committed = true; completed = true; current();
      } catch (error) {
        try { undo(); } catch { recoveryRequired = true; }
        throw new NativeDirectoryUpdateError(recoveryRequired, [work!, ...(recoveryRequired ? [claimPath] : [])], { cause: error });
      }
    },
    restore() {
      if (closed) throw new Error('Native directory update handle is closed');
      try { undo(); completed = false; }
      catch (error) { recoveryRequired = true; throw new NativeDirectoryUpdateError(true, [work!, claimPath], { cause: error }); }
    },
    finish() {
      if (closed) return result();
      if (!committed || recoveryRequired) throw new NativeDirectoryUpdateError(recoveryRequired, [work!, claimPath]);
      current();
      if (previous?.path === join(work!, 'superseded')) preservedPaths.push(previous.path);
      removeEmptyWork(); release(); closed = true; return result();
    },
    preserve() {
      if (!closed) { recoveryRequired = true; if (work) preservedPaths.push(work); preservedPaths.push(claimPath); }
      return result();
    },
    dispose() {
      if (closed) return result();
      if (moves.length || committed || recoveryRequired) throw new NativeDirectoryUpdateError(true, [work!, claimPath]);
      try {
        if (incoming?.active) removeTree(incoming);
        removeEmptyWork(); originalLiveSlots(); release(); closed = true; return result();
      } catch (error) {
        // A private discarded stage is not an uncertain live publication. If
        // original live/previous slots and the original claim are still proven,
        // preserve the altered stage without wedging future native updates.
        try {
          originalLiveSlots(); if (work && !preservedPaths.includes(work)) preservedPaths.push(work);
          release(); closed = true; return result();
        } catch {
          recoveryRequired = true;
          throw new NativeDirectoryUpdateError(true, [work!, claimPath], { cause: error });
        }
      }
    },
  };
}
