/**
 * A failed turn's error line comes from what the error already says (its
 * status and errno), at once, and failover starts at once. A reading of the
 * wording may only add one line afterwards, and only to an error that was shown.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { wireStreamEventMetrics, createStreamMetrics, type WireStreamEventMetricsOptions } from '../../core/stream-event-wiring.ts';
import type { FailoverRetry } from '../../core/user-turn.ts';
import { installUserErrorReading } from '../helpers/user-error-reading.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

/** A decision model that never answers and counts what it was asked. */
function silentModel() {
  let asked = 0;
  installJudgmentPort({ ...fakePort(() => { throw new Error('unexpected question'); }).port, ask: () => { asked++; return new Promise<never>(() => {}); } });
  return { asked: () => asked };
}

function bus() {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  return {
    on(type: string, callback: (event: Record<string, unknown>) => void) {
      const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set);
      return () => { set.delete(callback); };
    },
    emit(type: string, payload: Record<string, unknown> = {}) {
      for (const callback of [...listeners.get(type) ?? []]) callback({ type, ...payload });
    },
  };
}

const optimizer = { enabled: true, testFallback: () => ({ chain: [{ position: 0, capable: true, providerId: 'second', modelId: 'two' }] }), recordFallbackTransition() {}, fallbackLog: [] };

function fixture(overrides: Partial<WireStreamEventMetricsOptions> = {}) {
  const turns = bus(); const tools = bus(); const providers = bus(); const messages: string[] = []; const retries: FailoverRetry[] = [];
  let session = 'session-a'; let model = 'first:one'; let surfaced = 0;
  const result = wireStreamEventMetrics({
    events: { turns, tools, providers } as unknown as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry: { getCurrentModel: () => ({ provider: model.split(':')[0]!, registryKey: model }), setCurrentModel: key => { model = key; } },
    systemMessageRouter: { high: line => { messages.push(line); }, low() {}, userReceipt: line => { messages.push(line); } },
    metrics: createStreamMetrics(), render: () => {},
    getSessionId: () => session,
    retryTurn: (notice, retry) => { messages.push(notice); retries.push(retry); return true; },
    ...overrides,
  });
  result.onErrorSurfaced(() => { surfaced++; });
  turns.emit('TURN_SUBMITTED', { turnId: 'turn-a' });
  return { turns, messages, retries, result, session: (id: string) => { session = id; }, model: () => model,
    surfaced: () => surfaced, close: () => { for (const unsub of result.unsubs) unsub(); } };
}

test('a 401 prints its line at once while the decision model never answers', () => {
  silentModel(); const f = fixture();
  try {
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Request failed', status: 401, stopReason: 'provider_error' });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain('Authentication failed');
    expect(f.messages[0]).toContain('/login');
    expect(f.surfaced()).toBe(1);
  } finally { f.close(); }
});

test('failover starts at once with the structural class in its notice', () => {
  silentModel(); const f = fixture({ providerOptimizer: optimizer });
  try {
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Request failed', status: 429, stopReason: 'provider_error' });
    expect(f.retries).toHaveLength(1);
    expect(f.model()).toBe('second:two');
    expect(f.messages[0]).toContain('[Failover] first -> second (Rate limit reached');
    expect(f.surfaced()).toBe(0);
  } finally { f.close(); }
});

test('typed status and errno decide the line with no decision request', async () => {
  const model = silentModel(); const f = fixture();
  try {
    for (const [facts, expected] of [
      [{ status: 429 }, 'Rate limit reached'],
      [{ code: 'ECONNREFUSED' }, 'Network error'],
    ] as const) {
      f.turns.emit('TURN_SUBMITTED', { turnId: `turn-${expected}` });
      f.turns.emit('TURN_ERROR', { turnId: `turn-${expected}`, error: 'mentions 401 in passing', stopReason: 'provider_error', ...facts });
      expect(f.messages.at(-1)).toContain(expected);
    }
    await flush();
    expect(model.asked()).toBe(0);
  } finally { f.close(); }
});

test('a reading that says more adds one line after the structural one', async () => {
  const restore = installUserErrorReading('context-overflow'); const f = fixture();
  try {
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'prompt is too long for this model', stopReason: 'provider_error' });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain('Provider error');
    await flush();
    expect(f.messages).toHaveLength(2);
    expect(f.messages[1]).toContain('Context window exceeded');
  } finally { f.close(); restore(); }
});

for (const boundary of ['new-turn', 'new-session', 'dispose'] as const) {
  test(`a late reading adds nothing after ${boundary}`, async () => {
    const restore = installUserErrorReading('context-overflow'); const f = fixture();
    try {
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'prompt is too long for this model', stopReason: 'provider_error' });
      if (boundary === 'new-turn') { f.result.startNewTurn(); f.turns.emit('TURN_SUBMITTED', { turnId: 'turn-b' }); }
      if (boundary === 'new-session') f.session('session-b');
      if (boundary === 'dispose') f.close();
      await flush();
      expect(f.messages).toHaveLength(1);
    } finally { f.close(); restore(); }
  });
}

for (const boundary of ['cancel', 'new-turn', 'new-session', 'close'] as const) {
  test(`a failover retry loses its authority on ${boundary}`, () => {
    const f = fixture({ providerOptimizer: optimizer });
    try {
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'failed', status: 503, stopReason: 'provider_error' });
      const retry = f.retries[0]!;
      expect(retry.isCurrent()).toBe(true);
      if (boundary === 'cancel') expect(f.result.cancelPendingRecovery()).toBe(true);
      if (boundary === 'new-turn') { f.result.startNewTurn(); f.turns.emit('TURN_SUBMITTED', { turnId: 'turn-b' }); }
      if (boundary === 'new-session') f.session('session-b');
      if (boundary === 'close') f.close();
      expect(retry.isCurrent()).toBe(false);
    } finally { f.close(); }
  });
}

test('a late duplicate error of an ended turn is not shown again', () => {
  const f = fixture();
  try {
    f.turns.emit('TURN_COMPLETED', { turnId: 'turn-a', stopReason: 'completed' });
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'late', stopReason: 'provider_error' });
    expect(f.messages).toEqual([]);
  } finally { f.close(); }
});
