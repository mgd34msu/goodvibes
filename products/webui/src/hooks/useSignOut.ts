/**
 * useSignOut, the one sign-out every surface calls (the account menu and Settings,
 * Account): end the sign-in here and on the daemon, and drop the relay pairing once
 * the daemon session is ended or the person chose to leave it.
 *
 * Signing out starts a new client lifetime, which remounts the whole application
 * under IdentityBoundary, so the outcome lives in module scope: the signed-out gate
 * that replaces the screen the person pressed Sign out on reads it and shows the
 * failure with its retry and "Leave it".
 */
import { useSyncExternalStore } from 'react';
import { forgetUnendedSignIn, retryDaemonSignOut, signOut, type SignOutOutcome } from '../lib/goodvibes';
import { unpairRelay } from '../lib/relay-connection';

/** A sign-out whose daemon session could not be ended: signed out here, the reason, and whether a retry is running. */
export interface SignOutProblem {
  readonly error: string;
  readonly retrying: boolean;
}

let problem: SignOutProblem | null = null;
const listeners = new Set<() => void>();

function setProblem(next: SignOutProblem | null): void {
  problem = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function readProblem(): SignOutProblem | null {
  return problem;
}

function finish(): void {
  // A relay pairing routes this browser's requests to one daemon; signing out must not leave it behind.
  // It goes once the daemon session is ended (or given up on): the retry may need the relay route.
  unpairRelay();
  setProblem(null);
}

function settle(outcome: SignOutOutcome): void {
  if (outcome.endedOnDaemon) finish();
  else setProblem({ error: outcome.error ?? 'no answer', retrying: false });
}

/** Sign out here and on the daemon. */
export function signOutEverywhere(): Promise<void> {
  return signOut().then(settle);
}

/** Try again to end the daemon session the sign-out could not end. */
export function retrySignOut(): Promise<void> {
  if (problem !== null) setProblem({ ...problem, retrying: true });
  return retryDaemonSignOut().then(settle);
}

/** Leave the daemon session to end by its own expiry. */
export function leaveSignOutUnended(): void {
  forgetUnendedSignIn();
  finish();
}

export function useSignOut(): {
  readonly problem: SignOutProblem | null;
  readonly signOut: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly leaveIt: () => void;
} {
  const current = useSyncExternalStore(subscribe, readProblem, readProblem);
  return { problem: current, signOut: signOutEverywhere, retry: retrySignOut, leaveIt: leaveSignOutUnended };
}
