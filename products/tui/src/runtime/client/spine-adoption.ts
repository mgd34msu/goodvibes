/**
 * spine-adoption.ts, wiring this surface's session and memory spines to the
 * daemon it adopted, over the platform's adoption policy.
 *
 * ── What moved to the platform, and what stays here ────────────────────────────
 *
 * The platform's `@goodvibes/engine/platform/platform/runtime/client` now owns WHEN the
 * wire comes up and goes down: idempotent per base URL, torn down on a
 * change, the one-time legacy-store fold. This module owns WHAT the wire is,
 * this terminal's own `createDaemonHttpTransport` + `createSessionSpineRestTransport` +
 * `createTuiMemorySpineTransport`, injected as the platform's `connect(baseUrl,
 * authToken)` callback, because building the actual HTTP client is the same
 * connection-resolution concern the verb caller already keeps product-side.
 *
 * `activation: 'adopt-on-status'` is passed explicitly: this terminal gates
 * adoption on its boot discovery probe's `external` verdict (it can render
 * "no daemon" honestly), rather than wiring live-immediately the moment it is
 * handed a base URL.
 *
 * ── What crosses the wire ──────────────────────────────────────────────────
 *
 * Session IDENTITY, not session execution. The conversation itself runs here;
 * what the daemon holds is the register,
 * which sessions exist, which surface is live on each, and the inputs queued
 * against them. Concretely, on adoption this wires:
 *
 *   - `sessions.register` / `sessions.close`, the identity mirror, deliberately
 *     fire-and-forget so a slow daemon never shows up in a keystroke.
 *   - `sessions.inputs.list` / `sessions.inputs.deliver`, the inbound steer
 *     path, so a message another surface queued for THIS session lands in the
 *     turn machinery here and is acknowledged on the wire.
 *   - `sessions.list`, the cross-surface union the modals read, interval-
 *     refreshed and served synchronously.
 *   - the memory spine's wire transport, folded into the same handler by the
 *     platform, this module's own `syncMemorySpineToHostStatus` call is retired;
 *     supplying `memoryTransport` in the bundle and `memorySpine` in the
 *     options is what activates it now.
 *
 * Plus a one-time, marker-guarded fold of this project's own pre-spine
 * `control-plane/sessions.json` into the adopted daemon, done by the platform.
 *
 * ── Why this module's exported shape does not change ──────────────────────
 *
 * `bootstrap.ts` gates on `HostServiceStatus` and hands a bare
 * `(daemonStatus, sharedDaemonToken)` pair to whatever this returns. The platform's
 * handler takes a narrower `{ mode, baseUrl }` signal instead, so the adapting
 * happens inside this module rather than at the call site.
 */
import { parseDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { createDaemonHttpTransport, type HostServiceStatus, type DaemonHttpTransportOptions } from '@/runtime/index.ts';
import { createSessionInputChangeSubscriber, createSpineAdoptionSync as createPlatformSpineAdoptionSync, programFetch } from '@goodvibes/engine/platform/platform/runtime/client';
import type { SpineAdoptionOptions as PlatformSpineAdoptionOptions } from '@goodvibes/engine/platform/platform/runtime/client';

import { createSessionSpineRestTransport } from '@goodvibes/engine/platform/platform/runtime/session-spine';
import { createTuiMemorySpineTransport } from '../memory-spine-transport.ts';

/** This module's own options: the platform's shape minus the two fields it builds itself. */
export type SpineAdoptionOptions = Omit<PlatformSpineAdoptionOptions, 'connect' | 'activation'> & {
  /** Retry observers for the daemon wire, so its retries reach the runtime bus and the retry counter. */
  readonly retryHooks?: Pick<DaemonHttpTransportOptions, 'onRetryScheduled' | 'onRetryExecuted'> | undefined;
};

/**
 * Build the "the adopted daemon changed" handler.
 *
 * Idempotent per base URL (the platform's own guarantee): re-running it against the
 * same adopted daemon is a no-op, so a re-probe after an autostart does not
 * tear a live mirror down and put it back up.
 */
export function createSpineAdoptionSync(
  options: SpineAdoptionOptions,
): (daemonStatus: HostServiceStatus, sharedDaemonToken: string) => void {
  const { retryHooks, ...platformOptions } = options;
  const sync = createPlatformSpineAdoptionSync({
    ...platformOptions,
    // This terminal has a boot discovery probe and can render "no daemon"
    // honestly, so it gates on the probe's verdict rather than wiring the
    // moment it is handed a base URL.
    activation: 'adopt-on-status',
    connect: (baseUrl, authToken) => {
      // Its calls and its event stream with this program's registration: the operator token alone is a script on this
      // machine and reaches none of the owner's sessions (their inputs included).
      const httpTransport = createDaemonHttpTransport({ baseUrl, authToken, fetchImpl: programFetch(fetch), ...retryHooks });
      return {
        // The conversation is registered with this program's own registration (the session spine's REST transport sends
        // the call context and the key the daemon issued this program, as the Agent's does): the daemon then knows the
        // conversation as this program's, so a model's delegation from it is decided under the owner's mode
        // (control-plane/routes/capabilities.ts conversationDelegation), not put to the owner as a script's.
        // Pinned to this daemon: a close owed to it is sent only through a transport for it.
        sessionTransport: { ...createSessionSpineRestTransport({ resolveConnection: () => ({ baseUrl, token: authToken || null }) }), targetId: () => parseDaemonOrigin(baseUrl)?.baseUrl ?? baseUrl },
        inboundInputs: {
          listInputs: (sessionId, opts) => httpTransport.operator.sessions.inputsPage(sessionId, opts),
          // A renewal sends the claim's token (its epoch), so a held input stays this surface's while it waits.
          claimInput: (sessionId, inputId, claimEpoch?: number) =>
            httpTransport.operator.sessions.deliverInput(sessionId, inputId, { claim: true, ...(claimEpoch === undefined ? {} : { claimEpoch }) }),
          deliverInput: (sessionId, inputId, opts) =>
            httpTransport.operator.sessions.deliverInput(sessionId, inputId, opts),
          // Input moves are pushed from the daemon's session-update stream, so a hosted
          // session is read when one of its inputs moved, not every two seconds.
          subscribeInputChanges: createSessionInputChangeSubscriber({ baseUrl, getAuthToken: () => authToken }),
          // This client always goes to the daemon it was made for: answers owed to it are sent only through it.
          targetId: () => parseDaemonOrigin(baseUrl)?.baseUrl ?? baseUrl,
        },
        sessionList: { list: (limit: number) => httpTransport.operator.sessions.list(limit) },
        memoryTransport: createTuiMemorySpineTransport({ baseUrl, authToken }),
      };
    },
  });

  return (daemonStatus, sharedDaemonToken) => {
    sync({ mode: daemonStatus.mode, baseUrl: daemonStatus.baseUrl }, sharedDaemonToken);
  };
}
