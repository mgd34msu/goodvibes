import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProcessLockBusyError, withProcessLock } from '../packages/engine/platform/src/platform/utils/process-lock.ts';
import { DAEMON_SERVICE_NAME } from '../packages/engine/platform/src/platform/daemon/daemon-service-default.ts';

export const PACKAGE = 'goodvibes';
export const COMMANDS = ['goodvibes', 'goodvibes-agent', 'goodvibes-daemon', 'goodvibes-uninstall'] as const;
export interface Layout { prefix: string; binDir: string; dataDir: string; home: string }
/**
 * A layout with the systemd unit name the daemon wrote (its `service.serviceName`, without `.service`).
 * Absent before the daemon has written a unit (a first install's preflight) and in receipts written
 * before the name was recorded, which always named the default.
 */
export interface ServiceLayout extends Layout { serviceName?: string }
/** The daemon's systemd unit as systemctl names it. */
export const serviceUnit = (layout: ServiceLayout): string => `${layout.serviceName ?? DAEMON_SERVICE_NAME}.service`;
/** One setting an update is about to write: its value before the run and the value the run writes. */
export interface PendingSetting { readonly key: string; readonly previous: unknown; readonly written: unknown }
export interface Installation extends ServiceLayout {
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
  /**
   * Written before the service unit is written, rewritten or removed, and
   * dropped by the receipt that records the result. Present after a run was
   * stopped part way: `service` and `unit` above still describe the state
   * before that change, and {@link recoverPendingService} restores it.
   */
  pendingService?: { readonly service: boolean };
  /**
   * Written before an update's first daemon setting write and dropped by the receipt that records the
   * result. Present after an update was stopped part way: {@link recoverPendingSettings} puts back each
   * setting that still holds what the stopped run wrote.
   */
  pendingSettings?: readonly PendingSetting[];
}
export type Run = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean }) => string;
/**
 * A command that could not start or exited non-zero. Callers decide on `status` and `spawnCode`, never on the
 * message. Never carries argv or the environment: config commands may carry credentials.
 */
