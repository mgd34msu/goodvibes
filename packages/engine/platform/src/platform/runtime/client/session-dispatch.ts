/**
 * session-dispatch.ts, how work that arrives for a session THIS surface hosts
 * reaches the loop, now that the register is not in this process.
 *
 * ── The seam ───────────────────────────────────────────────────────────────
 *
 * A surface composition used to own a persisting `SharedSessionBroker`, and the
 * broker's `setContinuationRunner` was how the graph said "when a continuation
 * arrives for a session, spawn this". The broker was the register AND the
 * dispatcher, and the surface owned both.
 *
 * As a client it owns neither. The daemon holds the register; a surface only
 * needs to RECEIVE dispatch for sessions it is running. That is exactly the
 * `SessionContinuationDispatch` seam the client shape takes, one method,
 * `setContinuationRunner`, and this module satisfies it over the wire:
 * `sessions.inputs.list` for continuation-intent inputs on the sessions this
 * surface hosts, the bound runner for each, `sessions.inputs.deliver` to
 * acknowledge.
 *
 * ── The reply half ─────────────────────────────────────────────────────────
 *
 * The runner returns the id of the agent it started, and that id is not
 * bookkeeping, it is the reply binding. When the daemon spawns a continuation
 * itself, `SharedSessionBroker.bindAgent` pairs the agent with the input it was
 * started for and announces the pairing, which is how an answer to a message
 * that arrived from Telegram/Slack/ntfy finds its way back to that
 * conversation. Dispatched over the wire, the agent runs HERE, so nothing in
 * the daemon could make that pairing: the id was dropped, no binding existed,
 * and a channel message answered by a surface was answered into the void.
 *
 * So this dispatcher reports both halves of the pairing:
 *  - on dispatch, `deliver` carries `agentId` and marks the input DELIVERED,
 *    "collected, and this agent is answering it". The daemon binds the reply
 *    there.
 *  - when that agent finishes, `deliver` carries the answer and marks the input
 *    COMPLETED, "finished acting on it, here is what it said". The daemon
 *    writes it into the session and pushes it down the reply pipeline, exactly
 *    as its own completion poll does for the agents it spawned itself.
 *
 * The finish half needs a way to read this surface's own agent outcomes, which
 * is the `readAgentOutcome` option. A host that does not supply one keeps the
 * old single-acknowledgement behavior (still carrying `agentId`, so the reply
 * is bound) rather than silently claiming an answer it cannot produce.
 *
 * ── Discipline (inherited from the spine client, deliberately) ─────────────
 *
 * Every wire call is best-effort and never throws into the render or keystroke
 * path. A failed poll leaves the cursor where it was, so the input is retried
 * next tick. `deliver` de-duplicates across processes, because an input already
 * advanced past `queued` is not returned again; within this process a claim
 * remembers what the runner already did with an input whose `deliver` has not
 * landed, so a retry re-acknowledges it instead of starting a second agent.
 * Nothing here blocks a turn.
 *
 * ── When it reads ──────────────────────────────────────────────────────────
 *
 * A client that can report input changes (`subscribeInputChanges`, fed from
 * the daemon's session-update stream it already opens) drives dispatch: a
 * change for a hosted session reads that session once, and one reconcile read
 * a minute covers anything the stream missed (a suspended laptop, a dropped
 * tunnel). A client without it is read every two seconds.
 *
 * A runner that keeps failing on one input is not retried forever: after
 * MAX_RUNNER_FAILURES attempts the input is reported failed with the reason,
 * so the row and the sender's surface say so instead of waiting in silence.
 */
import { logger, summarizeError } from '../../utils/index.js';
import type { SharedSessionInputRecord } from '../../control-plane/index.js';
import type { SharedSessionContinuationRunner } from '../../control-plane/session-intents.js';
import type { SessionContinuationDispatch } from '../client-services.js';
import { renderAgentCompletionAnswer, type AgentCompletionRecordView } from '../../agents/completion-answer.js';

/** What a surface's own agent register says about a dispatched run. */
export interface SurfaceAgentOutcome {
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** The finished output. Only read on a terminal status; empty is a real answer (silence). */
  readonly answer?: string | undefined;
}

