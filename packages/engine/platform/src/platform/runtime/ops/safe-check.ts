/**
 * Shared diagnostic check safety wrapper.
 *
 * A check that throws did not look at the state it is about, so its result is
 * "unknown" (evaluated: false), never a failure of the system.
 */
import type { DiagnosticCheckResult } from './types.js';
import { summarizeError } from '../../utils/error-display.js';

export async function safeCheck(
  fn: () => Promise<DiagnosticCheckResult> | DiagnosticCheckResult,
): Promise<DiagnosticCheckResult> {
  try {
    return await fn();
  } catch (err) {
    return {
      passed: false,
      evaluated: false,
      summary: `This check could not read what it needs: ${summarizeError(err)}`,
      severity: 'info',
    };
  }
}

/** The result of a check whose live source this process does not have. */
export function notTracked(what: string): DiagnosticCheckResult {
  return { passed: false, evaluated: false, summary: `${what} is not tracked by this app, so this check was not evaluated.`, severity: 'info' };
}
