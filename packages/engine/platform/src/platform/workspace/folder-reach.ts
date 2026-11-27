/**
 * Whether a project's folder is there, merely out of reach, or really deleted.
 *
 * A folder that is not there is "deleted" only when the folder that held it is there: then it was removed or renamed
 * away. When the folder that held it is missing too (a disk that is not mounted, a parent folder renamed or not yet put
 * back), the folder is "unreachable": nothing of its project is let go, and when the folder is back it is the same
 * project. The same holds when the folder that held it is an empty mount point (a disk's mount folder left behind
 * empty when the disk is unmounted).
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '../config/goodvibes-home.js';
import { homeRegisteredRoots } from './project-identity.js';

export type FolderReach = 'present' | 'unreachable' | 'deleted';

/** The folders disks and drives are conventionally mounted in: a folder directly inside one of these is a mount point. */
const MOUNT_ROOTS: readonly string[] = ['/mnt', '/media', '/Volumes'];

/** The mount points listed in the machine's static mount table (`/etc/fstab`), spelled as paths. */
function tabledMountPoints(): readonly string[] {
  let text: string;
  try { text = readFileSync('/etc/fstab', 'utf8'); } catch { return []; }
  const points: string[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2 || fields[0]!.startsWith('#')) continue;
    // A space in a mount point is written \040 in the table.
    points.push(resolve(fields[1]!.replace(/\\040/g, ' ')));
  }
  return points;
}

/**
 * Whether `folder` is, as far as can be told without it being mounted, a place a disk is mounted on: directly inside a
 * conventional mount folder (`/mnt`, `/media`, `/Volumes`, `/run/media/<account>`), or named in the mount table. An
 * unmounted mount point stays behind as an empty folder, so a project directly inside one that is empty is not shown
 * removed by that: the disk is simply not there.
 */
function looksLikeMountPoint(folder: string): boolean {
  if (seenMountPoints.has(folder)) return true;
  const holder = dirname(folder);
  if (MOUNT_ROOTS.includes(holder)) return true;
  const parts = holder.split(sep);
  if (parts.length === 4 && parts[1] === 'run' && parts[2] === 'media') return true;
  return tabledMountPoints().includes(folder);
}

/**
 * The folders this process saw, while a folder was there, to be mount points (the folder's holder was a mount point in
 * `/proc/self/mountinfo`, or on another device than ITS holder). Bounded by count, oldest forgotten first; no clock. It
 * covers a disk unmounted while this process runs, wherever it was mounted; a process started with the disk already away
 * knows nothing of it and falls back to the conventional folders and `/etc/fstab`.
 */
const seenMountPoints = new Set<string>();
const SEEN_MOUNT_POINTS_BOUND = 1024;
const examinedHolders = new Set<string>();

function mountPointsNow(): ReadonlySet<string> | undefined {
  let text: string;
  try { text = readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return undefined; }
  const points = new Set<string>();
  for (const line of text.split('\n')) {
    const field = line.split(' ')[4];
    if (field) points.add(field.replace(/\\([0-7]{3})/g, (_all, octal: string) => String.fromCharCode(parseInt(octal, 8))));
  }
  return points;
}

/**
 * What is kept of "this project's folder was on its own mount, at this mount point": one small file of its own in the daemon's
 * home (`project-mounts.json`: project folder -> mount point). It is written when a registered project's folder is first seen
 * present with a mount point as its holder, holds one entry per registered project at most (an entry of a folder that is no
 * longer registered is dropped at every write, and `forgetProjectMount` drops it when the project is removed), is read once when
 * this process first needs it, and has no clock. No other file and no record of the project's registration is changed.
 */
const PROJECT_MOUNTS_FILE = 'project-mounts.json';
let projectMountsLoaded = false;
/** The projects whose mount this process has already put in the file (or found there). */
const rememberedRoots = new Map<string, string>();

function projectMountsPath(): string { return join(resolveGoodVibesDaemonHome(resolveGoodVibesHome()), PROJECT_MOUNTS_FILE); }

