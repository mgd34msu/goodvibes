import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface ProjectionCleanupOps {
  readonly lstat: typeof lstat;
  readonly chmod: typeof chmod;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly rm: typeof rm;
}

const defaultOps: ProjectionCleanupOps = { lstat, chmod, readdir: (path) => readdir(path), rm };

/**
 * Remove a captured run's temporary projection. The command may have left
 * directories unreadable, so access is restored first; a failure there or in
 * the removal is logged and never thrown, because this runs after the command
 * finished and must not replace its result with an unrelated error.
 */
export async function discardCapturedProjection(path: string, ops: ProjectionCleanupOps = defaultOps): Promise<void> {
  const restore = async (target: string): Promise<void> => {
    const stat = await ops.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await ops.chmod(target, (stat.mode & 0o777) | 0o700);
    for (const name of await ops.readdir(target)) await restore(join(target, name));
  };
  try { await restore(path); }
  catch (error) { logger.warn('[CapturedExec] could not restore access before removing the projection', { error: summarizeError(error) }); }
  try { await ops.rm(path, { recursive: true, force: true }); }
  catch (error) { logger.warn('[CapturedExec] could not remove the temporary projection', { path, error: summarizeError(error) }); }
}
