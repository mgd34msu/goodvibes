/** Shared private native selector persistence. The caller supplies only a
 * platform-owned format; physical ownership, file modes and write fencing are
 * identical for Discord, Slack, email and generic triage selectors. */
import { chmodSync, lstatSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { writeJsonFileAtomic } from '../../state/durable-file-io.js';
import { tryAcquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';
import { readFileObservation, fileObservationIdentity } from '../../utils/file-observation.js';

export interface InboxIdentityRegistryFormat<R> {
  readonly fileName: string;
  parse(value: unknown): R;
  empty(): R;
  assertStored(registry: R, directory: string): void;
}
export interface InboxIdentityRegistryOwner {
  readonly workingDirectory: string;
  readonly assertCurrent: () => void;
  /** Actual admitted installation owner; synchronous and completed before publication. */
  readonly beforeWrite?: (() => void) | undefined;
}
const unavailable = () => new Error('Inbox native identity registry is unavailable');
export function captureRegistryOwner(owner: InboxIdentityRegistryOwner): InboxIdentityRegistryOwner {
  return Object.freeze({ workingDirectory: owner.workingDirectory, assertCurrent: owner.assertCurrent.bind(owner), beforeWrite: owner.beforeWrite?.bind(owner) });
}
export function synchronous(check: () => void): void { const result: unknown = check(); if (result !== undefined) { drainOwned(result); throw unavailable(); } }
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function directoryStamp(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.geteuid && stat.uid !== BigInt(process.geteuid()))) throw unavailable();
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
}
function lockStamp(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw unavailable();
  // Heartbeat changes mtime/ctime; retained inode, owner, birth and payload prove this lease.
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.birthtimeNs].join(':');
}
export async function updateInboxIdentityRegistry<R, T>(owner: InboxIdentityRegistryOwner, format: InboxIdentityRegistryFormat<R>, change: (registry: R, directory: string, assertCurrent: () => void) => { value: T; changed: boolean }): Promise<{ value: T; assertDirectoryCurrent: () => void }> {
  if (!/^[a-z][a-z0-9-]{0,95}\.json$/.test(format.fileName)) throw unavailable();
  owner = captureRegistryOwner(owner);
  synchronous(owner.assertCurrent);
  const root = realpathSync(owner.workingDirectory), rootStamp = directoryStamp(root);
  const directory = join(root, '.goodvibes', 'tui', 'operator');
  const paths = [root, join(root, '.goodvibes'), join(root, '.goodvibes', 'tui'), directory];
  const parents: Array<{ path: string; stamp: string }> = [];
  const missingDirectories: string[] = [];
  // Validate every existing ancestor before creating anything. Recursive mkdir
  // would otherwise traverse an existing alias before the later fence rejects it.
  for (const path of paths) {
    try { parents.push({ path, stamp: directoryStamp(path) }); }
    catch (error) { if (!missing(error)) throw unavailable(); missingDirectories.push(path); }
  }
  const assertParents = () => {
    synchronous(owner.assertCurrent);
    if (realpathSync(owner.workingDirectory) !== root || parents.some(parent => directoryStamp(parent.path) !== parent.stamp)) throw unavailable();
  };
  for (const path of missingDirectories) {
    assertParents(); mkdirSync(path, { mode: 0o700 });
    const original = lstatSync(path, { bigint: true });
    const created = { path, stamp: directoryStamp(path) }; parents.push(created); assertParents();
    // Publish permissions on this exact newly created entry before traversing
    // it. A restrictive umask must not strand the next managed descendant.
    chmodSync(path, 0o700);
    const after = lstatSync(path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== original.dev || after.ino !== original.ino
      || after.uid !== original.uid || after.gid !== original.gid || after.birthtimeNs !== original.birthtimeNs
      || (after.mode & 0o777n) !== 0o700n) throw unavailable();
    created.stamp = directoryStamp(path); assertParents();
  }
  const path = join(directory, format.fileName), lock = `${path}.owner.lock`;
  const release = tryAcquireCrossProcessLock(lock);
  if (!release) throw unavailable();
  try {
    const held = lockStamp(lock), payload = readFileSync(lock);
    const current = () => {
      synchronous(owner.assertCurrent);
      if (realpathSync(owner.workingDirectory) !== root || directoryStamp(root) !== rootStamp
        || parents.some(parent => directoryStamp(parent.path) !== parent.stamp)
        || lockStamp(lock) !== held || !readFileSync(lock).equals(payload)) throw unavailable();
    };
    current();
    let observed: string | null = null, registry: R;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (stat.mode & 0o777) !== 0o600 || (process.geteuid && stat.uid !== process.geteuid()) || stat.size > 16 * 1024 * 1024) throw unavailable();
      const source = readFileObservation(path); observed = source.physical;
      registry = format.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)));
    } catch (error) {
      if (!missing(error)) throw unavailable();
      registry = format.empty();
    }
    format.assertStored(registry, directory);
    const selectedCurrent = () => {
      current();
      if (observed !== null) { if (fileObservationIdentity(path) !== observed) throw unavailable(); }
      else { try { lstatSync(path); } catch (error) { if (missing(error)) return; throw unavailable(); } throw unavailable(); }
    };
    selectedCurrent();
    const result = change(registry, directory, selectedCurrent);
    selectedCurrent();
    if (owner.beforeWrite) synchronous(owner.beforeWrite);
    selectedCurrent();
    if (result.changed) {
      format.parse(registry);
      selectedCurrent();
      writeJsonFileAtomic(path, registry, { durable: true, mode: 0o600, cleanupStaleTemps: false, assertCurrent: selectedCurrent });
      observed = fileObservationIdentity(path); current();
    }
    if (observed === null) throw unavailable();
    return { value: result.value, assertDirectoryCurrent: () => {
      if (realpathSync(owner.workingDirectory) !== root || parents.some(parent => directoryStamp(parent.path) !== parent.stamp)) throw unavailable();
    } };
  } catch { throw unavailable(); }
  finally { release(); }
}
