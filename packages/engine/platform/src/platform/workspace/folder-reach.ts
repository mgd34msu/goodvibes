/**
 * Whether a project's folder is there, merely out of reach, or really deleted.
 *
 * A folder that is not there is "deleted" only when the folder that held it is there: then it was removed or renamed
 * away. When the folder that held it is missing too (a disk that is not mounted, a parent folder renamed or not yet put
 * back), the folder is "unreachable": nothing of its project is let go, and when the folder is back it is the same
 * project.
 */
import { lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type FolderReach = 'present' | 'unreachable' | 'deleted';

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
    return statSync(parent, { throwIfNoEntry: false })?.isDirectory() === true ? 'deleted' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
