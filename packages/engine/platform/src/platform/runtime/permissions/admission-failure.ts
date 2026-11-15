/** One place the autonomous admissions report why they refused after an unexpected failure. */
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/**
 * An admission that throws is refused; the caller only sees "not approved".
 * Log the cause so a changed source, an untrusted workspace and a bug are
 * told apart. A cancellation is the normal end of an operation, not a fault.
 */
export function logAdmissionFailure(admission: string, error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') {
    logger.debug(`[permissions] ${admission} admission cancelled`);
    return;
  }
  logger.warn(`[permissions] ${admission} admission refused after an error`, { error: summarizeError(error) });
}