/**
 * Map a surface's own agent record onto the outcome this dispatcher reports.
 *
 * A missing record is `null`, "this surface no longer knows about that run",
 * and is deliberately distinct from a run still in flight. The answer text is
 * the SHARED rule (agents/completion-answer.ts), the same one the daemon
 * renders for the runs it hosts itself, so an answer does not read differently
 * depending on which process happened to execute it.
 */
export function readSurfaceAgentOutcome(
  record: AgentCompletionRecordView | null | undefined,
): SurfaceAgentOutcome | null {
  if (!record) return null;
  if (record.status === 'pending' || record.status === 'running') return { status: record.status };
  return { status: record.status, answer: renderAgentCompletionAnswer(record) };
}

/**
 * The narrow inbound wire surface this dispatcher needs, `sessions.inputs.list`
 * and `sessions.inputs.deliver`. A product's own operator client satisfies it
 * structurally, so a test injects a stub instead of a port.
 */
export interface SessionInputsWireClient {
  listInputs(
    sessionId: string,
    options: { readonly state?: string; readonly since?: number; readonly limit?: number },
  ): Promise<{ readonly inputs: readonly SharedSessionInputRecord[] }>;
  /**
   * Take an input before starting work on it: the daemon grants it to one
   * caller and refuses the rest (`INPUT_NOT_CLAIMABLE`, see
   * {@link isInputClaimRefusal}), so two processes hosting one session do not
   * both start an agent for the same message. Optional: a client without it
   * dispatches as before.
   */
  claimInput?(sessionId: string, inputId: string): Promise<unknown>;
  /**
   * Be told when a session's inputs change (from the session-update stream).
   * Returns the unsubscribe. Optional: without it inputs are read on a short interval.
   */
  subscribeInputChanges?(onChange: (sessionId: string) => void): () => void;
  deliverInput(
    sessionId: string,
    inputId: string,
    options?: {
      readonly consumed?: boolean | undefined;
      readonly agentId?: string | undefined;
      readonly answer?: string | undefined;
      readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
    },
  ): Promise<unknown>;
}

/** Whether a failed `claimInput` was the daemon saying another surface holds the input, not a failure to reach it. */
export function isInputClaimRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown; transport?: { status?: unknown } };
  return candidate.code === 'INPUT_NOT_CLAIMABLE'
    || candidate.status === 409
    || candidate.transport?.status === 409
    || summarizeError(error).includes('INPUT_NOT_CLAIMABLE');
}

/** The setter's own "unbind" argument is part of the seam's signature. */
type ContinuationRunner = SharedSessionContinuationRunner | null;

const DEFAULT_INTERVAL_MS = 2_000;
/** With input changes pushed, the interval read is only a reconcile for what the stream missed. */
const RECONCILE_INTERVAL_MS = 60_000;
/** Runner attempts on one input before it is reported failed with the reason. */
const MAX_RUNNER_FAILURES = 3;

/**
 * How long a claimed input with no agent is left to its claimant. The daemon
 * enforces the same lease; reading it here only spares claims that cannot succeed yet.
 */
const CLAIM_LEASE_MS = 2 * 60_000;

/**
 * How many dispatched runs this dispatcher will wait on answers for at once,
 * and for how long. Both are bounds on an in-memory map that only ever shrinks
 * when an agent reaches a terminal state, a run that never does (a killed
 * process, a register that forgot it) would otherwise be tracked forever.
 * Dropping one is disclosed, never silent, and the input is still acknowledged
 * so the daemon does not keep it queued.
 */
const MAX_AWAITED_ANSWERS = 200;
const AWAITED_ANSWER_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

interface AwaitedAnswer {
  readonly sessionId: string;
  readonly inputId: string;
  readonly startedAt: number;
  /** Failed attempts to report this answer; bounded by MAX_ANSWER_DELIVERY_ATTEMPTS. */
  deliveryFailures: number;
}

/**
 * How many times a finished run's answer is offered to the daemon before it is
 * dropped from the watch list. A rejected report is retried on later ticks
 * instead of being lost on the first failure.
 */
const MAX_ANSWER_DELIVERY_ATTEMPTS = 10;

