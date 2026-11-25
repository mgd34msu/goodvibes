/**
 * The single turn loop: ask the model, show its text as it arrives, run the
 * tool calls it asked for through the one tool-batch executor, and repeat until
 * it answers, the turn's budget is spent, a stop rule ends it or the turn is
 * cancelled. The main session, every worker agent and contract unit, and the
 * companion chat all run their turns here, so the rules below hold for each of
 * them alike:
 *
 * - a failed request is retried when its failure is retryable by its own
 *   facts (status, code, Retry-After), with the same waits for every caller;
 * - a request that failed for good is offered to the caller's failover
 *   (providers/failover.ts: the person's fallback order), which moves the
 *   rest of the turn to another model and sends the request again, or stops
 *   with the error;
 * - the completion check, for a caller that has one, runs after a draft was
 *   shown and ends when the decision model answers or fails (it has no clock
 *   of its own); it sends back at most `maxRejectedDrafts` drafts, then the
 *   draft stands with a "not verified" note;
 * - interim text is read beside its tools, never ahead of them;
 * - consecutive rounds in which every call failed warn the model, then end the
 *   turn after one closing reply without tools;
 * - the same call returning the same result again and again ends the turn the
 *   same way;
 * - a call identical to one a tool refused earlier in the turn is not sent
 *   again: the model gets the refusal once more, the person one line;
 * - a turn budget ends the turn after one closing reply without tools.
 *
 * What differs between callers (who is speaking, where text goes, the budget,
 * whether the answer is checked, whether delegated work is awaited) is a
 * `TurnPolicy`; how a caller reaches its provider, conversation and tools is a
 * `TurnContext`. The loop itself never branches on which product runs it.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { classifyFailure, type FailureClassification } from '@goodvibes/engine/errors';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { isBillingOrCreditError } from '../types/errors.js';
import { ConsecutiveErrorBreaker, CONSECUTIVE_ERROR_BREAK } from './circuit-breaker.js';
import type { HostInstructions } from './host-instructions.js';
import { TOOL_CALL_CANCELLED_MESSAGE } from './orchestrator-tool-runtime.js';

/** Who the turn answers: the owner at a surface, or the agent that delegated the work. */
export type TurnSpeaker = 'owner' | 'parent-agent';

/** Waits before each retry of a request whose failure is retryable; one list for every caller. */
export const TURN_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 10_000, 20_000, 40_000, 60_000]);
/**
 * The waits when the turn has a fallback model to move to: one short retry
 * (a passing blip), then the move. A server asking to wait longer than this is
 * not waited for; the turn moves at once. The full ladder above is for a model
 * with nowhere to go.
 */
export const TURN_RETRY_DELAYS_WITH_FAILOVER_MS: readonly number[] = Object.freeze([2_000]);
/** A server asking to come back later than this is not waited for: the failure is reported instead. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
/** Drafts the completion check may send back in one turn; the next one is shown with what was not verified. */
export const MAX_REJECTED_DRAFTS = 2;
/** The same call with the same arguments and the same result this many times ends the turn. */
export const REPEAT_STOP_THRESHOLD = 8;
/** Identical calls the model is told to review its history for, when a reading says they are stuck. */
const REPEAT_REVIEW_THRESHOLD = 3;
/** Identical calls the model is told to stop making, when a reading says they are stuck. */
const REPEAT_REFUSE_THRESHOLD = 5;
/** Calls kept for the repeat rules. */
const REPEAT_HISTORY_WINDOW = 20;
/** The same call failing the tool's schema this many times in a row ends the turn. */
const MALFORMED_REPEAT_STOP = 3;

/** Where the turn's visible output goes, as it happens. */
export interface TurnSink {
  /** Model text, streamed as the provider sends it, in every mode. */
  delta(text: string): void;
  /** The results of one batch, in the model's call order. */
  toolResults?(calls: readonly ToolCall[], results: readonly ToolResult[]): void;
  /** Calls the model asked for that will not run, and why. */
  unrunCalls?(calls: readonly ToolCall[], reason: string): void;
  /** A draft already shown was rejected by the completion check and is replaced by the next one. */
  draftWithdrawn?(draft: string, reason: string): void;
  /** The answer stands without a passed completion check; the note says why. */
  notVerified?(note: string): void;
  /** A line for the person about how the turn is going (a stop rule warned the model, a retry wait). */
  notice?(text: string, level: 'info' | 'warning' | 'error'): void;
}

