/**
 * The single cross-surface memory database path.
 */

import { join } from 'node:path';

/** The single cross-surface memory database path, rooted at the user home dir. */
export function resolveCanonicalMemoryDbPath(homeDir: string): string {
  return join(homeDir, '.goodvibes', 'shared', 'memory.sqlite');
}
