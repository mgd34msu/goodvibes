/**
 * session-inbound-inputs.ts
 *
 * Live-surface steer delivery (the inbound half of the
 * session spine): the TUI's INBOUND path for steer/follow-up inputs that another
 * live surface (e.g. the webui) queued against THIS TUI's session.
 *
 * Charter: when the owning surface is LIVE (heartbeating within the daemon's
 * SURFACE_ROUTE_FRESHNESS window), a steer is DELIVERED to that surface rather
 * than spawning a daemon-side executor (which would fail on the daemon's empty
 * model registry). The daemon already does its half, `sessions.steer` /
 * `sessions.followUp` to a surface-managed session with a fresh participant
 * QUEUES the input for the surface (mode 'queued-for-surface') instead of
 * spawning. This poller is the surface completing that contract:
 *
 *   1. poll `sessions.inputs.list` for QUEUED inputs on ITS OWN sessionId
 *      (the query is scoped by sessionId, so a steer for another session can
 *      never land here, the per-session isolation the concurrent-sessions
 *      charter requires);
 *   2. hand each steer/follow-up to `onSteer` (the surface-side injection into
 *      the TUI's turn machinery, narrate "steer received from <surface>" and
 *      fire the next-turn boundary), skipping the TUI's own submissions;
 *   3. claim each input on the wire BEFORE injecting it (`sessions.inputs.deliver`
 *      with `claim: true`, queued → delivered). The daemon grants a claim to one
 *      caller, so two terminals showing the same session never both run one steer;
 *      the claim is also the acknowledgement every surface reads as delivered.
 *
 * Discipline (mirrors SessionSpineClient): every wire call is best-effort and
 * never throws into the render/keystroke path; a failed poll leaves the cursor
 * where it was so the input is retried on the next tick. The cursor never moves
 * past an input that was not claimed (the daemon's `since` filter is exclusive,
 * so it would never be listed again). A refused claim means another surface took
 * the input: it is no longer queued, so it is not listed again. A claimed input
 * whose injection threw is retried from memory on the next tick.
 */

import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { Page } from '@goodvibes-jev/engine/errors';
import type {
  SharedSessionInputIntent,
  SharedSessionInputRecord,
} from '@goodvibes-jev/engine/platform/platform/control-plane';

/** The TUI's own participant surfaceId, inputs it authored are never re-injected. */
export const TUI_SURFACE_ID = 'surface:tui';

/** The narrow inbound wire surface this poller needs. Structurally satisfied by
 * the http operator client's `sessions.inputs` (list + deliver). Typed against
 * this shape rather than the concrete client so tests inject a stub. */
export interface SpineInboundInputsClient {
  listInputs(
    sessionId: string,
    options: { readonly state?: string; readonly since?: number; readonly limit?: number },
  ): Promise<Page<SharedSessionInputRecord>>;
  /**
   * `sessions.inputs.deliver { claim: true }`: queued → delivered for exactly one
   * caller; every other caller is refused. Absent on an older wire, where the
   * input is injected first and acknowledged after.
   */
  claimInput?(sessionId: string, inputId: string): Promise<unknown>;
  deliverInput(
    sessionId: string,
    inputId: string,
    options?: { readonly consumed?: boolean },
  ): Promise<unknown>;
}

/** A steer/follow-up collected from the wire for surface-side injection. */
export interface InboundSteer {
  readonly inputId: string;
  readonly sessionId: string;
  readonly intent: SharedSessionInputIntent;
  readonly body: string;
  readonly surfaceKind: string | undefined;
  readonly surfaceId: string | undefined;
  readonly displayName: string | undefined;
}

type InboundLogger = Pick<typeof logger, 'debug' | 'info'>;

