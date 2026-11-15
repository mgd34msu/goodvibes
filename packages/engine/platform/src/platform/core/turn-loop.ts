/**
 * The single turn loop: ask the model, show its text as it arrives, run the
 * tool calls it asked for through the one tool-batch executor, and repeat until
 * it answers, the turn's budget is spent or the turn is cancelled.
 *
 * What differs between callers (who is speaking, where text goes, the budget,
 * whether the answer is checked, whether delegated work is awaited) is a
 * `TurnPolicy`; how a caller reaches its provider, conversation and tools is a
 * `TurnContext`. The loop itself never branches on which product runs it.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { classifyFailure } from '@goodvibes-jev/engine/errors';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { TOOL_CALL_CANCELLED_MESSAGE } from './orchestrator-tool-runtime.js';

/** Who the turn answers: the owner at a surface, or the agent that delegated the work. */
export type TurnSpeaker = 'owner' | 'parent-agent';

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
}

export interface TurnPolicy {
  readonly speaker: TurnSpeaker;
  readonly sink: TurnSink;
  /** `turns`: most model rounds that may ask for tools. `tokens`: most input plus output tokens over the turn. Absent: unbounded. */
  readonly budget: { readonly turns?: number | undefined; readonly tokens?: number | undefined };
  /** At most `maxRejectedDrafts` drafts are withdrawn; each check has `deadlineMs`. Used only when the context can check a draft. */
  readonly completion: { readonly maxRejectedDrafts: number; readonly deadlineMs: number };
  /** `await-events`: an answer waits for delegated work to report before the turn ends. `return`: the turn ends at the answer. */
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
  /** False for the closing request after the budget is spent: the model is asked to answer without tools. */
  readonly tools: boolean;
  readonly signal: AbortSignal;
  /** Called with each piece of text as the provider streams it. */
  onDelta(text: string): void;
}

export type DraftVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string; readonly correction: string };

/** How one caller reaches its model, conversation and tools. */
export interface TurnContext {
  /** Aborted when the turn is cancelled; reaches every request and every tool call. */
  readonly signal: AbortSignal;
  request(request: TurnRequest): Promise<TurnModelResponse>;
  readonly conversation: {
    addAssistantMessage(content: string, options?: { toolCalls?: ToolCall[] }): void;
    addToolResults(results: ToolResult[]): void;
  };
  /**
   * The one tool-batch executor (`executeToolCalls`) bound to this caller.
   * `onSettled` receives each real receipt as it lands, so a cancelled batch
   * keeps them. Absent: tools cannot run here and calls are answered as not run.
   */
  executeTools?(calls: ToolCall[], options: { signal: AbortSignal; onSettled(result: ToolResult): void }): Promise<ToolResult[]>;
  /** The completion check of a final draft, run after the draft was shown. */
  checkDraft?(draft: string, options: { speaker: TurnSpeaker; signal: AbortSignal }): Promise<DraftVerdict>;
  /** Tells the model, on the next request only, what the rejected draft missed (the host-instruction channel). */
  correct?(text: string): void;
  /** Waits for delegated work to report; true when its results were added and the model should take another round. */
  awaitDelegates?(signal: AbortSignal): Promise<boolean>;
  /** Waits before each retry of a request that failed with a retryable failure; absent: no retry. */
  readonly retryDelaysMs?: readonly number[] | undefined;
}

export interface TurnOutcome {
  readonly status: 'answered' | 'budget' | 'cancelled';
  /** The answer that stands, or '' when the turn was cancelled before one. */
  readonly text: string;
  /** Model requests made, the closing one included. */
  readonly rounds: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly rejectedDrafts: number;
  /** True when a completion check accepted the answer, false when it stands unverified, undefined when nothing checks. */
  readonly verified?: boolean | undefined;
  /** Why the answer stands unverified, or which limit ended the turn. */
  readonly note?: string | undefined;
}

class TurnCancelled extends Error {}

async function requestWithRetry(ctx: TurnContext, request: TurnRequest): Promise<TurnModelResponse> {
  const delays = ctx.retryDelaysMs ?? [];
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.request(request);
    } catch (error) {
      if (ctx.signal.aborted) throw new TurnCancelled();
      const failure = classifyFailure(error);
      const wait = delays[attempt];
      if (!failure?.retryable || wait === undefined) throw error;
      try { await delay(Math.max(wait, failure.retryAfterMs ?? 0), undefined, { signal: ctx.signal }); }
      catch { throw new TurnCancelled(); }
    }
  }
}

/** A result for each call that has none: the receipt that landed, else a cancelled result. */
function closeCancelledBatch(calls: readonly ToolCall[], settled: ReadonlyMap<string, ToolResult>): ToolResult[] {
  return calls.map((call) => settled.get(call.id) ?? { callId: call.id, success: false, error: TOOL_CALL_CANCELLED_MESSAGE, cancelled: true });
}

