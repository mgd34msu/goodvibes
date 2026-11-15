import { createLiveContextAccountingSource } from '@goodvibes-jev/engine/terminal-shell/context-accounting-source';
import '../core/conversation-usage.ts';
/**
 * context-accounting-source.ts
 *
 * Binds the platform's `context_accounting` tool (platform 1.6.1,
 * platform/tools/context-accounting) to THIS fork's own interactive
 * Orchestrator so the tool reports real, live session data instead of the
 * unbound-holder honesty message ("no live session context bound"). GoodVibes
 * Agent is an interactive consumer with exactly one Orchestrator driving the
 * main conversation, see bootstrap.ts, where `bindOrchestratorContextAccounting`
 * is called once, right after the Orchestrator is constructed and
 * `setCoreServices` has run.
 *
 * The three ContextAccountingSource facets map onto data this fork already
 * tracks, nothing new is measured:
 *   - Token state: Orchestrator.usage (input/output/cacheRead/cacheWrite,
 *     public fields) + Orchestrator.lastInputTokens, plus the active model's
 *     context window from providerRegistry.getContextWindowForModel, the
 *     exact call bootstrap.ts already makes for the system prompt.
 *   - Turn injections: Orchestrator.getTurnInjections() (public accessor).
 *   - Compaction state: Orchestrator does not expose `isCompacting` publicly
 *     (private field), so this reads runtimeStore.getState().session.compactionState
 *     instead, the SAME state the platform's own updateSessionState reducer
 *     already derives from the 'compaction' domain's runtime-bus events (see
 *     agent-runtime-events.ts's `runtimeBus.onDomain('compaction', ...)`
 *     subscription, wired before this bind call runs). compactionCount is a
 *     local counter incremented on each applied COMPACTION_RECEIPT for THIS
 *     session, the platform does not track a running count itself.
 */
import type { ContextAccountingHolder, ContextAccountingSource } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Orchestrator } from '@goodvibes-jev/engine/platform/platform/core';
import type { CompactionEvent, RuntimeEventBus } from '@/runtime/index.ts';
import type { RuntimeStore } from './store/index.ts';

/** compactionState values that mean "a compaction pass is currently running", every non-idle, non-terminal state. */
const COMPACTING_STATES: ReadonlySet<string> = new Set([
  'checking_threshold',
  'microcompact',
  'collapse',
  'autocompact',
  'reactive_compact',
  'boundary_commit',
]);

export interface BindOrchestratorContextAccountingOptions {
  /** The interactive session's Orchestrator. Only the public surface this source reads is required. */
  readonly orchestrator: Pick<Orchestrator, 'usage' | 'lastInputTokens' | 'getTurnInjections'>;
  readonly holder: ContextAccountingHolder;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  /** The session in use, read when the tool runs, so a resume or fork is followed. */
  readonly getSessionId: () => string;
  /** Resolves the active model's context window; omitted/null when unknown (matches providerRegistry.getContextWindowForModel). */
  readonly getContextWindow: () => number | null;
  /** Human-readable scope label so the tool's caller knows whose context this is. Defaults to 'main session'. */
  readonly scope?: string;
}

/**
 * Binds an Orchestrator-backed ContextAccountingSource onto `holder` and
 * returns an unbind function (removes the compaction-receipt subscription and
 * clears the holder back to unbound). Safe to call once per Orchestrator
 * lifetime; bootstrap.ts pushes the returned function into `runtimeUnsubs` so
 * shutdown leaves no dangling bus subscription.
 */
export function bindOrchestratorContextAccounting(options: BindOrchestratorContextAccountingOptions): () => void {
  const { orchestrator, holder, runtimeBus, runtimeStore, getSessionId, getContextWindow } = options;
  const scope = options.scope ?? 'main session';

  // Local running count of applied compactions, per session id, the platform
  // emits the mandatory COMPACTION_RECEIPT after every compaction path
  // (agent-runtime-events.ts routes the same event into the visible system
  // message; this tracks only the count, filtered to the session in use so a
  // background agent's own compaction does not inflate the main session's
  // number, and a resume reports the resumed session's count).
  const compactionCounts = new Map<string, number>();
  const unsubReceipt = runtimeBus.on<Extract<CompactionEvent, { type: 'COMPACTION_RECEIPT' }>>('COMPACTION_RECEIPT', ({ payload }) => {
    if (payload.outcome !== 'applied' || payload.sessionId !== getSessionId()) return;
    compactionCounts.set(payload.sessionId, (compactionCounts.get(payload.sessionId) ?? 0) + 1);
  });

  const live: ContextAccountingSource = createLiveContextAccountingSource({
    orchestrator: orchestrator,
    sessionId: getSessionId(),
    scope: scope,
    copyAllUsage: false,
    getContextWindow: getContextWindow,
    getCompactionState: () => {
      const compactionState = runtimeStore.getState().session.compactionState;
      return {
        isCompacting: COMPACTING_STATES.has(compactionState),
        compactionCount: compactionCounts.get(getSessionId()) ?? 0,
      };
    },
  });
  const source: ContextAccountingSource = {
    scope: live.scope,
    get sessionId() { return getSessionId(); },
    getTurnInjections: () => live.getTurnInjections(),
    getTokenState: () => live.getTokenState(),
    getCompactionState: () => live.getCompactionState(),
  };

  holder.setSource(source);

  return () => {
    unsubReceipt();
    holder.setSource(null);
  };
}