export interface SessionInboundInputPollerOptions {
  /** Returns the TUI's current live sessionId, or null when there is none yet.
   * Read on every tick so a session swap re-targets the poll automatically. */
  readonly sessionId: () => string | null;
  /** Surface-side injection: narrate + deliver the steer into the turn machinery. */
  readonly onSteer: (steer: InboundSteer) => void;
  /**
   * False while the turn machinery cannot take a steer yet (start-up): the pass
   * is skipped, so nothing is claimed or reported delivered before a turn can run.
   */
  readonly ready?: () => boolean;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: InboundLogger;
  /** The poller's own surfaceId, inputs it authored are skipped (default TUI). */
  readonly ownSurfaceId?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 4_000;
/** Pages read in one poll at most; a larger backlog continues on the next tick from the cursor. */
const MAX_POLL_PAGES = 16;

export class SessionInboundInputPoller {
  private readonly sessionId: () => string | null;
  private readonly onSteer: (steer: InboundSteer) => void;
  private readonly ready: () => boolean;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: InboundLogger;
  private readonly ownSurfaceId: string;

  private client: SpineInboundInputsClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Exclusive createdAt cursor, per session, a session swap resets it. */
  private cursor = 0;
  private cursorSessionId: string | null = null;
  /** Inputs already handed to onSteer whose delivery ack has not gone through yet (wire without claims). */
  private readonly injected = new Set<string>();
  /** Inputs this surface claimed whose injection threw; injected again on the next pass. */
  private readonly claimedNotInjected = new Map<string, InboundSteer>();

  constructor(options: SessionInboundInputPollerOptions) {
    this.sessionId = options.sessionId;
    this.onSteer = options.onSteer;
    this.ready = options.ready ?? (() => true);
    this.intervalMs = Math.max(250, options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? logger;
    this.ownSurfaceId = options.ownSurfaceId ?? TUI_SURFACE_ID;
  }

  /** Whether a backend is attached (external daemon adopted). */
  get active(): boolean {
    return this.client !== null;
  }

  /**
   * Attach the wire client and begin polling (external daemon adopted). Idempotent:
   * re-activating swaps the client without stacking timers.
   */
  activate(client: SpineInboundInputsClient): void {
    this.client = client;
    if (this.timer === null) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.intervalMs);
      this.timer.unref?.();
    }
    this.log.info('session inbound-input poller activated: collecting queued steers for this surface', {});
  }

  /** Detach the backend and stop polling (daemon mode resolved to non-external, or lost). */
  deactivate(reason: string): void {
    this.client = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info('session inbound-input poller deactivated', { reason });
  }

