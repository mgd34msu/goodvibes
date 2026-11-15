/**
 * The one session-backed source for `context_accounting`: what a live
 * Orchestrator already tracks, read when the tool runs. The terminal apps and
 * the daemon's hosted sessions bind it the same way, so every session that can
 * call the tool answers with its own context.
 */
import type { TurnInjectionRecord } from '../../agents/turn-knowledge-injection.js';
import { isConversationUsageAvailable } from '../../core/conversation-usage.js';
import type { CompactionEvent } from '../../../events/compaction.js';
import type { ContextAccountingSource } from './index.js';

/** The Orchestrator surface the source reads. */
export interface ContextAccountingOrchestrator {
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly lastInputTokens: number;
  getTurnInjections(): readonly TurnInjectionRecord[];
}

/** The compaction events the source follows; their payload carries the session id. */
type CompactionType = CompactionEvent['type'];
/** A bus to follow compaction on: subscribe by event type, get an unsubscribe back. */
export interface CompactionActivityBus {
  on(eventType: CompactionType, callback: (envelope: { readonly payload?: unknown }) => void): () => void;
}

export interface SessionContextAccountingOptions {
  readonly orchestrator: ContextAccountingOrchestrator;
  /** The session in use, read on every call, so a resume or fork is followed. */
  readonly getSessionId: () => string;
  /** The active model's context window, or null when unknown. */
  readonly getContextWindow: () => number | null;
  /**
   * Compaction runs of this session start and end on this bus. Without one,
   * `isCompacting` reads false and applied compactions are not counted.
   */
  readonly runtimeBus?: CompactionActivityBus | null | undefined;
  /** The session's compaction count from its owner, when the host keeps one; otherwise applied receipts on the bus are counted. */
  readonly getCompactionCount?: (() => number) | undefined;
  /** Whose context this is, as the model is told. Defaults to 'main session'. */
  readonly scope?: string | undefined;
}

/** Events that mark a compaction run under way: the check opens every run, the strategy events follow it. */
const COMPACTION_ACTIVE: readonly CompactionType[] = ['COMPACTION_CHECK', 'COMPACTION_AUTOCOMPACT', 'COMPACTION_REACTIVE', 'COMPACTION_MICROCOMPACT', 'COMPACTION_COLLAPSE'];
/** Events that end a run, applied, rejected or failed. */
const COMPACTION_END: readonly CompactionType[] = ['COMPACTION_DONE', 'COMPACTION_FAILED', 'COMPACTION_RECEIPT'];

function payloadField(envelope: { readonly payload?: unknown }, field: string): unknown {
  const payload = envelope.payload;
  return typeof payload === 'object' && payload !== null && field in payload ? (payload as Record<string, unknown>)[field] : undefined;
}

export interface SessionContextAccountingHandle {
  readonly source: ContextAccountingSource;
  /** Removes the bus subscriptions. */
  readonly dispose: () => void;
}

/**
 * Builds the source. A compaction event of another session (a background agent
 * on the same bus) never changes this session's state; an event with no
 * session id is taken as this session's.
 */
export function createSessionContextAccountingSource(options: SessionContextAccountingOptions): SessionContextAccountingHandle {
  const { orchestrator } = options;
  let isCompacting = false;
  const appliedCompactions = new Map<string, number>();
  const unsubscribes: Array<() => void> = [];
  const ours = (envelope: { readonly payload?: unknown }): boolean => {
    const sessionId = payloadField(envelope, 'sessionId');
    return typeof sessionId !== 'string' || sessionId === options.getSessionId();
  };
  if (options.runtimeBus) {
    const bus = options.runtimeBus;
    for (const type of COMPACTION_ACTIVE) unsubscribes.push(bus.on(type, (envelope) => { if (ours(envelope)) isCompacting = true; }));
    for (const type of COMPACTION_END) unsubscribes.push(bus.on(type, (envelope) => {
      if (!ours(envelope)) return;
      isCompacting = false;
      if (type === 'COMPACTION_RECEIPT' && payloadField(envelope, 'outcome') === 'applied') {
        const id = options.getSessionId();
        appliedCompactions.set(id, (appliedCompactions.get(id) ?? 0) + 1);
      }
    }));
  }
  const source: ContextAccountingSource = {
    scope: options.scope ?? 'main session',
    get sessionId() { return options.getSessionId(); },
    getTurnInjections: () => orchestrator.getTurnInjections(),
    getTokenState: () => {
      if (!isConversationUsageAvailable(orchestrator.usage)) throw new TypeError('Session usage unavailable: saved token usage is invalid.');
      const { input, output, cacheRead, cacheWrite } = orchestrator.usage;
      return { measured: { input, output, cacheRead, cacheWrite }, lastInputTokens: orchestrator.lastInputTokens, contextWindow: options.getContextWindow() };
    },
    getCompactionState: () => ({
      isCompacting,
      compactionCount: options.getCompactionCount?.() ?? appliedCompactions.get(options.getSessionId()) ?? 0,
    }),
  };
  return { source, dispose: () => { for (const unsubscribe of unsubscribes.splice(0)) unsubscribe(); } };
}

/**
 * Binds the session's source onto the tool's holder and returns the unbind:
 * the bus subscriptions are removed and the holder goes back to unbound, but
 * only if this source is still the one bound.
 */
export function bindSessionContextAccounting(
  holder: { setSource(source: ContextAccountingSource | null): void; getSource(): ContextAccountingSource | null },
  options: SessionContextAccountingOptions,
): () => void {
  const handle = createSessionContextAccountingSource(options);
  holder.setSource(handle.source);
  return () => {
    handle.dispose();
    if (holder.getSource() === handle.source) holder.setSource(null);
  };
}
