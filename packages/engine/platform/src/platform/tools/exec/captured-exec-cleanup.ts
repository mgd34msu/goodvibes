import { rm } from 'node:fs/promises';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/**
 * Remove a captured run's temporary directory (its seccomp filter, mount
 * arguments, script source and runtime stubs; never project files). A failure
 * is logged and never thrown: this runs after the command finished and must
 * not replace its result with an unrelated error.
 */
export async function discardCapturedTemporary(path: string): Promise<void> {
  try { await rm(path, { recursive: true, force: true }); }
  catch (error) { logger.warn('[CapturedExec] could not remove the temporary directory', { path, error: summarizeError(error) }); }
}
