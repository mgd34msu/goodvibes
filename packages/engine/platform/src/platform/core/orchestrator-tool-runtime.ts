import { withExternalOperationSource } from '../permissions/external-operation-scope.js';
import type { ConversationManager } from './conversation.js';
import { assertDecisionAvailable } from '../routing/decision-availability.js';
import { isClassicOperation } from '../runtime/decision-policy.js';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { currentExecutionMode, isYoloExecution, withExecutionMode } from '../gate/execution-context.js';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { captureAutonomousChoices, type AutonomousToolSource } from '../permissions/autonomous.js';
import { UnknownPreparedToolError } from '../tools/preparation-error.js';
import type { PreparedToolCall } from '../tools/registry.js';
import { describeToolInputProjectionProblem, ToolInputProjectionError, type ProjectedToolCall } from '../tools/input-projection.js';
import type { AutonomousChoiceProjection } from '../permissions/autonomous-input-projection.js';
import { isAuthenticAutonomousAdmission, type AutonomousPermissionAdmission } from '../permissions/manager.js';
import type { TurnHookOwner } from '../hooks/turn-ownership.js';
import { hookPointBlocks } from '../hooks/contracts.js';
import { ToolError, PermissionError } from '../types/errors.js';
import type { HookEvent, HookEventPath, HookResult } from '../hooks/types.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../types/tools.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConfigManager } from '../config/manager.js';
import type { PermissionManager } from '../permissions/manager.js';
import { buildToolDenial, buildDenialErrorMessage, toolDecisionOf } from '../permissions/denial.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import {
  emitGateDecision,
  emitGateRequested,
  emitToolCancelled,
  emitToolExecuting,
  emitToolFailed,
  emitToolPermissioned,
  emitToolReconciled,
  emitToolReceived,
  emitToolSucceeded,
  toToolResultSummary,
} from '../runtime/emitters/index.js';
import { buildSyntheticResult, describeReconciledCalls, detectUnresolvedToolCalls, type ReconciliationReason } from './tool-reconciliation.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { DEFAULT_CEILING_TOKENS, capToolText } from '../runtime/tools/output-policy.js';
import { redactDiagnosticText } from '../utils/redaction.js';
import { withCostOriginAsync, mcpServerOfToolName } from '../runtime/cost/cost-origin.js';
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS, planToolBatch, runBounded, toolCallLane } from './tool-batch.js';

/** Event payloads leave the process; hook and permission messages can quote secrets from arguments. */
function redactedErrorResult<T extends { readonly error?: string | undefined }>(result: T): T {
  return { ...result, error: redactDiagnosticText(result.error ?? '') };
}

/**
 * Event previews leave the process and tool output or errors can echo a token:
 * redact a window wider than the 100-character preview first, so a secret cut
 * by the preview boundary is still recognised, then truncate.
 */
function redactedToolResultSummary(
  result: Parameters<typeof toToolResultSummary>[0],
): ReturnType<typeof toToolResultSummary> {
  const summary = toToolResultSummary(result);
  const source = result.success ? (result.output ?? '') : (result.error ?? 'unknown error');
  return { ...summary, preview: redactDiagnosticText(source.slice(0, 512)).slice(0, 100) };
}

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

// Replay identity belongs to the actual permission manager, just like its
// autonomousClaims/autonomousEpochs. Retain only protocol references, never
// requests or arguments. A call id can come back only within its own turn, and
// a session runs one turn at a time, so a session keeps the identities of its
// current turn and the one before it; older turns can never present a call
// again. The WeakMap releases everything when the manager becomes unreachable.
const autonomousInvocationSources = new WeakMap<object, Map<string, Map<string, Map<string, string>>>>();
const RETAINED_TURNS_PER_SESSION = 2;

function autonomousInvocationSource(manager: object, session: string, turn: string, call: string): string {
  // Admit the original references before lookup, even on an existing tuple.
  // A generated opaque ref must never conceal unsafe caller identity input.
  if (!isYoloExecution()) captureAutonomousChoices({ resumeConditions: [
    { id: session, revision: turn }, { id: call, revision: 'tool-call' },
  ] });
  let sessions = autonomousInvocationSources.get(manager);
  if (!sessions) { sessions = new Map(); autonomousInvocationSources.set(manager, sessions); }
  let turns = sessions.get(session);
  if (!turns) { turns = new Map(); sessions.set(session, turns); }
  let calls = turns.get(turn);
  if (!calls) {
    calls = new Map(); turns.set(turn, calls);
    // Maps keep insertion order: the first key is the oldest turn.
    while (turns.size > RETAINED_TURNS_PER_SESSION) turns.delete(turns.keys().next().value!);
  }
  let source = calls.get(call);
  if (!source) { source = opaqueUuid(); calls.set(call, source); }
  return source;
}

/**
 * Prefers `checkDetailed()` (carries `modifiedArgs` for per-hunk edit
 * approval) but falls back to the boolean-only `check()` for any caller
 * that injects a duck-typed permission manager stub without it (e.g. test
 * doubles built before `checkDetailed` existed). Mirrors the same
 * defensive duck-typing already used by the phased tool executor's
 * permission phase.
 */
