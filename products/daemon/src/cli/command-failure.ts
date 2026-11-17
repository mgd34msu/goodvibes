import { readRefusal } from '@goodvibes-jev/engine/errors';
import { describeFatalFailure } from '@goodvibes-jev/engine/platform/platform/daemon/fatal-boot-report';

/**
 * Lines printed when a command throws. A failure that carries a refusal gets
 * its code and next step. Any other failure prints its reason through the same
 * masking pass as a failed start: each link of its cause chain with tokens,
 * keys and pairing links masked, and its errno-style code (EADDRINUSE, EACCES).
 */
export function daemonCommandFailureLines(error: unknown): readonly string[] {
  const carried = readRefusal(error);
  if (carried === undefined) return ['Daemon command failed', `Reason: ${describeFatalFailure(error)}`];
  const next = carried.next[0];
  return ['Daemon command failed', next === undefined ? `Reason: ${carried.code}.` : `Reason: ${carried.code}. ${next}`];
}
