/**
 * The context_accounting source for one worker agent: the answer the tool gives
 * when a worker asks about its own run. It reads the worker's real record and
 * the last response's measured token counts; nothing is estimated here, and
 * turns used are reported against the limit the run actually applies.
 */
import type { ContextAccountingSource } from '../tools/context-accounting/index.js';
import type { AgentRecord } from '../tools/agent/manager.js';

export interface WorkerContextAccountingInput {
  readonly record: AgentRecord;
  /** The model's context window, or null when it is not known. */
  readonly contextWindow: number | null;
  /** The applied turn ceiling, or null when the run has none. */
  readonly turnLimit: number | null;
  /** Tokens the last request put in the context window, including cached ones; 0 before the first response. */
  readonly lastInputTokens: number;
  /** The worker's running children, when the host can list them. */
  readonly activeChildren?: (() => number) | undefined;
}

export function createWorkerContextAccountingSource(input: WorkerContextAccountingInput): ContextAccountingSource {
  const { record } = input;
  return {
    scope: `worker agent ${record.id}`,
    sessionId: record.id,
    getTurnInjections: () => record.turnInjections ?? [],
    getTokenState: () => ({
      measured: {
        input: record.usage?.inputTokens ?? 0,
        output: record.usage?.outputTokens ?? 0,
        cacheRead: record.usage?.cacheReadTokens ?? 0,
        cacheWrite: record.usage?.cacheWriteTokens ?? 0,
      },
      lastInputTokens: input.lastInputTokens,
      contextWindow: input.contextWindow,
    }),
    // A worker's compaction runs between its turns, never while one of its tool calls does.
    getCompactionState: () => ({ isCompacting: false }),
    getTurnState: () => ({ used: record.usage?.turnCount ?? 0, limit: input.turnLimit }),
    getRunState: () => ({
      mode: record.template,
      toolCalls: record.toolCallCount,
      ...(input.activeChildren === undefined ? {} : { activeChildren: input.activeChildren() }),
    }),
  };
}