async function resolvePermissionCheck(
  permissionManager: Pick<PermissionManager, 'checkDetailed' | 'check'> | { check: PermissionManager['check'] },
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  hookOwner?: TurnHookOwner,
  definition?: ToolDefinition,
): Promise<import('../permissions/types.js').PermissionCheckResult> {
  const manager = permissionManager as {
    checkDetailed?: PermissionManager['checkDetailed'];
    check: PermissionManager['check'];
  };
  const options = { signal, hookOwner, ...(definition ? { definition } : {}) };
  if (typeof manager.checkDetailed === 'function') {
    return manager.checkDetailed(toolName, args, undefined, options);
  }
  const approved = await manager.check(toolName, args, undefined, options);
  return {
    approved,
    persisted: false,
    sourceLayer: approved ? 'config_policy' : 'user_prompt',
    reasonCode: approved ? 'config_allow' : 'user_denied',
    analysis: {
      classification: 'generic',
      riskLevel: 'medium',
      summary: `Permission ${approved ? 'approved' : 'denied'} for ${toolName}`,
      reasons: [],
    },
  };
}

/** The category the gate classes a call under, for its request event; 'delegate' when the manager cannot say. */
function gateCategory(permissionManager: object, toolName: string, args: Record<string, unknown>, registry?: ToolRegistry): string {
  const manager = permissionManager as Partial<Pick<PermissionManager, 'getCategory'>>;
  if (typeof manager.getCategory !== 'function') return 'delegate';
  const definition = registry && typeof registry.definitionOf === 'function' ? registry.definitionOf(toolName) : undefined;
  return manager.getCategory(toolName, args, definition);
}

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.js').EmitterContext;

