import type { Tool, ToolCall, ToolResult } from '../../../types/tools.js';
import type { ToolRuntimeContext } from '../context.js';
import type { ExecutorConfig, PhaseResult, ToolExecutionRecord } from '../types.js';
import { summarizeError } from '../../../utils/error-display.js';
import { repairToolCall } from '../../../tools/auto-repair.js';

/**
 * Run auto-repair once per call and keep the outcome on the record. Permission
 * needs the repaired arguments (a renamed key can change what is being approved),
 * so the permission phase calls this first and execute reuses the result.
 * Repaired arguments replace `_updatedArgs`; a JudgmentError from the repair's
 * reading propagates.
 */
export async function repairRecordArguments(
  call: ToolCall,
  tool: Tool,
  record: ToolExecutionRecord,
): Promise<Record<string, unknown>> {
  const requestedArgs = record._updatedArgs ?? call.arguments;
  if (record._repair) return requestedArgs;
  const repair = await repairToolCall(call.name, requestedArgs, tool.definition);
  record._repair = repair;
  if (!repair.repaired) return requestedArgs;
  record._updatedArgs = repair.fixed;
  return repair.fixed;
}

/**
 * execute, Phase 4 of the tool execution pipeline.
 *
 * Calls `tool.execute(args)` and injects the callId into the result.
 * Respects the phase timeout and the effective budget.maxMs the executor passes in.
 * Caught errors produce a failed PhaseResult (not thrown) so the
 * executor can record the failure trace cleanly.
 *
 * The resolved args honour any prehook-modified input stored as
 * `_updatedArgs` on the record, then pass through auto-repair
 * (tools/auto-repair.ts, normally already done by the permission phase); the
 * repair is kept on the record as `_repair` so map-output can say what was
 * fixed. A JudgmentError from the repair's reading propagates rather than
 * becoming a failed phase.
 */
export async function executePhase(
  call: ToolCall,
  tool: Tool,
  context: ToolRuntimeContext,
  record: ToolExecutionRecord,
  config?: ExecutorConfig,
  budgetMaxMs?: number | undefined,
): Promise<PhaseResult & { toolResult?: ToolResult }> {
  const start = performance.now();

  const effectiveArgs = await repairRecordArguments(call, tool, record);
  // The budget clock starts when the tool does, not while hooks or a person
  // were still deciding whether it may run.
  record.executeStartedAt = performance.now();

  const budgets = [config?.phaseTimeouts?.['executing'], budgetMaxMs].filter((value): value is number => typeof value === 'number' && value > 0);
  const timeoutMs = budgets.length ? Math.min(...budgets) : 0;
  const deadline = new AbortController();
  const signal = AbortSignal.any([context.cancellation.signal, deadline.signal]);
  let onAbort: (() => void) | undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    signal.throwIfAborted();
    // Race between the tool and a timeout; clear the timer regardless of outcome
    const rawResult = await Promise.race([
      tool.execute(effectiveArgs, { signal }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error(`Tool '${call.name}' cancelled`));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        if (timeoutMs > 0) {
          timer = setTimeout(() => deadline.abort(new Error(`Tool '${call.name}' timed out after ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);

    signal.throwIfAborted();
    const toolResult: ToolResult = { ...rawResult, callId: call.id };

    return {
      phase: 'executing',
      success: true,
      durationMs: performance.now() - start,
      toolResult,
    };
  } catch (err) {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    const message = summarizeError(err);
    return {
      phase: 'executing',
      success: false,
      durationMs: performance.now() - start,
      error: message,
      abort: true,
    };
  }
}