export interface TurnPolicy {
  readonly speaker: TurnSpeaker;
  readonly sink: TurnSink;
  /** `turns`: most model rounds that may ask for tools. `tokens`: most input plus output tokens over the turn. Absent: unbounded. */
  readonly budget: { readonly turns?: number | undefined; readonly tokens?: number | undefined };
  /** At most `maxRejectedDrafts` drafts are withdrawn. Used only when the context can check a draft. */
  readonly completion: { readonly maxRejectedDrafts: number };
  /** `await-events`: delegated work is awaited after the round that started it, and before an answer ends the turn. `return`: the turn never waits for it. */
  readonly delegates: 'await-events' | 'return';
}

export interface TurnModelResponse {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
}

export interface TurnRequest {
  /** 1 for the first request of the turn. */
  readonly round: number;
  /**
   * 0 for the first attempt of this round, then the retry number. The loop is
   * the one owner of retrying a failed request, so a caller passes
   * `maxRetries: 0` to its provider and reads its retry count here.
   */
  readonly attempt: number;
  /** False for the closing request after a limit or stop rule: the model is asked to answer, and any call it makes is not run. */
  readonly tools: boolean;
  readonly signal: AbortSignal;
  /** Called with each piece of text as the provider streams it. */
  onDelta(text: string): void;
}

export type DraftVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string; readonly correction: string };

/** One settled tool round, as the stop rules and the delegate wait read it. */
export interface TurnToolRound {
  readonly round: number;
  readonly calls: readonly ToolCall[];
  readonly results: readonly ToolResult[];
}

/** One call and what it returned, kept for the repeat rules. */
export interface TurnCallObservation {
  readonly signature: string;
  readonly requested: ToolCall;
  readonly executed: { readonly name: string; readonly arguments: string };
  /** What the call returned, without its per-call ids: two runs that returned the same thing compare equal. */
  readonly result: TurnCallOutcome | null;
}

/** The part of a tool result the repeat rules compare and read. */
export interface TurnCallOutcome {
  readonly success: boolean;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
}

/** How one caller reaches its model, conversation and tools. */
export interface TurnContext {
  /** Aborted when the turn is cancelled; reaches every request and every tool call. */
  readonly signal: AbortSignal;
  /**
   * One model request. Everything the caller does around it (context checks,
   * knowledge, hooks, events, usage) happens inside. Throw `TurnEnded` when the
   * caller has already reported why the turn ends.
   */
  request(request: TurnRequest): Promise<TurnModelResponse>;
  readonly conversation: {
    addAssistantMessage(content: string, options?: { toolCalls?: ToolCall[] }): void;
    addToolResults(results: ToolResult[]): void;
  };
  /** What the model is told on its next request only (the host-instruction channel). Absent: the stop rules warn nobody. */
  readonly hostInstructions?: Pick<HostInstructions, 'set'> | undefined;
  /**
   * The one tool-batch executor (`executeToolCalls`) bound to this caller.
   * `onSettled` receives each real receipt as it lands, so a cancelled batch
   * keeps them. Absent (and no `runTools`): tools cannot run here and calls are
   * answered as not run.
   */
  executeTools?(calls: ToolCall[], options: { signal: AbortSignal; onSettled(result: ToolResult): void }): Promise<ToolResult[]>;
  /**
   * A whole tool round for a caller whose round does more than run the calls
   * (input projection, the assistant message with its metadata, plan and
   * contract reports): it publishes the assistant message, runs the calls
   * through the executor and records their results, closing a cancelled batch
   * itself. Takes precedence over `executeTools`.
   */
  runTools?(response: TurnModelResponse, options: { readonly round: number; readonly signal: AbortSignal }): Promise<ToolResult[]>;
  /** Reads interim text beside its tools; resolves with a correction for the next request, or null. */
  checkProgress?(text: string, signal: AbortSignal): Promise<string | null>;
  /**
   * Whether repeated calls look stuck; undefined when no reading settled.
   * Asked only when every run of the repeated call returned the same thing,
   * with only that call's runs, beside the next request (never ahead of it);
   * it ends when the decision model answers or fails, or the turn ends.
   * Absent: only the exact-repeat stop applies.
   */
  judgeRepeat?(history: readonly TurnCallObservation[], signature: string, signal: AbortSignal): Promise<{ readonly stuck: boolean } | undefined>;
  /** A held draft (a contract unit's answer the contract keeps open) takes another round instead of a check; true when held. */
  holdDraft?(draft: string, signal: AbortSignal): Promise<boolean>;
  /** The completion check of a final draft, run after the draft was shown. */
  checkDraft?(draft: string, options: { speaker: TurnSpeaker; signal: AbortSignal }): Promise<DraftVerdict>;
  /** Tells the model, on the next request, what the rejected draft missed (the host-instruction channel). */
  correct?(text: string): void;
  /**
   * The answer stands: record it. `verified` is true when a check accepted it,
   * false when it stands unchecked (`note` says why), undefined when nothing
   * checks. Resolves 'continue' when the caller needs another round (an empty
   * reply asked again, an owner's answer that arrived meanwhile).
   * Absent: the answer is appended to the conversation.
   */
  commit?(draft: string, outcome: { readonly verified?: boolean | undefined; readonly note?: string | undefined }): Promise<'end' | 'continue'>;
  /**
   * Waits for delegated work to report; true when its results were added and
   * the model should read them. Called with the round after a tool round, and
   * without one before an answer ends the turn.
   */
  awaitDelegates?(signal: AbortSignal, round?: TurnToolRound): Promise<boolean>;
  /** Waits before each retry of a request whose failure is retryable; absent: no retry. */
  readonly retryDelaysMs?: readonly number[] | undefined;
  /** Told before each retry wait (an event, a progress line); `plan` is the waits in force and whether a move follows them. */
  onRetry?(attempt: number, delayMs: number, error: unknown, failure: FailureClassification, plan: RetryPlan): void;
  /** Whether a provider failure now would move the turn to another model (TurnFailover.available). */
  failoverAvailable?(): boolean;
  /** The retry wait itself; absent: a timer bound to the turn's signal. */
  waitBeforeRetry?(delayMs: number, signal: AbortSignal): Promise<void>;
  /**
   * Asked when a request failed for good (not retryable, or its retries
   * spent): true when the turn moved to another model (createTurnFailover in
   * providers/failover.ts), and the request is sent again to it with fresh
   * retries. `shown`: text of the failed attempt already reached the sink.
   */
  failOver?(error: unknown, attempt: { readonly shown: boolean }): boolean | Promise<boolean>;
}