function readProjectMounts(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(projectMountsPath(), 'utf8')) as { mounts?: unknown };
    if (parsed === null || typeof parsed !== 'object' || parsed.mounts === null || typeof parsed.mounts !== 'object' || Array.isArray(parsed.mounts)) return {};
    return Object.fromEntries(Object.entries(parsed.mounts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

function writeProjectMounts(mounts: Record<string, string>): void {
  try {
    const path = projectMountsPath();
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, mounts }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch { /* the memory is a help: a write that cannot be made leaves things as they were */ }
}

/** Reads the file once: the mount point of each project still registered is known before its folder is first seen. */
function loadProjectMounts(): void {
  if (projectMountsLoaded) return;
  projectMountsLoaded = true;
  const registered = new Set(homeRegisteredRoots());
  for (const [root, mountPoint] of Object.entries(readProjectMounts())) if (registered.has(root)) seenMountPoints.add(mountPoint);
}

function rememberProjectMount(folder: string, holder: string): void {
  let root: string;
  try { root = realpathSync.native(folder); } catch { return; }
  if (rememberedRoots.get(root) === holder) return;
  const registered = new Set(homeRegisteredRoots());
  if (!registered.has(root)) return;
  if (rememberedRoots.size >= SEEN_MOUNT_POINTS_BOUND) rememberedRoots.delete(rememberedRoots.keys().next().value as string);
  rememberedRoots.set(root, holder);
  const known = readProjectMounts();
  const kept = Object.fromEntries(Object.entries(known).filter(([name]) => registered.has(name)));
  if (kept[root] === holder && Object.keys(kept).length === Object.keys(known).length) return;
  writeProjectMounts({ ...kept, [root]: holder });
}

/** The project was removed: what is kept of its mount goes with it. */
export function forgetProjectMount(root: string): void {
  let real: string;
  try { real = realpathSync.native(root); } catch { real = resolve(root); }
  rememberedRoots.delete(root); rememberedRoots.delete(real);
  const known = readProjectMounts();
  if (!(root in known) && !(real in known)) return;
  const { [root]: _a, [real]: _b, ...rest } = known;
  void _a; void _b;
  writeProjectMounts(rest);
}

/** Remembers `holder` (the folder that holds a present project folder) when it is a mount point. */
function noteMountPoint(holder: string, folder: string): void {
  loadProjectMounts();
  if (!seenMountPoints.has(holder)) {
    if (examinedHolders.has(holder) || dirname(holder) === holder) return;
    // Each holder is looked at once (no read of the mount table per call); bounded like the memory above.
    if (examinedHolders.size >= SEEN_MOUNT_POINTS_BOUND * 4) examinedHolders.delete(examinedHolders.values().next().value as string);
    examinedHolders.add(holder);
    let mounted: boolean;
    const listed = mountPointsNow();
    if (listed) mounted = listed.has(holder);
    else {
      try { mounted = statSync(holder).dev !== statSync(dirname(holder)).dev; } catch { return; }
    }
    if (!mounted) return;
    if (seenMountPoints.size >= SEEN_MOUNT_POINTS_BOUND) seenMountPoints.delete(seenMountPoints.values().next().value as string);
    seenMountPoints.add(holder);
  }
  // The holder is a mount point: the project's own record of it (a registered project only, once per process).
  rememberProjectMount(folder, holder);
}

/** An unmounted mount point: an empty folder that a disk is mounted on at other times. */
function emptyMountPoint(folder: string): boolean {
  loadProjectMounts();
  try { if (readdirSync(folder).length > 0) return false; } catch { return true; }
  return looksLikeMountPoint(folder);
}

export function folderReach(folder: string): FolderReach {
  try {
    if (lstatSync(folder, { throwIfNoEntry: false }) !== undefined) {
      noteMountPoint(dirname(folder), folder);
      return 'present';
    }
  } catch {
    // A part of the path is not a folder (ENOTDIR) or cannot be read: the folder cannot be reached, which is not proof
    // that it was deleted.
    return 'unreachable';
  }
  const parent = dirname(folder);
  if (parent === folder) return 'unreachable';
  try {
    if (statSync(parent, { throwIfNoEntry: false })?.isDirectory() !== true) return 'unreachable';
    // The folder that held it is there but empty and is a place a disk is mounted on: the disk is not mounted now, so the
    // folder is out of reach and its project stays the same project when the disk is back.
    return emptyMountPoint(parent) ? 'unreachable' : 'deleted';
  } catch {
    return 'unreachable';
  }
}
