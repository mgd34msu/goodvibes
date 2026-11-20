/**
 * The Agent's feed into the process's one memory usage tracker
 * (`services.memoryUsageTracker`, which follows every turn's end on the bus):
 * the memory ids its prompt receipt says were injected, read by the same
 * function a daemon-hosted Agent turn uses. The counters themselves are
 * columns on the memory record, so every product reading the store sees the
 * same counts and consolidation's decay reads them from there.
 */
export { injectedMemoryIds as extractInjectedMemoryIds } from '@goodvibes/engine/terminal-shell/agent-turn/prompt-context-receipts';
