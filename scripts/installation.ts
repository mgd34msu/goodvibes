import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProcessLockBusyError, withProcessLock } from '../packages/engine/platform/src/platform/utils/process-lock.ts';

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
/**
 * A command that could not start or exited non-zero. Callers decide on `status` and `spawnCode`, never on the
 * message. Never carries argv or the environment: config commands may carry credentials.
 */
export class CommandError extends Error {
  constructor(readonly command: string, readonly status: number | null, readonly spawnCode: string | undefined, stderr = '') {
    super(`${command} ${spawnCode ? `could not be started (${spawnCode})` : `failed${status === null ? '' : ` (${status})`}`}${stderr ? `: ${stderr}` : ''}`);
    this.name = 'CommandError';
  }
}
export const run: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) {
    const spawnCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    throw new CommandError(command, result.status, spawnCode, options.capture && result.stderr ? result.stderr.trim() : '');
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
  // A data directory that is gone has no owner to contradict the receipt; a directory that exists must still carry this installation's marker.
  if (present(receipt.dataDir) && readDataId(receipt) !== receipt.id) throw new Error('User data does not belong to this installation.');
}
const RELEASE_NAME = /^[0-9a-f]{40}-[0-9a-f-]{36}$/;
export function switchRelease(prefix: string, release: string): void {
  const temporary = join(prefix, `current-${process.pid}`);
  symlinkSync(`releases/${release}`, temporary);
  try { renameSync(temporary, join(prefix, 'current')); } finally { rmSync(temporary, { force: true }); }
}
/** The command wrappers and unit as an interrupted update left them on disk, as v2 receipt fields. */
function writtenFiles(receipt: Installation): Pick<Installation, 'schema' | 'wrappers' | 'unit'> {
  const wrappers: Record<string, string> = {};
  for (const name of COMMANDS) {
    const file = join(receipt.prefix, 'commands', name); plainPath(file);
    wrappers[name] = present(file) ? readFileSync(file, 'utf8') : receipt.wrappers[name]!;
  }
  const unit = unitPath(receipt); plainPath(unit);
  return { schema: 2, wrappers, unit: receipt.service && present(unit) ? readFileSync(unit, 'utf8') : receipt.unit };
}
/**
 * An update that was killed outright (hang-up, SIGKILL, power loss) after it moved `current` leaves the
 * receipt naming the previous release while `current` and the generated files are already the new ones:
 * `current` naming another release than the receipt is that fact, so no separate marker is kept.
 * For an update, put the receipt's release back so it can proceed; the abandoned release is removed by the next
 * successful update. For an uninstall nothing is put back: the receipt held in memory adopts the release `current`
 * names and the files the interrupted update wrote, which the uninstall then removes, so an installation whose
 * previous release is gone can still be removed. Returns whether a recovery was needed.
 */
export function recoverInterruptedUpdate(receipt: Installation, purpose: 'update' | 'uninstall' = 'update'): boolean {
  plainPath(receipt.prefix);
  const current = join(receipt.prefix, 'current');
  if (!present(current) || !lstatSync(current).isSymbolicLink()) return false;
  const target = readlinkSync(current);
  if (target === `releases/${receipt.release}` || !target.startsWith('releases/') || !RELEASE_NAME.test(target.slice('releases/'.length))) return false;
  if (purpose === 'uninstall') {
    Object.assign(receipt, { release: target.slice('releases/'.length), ...writtenFiles(receipt) });
    return true;
  }
  const previous = join(receipt.prefix, 'releases', receipt.release); plainPath(previous);
  if (!present(previous)) throw new Error(`An earlier update was interrupted and the previous release ${previous} is gone, so it cannot be restored; nothing was changed. Remove it with \`./scripts/uninstall.sh --prefix ${receipt.prefix}\` from this checkout (user data is kept), then install again.`);
  switchRelease(receipt.prefix, receipt.release);
  if (receipt.schema === 2) {
    for (const name of COMMANDS) atomicWrite(join(receipt.prefix, 'commands', name), receipt.wrappers[name]!, 0o755);
    if (receipt.service && present(unitPath(receipt))) atomicWrite(unitPath(receipt), receipt.unit, 0o644);
  } else {
    // A digest receipt cannot regenerate the previous files. The interrupted update itself wrote what is on disk,
    // so adopt that exact text in a v2 receipt rather than reporting the installer's own files as edited.
    Object.assign(receipt, writtenFiles(receipt));
    atomicWrite(join(receipt.prefix, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  console.warn(`An earlier update was interrupted; restored the previous release ${receipt.release.slice(0, 12)}.`);
  return true;
}
/**
 * A first install killed while it staged its release (before it wrote a receipt) leaves a program directory that
 * holds nothing but `releases/<commit>-<uuid>` directories. Only this installer writes that shape, and the caller
 * holds the program-directory lock, so the leftover is removed and the install proceeds. Returns whether it was.
 */
export function discardAbandonedFirstInstall(prefix: string): boolean {
  plainPath(prefix);
  if (!present(prefix) || !lstatSync(prefix).isDirectory()) return false;
  const entries = readdirSync(prefix);
  if (entries.length !== 1 || entries[0] !== 'releases') return false;
  const releases = join(prefix, 'releases');
  if (!lstatSync(releases).isDirectory()) return false;
  if (!readdirSync(releases).every(name => RELEASE_NAME.test(name) && lstatSync(join(releases, name)).isDirectory())) return false;
  rmSync(prefix, { recursive: true, force: true });
  console.warn(`Removed the unfinished release a first install left in ${prefix} when it was stopped.`);
  return true;
}
/**
 * The lock beside a program or data directory. Only uninstall removes it, while holding it and after the directory
 * it guards is gone; every contender tries once (no wait), so none is left waiting on the removed file.
 */
export const lockPath = (directory: string): string => `${directory}.writer.sqlite`;
/**
 * Run `work` while this process holds the lock beside `directory`. The kernel releases the lock when the
 * process ends for any reason, so a killed install leaves nothing to reclaim, and the lock is released
 * however `work` settles (including a synchronous throw).
 */
export async function withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  plainPath(directory); mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const lock = lockPath(directory);
  try {
    return await withProcessLock(lock, work, { waitMs: 0 });
  } catch (error) {
    if (error instanceof ProcessLockBusyError && error.lockPath === lock) {
      throw new Error(`Another install or uninstall is running for ${directory}; nothing was changed. Wait for it to finish, then retry.`);
    }
    throw error;
  }
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
    // Nothing is left to protect once the program directory is gone, so the lock files beside it go too; a later
    // install simply creates them again.
    if (!receipt) { rmSync(lockPath(prefix), { force: true }); console.log(`No Jev installation at ${prefix}. Preserved data remains untouched.`); return; }
    await withLock(receipt.dataDir, async () => {
      if (realpathSync(process.env.HOME ?? '') !== receipt.home) throw new Error('Run uninstall as the user who owns this installation.');
      recoverInterruptedUpdate(receipt, 'uninstall');
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
      if (purge) { plainPath(receipt.dataDir); rmSync(receipt.dataDir, { recursive: true, force: true }); }
      rmSync(prefix, { recursive: true });
      rmSync(lockPath(receipt.dataDir), { force: true }); rmSync(lockPath(prefix), { force: true });
      console.log(purge ? 'GoodVibes Jev uninstalled, including its data.' : `GoodVibes Jev uninstalled. Data and credentials preserved at ${receipt.dataDir}`);
    });
  });
}