export interface TurnOutcome {
  /**
   * `answered`: an answer stands. `budget`: the budget ended the turn after a
   * closing reply. `stopped`: a stop rule ended it after a closing reply.
   * `ended`: the caller ended it and already said why. `cancelled`.
   */
  readonly status: 'answered' | 'budget' | 'stopped' | 'ended' | 'cancelled';
  /** The answer that stands (the closing reply after a limit), or '' when there is none. */
  readonly text: string;
  /** Model requests made, the closing one included. */
  readonly rounds: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly rejectedDrafts: number;
  /** True when a completion check accepted the answer, false when it stands unverified, undefined when nothing checks. */
  readonly verified?: boolean | undefined;
  /** Why the answer stands unverified, or which limit or rule ended the turn. */
  readonly note?: string | undefined;
  /** Which stop rule ended a `stopped` turn. */
  readonly stop?: { readonly rule: 'all-calls-failed' | 'repeated-call'; readonly toolName?: string | undefined; readonly count: number } | undefined;
}

class TurnCancelled extends Error {}

/** Thrown by a caller's `request` when it ended the turn itself and already reported why (a refused hook, a failed context check). */
export class TurnEnded extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'TurnEnded';
  }
}

/** The retry waits a failed request gets, and whether the turn moves to another model once they are spent. */
export interface RetryPlan {
  readonly delaysMs: readonly number[];
  readonly thenFailover: boolean;
}

