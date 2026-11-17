/**
 * Reversible native directory publication (the browser driver and the served
 * web UI). The guarantees: one updater per target at a time (a cross-process
 * claim file), the new tree appears whole (it is staged in a private 0700
 * work directory, made durable and checked against the archive's entry list
 * before three renames put it in place), and the outgoing tree is kept as
 * `.previous`. A failed rename sequence is undone. Several renames are not
 * process-crash atomic; an interrupted publication is reported for recovery.
 *
 * Staging is asynchronous, so the daemon and the terminals keep answering
 * while a release directory is written.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { readTarGzEntries, type TarEntry } from '../browser/browser-driver-archive.js';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { retainNativeUpdateDirectory } from './update-file-io.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

export interface NativeDirectoryPreparationOptions {
  readonly stripComponents?: number;
  readonly sourceVersion?: string;
  readonly expectedRoot?: string;
  readonly retainedTarget?: NativeUpdateTreeObservation;
  readonly requiredFiles?: readonly string[];
  readonly maxArchiveBytes?: number;
  /** Live admission only. Compensation/cleanup do not consult it. */
  readonly assertCurrent?: (() => void) | undefined;
}
export interface NativeUpdateTreeObservation { readonly targetPath: string; assertCurrent(): void }
interface RetainedTree { readonly targetPath: string; readonly parent: ReturnType<typeof retainNativeUpdateDirectory>; readonly root: string | undefined }
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
  /** Keep the outgoing live tree at .previous. An older marked release is removed; unknown older trees are preserved. */
  finish(): NativeDirectoryFinishResult;
  /** Discard owned staging after restoration. Never silently undo a committed update. */
  dispose(): NativeDirectoryFinishResult;
  /** Leave the claim and staging intact when the enclosing file cohort needs recovery. */
  preserve(): NativeDirectoryFinishResult;
}
export type NativeUpdateDirectory = PreparedNativeUpdateDirectory;
export const NATIVE_UPDATE_DIRECTORY_RELEASE_FILE = '.goodvibes-release.json';
const releaseVersionSyntax = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
export class NativeDirectoryUpdateError extends Error {
  constructor(readonly recoveryRequired: boolean, readonly preservedPaths: readonly string[], options?: ErrorOptions) {
    super(recoveryRequired ? 'Native directory update requires recovery; the claim and trees are retained'
      : 'Native directory update did not complete; preserved paths remain available', options);
    this.name = 'NativeDirectoryUpdateError';
  }
}

/** Staged files written and made durable at once. */
const STAGING_CONCURRENCY = 32;
/** Most entries one release tree may hold. */
const MAX_TREE_ENTRIES = 100_000;

const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const existing = (path: string) => { try { return fs.lstatSync(path, { bigint: true }); } catch (error) { if (missing(error)) return undefined; throw error; } };
function physical(stat: fs.BigIntStats): string { return [stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.uid, stat.gid].join(':'); }
/** A tree root's identity, or undefined when nothing is there. A root that is not an ordinary directory is refused. */
function rootIdentity(path: string): string | undefined {
  const stat = existing(path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Native update target is not a directory');
  return physical(stat);
}

/**
 * Retain the selected live tree (or its absence) before network work: later
 * checks compare the tree root's identity, so a tree replaced or removed
 * meanwhile is refused. One lstat per check.
 */
export function retainNativeUpdateTree(selected: string): NativeUpdateTreeObservation {
  const targetPath = resolve(selected), parent = retainNativeUpdateDirectory(dirname(targetPath));
  parent.assertCurrent();
  const root = rootIdentity(targetPath);
  const observation = Object.freeze({ targetPath, assertCurrent() {
    parent.assertCurrent();
    if (rootIdentity(targetPath) !== root) throw new Error(root ? 'Native update tree was replaced' : 'Originally absent native update tree appeared');
  } });
  retainedTrees.set(observation, { targetPath, parent, root });
  return observation;
}
function relativePath(value: string): string[] {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('�')) throw new Error('Invalid native archive path');
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
    if (files.size >= MAX_TREE_ENTRIES) throw new Error('Native archive exceeds its entry limit');
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
/** The release a tree's marker names, or undefined for a tree without a valid marker (not ours to remove). */
function releaseVersionOf(path: string): string | undefined {
  const markerPath = join(path, NATIVE_UPDATE_DIRECTORY_RELEASE_FILE);
  const stat = existing(markerPath);
  if (!stat?.isFile() || stat.size > 4096n) return undefined;
  let marker: unknown;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { return undefined; }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return undefined;
  const row = marker as Record<string, unknown>;
  return row['schema'] === 1 && releaseVersionSyntax(row['version']) && Object.keys(row).every(key => ['schema', 'version', 'kind'].includes(key))
    && (row['kind'] === undefined || typeof row['kind'] === 'string') ? row['version'] : undefined;
}
function synchronous(check: (() => void) | undefined): void {
  assertSynchronousJudgmentGuard(check, () => new Error('Native directory admission must be synchronous'));
}

/** Every path the staged tree should hold: the archive's entries, the directories they imply, and the release marker. */
function expectedEntries(members: readonly TarEntry[], sourceVersion: string | undefined): Map<string, 'file' | 'directory'> {
  const expected = new Map<string, 'file' | 'directory'>();
  const addParents = (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) expected.set(parts.slice(0, i).join('/'), 'directory');
  };
  for (const member of members) { addParents(member.path); expected.set(member.path, member.kind === 'file' ? 'file' : 'directory'); }
  if (sourceVersion !== undefined) expected.set(NATIVE_UPDATE_DIRECTORY_RELEASE_FILE, 'file');
  return expected;
}

