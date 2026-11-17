import type { PromptContextReceiptDraft } from '@goodvibes-jev/engine/terminal-shell/agent-turn/prompt-context-receipts';

/**
 * The Agent's feed into the process's one memory usage tracker
 * (`services.memoryUsageTracker`, which follows every turn's end on the bus):
 * the memory ids its prompt receipt says were injected. The counters
 * themselves are columns on the memory record, so every product reading the
 * store sees the same counts and consolidation's decay reads them from there.
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
