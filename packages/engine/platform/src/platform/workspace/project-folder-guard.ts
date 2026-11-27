/**
 * project-folder-guard.ts: a store never makes anything under a project folder that cannot be reached now.
 *
 * A project keeps its records, checkpoints, file-writes log and locks under `<project>/.goodvibes/`. When the project's
 * folder is out of reach (its disk is not mounted: the mount point stays behind as an empty folder), a store that made its
 * folders again on a write would build a husk of that tree on the bare mount point, which hides under the disk when it
 * returns and makes the project read as present while it is not. The one answer to "is the folder reachable" is
 * `folderReach` (workspace/folder-reach.ts); this asks it for the project folder a path lies in, before a store makes a
 * folder or a file there.
 */
import { resolve, sep } from 'node:path';
import { folderReach } from './folder-reach.js';

/** The project folder a path under `<project>/.goodvibes/` belongs to; undefined for any other path. */
export function projectFolderOfRecords(path: string): string | undefined {
  const full = resolve(path);
  const inside = full.indexOf(`${sep}.goodvibes${sep}`);
  if (inside > 0) return full.slice(0, inside);
  return full.endsWith(`${sep}.goodvibes`) && full.length > `${sep}.goodvibes`.length ? full.slice(0, -`${sep}.goodvibes`.length) : undefined;
}

/**
 * Throws, naming the folder, when `path` lies under `<project>/.goodvibes/` of a project folder that is out of reach. The
 * error is the store's own "parent does not exist" (ENOENT), which a call reads as a plain sentence (daemon/control-plane.ts).
 */
export function assertProjectFolderReachable(path: string): void {
  const project = projectFolderOfRecords(path);
  if (project !== undefined && folderReach(project) === 'unreachable') {
    throw Object.assign(new Error(`Atomic publication parent does not exist: ${project} cannot be reached now`), { code: 'ENOENT' });
  }
}