async function requestWithRetry(ctx: TurnContext, request: Omit<TurnRequest, 'attempt'>): Promise<TurnModelResponse> {
  for (let attempt = 0; ; attempt++) {
    // With a fallback model to go to, a failing model gets one short retry,
    // not minutes of waiting: the person's order says where to go instead.
    const thenFailover = ctx.failoverAvailable?.() === true;
    const delays = thenFailover ? TURN_RETRY_DELAYS_WITH_FAILOVER_MS : ctx.retryDelaysMs ?? [];
    let shown = false;
    try {
      return await ctx.request({ ...request, attempt, onDelta: (text) => { shown = true; request.onDelta(text); } });
    } catch (error) {
      if (ctx.signal.aborted) throw new TurnCancelled();
      if (error instanceof TurnEnded) throw error;
      const failure = classifyFailure(error);
      const wait = delays[attempt];
      const retryable = failure?.retryable === true && wait !== undefined
        // Text already shown cannot be taken back; a second attempt would show the answer again after it.
        && !shown
        && (failure.retryAfterMs ?? 0) <= (thenFailover ? wait : MAX_RETRY_AFTER_MS)
        // A spent account is reported under a rate limit by some providers; waiting never clears it.
        && !(failure.category === 'rate_limit' && await isBillingOrCreditError(error, 'core.turn-loop.rate-limit-retry'));
      if (!retryable || failure === undefined || wait === undefined) {
        if (ctx.signal.aborted) throw new TurnCancelled();
        // The failure is final for this model: the caller's failover moves the turn on, or the error stands.
        if (ctx.failOver && await ctx.failOver(error, { shown })) {
          if (ctx.signal.aborted) throw new TurnCancelled();
          attempt = -1;
          continue;
        }
        throw error;
      }
      const delayMs = Math.max(wait, failure.retryAfterMs ?? 0);
      ctx.onRetry?.(attempt + 1, delayMs, error, failure, { delaysMs: delays, thenFailover });
      try {
        if (ctx.waitBeforeRetry) await ctx.waitBeforeRetry(delayMs, ctx.signal);
        else await delay(delayMs, undefined, { signal: ctx.signal });
      } catch {
        if (ctx.signal.aborted) throw new TurnCancelled();
        throw error;
      }
      if (ctx.signal.aborted) throw new TurnCancelled();
    }
  }
}

/** A result for each call that has none: the receipt that landed, else a cancelled result. */
function closeCancelledBatch(calls: readonly ToolCall[], settled: ReadonlyMap<string, ToolResult>): ToolResult[] {
  return calls.map((call) => settled.get(call.id) ?? { callId: call.id, success: false, error: TOOL_CALL_CANCELLED_MESSAGE, cancelled: true });
}

function callSignature(call: ToolCall): string {
  return `${call.name}::${JSON.stringify(call.arguments)}`;
}

/** What a call returned, without the ids every call gets afresh (call id, decision id, host evidence). */
function callOutcome(result: ToolResult | undefined): TurnCallOutcome | null {
  if (!result) return null;
  return { success: result.success, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error !== undefined ? { error: result.error } : {}) };
}

function outcomeKey(entry: TurnCallObservation): string {
  return JSON.stringify(entry.result);
}

/** The same call with the same result `threshold` times in the kept history. */
function identicalRepeat(history: readonly TurnCallObservation[], threshold: number): { readonly toolName: string; readonly count: number } | undefined {
  const counts = new Map<string, number>();
  for (const entry of history) {
    const key = entry.signature + '\u0000' + outcomeKey(entry);
    const count = (counts.get(key) ?? 0) + 1;
    if (count >= threshold) return { toolName: entry.signature.slice(0, entry.signature.indexOf('::')), count };
    counts.set(key, count);
  }
  return undefined;
}

