/**
 * The plain sentence for a read of a project whose folder cannot be reached now (a disk that is not mounted, a parent
 * folder renamed): the store that keeps the project's records under its folder answers "Atomic publication parent does
 * not exist" (utils/atomic-json-store.ts), which is no sentence a person can use and no fault of the daemon.
 */
import { folderReach } from './folder-reach.js';

/** The code a call answers when its project's folder cannot be reached. */
export const PROJECT_FOLDER_NOT_REACHABLE = 'PROJECT_FOLDER_NOT_REACHABLE';

/**
 * The sentence for `error` when it is the read of a folder that is not there: only that error, and only when the folder the
 * call named (`folder`, its `workingDirectory`) is not there either (a folder that is there means the failure is another one,
 * which stays the daemon's own fault). Undefined for every other error.
 */
export function unreachableFolderWords(error: unknown, folder: unknown): string | undefined {
  if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT' || !error.message.startsWith('Atomic publication parent does not exist')) return undefined;
  const named = typeof folder === 'string' && folder.trim() !== '' ? folder.trim() : undefined;
  if (named !== undefined && folderReach(named) === 'present') return undefined;
  return `This project's folder${named ? ` (${named})` : ''} cannot be reached now, so its work cannot be read. It may be on a disk that is not connected, or in a folder that was renamed or removed. Nothing was lost: connect the disk or put the folder back, then ask again.`;
}
