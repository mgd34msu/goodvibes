/**
 * The one answer to "has setup been done" in the Agent, read by start-up, the
 * setup screen, the harness setup check and status alike, so none of them can
 * offer setup while another says it is complete.
 *
 * The completion marker decides. An install from before the Agent wrote one
 * holds only the check marker, and that marker decides there. Done means the
 * deciding marker has a payload this build reads: a damaged marker, or one from
 * another version that was set aside, is not done anywhere.
 */
import type { OnboardingCheckMarkerState } from './types.ts';
import { readOnboardingCheckMarker, readOnboardingCompletionMarker } from './markers.ts';

type MarkerShellPaths = Parameters<typeof readOnboardingCompletionMarker>[0];

/** The marker that answers whether setup is done (see the module comment). One file read, two when no completion marker exists. */
export function readOnboardingDoneMarker(shellPaths: MarkerShellPaths): OnboardingCheckMarkerState {
  const completion = readOnboardingCompletionMarker(shellPaths, 'user');
  return completion.exists ? completion : readOnboardingCheckMarker(shellPaths, 'user');
}

/** True only when the deciding marker holds a payload this build reads. */
export function isOnboardingComplete(shellPaths: MarkerShellPaths): boolean {
  return readOnboardingDoneMarker(shellPaths).payload !== null;
}