/** Write the archive into `destination` (inside the private work directory) and make every file durable. */
async function stageArchive(destination: string, members: readonly TarEntry[], sourceVersion: string | undefined, admission: () => void): Promise<void> {
  const directories = new Set<string>();
  for (const member of members) {
    const parts = member.path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    if (member.kind === 'directory') directories.add(member.path);
  }
  // Parents before children; mkdir's mode is narrowed by the umask, so set it explicitly.
  await fsp.mkdir(destination, { mode: 0o755 });
  await fsp.chmod(destination, 0o755);
  for (const relative of [...directories].sort((a, b) => a.split('/').length - b.split('/').length)) {
    const path = join(destination, relative);
    await fsp.mkdir(path, { mode: 0o755 });
    await fsp.chmod(path, 0o755);
  }
  const files: { readonly path: string; readonly data: Buffer; readonly mode: number }[] = members
    .filter(member => member.kind === 'file')
    .map(member => ({ path: join(destination, member.path), data: member.data, mode: member.mode & 0o111 ? 0o755 : 0o644 }));
  if (sourceVersion !== undefined) {
    files.push({ path: join(destination, NATIVE_UPDATE_DIRECTORY_RELEASE_FILE), data: Buffer.from(JSON.stringify({ schema: 1, version: sourceVersion }) + '\n'), mode: 0o644 });
  }
  await mapWithConcurrency(files, STAGING_CONCURRENCY, async (file) => {
    admission();
    // Exclusive create: a name that already exists in the private stage was not written by us.
    const handle = await fsp.open(file.path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      await handle.chmod(file.mode);
      await handle.writeFile(file.data);
      // Durable before the rename publishes it: a crash after the swap must not leave empty files live.
      await handle.datasync();
    } finally {
      await handle.close();
    }
  });
}

