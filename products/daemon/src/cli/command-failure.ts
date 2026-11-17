import { readRefusal } from '@goodvibes-jev/engine/errors';
import { describeFatalFailure } from '@goodvibes-jev/engine/platform/platform/daemon/fatal-boot-report';

/**
 * Lines printed when a command throws: its reason through the same masking
 * pass as a failed start, each link of its cause chain with tokens, keys and
 * pairing links masked, its errno-style code (EADDRINUSE, EACCES) and the first
 * next step. A failure that carries a refusal leads with the refusal's code.
 */
export function daemonCommandFailureLines(error: unknown): readonly string[] {
  const carried = readRefusal(error);
  const reason = describeFatalFailure(error);
  return ['Daemon command failed', carried === undefined ? `Reason: ${reason}` : `Reason: ${carried.code}: ${reason}`];
}