export class CommandError extends Error {
  constructor(readonly command: string, readonly status: number | null, readonly spawnCode: string | undefined, stderr = '', readonly stdout = '') {
    super(`${command} ${spawnCode ? `could not be started (${spawnCode})` : `failed${status === null ? '' : ` (${status})`}`}${stderr ? `: ${stderr}` : ''}`);
    this.name = 'CommandError';
  }
}
export const run: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) {
    const spawnCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    throw new CommandError(command, result.status, spawnCode, options.capture && result.stderr ? result.stderr.trim() : '', options.capture && result.stdout ? result.stdout.trim() : '');
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
/**
 * Whether a process of this user runs a program from `release` (its executable, or an absolute argument inside it).
 * Processes in `skip` are not counted. An unreadable process table counts as in use.
 */
export function isReleaseInUse(release: string, procRoot = '/proc', skip: ReadonlySet<number> = new Set()): boolean {
  try {
    for (const entry of readdirSync(procRoot)) {
      if (!/^[0-9]+$/.test(entry) || skip.has(Number(entry))) continue;
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
export const unitPath = (layout: ServiceLayout): string => join(layout.home, '.config/systemd/user', serviceUnit(layout));
const SERVICE_NAME = /^[A-Za-z0-9_.@-]+$/;
/** One setting as the installed daemon reports it (`goodvibes-daemon config get <key> --json`). */
export function readDaemonSetting(execute: Run, daemon: string, dataDir: string, key: string): unknown {
  const output = execute(daemon, ['config', 'get', key, '--json'], { cwd: dataDir, capture: true });
  let parsed: { ok?: unknown; data?: { value?: unknown } };
  try { parsed = JSON.parse(output) as typeof parsed; } catch { parsed = {}; }
  if (parsed.ok !== true || parsed.data === undefined) throw new Error(`${daemon} config get ${key} --json did not report the setting; nothing was changed.`);
  return parsed.data.value;
}
/** The daemon's service as it reports it (`goodvibes-daemon service-status --json`): its unit name and definition path. */
export function readDaemonService(execute: Run, daemon: string, dataDir: string): { serviceName: string; path: string } {
  let output: string;
  // Exit 3 and 4 (not running, not installed) still print the document.
  try { output = execute(daemon, ['service-status', '--json'], { cwd: dataDir, capture: true }); }
  catch (error) {
    if (!(error instanceof CommandError) || (error.status !== 3 && error.status !== 4) || !error.stdout) throw error;
    output = error.stdout;
  }
  let parsed: { serviceName?: unknown; path?: unknown; platform?: unknown };
  try { parsed = (JSON.parse(output) as { data?: typeof parsed }).data ?? {}; } catch { parsed = {}; }
  if (parsed.platform !== 'systemd' || typeof parsed.serviceName !== 'string' || !SERVICE_NAME.test(parsed.serviceName) || typeof parsed.path !== 'string') {
    throw new Error(`${daemon} service-status --json did not report a systemd user service.`);
  }
  return { serviceName: parsed.serviceName, path: parsed.path };
}
/**
 * An update stopped after it began writing daemon settings (the receipt says `pendingSettings`): each recorded
 * setting that still holds what that run wrote is set back to its previous value with this installation's
 * daemon; one changed since (by the owner or a newer run) is left as it is. Run after
 * {@link recoverInterruptedUpdate}, so the daemon used is the release the receipt names. Returns whether there
 * was anything to recover.
 */
export function recoverPendingSettings(receipt: Installation, execute: Run): boolean {
  if (!receipt.pendingSettings) return false;
  const daemon = join(receipt.prefix, 'commands/goodvibes-daemon');
  const restored: string[] = [];
  for (const { key, previous, written } of receipt.pendingSettings) {
    if (JSON.stringify(readDaemonSetting(execute, daemon, receipt.dataDir, key)) !== JSON.stringify(written)) continue;
    if (previous === undefined || previous === null) execute(daemon, ['config', 'unset', key], { cwd: receipt.dataDir, capture: true });
    else execute(daemon, ['config', 'set', key, typeof previous === 'string' ? previous : JSON.stringify(previous)], { cwd: receipt.dataDir, capture: true });
    restored.push(key);
  }
  delete receipt.pendingSettings;
  atomicWrite(receiptPath(receipt), JSON.stringify(receipt, null, 2) + '\n');
  if (restored.length > 0) console.warn(`An earlier update was stopped after it changed daemon settings; put back ${restored.join(', ')}.`);
  return true;
}
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
    || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535
    || (value.serviceName !== undefined && (typeof value.serviceName !== 'string' || !SERVICE_NAME.test(value.serviceName)))
    || (value.pendingSettings !== undefined && (!Array.isArray(value.pendingSettings) || value.pendingSettings.some(entry => typeof entry?.key !== 'string')))) throw new Error('Invalid GoodVibes installation receipt.');
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
export function dataOwner(layout: Layout): string { return join(layout.dataDir, '.goodvibes-owner.json'); }
export function readDataId(layout: Layout): string | undefined {
  const marker = dataOwner(layout); plainPath(marker);
  if (!present(marker)) return undefined;
  const value = JSON.parse(readFileSync(marker, 'utf8')) as { package?: string; id?: string; dataDir?: string; prefix?: string };
  if (value.package !== PACKAGE || value.dataDir !== layout.dataDir || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id)) throw new Error('Invalid GoodVibes data ownership marker.');
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
 * A run stopped while it changed the service (the receipt says `pendingService`):
 * for an update, the unit is put back as the receipt records it (a unit the run
 * wrote for a receipt without a service is this installation's, so it is
 * disabled and removed), and the receipt is written without the mark; for an
 * uninstall, a unit that is there is adopted, so it is removed with the rest.
 * Returns whether there was anything to recover.
 */
export function recoverPendingService(receipt: Installation, purpose: 'update' | 'uninstall', execute: Run): boolean {
  if (!receipt.pendingService) return false;
  const unit = unitPath(receipt); plainPath(unit);
  const quietly = (args: string[]): void => { try { execute('systemctl', args, { capture: true }); } catch { /* best effort: the unit file is what is owned */ } };
  if (purpose === 'uninstall') {
    if (present(unit)) Object.assign(receipt, { service: true, unit: readFileSync(unit, 'utf8') });
  } else if (receipt.service) {
    if (receipt.unit) { atomicWrite(unit, receipt.unit, 0o644); quietly(['--user', 'daemon-reload']); quietly(['--user', 'enable', serviceUnit(receipt)]); }
  } else if (present(unit)) {
    quietly(['--user', 'disable', serviceUnit(receipt)]);
    rmSync(unit, { force: true });
    quietly(['--user', 'daemon-reload']);
  }
  delete receipt.pendingService;
  if (purpose === 'update') {
    atomicWrite(receiptPath(receipt), JSON.stringify(receipt, null, 2) + '\n');
    console.warn('An earlier install was stopped while it changed the daemon service; the service was put back as it was before.');
  }
  return true;
}

/**
 * A first install writes this record, naming the release it is about to stage, before it creates anything else in
 * the program directory, and removes it once the installation receipt exists. It is the receipt for the staged
 * release: the only thing a later run may remove on its behalf.
 */
export const STAGING_RECORD = 'installing.json';
export const stagingRecordPath = (prefix: string): string => join(prefix, STAGING_RECORD);

/** Write the staging record of a first install, before its release directory is made. */
export function recordFirstInstallStaging(prefix: string, release: string): void {
  if (!RELEASE_NAME.test(release)) throw new Error(`Not a release name: ${release}`);
  mkdirSync(prefix, { recursive: true });
  atomicWrite(stagingRecordPath(prefix), JSON.stringify({ release }) + '\n');
}

/**
 * A first install killed while it staged its release (before it wrote a receipt) leaves its staging record and the
 * release it names. The caller holds the program-directory lock, so exactly that release and the record are removed
 * and the install proceeds; nothing the record does not name is touched (anything else left in the directory is
 * refused by the install's own check, which names the directory). Returns whether a staged release was removed.
 */
export function discardAbandonedFirstInstall(prefix: string): boolean {
  plainPath(prefix);
  if (!present(prefix) || !lstatSync(prefix).isDirectory()) return false;
  const record = stagingRecordPath(prefix);
  plainPath(record);
  if (!present(record)) return false;
  let release: unknown;
  try { release = (JSON.parse(readFileSync(record, 'utf8')) as { release?: unknown }).release; } catch { release = undefined; }
  if (typeof release !== 'string' || !RELEASE_NAME.test(release)) {
    throw new Error(`The record of an interrupted first install, ${record}, cannot be read, so what it staged is unknown; nothing was removed. If nothing you need is in ${prefix}, remove it: rm -rf -- ${quote(prefix)}`);
  }
  const releases = join(prefix, 'releases');
  const staged = join(releases, release);
  plainPath(staged);
  if (present(staged)) rmSync(staged, { recursive: true, force: true });
  if (present(releases) && lstatSync(releases).isDirectory() && readdirSync(releases).length === 0) rmSync(releases, { recursive: true, force: true });
  rmSync(record, { force: true });
  console.warn(`Removed the unfinished release ${release.slice(0, 12)} a first install left in ${prefix} when it was stopped.`);
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
  const fragment = execute('systemctl', ['--user', 'show', serviceUnit(receipt), '--property=FragmentPath', '--value'], { capture: true });
  if (fragment && fragment !== unitPath(receipt)) throw new Error(`Systemd loaded a different ${serviceUnit(receipt)}; refusing to manage it.`);
}
export function stopService(receipt: Installation, execute: Run): void {
  assertServiceLocation(receipt, execute);
  execute('systemctl', ['--user', 'stop', serviceUnit(receipt)]);
  const state = execute('systemctl', ['--user', 'show', serviceUnit(receipt), '--property=ActiveState', '--value'], { capture: true });
  if (state !== 'inactive' && state !== 'failed') throw new Error('The daemon has not stopped; keeping the installation intact.');
}
function serviceAlreadyRemoved(receipt: Installation, execute: Run): boolean {
  if (present(unitPath(receipt))) return false;
  const state = execute('systemctl', ['--user', 'show', serviceUnit(receipt), '--property=ActiveState', '--value'], { capture: true });
  return state === 'inactive' || state === 'failed';
}
export async function uninstall(prefix: string, purge: boolean, execute: Run = run): Promise<void> {
  await withLock(prefix, async () => {
    const receipt = readInstallation(prefix);
    // Nothing is left to protect once the program directory is gone, so the lock files beside it go too; a later
    // install simply creates them again.
    if (!receipt) { rmSync(lockPath(prefix), { force: true }); console.log(`No GoodVibes installation at ${prefix}. Preserved data remains untouched.`); return; }
    await withLock(receipt.dataDir, async () => {
      if (realpathSync(process.env.HOME ?? '') !== receipt.home) throw new Error('Run uninstall as the user who owns this installation.');
      recoverInterruptedUpdate(receipt, 'uninstall');
      recoverPendingService(receipt, 'uninstall', execute);
      assertOwnedFiles(receipt);
      if (receipt.service) {
        // A re-run after a failure that came after the unit was removed: nothing is left to stop or disable.
        if (!serviceAlreadyRemoved(receipt, execute)) {
          stopService(receipt, execute);
          execute('systemctl', ['--user', 'disable', serviceUnit(receipt)]);
        }
      }
      // The uninstaller itself runs on the release's bun (its wrappers exec it), so its own pid is skipped.
      if (isReleaseInUse(receipt.prefix, '/proc', new Set([process.pid]))) {
        throw new Error(`A GoodVibes program from ${receipt.prefix} is still running (a daemon started with \`goodvibes-daemon serve\`, a terminal or an agent); quit it, then run the uninstall again.`);
      }
      if (receipt.service) {
        rmSync(unitPath(receipt), { force: true });
        execute('systemctl', ['--user', 'daemon-reload']);
      }
      for (const name of COMMANDS) rmSync(join(receipt.binDir, name), { force: true });
      // Data lives outside the program prefix. Only an explicit purge removes it.
      if (purge) { plainPath(receipt.dataDir); rmSync(receipt.dataDir, { recursive: true, force: true }); }
      rmSync(prefix, { recursive: true });
      rmSync(lockPath(receipt.dataDir), { force: true }); rmSync(lockPath(prefix), { force: true });
      console.log(purge ? 'GoodVibes uninstalled, including its data.' : `GoodVibes uninstalled. Data and credentials preserved at ${receipt.dataDir}`);
    });
  });
}
