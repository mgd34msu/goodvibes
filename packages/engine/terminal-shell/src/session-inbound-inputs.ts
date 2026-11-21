/**
 * session-inbound-inputs.ts
 *
 * The inbound half of the session spine for both terminal programs: the steer
 * and follow-up inputs that another surface (the web app, the companion app, a
 * channel such as ntfy) queued against the session THIS terminal runs.
 *
 * When the owning surface is live, the daemon queues a steer or follow-up for
 * it (mode 'queued-for-surface') instead of starting an agent of its own. This
 * poller completes that contract:
 *
 *   1. poll `sessions.inputs.list` for QUEUED inputs on its own session id (the
 *      query is scoped by session, so an input for another session never lands
 *      here);
 *   2. claim each input on the wire BEFORE injecting it (`sessions.inputs.deliver`
 *      with `claim: true`, queued → delivered). The daemon grants a claim to one
 *      caller, so two terminals showing the same session never both run one input;
 *   3. hand it to `onSteer`, which runs it in this terminal's conversation; the
 *      input's origin goes with it, so a message from the companion app or a
 *      channel is not taken for the owner typing here;
 *   4. report it done. For an input that came in over a channel route (it has a
 *      `routeId`), `onSteer` returns the turn's answer: the input is bound to a
 *      surface-turn id while it runs, and the answer is reported with it
 *      (`consumed`, `agentId`, `answer`), so the daemon writes it into the shared
 *      session and sends it back down that channel.
 *
 * Discipline: every wire call is best-effort and never throws into the
 * render/keystroke path; a failed poll leaves the cursor where it was so the
 * input is retried on the next tick. The cursor never moves past an input that
 * was not claimed (the daemon's `since` filter is exclusive, so it would never
 * be listed again). A refused claim means another surface took the input. A
 * claimed input whose injection threw is retried from memory on the next tick.
 *
 * Each input carries the session binding (session-binding.ts) it was listed
 * for: the session and the daemon client current when the pass began. An input
 * is injected only while this terminal is still on that session; one claimed
 * for a session the terminal has switched away from is kept for that session
 * and given to it when the terminal returns.
 */

import { logger } from '@goodvibes/engine/platform/platform/utils';
import { SessionBindingOwner, type SessionBinding } from '@goodvibes/engine/platform/platform/runtime/client/session-binding';
import type { Page } from '@goodvibes/engine/errors';
import type { SharedSessionInputIntent, SharedSessionInputRecord } from '@goodvibes/engine/platform/platform/control-plane';
import type { RuntimeEventBus } from '@goodvibes/engine/platform/platform/runtime/state';
import type { TurnEvent, TurnInputOrigin } from '@goodvibes/engine/platform/events/turn';
import type { OrchestratorUserInputOptions } from '@goodvibes/engine/platform/platform/core';
import { SESSION_HANDOVER_METADATA_KEY } from './session-handover.js';
import type { OwnerInputAnswer, OwnerInputAnswered } from './companion-input.js';

/** The terminal app's own participant surfaceId; inputs it authored are never re-injected. */
export const TUI_SURFACE_ID = 'surface:tui';

/** How a finished turn answered an input: its text, and whether it completed. */
export type InboundSteerAnswer = OwnerInputAnswer;

/** The narrow inbound wire surface this poller needs (`sessions.inputs.list` and `sessions.inputs.deliver`). */
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
    options?: {
      readonly consumed?: boolean;
      readonly claimEpoch?: number;
      /** The surface turn answering the input; with `answer`, the daemon routes the answer back to its channel. */
      readonly agentId?: string;
      readonly answer?: string;
      readonly status?: InboundSteerAnswer['status'];
    },
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
  /** The channel route the input came in on; its answer goes back down it. */
  readonly routeId: string | undefined;
  /**
   * Where the input came from, for the turn: undefined for the owner's own
   * surfaces (the web app, another terminal), a source for the companion app
   * and channels, which are not the owner typing here.
   */
  readonly origin: TurnInputOrigin | undefined;
  /** A request from another terminal to save this session and let go of it (session-handover.ts); never run as a turn. */
  readonly handover: boolean;
}

