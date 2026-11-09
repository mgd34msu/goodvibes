import { isConversationUsageAvailable, type Orchestrator } from '@goodvibes-jev/engine/platform/platform/core';
import type { ContextAccountingSource } from '@goodvibes-jev/engine/platform/platform/tools';
/** Read real counters at use time; products bind the compaction owner and active context window. */
export function createLiveContextAccountingSource(options: {
  readonly orchestrator: Pick<Orchestrator, 'usage' | 'lastInputTokens' | 'getTurnInjections'>;
  readonly sessionId: string;
  readonly scope?: string | undefined;
  readonly getContextWindow: () => number | null;
  readonly getCompactionState: ContextAccountingSource['getCompactionState'];
  readonly copyAllUsage: boolean;
}): ContextAccountingSource {
  const { orchestrator } = options;
  return {
    scope: options.scope ?? 'main session',
    sessionId: options.sessionId,
    getTurnInjections: () => orchestrator.getTurnInjections(),
    getTokenState: () => {
      if (!isConversationUsageAvailable(orchestrator.usage))
        throw new TypeError('Session usage unavailable: saved token usage is invalid.');
      return {
        measured: options.copyAllUsage
          ? { ...orchestrator.usage }
          : {
              input: orchestrator.usage.input,
              output: orchestrator.usage.output,
              cacheRead: orchestrator.usage.cacheRead,
              cacheWrite: orchestrator.usage.cacheWrite,
            },
        lastInputTokens: orchestrator.lastInputTokens,
        contextWindow: options.getContextWindow(),
      };
    },
    getCompactionState: options.getCompactionState,
  };
}