/** Run one turn to its end under `policy`. Throws only a failure that is not a cancellation and cannot be retried. */
export async function runTurn(ctx: TurnContext, policy: TurnPolicy): Promise<TurnOutcome> {
  const sink = policy.sink;
  let rounds = 0;
  let rejectedDrafts = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const breaker = new ConsecutiveErrorBreaker();
  const history: TurnCallObservation[] = [];
  const repeatReading = { pending: false };
  const malformedStreak = { signature: '', count: 0 };
  // Calls refused this turn, by signature: an identical call is not sent again (see blockRefusedRepeats).
  const refusedCalls = new Map<string, RefusedCall>();
  const toldBlocked = new Set<string>();
  // The readings that run beside the next request write to the conversation's
  // host channel; they end with this turn, so a late one cannot reach the next turn.
  const turnLifetime = new AbortController();
  const turnSignal = AbortSignal.any([ctx.signal, turnLifetime.signal]);
  const outcome = (status: TurnOutcome['status'], text: string, extra: Partial<Pick<TurnOutcome, 'verified' | 'note' | 'stop'>> = {}): TurnOutcome =>
    ({ status, text, rounds, usage: { ...usage }, rejectedDrafts, ...extra });
  const ask = async (tools: boolean): Promise<TurnModelResponse> => {
    rounds++;
    const response = await requestWithRetry(ctx, { round: rounds, tools, signal: ctx.signal, onDelta: (text) => sink.delta(text) });
    usage.inputTokens += response.usage?.inputTokens ?? 0;
    usage.outputTokens += response.usage?.outputTokens ?? 0;
    return response;
  };
  const spent = (): string | undefined => {
    const { turns, tokens } = policy.budget;
    if (turns !== undefined && rounds >= turns) return `this turn reached its limit of ${turns} tool rounds`;
    if (tokens !== undefined && usage.inputTokens + usage.outputTokens >= tokens) return `this turn reached its limit of ${tokens} tokens`;
    return undefined;
  };
  /**
   * One closing reply with no tools after a limit or a stop rule. It is best
   * effort: a failed request leaves the limit as the reason, with no reply.
   */
  const closingReply = async (): Promise<string | undefined> => {
    let closing: TurnModelResponse;
    try { closing = await ask(false); }
    catch (error) {
      if (error instanceof TurnCancelled || ctx.signal.aborted) return undefined;
      if (error instanceof TurnEnded) throw error;
      return '';
    }
    if (ctx.signal.aborted) return undefined;
    if (closing.content) ctx.conversation.addAssistantMessage(closing.content);
    return closing.content;
  };
  /** The answer stands: the caller records it, or it is appended. */
  const commit = async (draft: string, result: { verified?: boolean | undefined; note?: string | undefined }): Promise<'end' | 'continue'> => {
    if (ctx.commit) {
      const next = await ctx.commit(draft, result);
      // The owner may have spoken meanwhile: what was refused before is decided afresh.
      if (next === 'continue') refusedCalls.clear();
      return next;
    }
    ctx.conversation.addAssistantMessage(draft);
    return 'end';
  };

  try {
    while (true) {
      if (ctx.signal.aborted) return outcome('cancelled', '');
      let response = await ask(true);
      if (ctx.signal.aborted) return outcome('cancelled', '');
      let calls = [...response.toolCalls];

      if (calls.length === 0) {
        const draft = response.content;
        if (policy.delegates === 'await-events' && ctx.awaitDelegates) {
          if (await ctx.awaitDelegates(ctx.signal)) {
            ctx.conversation.addAssistantMessage(draft);
            continue;
          }
          if (ctx.signal.aborted) return outcome('cancelled', '');
        }
        if (ctx.holdDraft && await ctx.holdDraft(draft, ctx.signal)) continue;
        if (ctx.signal.aborted) return outcome('cancelled', '');
        if (!ctx.checkDraft) {
          if (await commit(draft, {}) === 'continue') continue;
          return outcome('answered', draft);
        }
        const verdict = await checkOnce(ctx, draft, policy);
        if (ctx.signal.aborted) return outcome('cancelled', '');
        if (verdict.kind === 'accepted') {
          if (await commit(draft, { verified: true }) === 'continue') continue;
          return outcome('answered', draft, { verified: true });
        }
        if (verdict.kind === 'rejected' && rejectedDrafts < policy.completion.maxRejectedDrafts) {
          rejectedDrafts++;
          sink.draftWithdrawn?.(draft, verdict.reason);
          ctx.correct?.(verdict.correction);
          continue;
        }
        const note = verdict.kind === 'rejected'
          ? `the completion check sent back ${rejectedDrafts} draft${rejectedDrafts === 1 ? '' : 's'} of this answer and did not accept this one`
          : verdict.why;
        const next = await commit(draft, { verified: false, note });
        sink.notVerified?.(note);
        if (next === 'continue') continue;
        return outcome('answered', draft, { verified: false, note });
      }

      const limit = spent();
      if (limit !== undefined || (!ctx.executeTools && !ctx.runTools)) {
        const reason = limit !== undefined ? `Not run: ${limit}.` : 'Not run: no tools can run here.';
        if (response.content) ctx.conversation.addAssistantMessage(response.content);
        sink.unrunCalls?.(calls, reason);
        if (limit === undefined) return outcome('answered', response.content);
        const closing = await closingReply();
        if (closing === undefined) return outcome('cancelled', '');
        return outcome('budget', closing, { note: limit });
      }

      // A call identical to one refused earlier in this turn is not sent again: the model is
      // given the refusal once more, whole, and the owner one line; the other calls run.
      const remaining = blockRefusedRepeats(ctx, sink, refusedCalls, toldBlocked, calls);
      if (remaining.length < calls.length) {
        if (remaining.length === 0) {
          if (response.content) ctx.conversation.addAssistantMessage(response.content);
          // A round of nothing but refused repeats counts as a failed round, so the stop rule still ends a turn that only repeats them.
          if (breaker.recordAllFailed() === 'break') {
            const stop = failedRoundsStop(ctx, sink, breaker);
            const closing = await closingReply();
            if (closing === undefined) return outcome('cancelled', '');
            return outcome('stopped', closing, stop);
          }
          continue;
        }
        calls = remaining;
        response = { ...response, toolCalls: remaining };
      }

      // Interim text never holds its tools: it is read beside them, and a finding corrects the next request.
      if (response.content.trim() && ctx.checkProgress) {
        void ctx.checkProgress(response.content, turnSignal)
          .then((correction) => { if (correction !== null && !turnSignal.aborted) ctx.hostInstructions?.set('correction', correction, { once: true, append: true }); })
          .catch(() => { /* An unsure or failed reading finds nothing. */ });
      }

      let results: ToolResult[];
      if (ctx.runTools) {
        try { results = await ctx.runTools(response, { round: rounds, signal: ctx.signal }); }
        catch (error) {
          // The caller's round closes its own cancelled batch.
          if (ctx.signal.aborted) return outcome('cancelled', '');
          throw error;
        }
      } else {
        ctx.conversation.addAssistantMessage(response.content, { toolCalls: calls });
        const settled = new Map<string, ToolResult>();
        try {
          results = await ctx.executeTools!(calls, { signal: ctx.signal, onSettled: (result) => { settled.set(result.callId, result); } });
        } catch (error) {
          if (!ctx.signal.aborted) throw error;
          // Every call the model issued gets a result, so the history stays valid for the next turn.
          const closed = closeCancelledBatch(calls, settled);
          ctx.conversation.addToolResults(closed);
          sink.toolResults?.(calls, closed);
          return outcome('cancelled', '');
        }
        ctx.conversation.addToolResults(results);
      }
      sink.toolResults?.(calls, results);
      if (ctx.signal.aborted) return outcome('cancelled', '');
      recordRefusals(refusedCalls, calls, results);

      const stop = applyStopRules(ctx, turnSignal, sink, breaker, history, repeatReading, malformedStreak, calls, results);
      if (stop) {
        const closing = await closingReply();
        if (closing === undefined) return outcome('cancelled', '');
        return outcome('stopped', closing, { note: stop.note, stop: stop.stop });
      }

      if (policy.delegates === 'await-events' && ctx.awaitDelegates) {
        await ctx.awaitDelegates(ctx.signal, { round: rounds, calls, results });
        if (ctx.signal.aborted) return outcome('cancelled', '');
      }
    }
  } catch (error) {
    if (error instanceof TurnCancelled) return outcome('cancelled', '');
    if (error instanceof TurnEnded) return outcome('ended', '', { note: error.reason });
    throw error;
  } finally {
    turnLifetime.abort();
  }
}

