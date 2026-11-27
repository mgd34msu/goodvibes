/**
 * Whether a project's folder is there, merely out of reach, or really deleted.
 *
 * A folder that is not there is "deleted" only when the folder that held it is there: then it was removed or renamed
 * away. When the folder that held it is missing too (a disk that is not mounted, a parent folder renamed or not yet put
 * back), the folder is "unreachable": nothing of its project is let go, and when the folder is back it is the same
 * project. The same holds when the folder that held it is an empty mount point (a disk's mount folder left behind
 * empty when the disk is unmounted).
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

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

/** Remembers `holder` (the folder that holds a present project folder) when it is a mount point. */
function noteMountPoint(holder: string): void {
  if (seenMountPoints.has(holder) || examinedHolders.has(holder) || dirname(holder) === holder) return;
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

/** An unmounted mount point: an empty folder that a disk is mounted on at other times. */
function emptyMountPoint(folder: string): boolean {
  try { if (readdirSync(folder).length > 0) return false; } catch { return true; }
  return looksLikeMountPoint(folder);
}

export function folderReach(folder: string): FolderReach {
  try {
    if (lstatSync(folder, { throwIfNoEntry: false }) !== undefined) {
      noteMountPoint(dirname(folder));
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
