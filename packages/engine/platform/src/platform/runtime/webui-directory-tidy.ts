/**
 * The installed web UI folder, named for what it holds and kept tidy.
 *
 * The suite installs the web UI into `<install dir>/webui/current` and every
 * update replaces that folder in place, keeping the outgoing copy as
 * `current.previous` for rollback (runtime/update-directories.ts). Releases
 * before 3.4.7 installed into `webui/<version>` and the updater kept writing
 * into it, so the folder kept its first version's name while holding a later
 * release, older version folders and their `.previous` copies stayed behind,
 * and the kernel lock files of every update target (`*.directory-update.lock.held`)
 * were never removed.
 *
 * {@link tidyInstalledWebuiDirectory} carries such an install forward, once,
 * when the daemon starts: the served folder becomes `current` (its `.previous`
 * becomes `current.previous`, or else the newest older release folder does),
 * the setting that names it is moved with it, every other release folder this
 * suite wrote is removed, and the lock files of targets that no longer exist go.
 * Only folders carrying this suite's release marker are moved or removed; any
 * other folder is left where it is. The live target's own lock file stays: it
 * is the lock the next update takes, and removing it while another program may
 * be opening it would let two updates run at once.
 */
import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { clearAbandonedCrossProcessLock, tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { NATIVE_UPDATE_DIRECTORY_RELEASE_FILE } from './update-directories.js';

/** The served web UI folder's name under `<install dir>/webui`. */
export const INSTALLED_WEBUI_FOLDER = 'current';
const PREVIOUS_SUFFIX = '.previous';
const CLAIM_SUFFIX = '.directory-update.lock';
const KERNEL_SUFFIX = '.held';

/** What the tidy did, in plain words for the daemon's start log. */
export interface WebuiDirectoryTidyResult {
  readonly bundleDir: string | undefined;
  readonly moved: readonly string[];
  readonly removed: readonly string[];
  readonly kept: readonly string[];
}

/** The release a folder's marker names, or undefined when it carries none (not ours). */
function markedRelease(path: string): string | undefined {
  try {
    const folder = fs.lstatSync(path);
    if (!folder.isDirectory() || folder.isSymbolicLink()) return undefined;
    const markerPath = join(path, NATIVE_UPDATE_DIRECTORY_RELEASE_FILE);
    const marker = fs.lstatSync(markerPath);
    if (!marker.isFile() || marker.size > 4096) return undefined;
    const row = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    return row['schema'] === 1 && typeof row['version'] === 'string' && /^\d+\.\d+\.\d+/.test(row['version']) ? row['version'] : undefined;
  } catch {
    return undefined;
  }
}

/** Newer first, by the numeric release parts. */
function compareReleases(a: string, b: string): number {
  const parts = (value: string) => value.split(/[-+]/)[0]!.split('.').map(Number);
  const left = parts(a), right = parts(b);
  for (let index = 0; index < 3; index++) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (right[index] ?? 0) - (left[index] ?? 0);
  return 0;
}

const absent = (path: string): boolean => { try { fs.lstatSync(path); return false; } catch { return true; } };

/**
 * Carry an installed web UI folder forward and remove what earlier updates left
 * (see the module comment). `installRoot` is the folder the suite's programs are
 * installed in; a bundle folder anywhere else is separately managed and left
 * alone. `setBundleDir` writes `controlPlane.webui.bundleDir`. Does nothing while
 * an update holds the served folder's claim.
 */
export function tidyInstalledWebuiDirectory(options: {
  readonly installRoot: string;
  readonly bundleDir: string | undefined;
  readonly setBundleDir: (path: string) => void;
}): WebuiDirectoryTidyResult {
  const nothing = { bundleDir: options.bundleDir, moved: [], removed: [], kept: [] };
  const configured = options.bundleDir?.trim();
  if (!configured) return nothing;
  const webuiRoot = join(resolve(options.installRoot), 'webui');
  const served = resolve(configured);
  if (dirname(served) !== webuiRoot || markedRelease(served) === undefined) return nothing;
  const current = join(webuiRoot, INSTALLED_WEBUI_FOLDER);
  const moved: string[] = [], removed: string[] = [], kept: string[] = [];

  // The served folder's claim keeps an update out while folders move.
  const release = tryAcquireCrossProcessLock(served + CLAIM_SUFFIX);
  if (!release) return nothing;
  let bundleDir = served;
  try {
    if (served !== current) {
      if (!absent(current) || !absent(current + PREVIOUS_SUFFIX)) return { ...nothing, kept: [current] };
      fs.renameSync(served, current);
      moved.push(`${served} -> ${current}`);
      if (markedRelease(served + PREVIOUS_SUFFIX) !== undefined) {
        fs.renameSync(served + PREVIOUS_SUFFIX, current + PREVIOUS_SUFFIX);
        moved.push(`${served}${PREVIOUS_SUFFIX} -> ${current}${PREVIOUS_SUFFIX}`);
      }
      options.setBundleDir(current);
      bundleDir = current;
    }
  } finally {
    release();
  }

  const siblings = fs.readdirSync(webuiRoot).filter((name) => !name.startsWith('.'));
  const releaseFolders = siblings
    .filter((name) => name !== INSTALLED_WEBUI_FOLDER && name !== INSTALLED_WEBUI_FOLDER + PREVIOUS_SUFFIX && !name.endsWith(CLAIM_SUFFIX) && !name.endsWith(CLAIM_SUFFIX + KERNEL_SUFFIX))
    .map((name) => ({ name, path: join(webuiRoot, name), version: markedRelease(join(webuiRoot, name)) }));
  // Exactly one copy is kept for rollback: when none is, the newest older release folder becomes it.
  if (absent(current + PREVIOUS_SUFFIX)) {
    const newest = releaseFolders.filter((folder) => folder.version !== undefined)
      .sort((a, b) => compareReleases(a.version!, b.version!))[0];
    if (newest) {
      fs.renameSync(newest.path, current + PREVIOUS_SUFFIX);
      moved.push(`${newest.path} -> ${current}${PREVIOUS_SUFFIX}`);
      newest.version = undefined;
      newest.name = '';
    }
  }
  for (const folder of releaseFolders) {
    if (!folder.name) continue;
    if (folder.version === undefined) { kept.push(folder.path); continue; }
    // Not served and not the rollback copy: an update could still be writing it only under its own claim.
    const claim = tryAcquireCrossProcessLock(folder.path + CLAIM_SUFFIX);
    if (!claim) { kept.push(folder.path); continue; }
    try { fs.rmSync(folder.path, { recursive: true, force: true }); removed.push(folder.path); } finally { claim(); }
  }
  // Lock files of targets that no longer exist: no update takes those names again.
  for (const name of fs.readdirSync(webuiRoot)) {
    if (!name.endsWith(CLAIM_SUFFIX + KERNEL_SUFFIX) && !name.endsWith(CLAIM_SUFFIX)) continue;
    const claimPath = join(webuiRoot, name.endsWith(KERNEL_SUFFIX) ? name.slice(0, -KERNEL_SUFFIX.length) : name);
    const target = claimPath.slice(0, -CLAIM_SUFFIX.length);
    if (basename(target) === INSTALLED_WEBUI_FOLDER || !absent(target)) continue;
    if (clearAbandonedCrossProcessLock(claimPath) === 'removed') removed.push(claimPath + KERNEL_SUFFIX);
  }
  return { bundleDir, moved, removed: [...new Set(removed)], kept };
}
