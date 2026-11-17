import { MemoryUsageTracker, type MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import type { PromptContextReceiptDraft } from '@goodvibes-jev/engine/terminal-shell/agent-turn/prompt-context-receipts';

/**
 * The Agent's feed into the shared memory usage tracker: the ids its prompt
 * receipt says were injected, and its turn events. The counters themselves are
 * columns on the memory record, so every product reading the store sees the
 * same counts and consolidation's decay reads them from there.
 */
export function extractInjectedMemoryIds(receipt: PromptContextReceiptDraft): string[] {
  const segment = receipt.segments.find((entry) => entry.id === 'memory');
  const selected = segment?.selected ?? [];
  const ids: string[] = [];
  for (const entry of selected) {
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) ids.push(id);
  }
  return ids;
}

export interface AgentMemoryUsage {
  /** At prompt composition: remember the injected ids for the turn (no write). */
  onComposed(turnId: string | null, receipt: PromptContextReceiptDraft): void;
  /** At turn completion: one usage reading for the turn, one counter update. */
  onTurnCompleted(turnId: string, response: string): Promise<void>;
  /** At turn error or cancel: count the injections, unassessed. */
  onTurnAborted(turnId: string): void;
}

export function createMemoryUsageTracker(memoryRegistry: MemoryRegistry): AgentMemoryUsage {
  const tracker = new MemoryUsageTracker(memoryRegistry);
  return {
    onComposed: (turnId, receipt) => tracker.onComposed(turnId, extractInjectedMemoryIds(receipt)),
    onTurnCompleted: (turnId, response) => tracker.onTurnCompleted(turnId, response),
    onTurnAborted: (turnId) => tracker.onTurnAborted(turnId),
  };
}
