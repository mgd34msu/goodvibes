import type { CommandContext } from './command-registry.ts';
import { readLiveAgentCounterStamp, readLiveAgentMemoryCounters, readLiveAgentRoutineCounters } from './agent-workspace-snapshot.ts';
import type { AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';

export interface SyncAgentWorkspaceLiveCountersOptions {
  readonly context: CommandContext | null;
  readonly runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  readonly setRuntimeSnapshot: (snapshot: AgentWorkspaceRuntimeSnapshot) => void;
  readonly clampSelection: () => void;
}

/** The store stamp each snapshot's live counters were last read at. */
const syncedAt = new WeakMap<AgentWorkspaceRuntimeSnapshot, string>();

/**
 * Quiet, render-path refresh of the memory count and the routine counts
 * (incl. each routine's live start count). Called once per repaint, before
 * rendering, so a change made elsewhere (the model saving a memory, another
 * shell deleting one, a CLI `routines start`) shows on the next paint instead
 * of after the next workspace action.
 *
 * A paint first compares the stores' change stamp (two stat calls) with the
 * stamp the snapshot was read at; only a changed store is read again, so the
 * memory scan and each routine's requirement probes run when a store changes,
 * not per paint. A snapshot replaced by a full rebuild has no stamp yet and is
 * read once.
 *
 * Unlike AgentWorkspace.refreshRuntimeSnapshot(), this never touches status
 * or lastActionResult; it must be safe on every passive repaint.
 *
 * On a read failure the previous counters are kept (never overwritten with a
 * fabricated 0) and runtimeSnapshot.liveCountersStale is set so the render
 * path can label them honestly as refreshing rather than asserting a number
 * the disk might already contradict.
 */
export function syncAgentWorkspaceLiveCounters(options: SyncAgentWorkspaceLiveCountersOptions): void {
  const { context, runtimeSnapshot, setRuntimeSnapshot, clampSelection } = options;
  if (!context || !runtimeSnapshot) return;
  try {
    const stamp = readLiveAgentCounterStamp(context);
    if (stamp !== null && syncedAt.get(runtimeSnapshot) === stamp && runtimeSnapshot.liveCountersStale !== true) return;
    const memory = readLiveAgentMemoryCounters(context);
    const routines = readLiveAgentRoutineCounters(context);
    const next: AgentWorkspaceRuntimeSnapshot = {
      ...runtimeSnapshot,
      localMemoryCount: memory.count,
      localMemoryReviewQueueCount: memory.reviewQueueCount,
      localMemoryPromptActiveCount: memory.promptActiveCount,
      localMemories: memory.items,
      localRoutineCount: routines.count,
      enabledRoutineCount: routines.enabled,
      localRoutines: routines.items,
      liveCountersStale: false,
    };
    if (stamp !== null) syncedAt.set(next, stamp);
    setRuntimeSnapshot(next);
  } catch {
    setRuntimeSnapshot({ ...runtimeSnapshot, liveCountersStale: true });
  }
  clampSelection();
}
