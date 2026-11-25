/**
 * policy-follow.ts: a terminal program follows the policy in force.
 *
 * The policy bundle in force is one activation record, the daemon's
 * (runtime/permissions/policy-config-loader.ts `sharedPolicyActivationPath`):
 * the daemon loads, enforces and restores policies (capabilities/builtin/
 * security-policy.ts). Each program keeps its own copy of the bundle in force
 * (its policy registry), which the gate of a running turn reads, so a turn
 * never asks the daemon. When the daemon changes the record it announces
 * LIST_CHANGED `safety`; on that notice, and each time the daemon's event
 * stream opens again after it was lost (a notice may have been missed), this
 * program reads the record again and takes the bundle it names. A stream that
 * cannot be opened is opened again when this program's daemon connection comes
 * back. Nothing here waits on a clock. The same notice comes when the daemon
 * trusts or restricts a folder, so `follow` also reads this folder's trust
 * again (places/index.ts `followSafetyState`).
 */
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';

export interface PolicyFollowOptions {
  /** The daemon's address and credential for its event stream, or why there is none. */
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  /** Told each time this program's daemon connection comes back; returns the stop. */
  readonly onDaemonBack: (listener: () => void) => () => void;
  /** Read the activation record again into this program's policy registry (permission-composition.ts `followPolicyActivation`). */
  readonly follow: () => void;
}

/** Follow the policy in force for this program's gate; returns the stop. */
export function followPolicyInForce(options: PolicyFollowOptions): () => void {
  let stopped = false;
  let stopStream: (() => void) | null = null;
  const follow = (): void => {
    try { options.follow(); } catch { /* the record is read again on the next notice */ }
  };
  const open = (): void => {
    stopStream?.();
    stopStream = null;
    void options.daemonEndpoint().then((endpoint) => {
      if (stopped || 'unavailable' in endpoint) return;
      stopStream = subscribeDaemonEventFrames(
        { baseUrl: endpoint.baseUrl, getAuthToken: () => endpoint.token },
        { domains: ['workspace'], events: [], lists: ['safety'] },
        follow,
      );
    }, () => { /* No daemon yet: opened when this program's daemon connection is back. */ });
  };
  open();
  const stopBack = options.onDaemonBack(() => {
    if (stopped) return;
    follow();
    open();
  });
  return () => {
    stopped = true;
    stopBack();
    stopStream?.();
    stopStream = null;
  };
}