/** A steer and the session (and daemon client) it was listed for, with the claim token the daemon granted. */
interface BoundSteer {
  readonly steer: InboundSteer;
  readonly binding: SessionBinding;
  readonly claimEpoch?: number | undefined;
}

/** An injected input waiting to be reported done, with its answer once its turn has given one. */
interface PendingCompletion {
  readonly sessionId: string;
  readonly claimEpoch?: number | undefined;
  /** Set for an input whose answer is reported: the surface turn bound to it. */
  readonly agentId?: string | undefined;
  /** Whether the input was bound to `agentId` on the wire yet. */
  bound: boolean;
  /** The turn's answer; undefined while the turn runs. */
  answer?: InboundSteerAnswer | undefined;
}

/** How long a claimed input with no agent stays its claimant's before another may claim it (the daemon's SURFACE_CLAIM_LEASE_MS). */
const CLAIM_LEASE_MS = 2 * 60_000;
/** How often claimed-but-unanswered inputs are looked for: once per lease half is enough to find one when it becomes claimable. */
const DELIVERED_SWEEP_MS = 60_000;

/** The claim epoch a granted claim returned (`{ input }` with `metadata.claimEpoch`), when it has one. */
function grantedEpoch(reply: unknown): number | undefined {
  const input = reply && typeof reply === 'object' && 'input' in reply ? (reply as { readonly input?: unknown }).input : reply;
  const metadata = input && typeof input === 'object' ? (input as { readonly metadata?: unknown }).metadata : undefined;
  const epoch = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)['claimEpoch'] : undefined;
  return typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch > 0 ? epoch : undefined;
}

/** Surfaces that are the owner's own: what they queue is the owner speaking. */
const OWNER_SURFACE_KINDS: ReadonlySet<string> = new Set(['web', 'tui', 'agent']);

/** Where an input came from, as a turn origin; undefined for the owner's own surfaces. */
function inputOrigin(input: SharedSessionInputRecord): TurnInputOrigin | undefined {
  const source = typeof input.metadata?.['source'] === 'string' ? input.metadata['source'] as string : undefined;
  if (!source && !input.routeId && (input.surfaceKind === undefined || OWNER_SURFACE_KINDS.has(input.surfaceKind))) return undefined;
  const topic = typeof input.metadata?.['topic'] === 'string' ? input.metadata['topic'] as string : undefined;
  return {
    source: source ?? input.surfaceKind ?? 'session-input',
    messageId: `session-input:${input.id}`,
    ...(input.surfaceKind ? { surface: input.surfaceKind } : {}),
    ...(topic ? { topic } : {}),
    ownerDirect: false,
  };
}

function steerOf(input: SharedSessionInputRecord, sessionId: string): InboundSteer {
  return {
    inputId: input.id,
    sessionId,
    intent: input.intent,
    body: input.body,
    surfaceKind: input.surfaceKind,
    surfaceId: input.surfaceId,
    displayName: input.displayName,
    routeId: input.routeId,
    origin: inputOrigin(input),
    handover: isHandoverRequest(input),
  };
}

function isHandoverRequest(input: SharedSessionInputRecord): boolean {
  return input.intent === 'steer' && input.metadata?.[SESSION_HANDOVER_METADATA_KEY] === true;
}

/** The id an input's surface turn is bound under: one per input, stable across retries. */
function surfaceTurnId(inputId: string): string {
  return `surface-turn:${inputId}`;
}

type InboundLogger = Pick<typeof logger, 'debug' | 'info'>;