  /** Stop the timer (shutdown). */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One poll pass: collect queued steer/follow-up inputs for the current session,
   * inject each, and acknowledge delivery. Returns the number of steers delivered.
   * Best-effort: any wire error is absorbed and the pass is retried next tick.
   */
  async pollOnce(): Promise<number> {
    const client = this.client;
    if (!client || this.polling || !this.ready()) return 0;
    const sessionId = this.sessionId();
    if (!sessionId) return 0;

    // A session swap resets the cursor so we never skip the new session's backlog.
    if (sessionId !== this.cursorSessionId) {
      this.cursor = 0;
      this.cursorSessionId = sessionId;
      this.injected.clear();
      this.claimedNotInjected.clear();
    }

    this.polling = true;
    let delivered = 0;
    try {
      for (const [inputId, steer] of this.claimedNotInjected) {
        if (this.inject(steer)) this.claimedNotInjected.delete(inputId);
      }
      // The cursor advances across a contiguous prefix of inputs that are done
      // (acknowledged, or not ours to deliver). After the first failure it holds,
      // so the failed input is listed again on the next tick.
      let cursorHeld = false;
      // `since` is exclusive and createdAt has millisecond resolution, so stop one
      // short of an input's own timestamp: a later input sharing that millisecond
      // that failed would otherwise be filtered out and never listed again.
      const settle = (createdAt: number): void => {
        if (!cursorHeld && createdAt - 1 > this.cursor) this.cursor = createdAt - 1;
      };
      // The daemon answers the OLDEST inputs after the cursor, a page at a time:
      // read pages while it says more remain, so a backlog larger than one page
      // is delivered in order instead of losing its oldest inputs.
      for (let page = 0; page < MAX_POLL_PAGES; page += 1) {
        const cursorBefore = this.cursor;
        const result = await client.listInputs(sessionId, { state: 'queued', since: this.cursor });
        const inputs = result?.items ?? [];
        for (const input of inputs) {
          if (input.state !== 'queued'
            || (input.intent !== 'steer' && input.intent !== 'follow-up')
            // Never re-inject this surface's OWN submissions.
            || input.surfaceId === this.ownSurfaceId) {
            settle(input.createdAt);
            continue;
          }

          const steer: InboundSteer = {
            inputId: input.id,
            sessionId,
            intent: input.intent,
            body: input.body,
            surfaceKind: input.surfaceKind,
            surfaceId: input.surfaceId,
            displayName: input.displayName,
          };
          if (client.claimInput) {
            try {
              await client.claimInput(sessionId, input.id);
            } catch (error) {
              // Refused: another surface claimed it and runs it; it is no longer
              // queued, so it is not listed again. Unreachable: still queued, and
              // the held cursor lists it again next tick. Either way, not injected here.
              cursorHeld = true;
              this.log.debug('session inbound steer not claimed; another surface holds it or the claim will be retried', {
                error: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
            delivered += 1;
            settle(input.createdAt);
            if (!this.inject(steer)) this.claimedNotInjected.set(input.id, steer);
            continue;
          }
          if (!this.injected.has(input.id)) {
            if (!this.inject(steer)) {
              // Not injected, so not acknowledged: the sending surface must not be
              // told a steer was delivered that never reached the turn. It is
              // retried on the next tick, and the loop carries on with the rest.
              cursorHeld = true;
              continue;
            }
            this.injected.add(input.id);
          }
          try {
            // consumed:false → queued → delivered (surface has collected it).
            await client.deliverInput(sessionId, input.id, { consumed: false });
            this.injected.delete(input.id);
            delivered += 1;
            settle(input.createdAt);
          } catch (error) {
            cursorHeld = true;
            this.log.debug('session inbound deliver ack failed; will retry the acknowledgement', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!result?.more || cursorHeld || this.cursor === cursorBefore) break;
      }
    } catch (error) {
      // Poll failed entirely (daemon gone, transient): keep the cursor, retry next tick.
      this.log.debug('session inbound-input poll failed: retry next tick', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }
    return delivered;
  }

  /** Hand one steer to the turn machinery; false when that threw (logged, retried by the caller). */
  private inject(steer: InboundSteer): boolean {
    try {
      this.onSteer(steer);
      return true;
    } catch (error) {
      this.log.debug('session inbound steer injection threw; will retry', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

/** Format the operator-facing narration for an inbound steer, e.g.
 * "steer received from webui (Alice): resize the sidebar". */
export function narrateInboundSteer(steer: InboundSteer): string {
  const surface = steer.surfaceKind ?? steer.surfaceId ?? 'another surface';
  const who = steer.displayName ? ` (${steer.displayName})` : '';
  const verb = steer.intent === 'follow-up' ? 'follow-up received from' : 'steer received from';
  return `${verb} ${surface}${who}: ${steer.body}`;
}

/**
 * Build the standard bootstrap-time poller: sessionId tracks the live runtime
 * session ref, and onSteer narrates the steer to the operator then injects it
 * via the SAME path COMPANION_MESSAGE_RECEIVED uses (orchestrator.handleUserInput).
 * Until the orchestrator is wired the poller does not claim anything (and onSteer
 * throws if reached): a steer that arrives during start-up stays queued and is
 * given to the turn on the first tick after, so it gets an answer instead of
 * sitting in the transcript as delivered with no turn run.
 * Extracted from bootstrap-core.ts to keep this module (not the bootstrap
 * god-function) the owner of the wiring.
 */
export function createBootstrapInboundInputPoller(deps: {
  readonly runtimeSessionIdRef: { readonly value: string };
  readonly routeOrBuffer: (text: string, priority: 'low' | 'high') => void;
  readonly orchestratorHandleUserInputRef: { readonly value: ((text: string) => void) | null };
}): SessionInboundInputPoller {
  return new SessionInboundInputPoller({
    sessionId: () => deps.runtimeSessionIdRef.value || null,
    ready: () => deps.orchestratorHandleUserInputRef.value !== null,
    onSteer: (steer) => {
      const handleUserInput = deps.orchestratorHandleUserInputRef.value;
      if (!handleUserInput) throw new Error('the conversation is still starting; the steer is held for the next tick');
      deps.routeOrBuffer(narrateInboundSteer(steer), 'low');
      handleUserInput(steer.body);
    },
  });
}
