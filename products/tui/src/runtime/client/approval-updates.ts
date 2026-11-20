/**
 * approval-updates.ts, this terminal's subscription to approval decisions made
 * somewhere else.
 *
 * ── What this replaces ────────────────────────────────────────────────────
 *
 * The platform's client raiser (approval-raiser.ts) raises an ask on the daemon and
 * prompts locally at the same time, and then has to learn about a decision made
 * on another surface, a phone, the web UI, a second terminal. Without a push
 * channel wired it learns by RE-READING the record on an interval, which is
 * both slower than it needs to be and the thing the `control.approval_update`
 * event exists to end. Wiring this seam makes a remote decision arrive in the
 * time one frame takes.
 *
 * The interval is deliberately KEPT as the fallback, not removed: a terminal
 * whose daemon refuses the stream (no daemon, a 401, a proxy that will not hold
 * a connection) still has to be able to answer a tool call. `watchApprovalUpdates`
 * reports failure by returning null rather than throwing, and the raiser then
 * behaves exactly as it did before this seam existed. Push is the fast path, not
 * a new dependency, and the raiser's own discipline of doing one immediate read
 * after subscribing stays intact, because a decision can land between the raise
 * and the subscription and no push channel can deliver what happened before it
 * opened.
 *
 * ── Why the product owns this and the platform does not ────────────────────────
 *
 * Resolving "which daemon" and proving this surface may subscribe to it are
 * trust-boundary concerns the platform core deliberately never reaches into (the
 * same carve-out `DaemonVerbCaller` records). The resolution here is the one
 * every other client seam in this repo uses: operator-endpoint.ts.
 */
import { watchApprovalUpdates } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { ApprovalUpdateSubscriber } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { resolveDaemonEndpoint } from './operator-endpoint.ts';

export interface TerminalApprovalUpdateSubscriberOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** Injectable fetch (tests, or a relay-tunnelled fetch). */
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Build the subscriber the platform raiser takes.
 *
 * Every refusal is a null return, never a throw: this runs on the path that
 * decides a tool call, and a subscription that cannot be opened must degrade to
 * the interval rather than take the ask down with it.
 */
export function createTerminalApprovalUpdateSubscriber(
  options: TerminalApprovalUpdateSubscriberOptions,
): ApprovalUpdateSubscriber {
  return async (onUpdate, onTerminate) => {
    const endpoint = await resolveDaemonEndpoint({ configManager: options.configManager, homeDirectory: options.homeDirectory });
    if (!endpoint.available) {
      logger.debug('[approvals] the approval-update stream is not opened', { reason: endpoint.reason });
      return null;
    }
    const token = endpoint.token;
    return await watchApprovalUpdates({
      baseUrl: endpoint.baseUrl,
      getAuthToken: () => token,
      onUpdate,
      // The raiser reads the record instead once the stream has ended.
      ...(onTerminate ? { onTerminate: () => onTerminate() } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  };
}