export interface SessionInboundInputPollerOptions {
  /** The terminal's current live sessionId, or null when there is none yet; read on every tick. */
  readonly sessionId: () => string | null;
  /**
   * Run the input in the conversation. For an input with a `routeId`, return
   * the promise of its turn's answer, which is reported back to its channel;
   * otherwise return nothing. Throws when the conversation cannot take it now.
   */
  readonly onSteer: (steer: InboundSteer) => Promise<InboundSteerAnswer> | void;
  /** False while the turn machinery cannot take a steer yet (start-up): nothing is claimed then. */
  readonly ready?: () => boolean;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: InboundLogger;
  /** The poller's own surfaceId; inputs it authored are skipped. */
  readonly ownSurfaceId?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 4_000;
/** Pages read in one poll at most; a larger backlog continues on the next tick from the cursor. */
const MAX_POLL_PAGES = 16;

export class SessionInboundInputPoller {
  private readonly sessionId: () => string | null;
  private readonly onSteer: SessionInboundInputPollerOptions['onSteer'];
  private readonly ready: () => boolean;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: InboundLogger;
  private readonly ownSurfaceId: string;

  private client: SpineInboundInputsClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Exclusive createdAt cursor, per session; a session swap resets it. */
  private cursor = 0;
  private cursorSessionId: string | null = null;
  /** Inputs already handed to onSteer whose delivery ack has not gone through yet (wire without claims). */
  private readonly injected = new Set<string>();
  /** Inputs this surface claimed and has not injected (the injection threw, or the terminal left their session). */
  private readonly claimedNotInjected = new Map<string, BoundSteer>();
  /** Inputs injected here whose completion report has not reached the daemon yet; retried every pass. */
  private readonly toComplete = new Map<string, PendingCompletion>();
  /** When claimed inputs nobody answered were last looked for. */
  private lastDeliveredSweep = 0;
  /** The session (and daemon client, by activation) each pass is for. */
  private readonly bindings = new SessionBindingOwner();
  /** Moves on every activate: a new client may be another daemon. */
  private clientGeneration = 0;

  constructor(options: SessionInboundInputPollerOptions) {
    this.sessionId = options.sessionId;
    this.onSteer = options.onSteer;
    this.ready = options.ready ?? (() => true);
    this.intervalMs = Math.max(250, options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? logger;
    this.ownSurfaceId = options.ownSurfaceId ?? TUI_SURFACE_ID;
  }

  /** Whether a backend is attached (a daemon adopted). */
  get active(): boolean {
    return this.client !== null;
  }

  /** Attach the wire client and begin polling. Idempotent: re-activating swaps the client without stacking timers. */
  activate(client: SpineInboundInputsClient): void {
    if (client !== this.client) this.clientGeneration += 1;
    this.client = client;
    if (this.timer === null) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.intervalMs);
      this.timer.unref?.();
    }
    this.log.info('session inbound-input poller activated: collecting queued steers for this surface', {});
  }

  /** Detach the backend and stop polling (the daemon was lost or is not adopted). */
  deactivate(reason: string): void {
    this.client = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info('session inbound-input poller deactivated', { reason });
  }

