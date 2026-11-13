import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PACKAGE = 'goodvibes-jev';
export const SERVICE = 'goodvibes-jev.service';
export const COMMANDS = ['goodvibes', 'goodvibes-agent', 'goodvibes-daemon', 'goodvibes-uninstall'] as const;
export interface Layout { prefix: string; binDir: string; dataDir: string; home: string }
export interface Installation extends Layout {
  /** v1 contains digests; v2 retains exact generated wrapper/unit text. */
  schema: 1 | 2;
  package: typeof PACKAGE;
  id: string;
  release: string;
  sourceCommit: string;
  port: number;
  workspace?: string;
  service: boolean;
  unit: string;
  wrappers: Record<string, string>;
}
export type Run = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean }) => string;
export const run: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) {
    // Never echo argv/environment: config commands may carry credentials.
    throw new Error(`${command} failed${result.status === null ? '' : ` (${result.status})`}${options.capture && result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
};
export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const present = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
export function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
/** Keep runtime files needed by a terminal or agent that is still running the previous release. */
export function isReleaseInUse(release: string, procRoot = '/proc'): boolean {
  try {
    for (const entry of readdirSync(procRoot)) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const directory = join(procRoot, entry);
      try {
        if (process.getuid && lstatSync(directory).uid !== process.getuid()) continue;
        try { if (contained(release, readlinkSync(join(directory, 'exe')))) return true; }
        catch (error) {
          if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
        // Same-user service managers may protect their exe link. argv also
        // covers an installed script running through an external interpreter.
        for (const argument of readFileSync(join(directory, 'cmdline'), 'utf8').split('\0'))
          if (isAbsolute(argument) && contained(release, argument)) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
      }
    }
    return false;
  } catch { return true; }
}
/** No installation or deletion through a symlink, including a dangling one. */
export function plainPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error(`Expected a normalized absolute path: ${path}`);
  let current = path;
  for (;;) {
    if (present(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink path: ${current}`);
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export function validateLayout(layout: Layout): void {
  const { prefix, binDir, dataDir, home } = layout;
  plainPath(home);
  for (const path of [prefix, binDir, dataDir]) {
    plainPath(path);
    if (!contained(home, path) || path === home) throw new Error('Installation, commands and data must be separate directories below your home.');
  }
  for (const [a, b] of [[prefix, binDir], [prefix, dataDir], [binDir, dataDir]]) {
    if (contained(a!, b!) || contained(b!, a!)) throw new Error('Installation, command and data directories must not overlap.');
  }
  const unit = unitPath(layout);
  plainPath(unit);
  if ([prefix, binDir, dataDir].some(path => contained(path, unit))) throw new Error('Installation paths must not contain the systemd unit directory.');
}
export const unitPath = (layout: Layout): string => join(layout.home, '.config/systemd/user', SERVICE);
export const receiptPath = (layout: Layout): string => join(layout.prefix, 'installation.json');
export function atomicWrite(path: string, contents: string, mode = 0o600): void {
  plainPath(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.pending-${process.pid}`;
  writeFileSync(pending, contents, { mode, flag: 'wx' });
  try { chmodSync(pending, mode); renameSync(pending, path); } finally { rmSync(pending, { force: true }); }
}
export function readInstallation(prefix: string): Installation | undefined {
  plainPath(prefix);
  const path = join(prefix, 'installation.json');
  if (!present(path)) return undefined;
  plainPath(path);
  const value = JSON.parse(readFileSync(path, 'utf8')) as Installation;
  if ((value.schema !== 1 && value.schema !== 2) || value.package !== PACKAGE || value.prefix !== prefix || !/^[0-9a-f-]{36}$/.test(value.id)
    || !/^[0-9a-f]{40}-[0-9a-f-]{36}$/.test(value.release) || !/^[0-9a-f]{40}$/.test(value.sourceCommit)
    || typeof value.service !== 'boolean' || typeof value.unit !== 'string' || !value.wrappers
    || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('Invalid Jev installation receipt.');
  validateLayout(value);
  for (const name of COMMANDS) if (typeof value.wrappers[name] !== 'string') throw new Error('Invalid command ownership receipt.');
  return value;
}

/** v1 saved only a digest of each generated file. Reading that existing receipt
 * is the only remaining hashing path: it lets an update/uninstall detect edits
 * without trusting the current file as its own expected content. Every new
 * receipt saves the original generated UTF-8 text and compares bytes directly.
 */
function managedFileMatches(path: string, expected: string, schema: Installation['schema']): boolean {
  const actual = readFileSync(path);
  return schema === 1 ? createHash('sha256').update(actual).digest('hex') === expected
    : actual.equals(Buffer.from(expected, 'utf8'));
}
export function dataOwner(layout: Layout): string { return join(layout.dataDir, '.goodvibes-jev-owner.json'); }
export function readDataId(layout: Layout): string | undefined {
  const marker = dataOwner(layout); plainPath(marker);
  if (!present(marker)) return undefined;
  const value = JSON.parse(readFileSync(marker, 'utf8')) as { package?: string; id?: string; dataDir?: string; prefix?: string };
  if (value.package !== PACKAGE || value.dataDir !== layout.dataDir || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id)) throw new Error('Invalid Jev data ownership marker.');
  const ownerPrefix = value.prefix ?? layout.prefix;
  const owner = readInstallation(ownerPrefix);
  if (ownerPrefix !== layout.prefix && owner?.id === value.id) throw new Error(`Data directory is in use by another installation: ${ownerPrefix}`);
  if (!value.prefix && owner?.id !== value.id) throw new Error('Legacy data ownership cannot be established. Update the owning installation before moving its data.');
  return value.id;
}
export function assertOwnedFiles(receipt: Installation): void {
  validateLayout(receipt);
  for (const name of COMMANDS) {
    const link = join(receipt.binDir, name);
    if (present(link) && (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== join(receipt.prefix, 'commands', name))) {
      throw new Error(`Refusing to replace or remove another installation: ${link}`);
    }
    const wrapper = join(receipt.prefix, 'commands', name); plainPath(wrapper);
    const expected = receipt.wrappers[name];
    if (typeof expected !== 'string') throw new Error('Invalid command ownership receipt.');
    if (present(wrapper) && !managedFileMatches(wrapper, expected, receipt.schema)) throw new Error(`Managed command has been modified: ${wrapper}`);
  }
  const unit = unitPath(receipt); plainPath(unit);
  if (present(unit) && (!receipt.service || !managedFileMatches(unit, receipt.unit, receipt.schema))) throw new Error(`Service has been modified or is not owned: ${unit}`);
  const current = join(receipt.prefix, 'current');
  if (present(current) && (!lstatSync(current).isSymbolicLink() || readlinkSync(current) !== `releases/${receipt.release}`)) throw new Error('Installation current link has changed.');
  plainPath(join(receipt.prefix, 'releases', receipt.release));
  if (readDataId(receipt) !== receipt.id) throw new Error('User data does not belong to this installation.');
}
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return value && /^[0-9]+$/.test(value) ? value : undefined;
  } catch { return undefined; }
}
interface LockOwner { pid: number; startTime?: string }
function readLockOwner(lock: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    const { pid, startTime } = value as { pid?: unknown; startTime?: unknown };
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return { pid, ...(typeof startTime === 'string' ? { startTime } : {}) };
  } catch { return undefined; }
}
/** True only when the recorded process is provably gone (or its pid now belongs to a different process). */
function ownerIsDead(owner: LockOwner): boolean {
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (owner.startTime === undefined) return false;
  const current = processStartTime(owner.pid);
  return current !== undefined && current !== owner.startTime;
}
const heldLocks = new Set<string>();
/** Remove every lock this process still holds. Used by signal handling, where the work cannot unwind. */
export function releaseHeldLocks(): void {
  for (const lock of heldLocks) rmSync(lock, { recursive: true, force: true });
  heldLocks.clear();
}
function acquireLock(lock: string): void {
  const refuse = (detail: string): never => { throw new Error(`Another install/uninstall may be running (${lock}). ${detail}`); };
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch {
    const owner = readLockOwner(lock);
    if (!owner) refuse(`This lock has no owner record (created by an older version, or being created right now). Check that no install or uninstall is running, then remove it with: rmdir '${lock}'`);
    else if (!ownerIsDead(owner!)) refuse(`It is held by running process ${owner!.pid}. Wait for it to finish, or stop it first.`);
    // The owner is gone. Move the lock aside atomically so only one contender reclaims it,
    // and confirm that what we moved is still the dead owner's record before deleting it.
    const aside = `${lock}.stale-${process.pid}`;
    try { renameSync(lock, aside); } catch { refuse('Another process is reclaiming it; retry in a moment.'); }
    const moved = readLockOwner(aside);
    if (moved?.pid !== owner!.pid || moved?.startTime !== owner!.startTime) {
      try { renameSync(aside, lock); } catch { /* a new lock now exists; leave the moved one for inspection */ }
      refuse('The lock changed while it was being reclaimed; retry in a moment.');
    }
    rmSync(aside, { recursive: true, force: true });
    try { mkdirSync(lock, { mode: 0o700 }); } catch { refuse('Another process took it first; retry in a moment.'); }
  }
  const startTime = processStartTime(process.pid);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, ...(startTime ? { startTime } : {}) }), { mode: 0o600 });
  heldLocks.add(lock);
}
export function withLock<T>(prefix: string, work: () => Promise<T>): Promise<T> {
  plainPath(prefix); mkdirSync(dirname(prefix), { recursive: true, mode: 0o700 });
  const lock = `${prefix}.lock`;
  acquireLock(lock);
  // Release only a lock this process still holds: a signal handler may already have released it.
  return work().finally(() => { if (heldLocks.delete(lock)) rmSync(lock, { recursive: true, force: true }); });
}
export function assertServiceLocation(receipt: Installation, execute: Run): void {
  const fragment = execute('systemctl', ['--user', 'show', SERVICE, '--property=FragmentPath', '--value'], { capture: true });
  if (fragment && fragment !== unitPath(receipt)) throw new Error(`Systemd loaded a different ${SERVICE}; refusing to manage it.`);
}
export function stopService(receipt: Installation, execute: Run): void {
  assertServiceLocation(receipt, execute);
  execute('systemctl', ['--user', 'stop', SERVICE]);
  const state = execute('systemctl', ['--user', 'show', SERVICE, '--property=ActiveState', '--value'], { capture: true });
  if (state !== 'inactive' && state !== 'failed') throw new Error('The daemon has not stopped; keeping the installation intact.');
}
function serviceAlreadyRemoved(receipt: Installation, execute: Run): boolean {
  if (present(unitPath(receipt))) return false;
  const state = execute('systemctl', ['--user', 'show', SERVICE, '--property=ActiveState', '--value'], { capture: true });
  return state === 'inactive' || state === 'failed';
}
export async function uninstall(prefix: string, purge: boolean, execute: Run = run): Promise<void> {
  await withLock(prefix, async () => {
    const receipt = readInstallation(prefix);
    if (!receipt) { console.log(`No Jev installation at ${prefix}. Preserved data remains untouched.`); return; }
    await withLock(receipt.dataDir, async () => {
      if (realpathSync(process.env.HOME ?? '') !== receipt.home) throw new Error('Run uninstall as the user who owns this installation.');
      assertOwnedFiles(receipt);
      if (receipt.service) {
        // A re-run after a failure that came after the unit was removed: nothing is left to stop or disable.
        if (!serviceAlreadyRemoved(receipt, execute)) {
          stopService(receipt, execute);
          execute('systemctl', ['--user', 'disable', SERVICE]);
        }
        rmSync(unitPath(receipt), { force: true });
        execute('systemctl', ['--user', 'daemon-reload']);
      }
      for (const name of COMMANDS) rmSync(join(receipt.binDir, name), { force: true });
      // Data lives outside the program prefix. Only an explicit purge removes it.
      if (purge) { plainPath(receipt.dataDir); rmSync(receipt.dataDir, { recursive: true }); }
      rmSync(prefix, { recursive: true });
      console.log(purge ? 'GoodVibes Jev uninstalled, including its data.' : `GoodVibes Jev uninstalled. Data and credentials preserved at ${receipt.dataDir}`);
    });
  });
}