const FINAL_REPLY = 'You have one final reply. Tools are no longer available and any tool call in it will not run. ';

/** Every call failed in too many rounds running: the model is told it has one closing reply, and the person why the turn stops. */
function failedRoundsStop(ctx: TurnContext, sink: TurnSink, breaker: ConsecutiveErrorBreaker): { readonly note: string; readonly stop: NonNullable<TurnOutcome['stop']> } {
  ctx.hostInstructions?.set('breaker', `[Tool recovery] Every tool call failed in ${breaker.consecutiveErrors} consecutive rounds, so this turn is stopping. ` + FINAL_REPLY
    + 'Report what you were trying to do, the errors you encountered, and what remains undone.', { once: true, append: true });
  sink.notice?.(`[Tool recovery] Stopped after ${breaker.consecutiveErrors} consecutive tool rounds in which every call failed. The request is not complete. Check the tool failures above, fix the cause (permissions, an unavailable service, the inputs), then send the request again.`, 'error');
  return { note: `every tool call failed in ${breaker.consecutiveErrors} consecutive rounds`, stop: { rule: 'all-calls-failed', count: breaker.consecutiveErrors } };
}

/** A call refused this turn: the tool said so with a refused decision, which holds until what it names changes. */
interface RefusedCall {
  readonly toolName: string;
  /** The refusal's reason, for the person's one line. */
  readonly reason: string;
  /** Everything the model was told, given again in full on a repeat. */
  readonly text: string;
}

