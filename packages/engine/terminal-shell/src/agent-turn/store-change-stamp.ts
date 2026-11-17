import { statSync } from 'node:fs';

/**
 * A store file's identity: device, inode, size and modification time. Every
 * write replaces or rewrites the file, so an unchanged stamp means an unchanged
 * store and a reader can skip re-reading it. 'absent' when the file does not exist.
 */
export function storeFileChangeStamp(path: string): string {
  try {
    const info = statSync(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}