/**
 * The runner's result for an input whose acknowledgement has not reached the
 * daemon yet. While one exists, a still-queued input is only re-acknowledged,
 * never handed to the runner again: the runner already acted on it, and a
 * second call would start a second agent for the same message.
 */
type DispatchClaim =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'consumed' };

/** Bound on remembered claims; each is removed once its acknowledgement lands. */
const MAX_DISPATCH_CLAIMS = 500;

export interface WireSessionDispatchOptions {
  /** The sessions this surface is hosting right now. Re-read every tick. */
  readonly hostedSessionIds: () => readonly string[];
  /**
   * This surface's own read of a dispatched agent's state. Supplying it is what
   * lets the answer reach the conversation the message came from; omitting it
   * keeps the reply binding but leaves the answer un-reported.
   */
  readonly readAgentOutcome?: ((agentId: string) => SurfaceAgentOutcome | null) | undefined;
  /** Read interval without pushed input changes; defaults to two seconds (one minute with them). */
  readonly intervalMs?: number;
  readonly log?: Pick<typeof logger, 'debug' | 'info' | 'warn'>;
  readonly now?: (() => number) | undefined;
}

export interface WireSessionDispatch extends SessionContinuationDispatch {
  /** Attach the wire once a daemon has been adopted. Idempotent per base URL. */
  activate(client: SessionInputsWireClient): void;
  /** Detach; the bound runner is kept so a re-adopted daemon resumes dispatch. */
  deactivate(reason: string): void;
  /** Run one poll now instead of waiting for the interval. Never rejects. */
  pollNow(): Promise<void>;
  /**
   * Stop polling entirely. Idempotent. What was already dispatched stays
   * remembered, so a later `activate` does not start those inputs a second time.
   */
  stop(): void;
}

/**
 * A dispatch seam backed by the adopted daemon's session inputs.
 *
 * Inert until `activate`, a surface with no daemon adopted holds its runner and
 * dispatches nothing, which is the honest offline posture rather than a missing
 * dependency.
 */
