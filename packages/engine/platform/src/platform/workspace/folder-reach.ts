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
  const holder = dirname(folder);
  if (MOUNT_ROOTS.includes(holder)) return true;
  const parts = holder.split(sep);
  if (parts.length === 4 && parts[1] === 'run' && parts[2] === 'media') return true;
  return tabledMountPoints().includes(folder);
}

/** An unmounted mount point: an empty folder that a disk is mounted on at other times. */
function emptyMountPoint(folder: string): boolean {
  try { if (readdirSync(folder).length > 0) return false; } catch { return true; }
  return looksLikeMountPoint(folder);
}

export function folderReach(folder: string): FolderReach {
  try {
    if (lstatSync(folder, { throwIfNoEntry: false }) !== undefined) return 'present';
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