/** Run one turn to its end under `policy`. Throws only a failure that is not a cancellation and cannot be retried. */
export async function runTurn(ctx: TurnContext, policy: TurnPolicy): Promise<TurnOutcome> {
  const sink = policy.sink;
  let rounds = 0;
  let rejectedDrafts = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const outcome = (status: TurnOutcome['status'], text: string, extra: Partial<Pick<TurnOutcome, 'verified' | 'note'>> = {}): TurnOutcome =>
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

  try {
    while (true) {
      if (ctx.signal.aborted) return outcome('cancelled', '');
      const response = await ask(true);
      if (ctx.signal.aborted) return outcome('cancelled', '');
      const calls = [...response.toolCalls];

      if (calls.length === 0) {
        const draft = response.content;
        if (policy.delegates === 'await-events' && ctx.awaitDelegates) {
          if (await ctx.awaitDelegates(ctx.signal)) {
            ctx.conversation.addAssistantMessage(draft);
            continue;
          }
          if (ctx.signal.aborted) return outcome('cancelled', '');
        }
        if (!ctx.checkDraft) {
          ctx.conversation.addAssistantMessage(draft);
          return outcome('answered', draft);
        }
        const verdict = await checkWithDeadline(ctx, draft, policy);
        if (ctx.signal.aborted) return outcome('cancelled', '');
        if (verdict.kind === 'accepted') {
          ctx.conversation.addAssistantMessage(draft);
          return outcome('answered', draft, { verified: true });
        }
        if (verdict.kind === 'rejected' && rejectedDrafts < policy.completion.maxRejectedDrafts) {
          rejectedDrafts++;
          sink.draftWithdrawn?.(draft, verdict.reason);
          ctx.correct?.(verdict.correction);
          continue;
        }
        const note = verdict.kind === 'rejected' ? `not verified: ${verdict.reason}` : `not verified: ${verdict.why}`;
        ctx.conversation.addAssistantMessage(draft);
        sink.notVerified?.(note);
        return outcome('answered', draft, { verified: false, note });
      }

      const limit = spent();
      if (limit !== undefined || !ctx.executeTools) {
        const reason = limit !== undefined ? `Not run: ${limit}.` : 'Not run: no tools can run here.';
        if (response.content) ctx.conversation.addAssistantMessage(response.content);
        sink.unrunCalls?.(calls, reason);
        if (limit === undefined) return outcome('answered', response.content);
        const closing = await ask(false);
        if (ctx.signal.aborted) return outcome('cancelled', '');
        ctx.conversation.addAssistantMessage(closing.content);
        return outcome('budget', closing.content, { note: limit });
      }

      ctx.conversation.addAssistantMessage(response.content, { toolCalls: calls });
      const settled = new Map<string, ToolResult>();
      let results: ToolResult[];
      try {
        results = await ctx.executeTools(calls, { signal: ctx.signal, onSettled: (result) => { settled.set(result.callId, result); } });
      } catch (error) {
        if (!ctx.signal.aborted) throw error;
        // Every call the model issued gets a result, so the history stays valid for the next turn.
        const closed = closeCancelledBatch(calls, settled);
        ctx.conversation.addToolResults(closed);
        sink.toolResults?.(calls, closed);
        return outcome('cancelled', '');
      }
      ctx.conversation.addToolResults(results);
      sink.toolResults?.(calls, results);
    }
  } catch (error) {
    if (error instanceof TurnCancelled) return outcome('cancelled', '');
    throw error;
  }
}

type CheckVerdict =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: string; readonly correction: string }
  | { readonly kind: 'unchecked'; readonly why: string };

async function checkWithDeadline(ctx: TurnContext, draft: string, policy: TurnPolicy): Promise<CheckVerdict> {
  const late = `the check did not finish within ${policy.completion.deadlineMs} ms`;
  const deadline = AbortSignal.timeout(policy.completion.deadlineMs);
  const signal = AbortSignal.any([ctx.signal, deadline]);
  // The deadline holds even for a check that ignores its signal.
  let onAbort = (): void => {};
  const stopped = new Promise<'stopped'>((resolve) => {
    onAbort = () => resolve('stopped');
    if (signal.aborted) resolve('stopped');
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const check = ctx.checkDraft!(draft, { speaker: policy.speaker, signal });
  check.catch(() => {});
  try {
    const verdict = await Promise.race([check, stopped]);
    if (ctx.signal.aborted) throw new TurnCancelled();
    if (verdict === 'stopped' || deadline.aborted) return { kind: 'unchecked', why: late };
    return verdict.accepted ? { kind: 'accepted' } : { kind: 'rejected', reason: verdict.reason, correction: verdict.correction };
  } catch (error) {
    if (error instanceof TurnCancelled || ctx.signal.aborted) throw new TurnCancelled();
    if (deadline.aborted) return { kind: 'unchecked', why: late };
    return { kind: 'unchecked', why: error instanceof Error ? error.message : String(error) };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