export type ToolExecutionDeps = {
  /** Trusted native lifecycle decorator over the same shared recorded transport. */
  autonomousPort?: ((port: import('@goodvibes-jev/judgment').JudgmentPort) => import('@goodvibes-jev/judgment').JudgmentPort) | undefined;
  /** Current source supplied by the real turn/contract owner. Required for autonomous execution. */
  autonomousSource?: (() => AutonomousToolSource) | undefined;
  hookOwner?: TurnHookOwner | undefined;
  /** This execution's immutable whole-turn signal, never a later turn's controller. */
  turnSignal?: AbortSignal | undefined;
  /** Additive caller observation restriction; never execution permission. */
  assertCurrent?: (() => void) | undefined;
  /** Retain each actual settled receipt even when a later call or hook aborts the batch. */
  onToolSettled?: ((result: ToolResult) => void) | undefined;
  toolRegistry: ToolRegistry;
  /** Without `admitAutonomous` and `autonomousPreparation` each call is asked through `checkDetailed` (an embedding's own gate). */
  permissionManager: Pick<PermissionManager, 'checkDetailed' | 'check'>
    & Partial<Pick<PermissionManager, 'admitAutonomous' | 'autonomousPreparation' | 'prepareAutonomousOwner' | 'projectAutonomousChoices' | 'releaseAutonomousChoices' | 'retireAutonomousSource' | 'getMode' | 'captureExecutionMode'>>;
  hookDispatcher: HookDispatcherLike | null;
  runtimeBus: RuntimeEventBus | null;
  sessionId: string;
  emitterContext: EmitterContextFactory;
  /**
   * Called once per executed tool with (toolName, resolved args, success) so a
   * code-index reindex scheduler can debounce an incremental reindex of touched files. Invoked
   * for BOTH success and failure (the scheduler no-ops on failure); never awaited, it must not
   * block the tool-result path.
   */
  onToolExecuted?: ((toolName: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
  /** Handed to each tool body: a tool that reports progress tells the caller it is still working (liveness). */
  onProgress?: ((note?: string) => void) | undefined;
  /**
   * Per-call cancellation seam: `open(callId)` yields the AbortSignal passed to
   * the tool body (registering the call as cancellable), `close(callId)`
   * retires it once the call settles. A cancel of ONE call aborts only that
   * call's signal, other calls in the batch and the turn itself continue.
   * Optional/undefined preserves the previous uncancellable behavior.
   */
  toolCallSignals?: {
    open(callId: string): AbortSignal;
    close(callId: string): void;
  } | undefined;
  /**
   * Per-call budget (`runtime.toolBudget.*`), read once per call. Absent or
   * undefined means no limit. The time limit stops the call when it is reached
   * (its signal aborts); token and cost limits are known only from the result,
   * so a breach of those is reported on it.
   */
  toolBudget?: (() => ToolBudget | undefined) | undefined;
  /** The cap on calls of one batch in flight at once, read once per batch (`maxParallelToolCalls`). Absent: the default of 8. */
  maxParallel?: (() => number) | undefined;
  /**
   * The directory the tools resolve relative paths against. Lets a write with a
   * relative path run beside one with an absolute path to another file; without
   * it such a pair runs one after the other.
   */
  workingDirectory?: string | undefined;
};

const OUTPUT_CUT_GUIDANCE = 'Ask for a narrower part (a smaller path, range, query or page), or use the tool option that pages or limits its output.';

/** A caller's own `max_tokens` (top level or under `output`) wins over the default ceiling, as it does in the tools that honour it. */
function explicitOutputCeiling(args: Record<string, unknown>): number | undefined {
  const nested = args['output'];
  const candidates = [args['max_tokens'], nested && typeof nested === 'object' ? (nested as Record<string, unknown>)['max_tokens'] : undefined];
  for (const value of candidates) if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

/** Limits for one tool call; a field that is absent is unlimited. */
export type ToolBudget = { readonly maxMs?: number | undefined; readonly maxTokens?: number | undefined; readonly maxCostUsd?: number | undefined };

/** The budget the configuration asks for, or undefined while enforcement is off or every limit is 0 (unlimited). */
export function toolBudgetFromConfig(configManager: Pick<ConfigManager, 'get'> | undefined): ToolBudget | undefined {
  if (!configManager || configManager.get('runtime.toolBudget.enforced') !== true) return undefined;
  const maxMs = configManager.get('runtime.toolBudget.maxMs');
  const maxTokens = configManager.get('runtime.toolBudget.maxTokens');
  const maxCostUsd = configManager.get('runtime.toolBudget.maxCostUsd');
  const budget: { maxMs?: number; maxTokens?: number; maxCostUsd?: number } = {};
  if (maxMs > 0) budget.maxMs = maxMs;
  if (maxTokens > 0) budget.maxTokens = maxTokens;
  if (maxCostUsd > 0) budget.maxCostUsd = maxCostUsd;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

/** The signal that stops a call at its time limit, or undefined when it has none. */
export function toolBudgetDeadline(budget: ToolBudget | undefined): AbortSignal | undefined {
  return budget?.maxMs === undefined ? undefined : AbortSignal.timeout(budget.maxMs);
}

/**
 * The result of a call its time limit stopped. Whatever the tool produced
 * before it stopped is kept; it may have done part of its work.
 */
export function toolBudgetStoppedResult(callId: string, toolName: string, budget: ToolBudget, settled: ToolResult | null): ToolResult {
  return {
    callId,
    success: false,
    error: `Tool '${toolName}' was stopped at its time limit of ${budget.maxMs} ms (runtime.toolBudget.maxMs). Part of its action may have taken effect, so check before repeating it, or ask for a smaller piece of work.`,
    ...(settled?.output !== undefined ? { output: settled.output } : {}),
  };
}

/**
 * The first limit a finished call went over, as a sentence for the model, or
 * null. The result keeps its output: the tool already ran, so the model is told
 * to check its effect before repeating it. Token and cost limits apply only to
 * tools that report `tokenCount` / `costUsd` on their result.
 */
function describeBudgetBreach(budget: ToolBudget, elapsedMs: number, result: ToolResult): string | null {
  const reported = result as ToolResult & { readonly tokenCount?: unknown; readonly costUsd?: unknown };
  if (budget.maxMs !== undefined && elapsedMs > budget.maxMs) return `it ran ${Math.round(elapsedMs)} ms against a limit of ${budget.maxMs} ms (runtime.toolBudget.maxMs)`;
  if (budget.maxTokens !== undefined && typeof reported.tokenCount === 'number' && reported.tokenCount > budget.maxTokens) return `it used ${reported.tokenCount} tokens against a limit of ${budget.maxTokens} (runtime.toolBudget.maxTokens)`;
  if (budget.maxCostUsd !== undefined && typeof reported.costUsd === 'number' && reported.costUsd > budget.maxCostUsd) return `it cost ${reported.costUsd} USD against a limit of ${budget.maxCostUsd} (runtime.toolBudget.maxCostUsd)`;
  return null;
}

/**
 * A finished call that went over its budget becomes a failed result that keeps
 * its output; a call within budget, or already failed, is returned as is.
 */
export function applyToolBudget(budget: ToolBudget | undefined, toolName: string, elapsedMs: number, result: ToolResult): ToolResult {
  if (!budget || !result.success) return result;
  const breach = describeBudgetBreach(budget, elapsedMs, result);
  if (!breach) return result;
  return {
    ...result,
    success: false,
    error: `Tool '${toolName}' finished but exceeded its budget: ${breach}. Its action may have taken effect, so check the result before repeating it.`,
  };
}

/** Tools that clip and page their own output; a second cut would drop lines their continuation marker says were delivered. */
const SELF_PAGING_TOOLS: ReadonlySet<string> = new Set(['read']);

/** Keeps one tool result from putting its whole text into a conversation; used by every loop that appends tool results. */
export function capToolResultOutput(toolName: string, args: Record<string, unknown>, result: ToolResult): ToolResult {
  if (typeof result.output !== 'string' || SELF_PAGING_TOOLS.has(toolName)) return result;
  const capped = capToolText(result.output, explicitOutputCeiling(args) ?? DEFAULT_CEILING_TOKENS.read, OUTPUT_CUT_GUIDANCE);
  return capped === result.output ? result : { ...result, output: capped };
}

/** The human-readable per-call cancellation message the model sees. */
export const TOOL_CALL_CANCELLED_MESSAGE = 'cancelled by user';
export const TOOL_CALL_CANCELLED_AFTER_COMPLETION_MESSAGE = 'cancelled by user, but the call had already finished; its action may have taken effect, so check the result before repeating it';

/**
 * Normalize a settled (or thrown-through) result of a call whose per-call
 * signal was aborted into the structured cancelled shape: the model sees
 * "cancelled by user" with `cancelled: true`, keeping any partial output the
 * tool produced before it stopped. The tiny race where a tool completes
 * successfully in the same instant the user cancels still reports cancelled,
 * the user's decision is the truth the model should adapt to. The wording then
 * says the action may already have happened, so the model checks before it
 * repeats a write or a send.
 */
function toCancelledResult(callId: string, settled: ToolResult | null): ToolResult {
  return {
    callId,
    success: false,
    error: settled?.success === true ? TOOL_CALL_CANCELLED_AFTER_COMPLETION_MESSAGE : TOOL_CALL_CANCELLED_MESSAGE,
    cancelled: true,
    ...(settled?.output !== undefined ? { output: settled.output } : {}),
    ...(settled?.autonomousDecision ? { autonomousDecision: settled.autonomousDecision } : {}),
    ...(settled?.decision ? { decision: settled.decision } : {}),
  };
}

/** A Pre hook's note rides with the call's result, where the model reads it (output on success, error otherwise). */
function withHookNote(result: ToolResult, note: string): ToolResult {
  const line = `[Note from the owner's Pre:tool hook] ${note}`;
  if (result.success) return { ...result, output: result.output ? `${result.output}\n\n${line}` : line };
  return { ...result, error: result.error ? `${result.error}\n\n${line}` : line };
}

/**
 * Fires an observing hook point (Post, Fail, file). The point's contract says whether
 * the call waits: a `non_blocking` point runs beside the turn, which the turn's hook
 * owner joins before the turn ends, so a slow hook no longer delays the next call.
 */
async function fireObservingHook(dispatcher: HookDispatcherLike, event: HookEvent): Promise<void> {
  const fired = dispatcher.fire(event).catch((error: unknown) => {
    logger.warn(`${event.path} hook error`, { error: summarizeError(error) });
  });
  if (hookPointBlocks(event.path)) await fired;
}

/** How each call of a batch may run beside the others, from the registry's declarations; every call runs alone when the registry cannot list them. */
function batchLanes(deps: ToolExecutionDeps, calls: readonly ToolCall[]): number[][] {
  if (calls.length < 2 || typeof deps.toolRegistry.list !== 'function') return calls.map((_, index) => [index]);
  const definitions = new Map(deps.toolRegistry.list().map((tool) => [tool.definition.name, tool.definition]));
  return planToolBatch(calls, (call) => call.argumentError !== undefined
    ? { kind: 'read', paths: [] }
    : toolCallLane(definitions.get(call.name), call.arguments, deps.workingDirectory));
}

/**
 * The one tool-batch executor. Independent calls of one response run side by
 * side (tool-batch.ts decides which, from declarations), each through its own
 * admission, hooks and execution; at most `maxParallel` are in flight. Results
 * come back in the model's order, one per call. A call that fails is a failed
 * result and never fails its siblings. A throw (the turn was cancelled, or an
 * admission owner refused to go on) stops new calls from starting, lets the
 * running ones finish so their receipts reach `onToolSettled`, then rethrows.
 */
export async function executeToolCalls(
  deps: ToolExecutionDeps,
  turnId: string,
  calls: ToolCall[],
): Promise<ToolResult[]> {
  const slots: (ToolResult | undefined)[] = new Array<ToolResult | undefined>(calls.length);
  const runOne = async (index: number): Promise<void> => {
    const call = calls[index]!;
    await deps.permissionManager.prepareAutonomousOwner?.(deps.turnSignal);
    deps.turnSignal?.throwIfAborted();
    deps.assertCurrent?.();
    const inheritedMode = currentExecutionMode();
    const selection = deps.permissionManager.captureExecutionMode?.();
    const mode = selection?.mode ?? deps.permissionManager.getMode?.() ?? inheritedMode ?? 'safe-owner';
    const [result] = await withExecutionMode(mode, () => executeToolCallsInMode(deps, turnId, [call]), selection?.assertCurrent);
    slots[index] = result;
  };
  const limit = deps.maxParallel?.() ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
  for (const group of batchLanes(deps, calls)) {
    if (group.length === 1) await runOne(group[0]!);
    else await runBounded(group, limit, undefined, (index) => runOne(index));
  }
  return slots.filter((result): result is ToolResult => result !== undefined);
}

async function executeToolCallsInMode(
  deps: ToolExecutionDeps,
  turnId: string,
  calls: ToolCall[],
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  const turnSignal = deps.turnSignal;
  const callerCurrent = deps.assertCurrent;
  const assertTurnActive = () => { turnSignal?.throwIfAborted(); callerCurrent?.(); };

  for (const originalCall of calls) {
    assertTurnActive();
    let call = { id: originalCall.id, name: originalCall.name, arguments: originalCall.arguments };
    let prepared: PreparedToolCall | undefined;
    let admission: AutonomousPermissionAdmission | undefined;
    let inputProjection: ProjectedToolCall | undefined;
    let choiceProjection: AutonomousChoiceProjection | undefined;
    let settledResult: ToolResult | undefined;
    let resultPolicy = decisionModelPolicyState();
    const appendResult = (result: ToolResult) => {
      const recorded = { ...result, ...(resultPolicy.operation === 'classic' ? { decisionPolicy: resultPolicy } : {}) };
      settledResult = { ...recorded }; results.push(recorded);
    };
    // The provider could not read this call's arguments: answer it with that, never run it on empty ones.
    if (originalCall.argumentError !== undefined) {
      const result: ToolResult = { callId: call.id, success: false, error: originalCall.argumentError };
      if (deps.runtimeBus) emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
        callId: call.id, turnId, tool: call.name, error: redactDiagnosticText(originalCall.argumentError),
        durationMs: 0, result: redactedToolResultSummary(result),
      });
      appendResult(result);
      continue;
    }
    // A tool the request listed in one line and that is not loaded: not run; its full
    // definition is the answer (refused, with the next step) and it is sent in full from now on.
    const deferred = typeof deps.toolRegistry.deferredCallRefusal === 'function' ? deps.toolRegistry.deferredCallRefusal(call.id, call.name) : undefined;
    if (deferred) {
      if (deps.runtimeBus) emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
        callId: call.id, turnId, tool: call.name, error: redactDiagnosticText(deferred.error ?? ''),
        durationMs: 0, result: redactedToolResultSummary(deferred),
      });
      appendResult(deferred);
      continue;
    }
    // The owner's Pre:tool hooks run before admission, on the call the model made: a deny
    // refuses it with no gate work and no owner prompt; a rewrite is what the gate admits and
    // what runs; a note reaches the model with this call's result. A hook that fails refuses
    // the call (the point's contract is fail-closed; the dispatcher applies it).
    let hookNote: string | undefined;
    if (deps.hookDispatcher && !isYoloExecution()) {
      const hookStartedAt = Date.now();
      let refusal: string | undefined;
      try {
        const preResult = await deps.hookDispatcher.fire({
          path: `Pre:tool:${call.name}`,
          phase: 'Pre',
          category: 'tool',
          specific: call.name,
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { callId: call.id, tool: call.name, args: call.arguments },
        });
        assertTurnActive();
        if (preResult.decision === 'deny') {
          refusal = preResult.reason ?? `Tool '${call.name}' was refused by its Pre hook.`;
        } else {
          if (preResult.updatedInput) call = { ...call, arguments: preResult.updatedInput };
          if (preResult.additionalContext) hookNote = preResult.additionalContext;
        }
      } catch (hookErr) {
        // Cancellation is not a hook failure; it ends the turn.
        assertTurnActive();
        const hookMessage = summarizeError(hookErr);
        logger.error('Orchestrator: Pre hook error', { tool: call.name, error: hookMessage });
        refusal = `Tool '${call.name}' was not run because its Pre hook failed (${hookMessage}). Fix or remove the hook, then retry.`;
      }
      if (refusal !== undefined) {
        const deniedResult: ToolResult = {
          callId: call.id,
          success: false,
          error: refusal,
          decision: { state: 'refused', decidedBy: 'rule', reason: refusal, limit: `Pre:tool:${call.name} hook`,
            next: ['Do something else, or ask the owner to change the hook.'] },
        };
        if (deps.runtimeBus) emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id, turnId, tool: call.name, error: redactDiagnosticText(refusal),
          durationMs: Date.now() - hookStartedAt, result: redactedToolResultSummary(redactedErrorResult(deniedResult)),
        });
        appendResult(deniedResult);
        continue;
      }
    }
    // Production managers/registries use the migrated path. The boolean seam is
    // retained only for pre-existing duck-typed test/embedding implementations.
    const manager = deps.permissionManager;
    const owner = typeof manager.admitAutonomous === 'function' && typeof manager.autonomousPreparation === 'function'
      && typeof deps.toolRegistry.prepareCall === 'function'
      ? { admit: manager.admitAutonomous.bind(manager), preparation: manager.autonomousPreparation.bind(manager) }
      : undefined;
    const autonomous = owner !== undefined;
    const sourceId = autonomous ? autonomousInvocationSource(deps.permissionManager, deps.sessionId, turnId, call.id) : '';
    const sourceOf = deps.autonomousSource;
    if (autonomous && !sourceOf) throw new Error('Autonomous execution requires the host source goal and criteria');
    const earlyCallSignal = autonomous ? deps.toolCallSignals?.open(call.id) : undefined;
    const admissionSignal = turnSignal && earlyCallSignal ? AbortSignal.any([turnSignal, earlyCallSignal]) : turnSignal ?? earlyCallSignal;
    try {
      if (autonomous) {
        await deps.permissionManager.prepareAutonomousOwner?.(admissionSignal);
        assertTurnActive();
        admissionSignal?.throwIfAborted();
        const originalPreparation = owner.preparation(sourceId, sourceOf!, admissionSignal, deps.autonomousPort);
        try {
          if (typeof deps.toolRegistry.projectCall === 'function') {
            inputProjection = await deps.toolRegistry.projectCall(call.id, call.name, call.arguments,
              { signal: admissionSignal, assertCurrent: () => { assertTurnActive(); originalPreparation.assertCurrent(); } });
            call = { id: inputProjection.callId, name: inputProjection.name, arguments: inputProjection.args };
          }
          if (!isYoloExecution() && !isClassicOperation() && deps.permissionManager.projectAutonomousChoices && deps.permissionManager.releaseAutonomousChoices) {
            choiceProjection = await deps.permissionManager.projectAutonomousChoices(sourceId, call.id, sourceOf!, deps.toolRegistry, admissionSignal);
          }
          originalPreparation.assertCurrent();
          const preparation = choiceProjection
            ? owner.preparation(sourceId, sourceOf!, admissionSignal, deps.autonomousPort, choiceProjection)
            : originalPreparation;
          prepared = await deps.toolRegistry.prepareCall(call.id, call.name, call.arguments, { signal: admissionSignal,
            port: preparation.port, assertCurrent: () => { assertTurnActive(); preparation.assertCurrent(); } });
          preparation.assertCurrent();
        } catch (error) {
          // A hallucinated tool remains a failed call so the model can recover
          // and repeated failures still reach the turn-loop circuit breaker.
          // Authority, privacy, schema and judgment failures are not converted.
          if (!(error instanceof UnknownPreparedToolError)) throw error;
          originalPreparation.assertCurrent();
          const result: ToolResult = { callId: call.id, success: false, error: error.message };
          if (deps.runtimeBus) emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
            callId: call.id, turnId, tool: call.name, error: redactDiagnosticText(error.message),
            durationMs: 0, result: redactedToolResultSummary(result),
          });
          appendResult(result);
          continue;
        }
        call = { id: prepared.callId, name: prepared.name, arguments: prepared.args };
      } else if (typeof deps.toolRegistry.projectCall === 'function' && deps.toolRegistry.has(call.name)) {
        inputProjection = await deps.toolRegistry.projectCall(call.id, call.name, call.arguments, { signal: admissionSignal, assertCurrent: assertTurnActive });
        call = { id: inputProjection.callId, name: inputProjection.name, arguments: inputProjection.args };
      }
      if (deps.runtimeBus) {
        emitToolReceived(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          args: call.arguments,
        });
      }

      // The gate's own pair of events: requested before any owner prompt, decided once it settles.
      const requestedCategory = gateCategory(deps.permissionManager, call.name, call.arguments, deps.toolRegistry);
      if (deps.runtimeBus) {
        emitGateRequested(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id, tool: call.name, args: call.arguments, category: requestedCategory,
        });
      }
      // Event observers and every awaited admission boundary can cancel the turn.
      assertTurnActive();
      let checkResult: import('../permissions/types.js').PermissionCheckResult;
      if (prepared && owner) {
        const consumedRevisions: string[] = [];
        let permittedRevisionIds: readonly string[] | undefined;
        while (true) {
          const currentPrepared = prepared;
          admission = await owner.admit(sourceId, currentPrepared.name, currentPrepared.args, { sourceOf: sourceOf!, decoratePort: deps.autonomousPort, signal: admissionSignal, hookOwner: deps.hookOwner, consumedRevisions, ...(permittedRevisionIds ? { permittedRevisionIds } : {}), ...(choiceProjection ? { choiceProjection } : {}), schemaRevision: currentPrepared.schemaRevision, preparationDecisionIds: currentPrepared.judgmentDecisionIds, preparedCall: { registry: deps.toolRegistry, call: currentPrepared }, assertPrepared: () => deps.toolRegistry.assertPrepared(currentPrepared) });
          assertTurnActive();
          permittedRevisionIds ??= admission.revisionIds;
          checkResult = admission.result;
          if (!admission.revision) break;
          const revision = admission.revision;
          if (consumedRevisions.includes(revision.ref.id)) throw new Error('Autonomous revision was already consumed');
          consumedRevisions.push(revision.ref.id);
          const preparation = owner.preparation(sourceId, sourceOf!, admissionSignal, deps.autonomousPort, choiceProjection);
          prepared = await deps.toolRegistry.prepareCall(call.id, revision.toolName, revision.args, { signal: admissionSignal, port: preparation.port, assertCurrent: () => { assertTurnActive(); preparation.assertCurrent(); } });
          preparation.assertCurrent();
          call = { id: prepared.callId, name: prepared.name, arguments: prepared.args };
        }
      } else {
        checkResult = await resolvePermissionCheck(deps.permissionManager, call.name, call.arguments, turnSignal, deps.hookOwner,
          typeof deps.toolRegistry.definitionOf === 'function' ? deps.toolRegistry.definitionOf(call.name) : undefined);
      }
      if (deps.runtimeBus) {
        emitGateDecision(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id, tool: call.name, category: checkResult.category ?? requestedCategory,
          approved: checkResult.approved, source: checkResult.sourceLayer, sourceLayer: checkResult.sourceLayer,
          persisted: checkResult.persisted, reasonCode: checkResult.reasonCode,
          classification: checkResult.analysis.classification, riskLevel: checkResult.analysis.riskLevel, summary: checkResult.analysis.summary,
        });
      }
      assertTurnActive();
      if (checkResult.decisionPolicy) resultPolicy = checkResult.decisionPolicy;
      const approved = checkResult.approved;
      if (deps.runtimeBus) {
        emitToolPermissioned(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          approved,
          ...(checkResult.autonomousDecision ? { autonomousDecision: checkResult.autonomousDecision } : {}),
        });
      }
      assertTurnActive();
      if (!approved) {
        // Structured, call-scoped denial: the asking agent gets reason + scope on
        // the failed result (not just a bare string) and can continue honestly.
        // Plan-mode refusals surface reason 'plan-mode' with plan-steering text.
        const denialSource = { reasonCode: checkResult.reasonCode, sourceLayer: checkResult.sourceLayer, userReason: checkResult.userReason, detail: checkResult.detail };
        const err = new PermissionError(buildDenialErrorMessage(call.name, denialSource));
        const deniedResult = {
          callId: call.id,
          success: false,
          error: err.message,
          decision: checkResult.decision ?? toolDecisionOf({ ...denialSource, approved: false }),
          denial: buildToolDenial(denialSource),
          ...(checkResult.autonomousDecision ? { autonomousDecision: checkResult.autonomousDecision } : {}),
        };
        appendResult(deniedResult);
        if (deps.runtimeBus) {
          emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
            callId: call.id,
            turnId,
            tool: call.name,
            error: redactDiagnosticText(err.message),
            durationMs: 0,
            result: redactedToolResultSummary(redactedErrorResult(deniedResult)),
          });
        }
        continue;
      }

      const startedAt = Date.now();
      if (deps.runtimeBus) {
        emitToolExecuting(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          startedAt,
        });
      }

      // No new call may acquire a fresh, un-aborted execution signal after a cancel.
      assertTurnActive();
      let result: ToolResult;
      const budget = deps.toolBudget?.();
      const executeStartedAt = performance.now();
      const perCallSignal = earlyCallSignal ?? deps.toolCallSignals?.open(call.id);
      const deadline = toolBudgetDeadline(budget);
      const callSignals = [turnSignal, perCallSignal, deadline].filter((signal): signal is AbortSignal => signal !== undefined);
      const callSignal = callSignals.length > 1 ? AbortSignal.any(callSignals) : callSignals[0];
      // The time limit, not the person or the turn, stopped this call.
      const stoppedByBudget = () => deadline?.aborted === true && turnSignal?.aborted !== true && perCallSignal?.aborted !== true;
      try {
        assertTurnActive();
        callSignal?.throwIfAborted();
        // Open a cost-attribution origin scope around the tool body: any LLM usage
        // a tool drives synchronously (e.g. an MCP tool's model call) is attributed
        // to this tool/MCP server rather than the agent's own reasoning.
        result = await withExternalOperationSource(sourceOf && autonomous ? {
          sourceOf, signal: callSignal, assertCurrent: () => { assertTurnActive(); callSignal?.throwIfAborted(); },
          inputFacts: [prepared?.args ?? call.arguments],
        } : undefined, () => withCostOriginAsync(
          { tool: call.name, callId: call.id, mcpServer: mcpServerOfToolName(call.name) },
          () => {
            const progress = deps.onProgress ? { onProgress: deps.onProgress } : {};
            const executeOptions = callerCurrent ? { signal: callSignal, assertCurrent: assertTurnActive, ...progress }
              : callSignal ? { signal: callSignal, ...progress } : deps.onProgress ? progress : undefined;
            if (!prepared || !admission) return deps.toolRegistry.execute(call.id, call.name,
              checkResult.modifiedArgs ?? call.arguments, executeOptions);
            // Older embedding managers own a callback-only admission contract.
            // Permit it only on authenticated non-adopted registrations; it
            // mints no strict-body proof. Any genuine brand (even stale) keeps
            // exact registry/call validation rather than downgrading to legacy.
            const preparedAdmission = isAuthenticAutonomousAdmission(admission)
              || deps.toolRegistry.readPreparedOwnedAdmissionEvidence(prepared) !== undefined
              ? admission : admission.claim;
            return deps.toolRegistry.executePrepared(prepared, preparedAdmission, executeOptions);
          },
        ));
        if (checkResult.autonomousDecision) result = { ...result, autonomousDecision: checkResult.autonomousDecision };
        if (stoppedByBudget()) {
          result = toolBudgetStoppedResult(call.id, call.name, budget!, result);
        } else if (callSignal?.aborted) {
          // The user cancelled THIS call mid-flight: the model sees a structured
          // cancelled result and the turn continues.
          result = toCancelledResult(call.id, result);
        } else if (budget && result.success) {
          result = applyToolBudget(budget, call.name, performance.now() - executeStartedAt, result);
        }
      } catch (err) {
        assertDecisionAvailable(err);
        const stopped = stoppedByBudget() ? toolBudgetStoppedResult(call.id, call.name, budget!, null) : undefined;
        const message = stopped ? stopped.error!
          : callSignal?.aborted
          ? TOOL_CALL_CANCELLED_MESSAGE
          : err instanceof ToolInputProjectionError
            ? describeToolInputProjectionProblem(err.problem, err.detail)
            : err instanceof ToolError
              ? err.message
              : err instanceof Error
                ? err.message
                : summarizeError(err);
        result = stopped ?? (callSignal?.aborted
          ? toCancelledResult(call.id, null)
          : {
            callId: call.id,
            success: false,
            error: message,
          });

        if (deps.hookDispatcher && !turnSignal?.aborted) {
          await fireObservingHook(deps.hookDispatcher, {
            path: `Fail:tool:${call.name}`,
            phase: 'Fail',
            category: 'tool',
            specific: call.name,
            sessionId: deps.sessionId,
            timestamp: Date.now(),
            payload: { callId: call.id, tool: call.name, error: message },
          });
        }
      } finally {
        if (!earlyCallSignal) deps.toolCallSignals?.close(call.id);
      }

      if (checkResult.autonomousDecision) result = { ...result, autonomousDecision: checkResult.autonomousDecision };
      // A plain allow by code or rule is not reported; one Jev or the owner made is.
      const decided = checkResult.decision;
      if (decided && (decided.state !== 'allowed' || decided.decidedBy === 'owner')) result = { ...result, decision: decided };
      // Do not race the tool promise: abort-ignoring work must actually return
      // before this throw allows the turn's terminal cancellation event.
      assertTurnActive();
      if (deps.hookDispatcher && result.success === true) {
        await fireObservingHook(deps.hookDispatcher, {
          path: `Post:tool:${call.name}`,
          phase: 'Post',
          category: 'tool',
          specific: call.name,
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { callId: call.id, tool: call.name, result },
        });
      }

      assertTurnActive();
      if (deps.runtimeBus) {
        if (result.success) {
          emitToolSucceeded(deps.runtimeBus, deps.emitterContext(turnId), {
            callId: call.id,
            turnId,
            tool: call.name,
            durationMs: Date.now() - startedAt,
            result: redactedToolResultSummary(result),
          });
        } else {
          emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
            callId: call.id,
            turnId,
            tool: call.name,
            error: redactDiagnosticText(result.error ?? 'unknown tool failure'),
            durationMs: Date.now() - startedAt,
            result: redactedToolResultSummary(result),
          });
        }
      }

      assertTurnActive();
      if (deps.hookDispatcher && (call.name === 'write' || call.name === 'edit')) {
        const filePath = typeof call.arguments['path'] === 'string' ? call.arguments['path'] :
          (Array.isArray(call.arguments['files']) ? JSON.stringify(call.arguments['files']) : '');
        const phase = result.success ? 'Post' : 'Fail';
        await fireObservingHook(deps.hookDispatcher, {
          path: `${phase}:file:${call.name}` as HookEventPath,
          phase,
          category: 'file',
          specific: call.name,
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { tool: call.name, path: filePath, callId: call.id, ...(result.success ? {} : { error: result.error }) },
        });
        // A cancellation during dispatch cannot admit another tool or continue
        // the turn, including when the hook rejected and was logged above.
        assertTurnActive();
      }

      result = capToolResultOutput(call.name, call.arguments, result);
      if (hookNote) result = withHookNote(result, hookNote);

      if (deps.onToolExecuted) {
        // Fire-and-forget: the scheduler only records a debounce timer; it must never block the
        // tool-result path. Args are the ones actually executed (post-permission modification).
        try {
          withExternalOperationSource(sourceOf && autonomous ? {
            sourceOf, signal: callSignal, assertCurrent: () => { assertTurnActive(); callSignal?.throwIfAborted(); },
            inputFacts: [prepared?.args ?? checkResult.modifiedArgs ?? call.arguments],
          } : undefined, () => deps.onToolExecuted!(call.name, checkResult.modifiedArgs ?? call.arguments, result.success === true));
        } catch (err) {
          logger.warn('onToolExecuted hook error', { tool: call.name, error: summarizeError(err) });
        }
      }

      assertTurnActive();
      appendResult(result);
    } catch (error) {
      if (earlyCallSignal?.aborted && !turnSignal?.aborted) {
        // Cancelled during admission, before the tool body ran: observers saw
        // the call received, so they must also see it end.
        appendResult(toCancelledResult(call.id, admission?.result.autonomousDecision
          ? { callId: call.id, success: false, autonomousDecision: admission.result.autonomousDecision } : null));
        if (deps.runtimeBus) emitToolCancelled(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id, turnId, tool: call.name, reason: TOOL_CALL_CANCELLED_MESSAGE,
        });
      } else throw error;
    } finally {
      if (earlyCallSignal) deps.toolCallSignals?.close(call.id);
      if (autonomous) deps.permissionManager.retireAutonomousSource?.(sourceId);
      const choicesToRelease = choiceProjection;
      const inputToRelease = inputProjection;
      const cleanup = await Promise.allSettled([
        ...(choicesToRelease ? [Promise.resolve().then(() => deps.permissionManager.releaseAutonomousChoices!(choicesToRelease))] : []),
        ...(inputToRelease ? [Promise.resolve().then(() => deps.toolRegistry.releaseProjected(inputToRelease))] : []),
      ]);
      if (cleanup.some(result => result.status === 'rejected')) throw new Error('Tool input projection cleanup failed');
      // Retention observes the same publication fences as the ordinary result.
      // Never leak a current call's output through recovery after revocation.
      assertTurnActive();
      if (settledResult) deps.onToolSettled?.(settledResult);
    }
  }

  assertTurnActive();
  return results;
}