/** Keeps each refused call of the round (a result whose decision is `refused`), by its exact signature. */
function recordRefusals(refused: Map<string, RefusedCall>, calls: readonly ToolCall[], results: readonly ToolResult[]): void {
  const byId = new Map(results.map((result) => [result.callId, result] as const));
  for (const call of calls) {
    const result = byId.get(call.id);
    // A call held back only to load its tool's parameters was never refused: its retry runs.
    if (!result || result.success || result.cancelled === true || result.heldToLoad === true || result.decision?.state !== 'refused') continue;
    const text = [result.error, result.output].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n') || result.decision.reason;
    refused.set(callSignature(call), { toolName: call.name, reason: result.decision.reason, text });
  }
}

/**
 * The calls of a round that are not repeats of a call refused this turn. For
 * each repeat the model is told, on its next request, that this exact call was
 * already refused and will be again until what the refusal names changes,
 * with the refusal in full; the person sees one line per refused call, the
 * first time it is repeated.
 */
function blockRefusedRepeats(ctx: TurnContext, sink: TurnSink, refused: ReadonlyMap<string, RefusedCall>, told: Set<string>, calls: readonly ToolCall[]): ToolCall[] {
  const remaining: ToolCall[] = [];
  const blocked = new Set<string>();
  for (const call of calls) {
    const signature = callSignature(call);
    if (refused.has(signature)) blocked.add(signature);
    else remaining.push(call);
  }
  for (const signature of blocked) {
    const entry = refused.get(signature)!;
    ctx.hostInstructions?.set('breaker', `[Blocked call] ${entry.toolName} was not run: this exact call was already refused in this turn, and it will be refused again until what the refusal names changes. `
      + `Do not make it again; act on the refusal instead. The refusal, in full:\n${entry.text}`, { once: true, append: true });
    if (told.has(signature)) continue;
    told.add(signature);
    sink.notice?.(`[Blocked] ${entry.toolName} was asked for again exactly as before and was not run: ${entry.reason}`, 'warning');
  }
  return remaining;
}

/**
 * The stop rules after a tool round, the same for every caller: rounds in
 * which every call failed, and calls repeated with the same result. A warning
 * reaches the model on its next request only; a stop tells the model it has
 * one closing reply, tells the person the request is not complete, and
 * returns why the turn ends.
 * Nothing here waits: a reading of repeated calls runs beside the next request.
 */