export function createWireSessionDispatch(options: WireSessionDispatchOptions): WireSessionDispatch {
  const log = options.log ?? logger;
  const now = options.now ?? Date.now;
  let runner: ContinuationRunner = null;
  let client: SessionInputsWireClient | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let timerMs = 0;
  let unsubscribe: (() => void) | null = null;
  /** A change arrived while a read was running: read again when it ends. */
  let rerun = false;
  let inFlight = false;
  /** `sessionId\0inputId` -> runner failures so far on that input. */
  const runnerFailures = new Map<string, number>();
  let generation = 0;
  /** agentId -> the input it is answering. Insertion-ordered, so the oldest is first. */
  const awaitingAnswers = new Map<string, AwaitedAnswer>();
  /** `sessionId\0inputId` -> what the runner did with it, until the daemon has the acknowledgement. */
  const claims = new Map<string, DispatchClaim>();
  const claimKey = (sessionId: string, inputId: string): string => `${sessionId}\0${inputId}`;
  /** Inputs this process claimed whose runner has not started them yet (held, or it threw); retried without claiming again. */
  const claimedUnstarted = new Set<string>();
  const rememberUnstarted = (key: string): void => {
    claimedUnstarted.add(key);
    while (claimedUnstarted.size > MAX_DISPATCH_CLAIMS) {
      const oldest = claimedUnstarted.values().next();
      if (oldest.done) break;
      claimedUnstarted.delete(oldest.value);
    }
  };

  const recordClaim = (key: string, claim: DispatchClaim): void => {
    claims.set(key, claim);
    while (claims.size > MAX_DISPATCH_CLAIMS) {
      const oldest = claims.keys().next();
      if (oldest.done) break;
      claims.delete(oldest.value);
      log.warn('[session dispatch] forgot an unacknowledged dispatch: too many are outstanding; that input may be dispatched again', {
        limit: MAX_DISPATCH_CLAIMS,
      });
    }
  };

  /** Acknowledges what the runner did. Throws when the daemon rejects it; the claim then stays for the next tick. */
  const acknowledge = async (
    active: SessionInputsWireClient,
    sessionId: string,
    inputId: string,
    claim: DispatchClaim,
  ): Promise<void> => {
    const key = claimKey(sessionId, inputId);
    if (claim.kind === 'consumed') {
      await active.deliverInput(sessionId, inputId, { consumed: true });
      claims.delete(key);
      return;
    }
    const { agentId } = claim;
    // No way to read this surface's outcomes: bind the reply, acknowledge in
    // one step, and do not pretend an answer is coming.
    if (!options.readAgentOutcome) {
      await active.deliverInput(sessionId, inputId, { consumed: true, agentId });
      claims.delete(key);
      return;
    }
    await active.deliverInput(sessionId, inputId, { agentId });
    claims.delete(key);
  };

  const trackAnswer = (agentId: string, entry: AwaitedAnswer): void => {
    awaitingAnswers.set(agentId, entry);
    while (awaitingAnswers.size > MAX_AWAITED_ANSWERS) {
      const oldest = awaitingAnswers.keys().next();
      if (oldest.done) break;
      awaitingAnswers.delete(oldest.value);
      log.warn('[session dispatch] dropped a run from the answer watch list: too many are outstanding', {
        agentId: oldest.value,
        limit: MAX_AWAITED_ANSWERS,
      });
    }
  };

  const drainSession = async (active: SessionInputsWireClient, sessionId: string): Promise<void> => {
    const bound = runner; const selectedGeneration = generation;
    const current = () => client === active && runner === bound && generation === selectedGeneration;
    if (!bound) return;
    const { inputs: queued } = await active.listInputs(sessionId, { state: 'queued', limit: 500 });
    let inputs = queued;
    // Claims are pruned only against a complete view: when the delivered list
    // failed, a claimed input missing from `inputs` is not evidence it was acknowledged.
    let sawDelivered = !active.claimInput;
    if (active.claimInput) {
      // A claimed input waits for its agent as `delivered`. Ours are retried;
      // another process's are taken over only once its lease has run out.
      try {
        const { inputs: delivered } = await active.listInputs(sessionId, { state: 'delivered', limit: 500 });
        inputs = [...queued, ...delivered.filter((input) => {
          if (input.activeAgentId) return false;
          const key = claimKey(sessionId, input.id);
          return claims.has(key) || claimedUnstarted.has(key) || now() - input.updatedAt >= CLAIM_LEASE_MS;
        })];
        sawDelivered = true;
      } catch (error) {
        log.debug('[session dispatch] listing claimed inputs failed; only queued inputs this tick', { sessionId, error: summarizeError(error) });
      }
    }
    // An acknowledgement whose reply was lost still reached the daemon: the
    // input is no longer waiting for an agent, so its claim has nothing left to protect.
    const stillWaiting = new Set(inputs.map((input) => claimKey(sessionId, input.id)));
    if (sawDelivered) {
      for (const key of [...claims.keys()]) {
        if (key.startsWith(`${sessionId}\0`) && !stillWaiting.has(key)) claims.delete(key);
      }
      for (const key of [...claimedUnstarted]) {
        if (key.startsWith(`${sessionId}\0`) && !stillWaiting.has(key)) claimedUnstarted.delete(key);
      }
    }
    // The broker retains at most 500 inputs. Read the whole bounded queue so
    // a held tail never starves older eligible inputs.
    for (const input of inputs) {
      if (!current()) return;
      // A `submit` is the continuation case: a message posted into a session
      // THIS surface hosts, which the surface's loop must answer. `steer` and
      // `follow-up` are the live-turn path and belong to the inbound steer
      // poller, which injects them into the turn already in flight rather than
      // starting a new run.
      if (input.intent !== 'submit') continue;
      const key = claimKey(sessionId, input.id);
      const earlier = claims.get(key);
      if (earlier) {
        // One input the daemon keeps rejecting must not hold up the ones behind it.
        try {
          await acknowledge(active, sessionId, input.id, earlier);
        } catch (error) {
          log.debug('[session dispatch] re-acknowledging an input failed; retrying next tick', { sessionId, inputId: input.id, error: summarizeError(error) });
        }
        continue;
      }
      // The daemon grants a claim to one caller. Refused: another surface holds
      // this input and will answer it. Failed to reach the daemon: it stays
      // queued and the next tick tries again, so nothing is lost either way.
      if (active.claimInput && !claimedUnstarted.has(key)) {
        try {
          await active.claimInput(sessionId, input.id);
        } catch (error) {
          if (isInputClaimRefusal(error)) log.debug('[session dispatch] another surface holds this input', { sessionId, inputId: input.id });
          else log.debug('[session dispatch] claiming an input failed; retrying next tick', { sessionId, inputId: input.id, error: summarizeError(error) });
          continue;
        }
        rememberUnstarted(key);
      }
      if (!current()) return;
      let claim: DispatchClaim;
      try {
        const spawned = await bound({ sessionId, task: input.body, input });
        // Explicit native outcomes never use null as an ambiguous acknowledgment.
        // A full fleet keeps the input queued for the next tick, like a held reading.
        if (spawned?.disposition === 'held' || spawned?.disposition === 'unknown' || spawned?.disposition === 'capacity') continue;
        if (spawned?.disposition === 'transferred') {
          if (!spawned.requestId.trim()) continue;
          claim = { kind: 'consumed' };
        } else {
          const agentId = spawned?.agentId?.trim();
          if (spawned?.disposition === 'started' && !agentId) continue;
          // No agent id means nothing ran HERE, the runner declined, or the work
          // moved elsewhere (a conversation handed to daemon hosting). The input
          // is still consumed, because leaving it queued would have it
          // dispatched again; there is nothing to bind a reply to, and claiming
          // otherwise would bind one to an agent that does not exist.
          claim = agentId ? { kind: 'agent', agentId } : { kind: 'consumed' };
        }
      } catch (error) {
        const failures = (runnerFailures.get(key) ?? 0) + 1;
        runnerFailures.set(key, failures);
        log.warn('[session dispatch] the bound runner rejected a continuation', {
          sessionId,
          inputId: input.id,
          attempt: failures,
          error: summarizeError(error),
        });
        // A transient failure is retried; one that repeats is reported, so the
        // input ends failed with the reason instead of being retried forever in silence.
        if (failures >= MAX_RUNNER_FAILURES) {
          try {
            await active.deliverInput(sessionId, input.id, {
              consumed: true,
              status: 'failed',
              answer: `This surface could not start the message after ${failures} attempts: ${summarizeError(error)}. Send it again to retry.`,
            });
            runnerFailures.delete(key);
            claimedUnstarted.delete(key);
          } catch (reportError) {
            log.debug('[session dispatch] reporting a failed input did not reach the daemon; retrying next read', { sessionId, inputId: input.id, error: summarizeError(reportError) });
          }
        }
        continue;
      }
      runnerFailures.delete(key);
      // Recorded before anything else can fail or detach, so a later tick only
      // re-acknowledges this input instead of starting it a second time.
      recordClaim(key, claim);
      claimedUnstarted.delete(key);
      // The answer is watched from the moment the agent exists, not from the
      // moment the daemon acknowledges it: an acknowledgement whose reply was
      // lost must not leave the sender without an answer.
      if (claim.kind === 'agent' && options.readAgentOutcome && !awaitingAnswers.has(claim.agentId)) {
        trackAnswer(claim.agentId, { sessionId, inputId: input.id, startedAt: now(), deliveryFailures: 0 });
      }
      if (!current()) return;
      try {
        await acknowledge(active, sessionId, input.id, claim);
      } catch (error) {
        log.debug('[session dispatch] acknowledging a dispatched input failed; retrying next tick', { sessionId, inputId: input.id, error: summarizeError(error) });
      }
    }
  };

  const reportAnswers = async (active: SessionInputsWireClient): Promise<void> => {
    const readOutcome = options.readAgentOutcome;
    if (!readOutcome || awaitingAnswers.size === 0) return;
    for (const [agentId, awaited] of [...awaitingAnswers]) {
      const outcome = readOutcome(agentId);
      let report: Parameters<SessionInputsWireClient['deliverInput']>[2];
      if (outcome && (outcome.status === 'pending' || outcome.status === 'running')) {
        if (now() - awaited.startedAt < AWAITED_ANSWER_MAX_AGE_MS) continue;
        log.warn('[session dispatch] a dispatched run has not finished within the answer watch window; acknowledging without an answer', {
          sessionId: awaited.sessionId,
          agentId,
          ageMs: now() - awaited.startedAt,
        });
        report = { consumed: true, agentId };
      } else if (!outcome) {
        // A run this surface no longer knows about. It cannot be waited on, and
        // the daemon must not keep the input open on its account.
        log.warn('[session dispatch] a dispatched run left this surface\'s register before it reported an answer', {
          sessionId: awaited.sessionId,
          agentId,
        });
        report = { consumed: true, agentId };
      } else {
        report = {
          consumed: true,
          agentId,
          answer: outcome.answer ?? '',
          // Narrowed above: only a terminal status reaches here.
          status: outcome.status as 'completed' | 'failed' | 'cancelled',
        };
      }
      try {
        await active.deliverInput(awaited.sessionId, awaited.inputId, report);
        awaitingAnswers.delete(agentId);
        claims.delete(claimKey(awaited.sessionId, awaited.inputId));
      } catch (error) {
        // Kept on the watch list so a later tick offers the answer again; only
        // a run that keeps failing is given up on, and that is said.
        awaited.deliveryFailures += 1;
        if (awaited.deliveryFailures >= MAX_ANSWER_DELIVERY_ATTEMPTS) {
          awaitingAnswers.delete(agentId);
          log.warn('[session dispatch] gave up reporting a dispatched run\'s answer after repeated failures; the sender will not receive it', {
            sessionId: awaited.sessionId,
            inputId: awaited.inputId,
            agentId,
            attempts: awaited.deliveryFailures,
            error: summarizeError(error),
          });
        } else {
          log.debug('[session dispatch] reporting an answer failed; retrying next tick', {
            sessionId: awaited.sessionId,
            agentId,
            error: summarizeError(error),
          });
        }
      }
    }
  };

  const tick = async (): Promise<void> => {
    const active = client;
    if (!active || runner === null) return;
    if (inFlight) { rerun = true; return; }
    inFlight = true;
    rerun = false;
    try {
      // One session's failure (an unknown or unreadable session on the daemon)
      // must not starve the others, nor the answers already waiting.
      for (const sessionId of options.hostedSessionIds()) {
        try {
          await drainSession(active, sessionId);
        } catch (error) {
          log.debug('[session dispatch] poll failed for one session; retrying next tick', { sessionId, error: summarizeError(error) });
        }
      }
      await reportAnswers(active);
    } catch (error) {
      log.debug('[session dispatch] poll failed; retrying next tick', { error: summarizeError(error) });
    } finally {
      inFlight = false;
    }
    if (rerun && client === active) void tick();
  };

  const ensureTimer = (): void => {
    const wanted = options.intervalMs ?? (unsubscribe !== null ? RECONCILE_INTERVAL_MS : DEFAULT_INTERVAL_MS);
    if (timer !== null && timerMs === wanted) return;
    if (timer !== null) clearInterval(timer);
    timerMs = wanted;
    timer = setInterval(() => { void tick(); }, wanted);
    timer.unref?.();
  };

  const listen = (next: SessionInputsWireClient): void => {
    unsubscribe?.();
    unsubscribe = null;
    if (!next.subscribeInputChanges) return;
    unsubscribe = next.subscribeInputChanges((sessionId) => {
      if (client !== next || !options.hostedSessionIds().includes(sessionId)) return;
      void tick();
    });
  };

  return {
    setContinuationRunner(next) {
      ++generation; runner = next;
      if (next !== null && client !== null) ensureTimer();
    },
    activate(next) {
      ++generation; client = next;
      listen(next);
      // With changes pushed, read once now: what queued before the stream opened is not announced again.
      if (runner !== null) { ensureTimer(); if (unsubscribe !== null) void tick(); }
      log.info('[session dispatch] adopted the daemon\'s session inputs for continuation dispatch');
    },
    deactivate(reason) {
      ++generation; client = null;
      unsubscribe?.(); unsubscribe = null;
      log.info(`[session dispatch] detached: ${reason}`);
    },
    pollNow: tick,
    stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
      unsubscribe?.(); unsubscribe = null;
      ++generation; client = null;
    },
  };
}