export type ReconciliationDeps = {
  conversation: Pick<ConversationManager, 'addToolResults' | 'addNotice' | 'hostInstructions'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  isReconciliationEnabled: () => boolean;
  currentSubmissionKey: string | null;
  pendingToolCalls: ToolCall[];
  setPendingToolCalls: (calls: ToolCall[]) => void;
};

export function reconcileUnresolvedToolCalls(
  deps: ReconciliationDeps,
  resolvedResults: ToolResult[],
  reason: ReconciliationReason,
): void {
  const pending = deps.pendingToolCalls;
  if (pending.length === 0) return;

  const unresolved = detectUnresolvedToolCalls(pending, resolvedResults);
  if (unresolved.length === 0) {
    deps.setPendingToolCalls([]);
    return;
  }

  if (!deps.isReconciliationEnabled()) {
    logger.warn(
      'Orchestrator: unresolved tool calls detected but reconciliation is disabled. ' +
      'Enable the tool-result-reconciliation flag to suppress this.',
      { count: unresolved.length, callIds: unresolved.map((c) => c.id), reason },
    );
    deps.setPendingToolCalls([]);
    return;
  }

  const syntheticResults = unresolved.map((call) => buildSyntheticResult(call, reason));
  deps.conversation.addToolResults(syntheticResults);

  const turnId = deps.currentSubmissionKey ?? `reconciled:${Date.now()}`;

  for (const sr of syntheticResults) {
    if (deps.runtimeBus) {
      emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
        callId: sr.callId,
        turnId,
        tool: unresolved.find((call) => call.id === sr.callId)?.name ?? 'unknown',
        error: redactDiagnosticText(sr.error ?? 'synthetic tool reconciliation failure'),
        durationMs: 0,
        result: redactedToolResultSummary(sr),
      });
    }
  }

  const reconciliation = describeReconciledCalls(unresolved);
  deps.conversation.addNotice(reconciliation, { level: 'warning' });
  // Reconciliation can close a turn, so this rides the next request whichever turn makes it.
  deps.conversation.hostInstructions.set('replay', reconciliation, { once: true, append: true });

  if (deps.runtimeBus) {
    emitToolReconciled(deps.runtimeBus, deps.emitterContext(turnId), {
      turnId,
      count: unresolved.length,
      callIds: unresolved.map((c) => c.id),
      toolNames: unresolved.map((c) => c.name),
      reason,
      timestamp: Date.now(),
    });
  }

  logger.warn('Orchestrator: reconciled unresolved tool calls', {
    count: unresolved.length,
    callIds: unresolved.map((c) => c.id),
    reason,
  });

  deps.setPendingToolCalls([]);
}