/** One walk of the staged tree: it holds exactly the expected names, as ordinary files and directories. */
async function verifyStagedTree(destination: string, expected: ReadonlyMap<string, 'file' | 'directory'>): Promise<void> {
  let seen = 0;
  const walk = async (relative: string): Promise<void> => {
    for (const dirent of await fsp.readdir(join(destination, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${dirent.name}` : dirent.name;
      const kind = dirent.isFile() ? 'file' : dirent.isDirectory() ? 'directory' : undefined;
      if (kind === undefined || expected.get(path) !== kind) throw new Error('Native staging holds an entry the archive did not');
      seen += 1;
      if (kind === 'directory') await walk(path);
    }
  };
  await walk('');
  if (seen !== expected.size) throw new Error('Native staging is missing entries from the archive');
}

/** New release tree. All archive validation completes before taking filesystem ownership. */
export async function prepareNativeUpdateDirectory(targetPath: string, archive: Buffer | Uint8Array,
  options: NativeDirectoryPreparationOptions = {}): Promise<PreparedNativeUpdateDirectory> {
  options = Object.freeze({ ...options, ...(options.requiredFiles === undefined ? {} : { requiredFiles: Object.freeze([...options.requiredFiles]) }) });
  const members = archiveEntries(archive, options);
  const handle = claimTarget(targetPath, options, true);
  try {
    const destination = join(handle.work, 'incoming');
    await stageArchive(destination, members, options.sourceVersion, handle.admit);
    await verifyStagedTree(destination, expectedEntries(members, options.sourceVersion));
    handle.live();
  } catch (error) {
    throw handle.abandon(error);
  }
  return handle.prepared;
}
/** Explicit exchange with the selected existing .previous directory. */
export function prepareNativeDirectoryRollback(targetPath: string,
  options: Omit<NativeDirectoryPreparationOptions, 'stripComponents' | 'sourceVersion' | 'expectedRoot' | 'requiredFiles' | 'maxArchiveBytes'> = {}): PreparedNativeUpdateDirectory {
  const handle = claimTarget(targetPath, Object.freeze({ ...options }), false);
  try { handle.live(); } catch (error) { throw handle.abandon(error); }
  return handle.prepared;
}

interface ClaimedTarget {
  readonly work: string;
  readonly prepared: PreparedNativeUpdateDirectory;
  /** The caller's own admission (cancel, deadline); no filesystem read. */
  admit(): void;
  live(): void;
  /** Remove the private work directory, release the claim, and give the error to throw. */
  abandon(error: unknown): NativeDirectoryUpdateError;
}

function claimTarget(selected: string, options: NativeDirectoryPreparationOptions, staging: boolean): ClaimedTarget {
  const targetPath = resolve(selected), previousPath = `${targetPath}.previous`, parent = dirname(targetPath);
  const retained = options.retainedTarget ?? retainNativeUpdateTree(targetPath), proof = retainedTrees.get(retained);
  if (!proof || proof.targetPath !== targetPath) throw new Error('Native directory target observation does not match');
  retained.assertCurrent();
  const parentOwner = proof.parent;
  const admission = options.assertCurrent?.bind(options);
  synchronous(admission); parentOwner.ensure(); parentOwner.assertCurrent();
  const claimPath = `${targetPath}.directory-update.lock`;
  const release = tryAcquireCrossProcessLock(claimPath, { assertCurrent: () => parentOwner.assertCurrent() });
  if (!release) throw new Error('Another native directory update owns this target');

  const originalRoot = proof.root;
  let claim: ReturnType<typeof physical>;
  let previousRoot: ReturnType<typeof rootIdentity>;
  let previousVersion: ReturnType<typeof releaseVersionOf> | undefined;
  let workPath: string;
  // Until the work directory exists every read can throw (a `.previous` that is
  // a link or a file, an unreadable marker); the claim is released with it, or
  // every later update of this directory is refused until the process restarts.
  try {
    claim = physical(fs.lstatSync(claimPath, { bigint: true }));
    previousRoot = rootIdentity(previousPath);
    previousVersion = previousRoot === undefined ? undefined : releaseVersionOf(previousPath);
    if (!staging && (originalRoot === undefined || previousRoot === undefined)) {
      throw new Error('Native directory rollback requires live and previous trees');
    }
    workPath = fs.mkdtempSync(join(parent, `.${basename(targetPath)}.update-`));
  } catch (error) {
    release();
    throw error;
  }
  try {
    fs.chmodSync(workPath, 0o700);
  } catch (error) {
    try { fs.rmdirSync(workPath); } catch { /* an empty private directory the next update reports */ }
    release();
    throw error;
  }
  const incomingPath = join(workPath, 'incoming'), supersededPath = join(workPath, 'superseded'), exchangePath = join(workPath, 'exchange');
  const moves: { readonly from: string; readonly to: string }[] = [];
  let completed = false, recoveryRequired = false, closed = false, committed = false, workRemoved = false;
  const preservedPaths: string[] = [];

  const claimCurrent = () => {
    if (physical(fs.lstatSync(claimPath, { bigint: true })) !== claim) throw new Error('Native directory update claim changed');
  };
  const live = () => {
    if (closed) throw new Error('Native directory update handle is closed');
    synchronous(admission); claimCurrent();
  };
  const move = (from: string, to: string) => {
    if (existing(to)) throw new Error('Native directory update destination is occupied');
    fs.renameSync(from, to);
    moves.push({ from, to });
  };
  const undo = () => {
    // Compensation runs under the claim, whatever the caller's admission says. Each move is retired only after reversal.
    claimCurrent();
    while (moves.length) {
      const last = moves[moves.length - 1]!;
      if (existing(last.from)) throw new Error('Native directory compensation is blocked');
      fs.renameSync(last.to, last.from); moves.pop();
    }
    committed = false; recoveryRequired = false;
  };
  /** The live and previous slots hold the trees they held when the update began. */
  const originalSlots = () => {
    if (rootIdentity(targetPath) !== originalRoot || rootIdentity(previousPath) !== previousRoot) throw new Error('Original live directory has not been restored');
  };
  const removeWork = () => {
    if (workRemoved) return;
    // The private work directory was created by this update (mkdtemp, 0700); everything in it is ours.
    fs.rmSync(workPath, { recursive: true, force: true });
    workRemoved = true;
  };
  const result = () => Object.freeze({ preservedPaths: Object.freeze([...new Set(preservedPaths)]) });

  const prepared: PreparedNativeUpdateDirectory = {
    targetPath, ...(previousVersion === undefined ? {} : { previousVersion }),
    get committed() { return committed; }, get recoveryRequired() { return recoveryRequired; },
    assertCurrent: live,
    commit() {
      if (completed) { live(); return; }
      if (recoveryRequired) throw new NativeDirectoryUpdateError(true, [workPath, claimPath]);
      live(); retained.assertCurrent();
      if (rootIdentity(previousPath) !== previousRoot) throw new Error('Native update previous tree changed');
      try {
        if (staging) {
          if (previousRoot !== undefined) move(previousPath, supersededPath);
          if (originalRoot !== undefined) move(targetPath, previousPath);
          move(incomingPath, targetPath);
        } else {
          move(targetPath, exchangePath); move(previousPath, targetPath); move(exchangePath, previousPath);
        }
        committed = true; completed = true;
      } catch (error) {
        try { undo(); } catch { recoveryRequired = true; }
        throw new NativeDirectoryUpdateError(recoveryRequired, [workPath, ...(recoveryRequired ? [claimPath] : [])], { cause: error });
      }
    },
    restore() {
      if (closed) throw new Error('Native directory update handle is closed');
      try { undo(); completed = false; }
      catch (error) { recoveryRequired = true; throw new NativeDirectoryUpdateError(true, [workPath, claimPath], { cause: error }); }
    },
    finish() {
      if (closed) return result();
      if (!committed || recoveryRequired) throw new NativeDirectoryUpdateError(recoveryRequired, [workPath, claimPath]);
      claimCurrent();
      // The outgoing live tree is the one backup this update keeps, so the generation before it is
      // superseded. A tree carrying our release marker is ours to remove; anything else stays and is reported.
      if (existing(supersededPath) && previousVersion === undefined) {
        preservedPaths.push(supersededPath);
      } else {
        try { removeWork(); } catch { preservedPaths.push(workPath); }
      }
      release(); closed = true; return result();
    },
    preserve() {
      if (!closed) { recoveryRequired = true; preservedPaths.push(workPath, claimPath); }
      return result();
    },
    dispose() {
      if (closed) return result();
      if (moves.length || committed || recoveryRequired) throw new NativeDirectoryUpdateError(true, [workPath, claimPath]);
      try {
        originalSlots();
      } catch (error) {
        recoveryRequired = true;
        throw new NativeDirectoryUpdateError(true, [workPath, claimPath], { cause: error });
      }
      // A discarded private stage is not an uncertain live publication: a removal that fails leaves it reported.
      try { removeWork(); } catch { preservedPaths.push(workPath); }
      release(); closed = true; return result();
    },
  };
  return {
    work: workPath,
    prepared,
    admit: () => synchronous(admission),
    live,
    abandon(error: unknown) {
      try { removeWork(); } catch { preservedPaths.push(workPath); }
      try { release(); } catch { preservedPaths.push(claimPath); }
      closed = true;
      return new NativeDirectoryUpdateError(false, Object.freeze([...new Set(preservedPaths)]), { cause: error });
    },
  };
}
