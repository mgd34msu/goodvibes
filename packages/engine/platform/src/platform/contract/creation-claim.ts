/** One short creation reservation, not a contract journal or execution grant. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { captureExistingDirectory, createAtomicTempPath, prepareAtomicPublicationDirectory } from '../utils/atomic-json-store.js';
import { assertCrossProcessLockCurrent, tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { isContractId } from './types.js';
export interface ContractCreationClaim { assertCurrent(): void; release(): void }
const absent = (path: string): boolean => {
  try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
};
export function contractCreationPathAbsent(path: string): boolean { return absent(path); }
export function claimContractCreation(projectRoot: string, id: string): ContractCreationClaim {
  if (!isContractId(id)) throw new Error('Invalid contract creation identity');
  const root = captureExistingDirectory(projectRoot);
  const parent = prepareAtomicPublicationDirectory(join(root.canonical, '.goodvibes', 'contracts', '.creation-claims'), { assertCurrent: () => root.assertCurrent() });
  const release = tryAcquireCrossProcessLock(join(parent.canonical, `${id}.lock`), { assertCurrent: () => { root.assertCurrent(); parent.assertCurrent(); } });
  if (!release) throw new Error('Contract identity is being created');
  let retired = false;
  return Object.freeze({ assertCurrent() {
    if (retired) throw new Error('Contract creation reservation has retired');
    root.assertCurrent(); parent.assertCurrent(); assertCrossProcessLockCurrent(release);
  }, release() { if (retired) return; retired = true; release(); } });
}
/** A read may recover a dead creator, but never adopt an actively publishing
 * checkpoint. Absent readonly probes create no directories or claim files. */
export function retainContractCreationRead(projectRoot: string, id: string): (() => void) | undefined {
  if (!isContractId(id)) throw new Error('Invalid contract creation identity');
  const path = join(projectRoot, '.goodvibes', 'contracts', '.creation-claims', `${id}.lock`);
  if (absent(path)) return undefined;
  const parent = captureExistingDirectory(dirname(path));
  const release = tryAcquireCrossProcessLock(path, { assertCurrent: () => parent.assertCurrent() });
  if (!release) throw new Error('Contract identity is still being created');
  return release;
}
const inode = (stat: BigIntStats): string => [stat.dev, stat.ino, stat.uid, stat.gid, stat.birthtimeNs].join(':');
/** Publish complete bytes if and ONLY if the original selected name is absent.
 * The final link is exclusive; a foreign leaf can never be renamed over. */
export function publishInitialContractCheckpoint(directory: string, id: string, text: string, assertCurrent: () => void): { readonly path: string; assertCurrent(): void } {
  const parent = prepareAtomicPublicationDirectory(directory, { assertCurrent });
  const target = join(parent.canonical, `${id}.json`), stage = createAtomicTempPath(target);
  let fd: number | undefined, owned: BigIntStats | undefined, stageRetired = false;
  const current = () => { assertCurrent(); parent.assertCurrent(); };
  const ownStage = () => {
    current(); if (fd === undefined || !owned) throw new Error('Contract creation stage is unavailable');
    const actual = lstatSync(stage, { bigint: true }), descriptor = fstatSync(fd, { bigint: true });
    if (!actual.isFile() || actual.isSymbolicLink() || inode(actual) !== inode(owned) || inode(descriptor) !== inode(owned)) throw new Error('Contract creation stage changed');
  };
  try {
    current(); if (!absent(target)) throw new Error('Contract identity is already stored');
    fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    owned = fstatSync(fd, { bigint: true }); ownStage();
    fchmodSync(fd, 0o600); ownStage();
    writeFileSync(fd, text, 'utf8'); fsyncSync(fd); ownStage();
    const prepared = fstatSync(fd, { bigint: true });
    if (prepared.size !== BigInt(Buffer.byteLength(text, 'utf8')) || (prepared.mode & 0o777n) !== 0o600n || prepared.nlink !== 1n) throw new Error('Contract creation stage is incomplete');
    // Every shared claim/owner restriction runs immediately before the only
    // publication syscall; link fails on any occupied regular/symlink leaf.
    current(); linkSync(stage, target);
    const published = lstatSync(target, { bigint: true });
    if (!published.isFile() || published.isSymbolicLink() || inode(published) !== inode(owned)) throw new Error('Contract creation publication changed');
    // Do not repeat logical absence checks after our own exclusive publication.
    parent.assertCurrent(); ownPhysicalStage(); unlinkSync(stage); stageRetired = true;
    const sync = new Set(parent.durabilityDirectories);
    let ancestor = parent.canonical;
    for (let depth = 0; depth < 4; depth++) { sync.add(ancestor); ancestor = dirname(ancestor); }
    for (const path of sync) { parent.assertCurrent(); const directoryFd = openSync(path, constants.O_RDONLY); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); } }
    parent.assertCurrent();
    const final = lstatSync(target, { bigint: true });
    if (inode(final) !== inode(owned) || final.nlink !== 1n || final.size !== prepared.size || final.mtimeNs !== prepared.mtimeNs || (final.mode & 0o777n) !== 0o600n) throw new Error('Contract creation publication changed');
    const physical = fileObservationIdentity(target);
    const result = Object.freeze({ path: target, assertCurrent() {
      parent.assertCurrent(); if (fileObservationIdentity(target) !== physical) throw new Error('Original contract creation publication changed');
    } });
    result.assertCurrent(); return result;
  } finally {
    // Failed opens have no created leaf. Late foreign replacements and retired
    // parent trees are preserved; no name-only cleanup or final-target removal.
    try { if (fd !== undefined && owned && !stageRetired) { parent.assertCurrent(); ownPhysicalStage(); unlinkSync(stage); } }
    catch { /* Preserve unproven staging; never delete an unknown leaf or final publication. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function ownPhysicalStage(): void {
    if (fd === undefined || !owned) throw new Error('Contract creation stage is unavailable');
    const actual = lstatSync(stage, { bigint: true }), descriptor = fstatSync(fd, { bigint: true });
    if (!actual.isFile() || actual.isSymbolicLink() || inode(actual) !== inode(owned) || inode(descriptor) !== inode(owned)) throw new Error('Contract creation stage changed');
  }
}