  /**
   * Stop the timer (shutdown). An input this terminal claimed and has not
   * answered is reported ended, with that said to its sender, so its claim is
   * released instead of held by a terminal that is gone.
   */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const client = this.client;
    if (!client) return;
    for (const done of this.toComplete.values()) {
      done.answer ??= { answer: 'This message was not answered: the terminal running the conversation closed first. Send it again.', status: 'failed' };
    }
    void this.reportCompleted(client).catch(() => undefined);
  }

  /**
   * One poll pass: collect queued steer/follow-up inputs for the current
   * session, inject each, and report delivery. Returns the number delivered.
   * Best-effort: any wire error is absorbed and the pass is retried next tick.
   */
  async pollOnce(): Promise<number> {
    const client = this.client;
    if (!client || this.polling || !this.ready()) return 0;
    const sessionId = this.sessionId();
    if (!sessionId) return 0;

    if (sessionId !== this.cursorSessionId) {
      this.cursor = 0;
      this.cursorSessionId = sessionId;
    }
    const binding = this.bindings.bind(`client-${this.clientGeneration}`, sessionId);
    const stillHere = (): boolean => this.bindings.bind(`client-${this.clientGeneration}`, this.sessionId() ?? '') === binding
      && this.client === client;

    this.polling = true;
    let delivered = 0;
    try {
      for (const [inputId, held] of this.claimedNotInjected) {
        if (!this.bindings.isSameSession(held.binding)) continue;
        if (this.injectClaimed(held.steer, held.claimEpoch)) this.claimedNotInjected.delete(inputId);
      }
      await this.reportCompleted(client);
      // The cursor advances across a contiguous prefix of inputs that are done
      // (acknowledged, or not ours to deliver). After the first failure it holds.
      let cursorHeld = false;
      // `since` is exclusive and createdAt has millisecond resolution, so stop one
      // short of an input's own timestamp.
      const settle = (createdAt: number): void => {
        if (!cursorHeld && createdAt - 1 > this.cursor) this.cursor = createdAt - 1;
      };
      for (let page = 0; page < MAX_POLL_PAGES; page += 1) {
        const cursorBefore = this.cursor;
        const result = await client.listInputs(sessionId, { state: 'queued', since: this.cursor });
        const inputs = result?.items ?? [];
        for (const input of inputs) {
          if (input.state !== 'queued'
            || (input.intent !== 'steer' && input.intent !== 'follow-up')
            || (input.surfaceId === this.ownSurfaceId && !isHandoverRequest(input))) {
            settle(input.createdAt);
            continue;
          }
          const steer = steerOf(input, sessionId);
          if (!stillHere()) { cursorHeld = true; break; }
          if (client.claimInput) {
            let claimEpoch: number | undefined;
            try {
              claimEpoch = grantedEpoch(await client.claimInput(sessionId, input.id));
            } catch (error) {
              // Refused: another surface holds it. Unreachable: still queued, listed again next tick.
              cursorHeld = true;
              this.log.debug('session inbound steer not claimed; another surface holds it or the claim will be retried', {
                error: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
            delivered += 1;
            settle(input.createdAt);
            if (!stillHere() || !this.injectClaimed(steer, claimEpoch)) this.claimedNotInjected.set(input.id, { steer, binding, claimEpoch });
            continue;
          }
          if (!this.injected.has(input.id)) {
            // Not injected, so not acknowledged; retried on the next tick.
            if (this.inject(steer) === false) { cursorHeld = true; continue; }
            this.injected.add(input.id);
          }
          try {
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
        if (!result?.more || cursorHeld || this.cursor === cursorBefore || !stillHere()) break;
      }
      if (client.claimInput && stillHere() && this.now() - this.lastDeliveredSweep >= DELIVERED_SWEEP_MS) {
        this.lastDeliveredSweep = this.now();
        delivered += await this.reclaimUnanswered(client, sessionId, binding, stillHere);
      }
      await this.reportCompleted(client);
    } catch (error) {
      this.log.debug('session inbound-input poll failed: retry next tick', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }
    return delivered;
  }

  /**
   * A steer claimed for this session that no surface answered stays
   * `delivered` with no agent. Once its lease has passed the daemon grants it
   * again, so it is claimed and injected here instead of being lost. One read
   * per sweep interval.
   */
  private async reclaimUnanswered(client: SpineInboundInputsClient, sessionId: string, binding: SessionBinding, stillHere: () => boolean): Promise<number> {
    let reclaimed = 0;
    const page = await client.listInputs(sessionId, { state: 'delivered' });
    for (const input of page?.items ?? []) {
      if (input.state !== 'delivered' || input.activeAgentId || input.surfaceId === this.ownSurfaceId) continue;
      if (input.intent !== 'steer' && input.intent !== 'follow-up') continue;
      if (this.toComplete.has(input.id) || this.claimedNotInjected.has(input.id)) continue;
      if (this.now() - input.updatedAt < CLAIM_LEASE_MS) continue;
      if (!stillHere()) break;
      let claimEpoch: number | undefined;
      try {
        claimEpoch = grantedEpoch(await client.claimInput!(sessionId, input.id));
      } catch {
        continue;
      }
      const steer = steerOf(input, sessionId);
      reclaimed += 1;
      if (!stillHere() || !this.injectClaimed(steer, claimEpoch)) this.claimedNotInjected.set(input.id, { steer, binding, claimEpoch });
    }
    return reclaimed;
  }

  /** Inject a claimed input and queue its completion report; false when the injection threw. */
  private injectClaimed(steer: InboundSteer, claimEpoch: number | undefined): boolean {
    const answer = this.inject(steer);
    if (answer === false) return false;
    const completion: PendingCompletion = {
      sessionId: steer.sessionId,
      ...(claimEpoch === undefined ? {} : { claimEpoch }),
      ...(answer && steer.routeId ? { agentId: surfaceTurnId(steer.inputId) } : {}),
      bound: false,
    };
    if (completion.agentId === undefined) completion.answer = { answer: '', status: 'completed' };
    else if (answer) {
      void answer.then(
        (outcome) => { completion.answer = outcome; },
        (error: unknown) => {
          completion.answer = { answer: `This message could not be answered: ${error instanceof Error ? error.message : String(error)}`, status: 'failed' };
        },
      );
    }
    this.toComplete.set(steer.inputId, completion);
    return true;
  }

  /**
   * Report injected inputs to the daemon: an input whose answer goes back to
   * its channel is first bound to its surface turn, then reported with the
   * answer once the turn gave one; any other is reported done at once. A failed
   * report is retried next pass.
   */
  private async reportCompleted(client: SpineInboundInputsClient): Promise<void> {
    if (!client.claimInput) return;
    for (const [inputId, done] of [...this.toComplete]) {
      const epoch = done.claimEpoch === undefined ? {} : { claimEpoch: done.claimEpoch };
      try {
        if (done.agentId !== undefined && !done.bound) {
          await client.deliverInput(done.sessionId, inputId, { agentId: done.agentId, ...epoch });
          done.bound = true;
        }
        if (done.answer === undefined) continue;
        await client.deliverInput(done.sessionId, inputId, {
          consumed: true,
          ...epoch,
          ...(done.agentId === undefined ? {} : { agentId: done.agentId, answer: done.answer.answer, status: done.answer.status }),
        });
        this.toComplete.delete(inputId);
      } catch (error) {
        // A superseded claim is the other claimant's now; anything else is retried.
        if (/INPUT_NOT_CLAIMABLE|INPUT_NOT_DELIVERABLE|409/.test(error instanceof Error ? error.message : String(error))) this.toComplete.delete(inputId);
      }
    }
  }

  /** Hand one input to the conversation: its answer promise, nothing, or false when that threw (logged, retried). */
  private inject(steer: InboundSteer): Promise<InboundSteerAnswer> | void | false {
    try {
      return this.onSteer(steer);
    } catch (error) {
      this.log.debug('session inbound steer injection threw; will retry', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

/**
 * Sender-supplied text on one bounded line: control characters (newlines,
 * escapes) become spaces, so a remote sender cannot start a second line or fake
 * a prefix in the operator's notice.
 */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The operator-facing narration for an inbound input, e.g. "steer received from web (Alice): resize the sidebar". */
export function narrateInboundSteer(steer: InboundSteer): string {
  const surface = oneLine(steer.surfaceKind ?? steer.surfaceId ?? 'another surface', 40);
  const who = steer.displayName ? ` (${oneLine(steer.displayName, 40)})` : '';
  const verb = steer.intent === 'follow-up' ? 'follow-up received from' : 'steer received from';
  return `${verb} ${surface}${who}: ${oneLine(steer.body, 200)}`;
}

/**
 * The answers of turns started for inputs, read from the runtime bus: a turn
 * whose origin names an input's message id is that input's turn, and its
 * completion, error or cancel is the answer. One set of listeners for every
 * input, attached on first use.
 */
function createTurnAnswerWatch(bus: Pick<RuntimeEventBus, 'on'>): {
  /** The answer of the turn for `messageId`, and the way for a turn run elsewhere to give it; the first one given counts. */
  readonly answerFor: (messageId: string) => { readonly answer: Promise<InboundSteerAnswer>; readonly answered: OwnerInputAnswered };
  readonly dispose: () => void;
} {
  const waiting = new Map<string, (answer: InboundSteerAnswer) => void>();
  const turns = new Map<string, string>();
  let unsubs: Array<() => void> = [];
  const settle = (turnId: string, answer: InboundSteerAnswer): void => {
    const messageId = turns.get(turnId);
    if (messageId === undefined) return;
    turns.delete(turnId);
    // The waiter removes itself (and its turn) when it takes the answer.
    waiting.get(messageId)?.(answer);
  };
  const attach = (): void => {
    if (unsubs.length > 0) return;
    unsubs = [
      bus.on<Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>>('TURN_SUBMITTED', ({ payload }) => {
        const messageId = payload.origin?.messageId;
        if (messageId !== undefined && waiting.has(messageId)) turns.set(payload.turnId, messageId);
      }),
      bus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => {
        settle(payload.turnId, { answer: payload.response, status: 'completed' });
      }),
      bus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload }) => {
        settle(payload.turnId, { answer: `The answer failed: ${payload.error}`, status: 'failed' });
      }),
      bus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload }) => {
        settle(payload.turnId, { answer: 'The request was cancelled before it finished.', status: 'cancelled' });
      }),
    ];
  };
  return {
    answerFor: (messageId) => {
      attach();
      let give: (answer: InboundSteerAnswer) => void = () => {};
      const answer = new Promise<InboundSteerAnswer>((resolve) => {
        give = (value) => {
          if (waiting.get(messageId) !== give) return;
          waiting.delete(messageId);
          for (const [turnId, id] of turns) if (id === messageId) turns.delete(turnId);
          resolve(value);
        };
        waiting.set(messageId, give);
      });
      return { answer, answered: (value) => give(value) };
    },
    dispose: () => {
      for (const unsub of unsubs) unsub();
      unsubs = [];
    },
  };
}

/**
 * The bootstrap-time poller: the session id tracks the live runtime session,
 * and each input is narrated to the operator then run through the same path an
 * owner message takes (the conversation's user-input handler), with its origin.
 * Until that handler is wired the poller claims nothing: an input that arrives
 * during start-up stays queued and is run on the first tick after.
 */
export function createBootstrapInboundInputPoller(deps: {
  readonly runtimeSessionIdRef: { readonly value: string };
  readonly narrate: (text: string) => void;
  readonly orchestratorHandleUserInputRef: { readonly value: ((text: string, options?: OrchestratorUserInputOptions, answered?: OwnerInputAnswered) => void) | null };
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  readonly ownSurfaceId?: string;
  /** Another terminal asked for this session: save it, let go of it, tell the person (session-handover.ts `handOverLiveSession`). */
  readonly onHandover: (sessionId: string) => void;
}): { readonly poller: SessionInboundInputPoller; readonly dispose: () => void } {
  const answers = createTurnAnswerWatch(deps.runtimeBus);
  const poller = new SessionInboundInputPoller({
    sessionId: () => deps.runtimeSessionIdRef.value || null,
    ready: () => deps.orchestratorHandleUserInputRef.value !== null,
    ...(deps.ownSurfaceId ? { ownSurfaceId: deps.ownSurfaceId } : {}),
    onSteer: (steer) => {
      // Saved and released before the input is reported done, which is what the asking terminal waits for.
      if (steer.handover) {
        deps.onHandover(steer.sessionId);
        return;
      }
      const handleUserInput = deps.orchestratorHandleUserInputRef.value;
      if (!handleUserInput) throw new Error('the conversation is still starting; the input is held for the next tick');
      deps.narrate(narrateInboundSteer(steer));
      // The answer of an input from a channel route goes back to that channel, exactly once:
      // from this process's turn events when the turn runs here, else from whoever ran it
      // (the connected host's loop) or from the refusal that kept it from running.
      if (!steer.routeId || !steer.origin?.messageId) {
        handleUserInput(steer.body, steer.origin ? { origin: steer.origin } : undefined);
        return undefined;
      }
      const reply = answers.answerFor(steer.origin.messageId);
      handleUserInput(steer.body, { origin: steer.origin }, reply.answered);
      return reply.answer;
    },
  });
  return { poller, dispose: () => { poller.dispose(); answers.dispose(); } };
}
