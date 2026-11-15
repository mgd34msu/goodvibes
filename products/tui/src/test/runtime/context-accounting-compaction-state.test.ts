/**
 * What `context_accounting` says about compaction: on from the moment a run is
 * under way, off when it ends in any way, and only for this session's runs.
 */
import { describe, expect, test } from 'bun:test';
import { createContextAccountingSource } from '../../runtime/context-accounting-source.ts';

type Handler = (envelope?: { payload?: Record<string, unknown> }) => void;

function build() {
  const handlers = new Map<string, Handler[]>();
  const bus = { on: (type: string, callback: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), callback]); return () => {}; } };
  const emit = (type: string, payload?: Record<string, unknown>) => { for (const cb of handlers.get(type) ?? []) cb(payload ? { payload } : undefined); };
  const handle = createContextAccountingSource({
    orchestrator: { getTurnInjections: () => [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lastInputTokens: 0 },
    providerRegistry: { getCurrentModel: () => ({}) as never, getKnownContextWindowForModel: () => 1000 },
    sessionLineageTracker: { getCompactionCount: () => 0 },
    runtimeBus: bus as never,
    sessionId: 'main',
    currentSessionId: () => 'main-resumed',
  });
  const state = (): boolean => handle.source.getCompactionState().isCompacting;
  return { emit, state };
}

describe('compaction state in context_accounting', () => {
  test('every check starts it, including a run forced under the threshold, until the run ends', () => {
    const { emit, state } = build();
    emit('COMPACTION_CHECK', { sessionId: 'main', tokenCount: 50, threshold: 100 });
    expect(state()).toBe(true);
    emit('COMPACTION_DONE', { sessionId: 'main' });
    expect(state()).toBe(false);
    emit('COMPACTION_CHECK', { sessionId: 'main', tokenCount: 120, threshold: 100 });
    expect(state()).toBe(true);
  });

  test("another session's check does not start this session's", () => {
    const { emit, state } = build();
    emit('COMPACTION_CHECK', { sessionId: 'background-agent', tokenCount: 500, threshold: 100 });
    expect(state()).toBe(false);
  });

  test("another session's compaction ending does not end this session's", () => {
    const { emit, state } = build();
    emit('COMPACTION_AUTOCOMPACT', { sessionId: 'main' });
    emit('COMPACTION_DONE', { sessionId: 'background-agent' });
    expect(state()).toBe(true);
    emit('COMPACTION_DONE', { sessionId: 'main' });
    expect(state()).toBe(false);
  });

  test("another session's compaction starting does not start this session's, and a resumed session's events count", () => {
    const { emit, state } = build();
    emit('COMPACTION_COLLAPSE', { sessionId: 'background-agent' });
    expect(state()).toBe(false);
    emit('COMPACTION_COLLAPSE', { sessionId: 'main-resumed' });
    expect(state()).toBe(true);
    emit('COMPACTION_FAILED', { sessionId: 'main-resumed' });
    expect(state()).toBe(false);
  });
});