function applyStopRules(ctx: TurnContext, turnSignal: AbortSignal, sink: TurnSink, breaker: ConsecutiveErrorBreaker, history: TurnCallObservation[],
  repeatReading: { pending: boolean }, malformed: { signature: string; count: number },
  roundCalls: readonly ToolCall[], roundResults: readonly ToolResult[]): { readonly note: string; readonly stop: NonNullable<TurnOutcome['stop']> } | undefined {
  const tell = (text: string): void => ctx.hostInstructions?.set('breaker', text, { once: true, append: true });
  // A call held back only to load its tool's parameters never ran: it is no failed round, no repeat and no malformed call.
  const held = new Set(roundResults.filter((result) => result.heldToLoad === true).map((result) => result.callId));
  const calls = held.size === 0 ? roundCalls : roundCalls.filter((call) => !held.has(call.id));
  const results = held.size === 0 ? roundResults : roundResults.filter((result) => !held.has(result.callId));
  const finalReply = 'You have one final reply. Tools are no longer available and any tool call in it will not run. ';

  const byId = new Map(results.map((result) => [result.callId, result] as const));
  for (const call of calls) {
    history.push({ signature: callSignature(call), requested: call, executed: { name: call.name, arguments: JSON.stringify(call.arguments) }, result: callOutcome(byId.get(call.id)) });
  }
  while (history.length > REPEAT_HISTORY_WINDOW) history.shift();

  // The same malformed call sent again and again: the model is not reading what it was told to fix.
  for (const call of calls) {
    const signature = callSignature(call);
    if (byId.get(call.id)?.malformed !== true) { malformed.signature = ''; malformed.count = 0; continue; }
    malformed.count = malformed.signature === signature ? malformed.count + 1 : 1;
    malformed.signature = signature;
    if (malformed.count >= MALFORMED_REPEAT_STOP) {
      tell(`[Repeated call] Your call to ${call.name} was malformed ${malformed.count} times in a row with the same arguments, so this turn is stopping. `
        + finalReply + 'Report what you were trying to do and what remains undone.');
      sink.notice?.(`Stopped: the model sent the same malformed call to ${call.name} ${malformed.count} times in a row.`, 'error');
      return { note: `the model sent the same malformed call to ${call.name} ${malformed.count} times in a row`, stop: { rule: 'repeated-call', toolName: call.name, count: malformed.count } };
    }
  }

  if (results.length > 0 && results.every((result) => result.success === false)) {
    const state = breaker.recordAllFailed();
    if (state === 'break') return failedRoundsStop(ctx, sink, breaker);
    if (state === 'warn') {
      // The model is told; the person sees the failed calls themselves, so no notice repeats them.
      tell(`[Tool recovery] Your last ${breaker.consecutiveErrors} tool rounds all failed. Stop attempting the same approach. `
        + `Say what you are trying to do and what is going wrong, then try a different strategy. At ${CONSECUTIVE_ERROR_BREAK} such rounds the turn stops.`);
    }
  } else if (results.length > 0) {
    breaker.recordSuccess();
  }

  const repeat = identicalRepeat(history, REPEAT_STOP_THRESHOLD);
  if (repeat) {
    tell(`[Repeated call] ${repeat.toolName} has run ${repeat.count} times with the same arguments and returned the same result each time, so this turn is stopping. `
      + finalReply + 'Report what you were trying to do, what the repeated call returned, and what remains undone.');
    sink.notice?.(`[Repeated call] Stopped: ${repeat.toolName} ran ${repeat.count} times with the same arguments and the same result.`, 'error');
    return { note: `${repeat.toolName} ran ${repeat.count} times with the same arguments and the same result`, stop: { rule: 'repeated-call', toolName: repeat.toolName, count: repeat.count } };
  }

  const judgeRepeat = ctx.judgeRepeat;
  if (!judgeRepeat || repeatReading.pending) return undefined;
  const counts = new Map<string, number>();
  for (const entry of history) counts.set(entry.signature, (counts.get(entry.signature) ?? 0) + 1);
  const repeated = calls.map(callSignature).filter((signature) => (counts.get(signature) ?? 0) >= 2);
  if (repeated.length === 0) return undefined;
  const worst = repeated.reduce((best, signature) => (counts.get(signature)! > counts.get(best)! ? signature : best));
  const count = counts.get(worst)!;
  if (count < REPEAT_REVIEW_THRESHOLD) return undefined;
  const runs = history.filter((entry) => entry.signature === worst);
  // Runs that returned different things show the work moving (a poll, a test run after an edit): no reading is needed.
  const firstKey = outcomeKey(runs[0]!);
  if (runs.some((entry) => outcomeKey(entry) !== firstKey)) return undefined;
  const toolName = worst.slice(0, worst.indexOf('::'));
  repeatReading.pending = true;
  void judgeRepeat(runs, worst, turnSignal)
    .then((reading) => {
      if (!reading?.stuck || turnSignal.aborted) return;
      tell(count >= REPEAT_REFUSE_THRESHOLD
        ? `You are repeating the same tool call. ${toolName} has been called ${count} times with identical arguments and no meaningful progress in the results. Do NOT call ${toolName} with these arguments again. Identify what you were trying to accomplish and take a different action.`
        : `You have already executed this exact call (${toolName}) ${count} times with identical arguments. The results from your previous calls are already in your conversation history. Review them and proceed to the next step.`);
    })
    .catch(() => { /* An unsure or failed reading gives no warning; the exact-repeat stop still holds. */ })
    .finally(() => { repeatReading.pending = false; });
  return undefined;
}

type CheckVerdict =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: string; readonly correction: string }
  | { readonly kind: 'unchecked'; readonly why: string };

/** One completion check of a draft: it ends when the decision model answers or fails, or the turn is cancelled. */
async function checkOnce(ctx: TurnContext, draft: string, policy: TurnPolicy): Promise<CheckVerdict> {
  try {
    const verdict = await ctx.checkDraft!(draft, { speaker: policy.speaker, signal: ctx.signal });
    if (ctx.signal.aborted) throw new TurnCancelled();
    return verdict.accepted ? { kind: 'accepted' } : { kind: 'rejected', reason: verdict.reason, correction: verdict.correction };
  } catch (error) {
    if (error instanceof TurnCancelled || ctx.signal.aborted) throw new TurnCancelled();
    return { kind: 'unchecked', why: `the completion check could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}
