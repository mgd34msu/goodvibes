/**
 * Provider failover re-submits the whole user turn, so it runs only for a
 * provider failure in a turn where no tool has started. A structured status
 * on the failure decides the error class instead of its wording.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { installUserErrorReading } from '../helpers/user-error-reading.ts';
import { createStreamMetrics, wireStreamEventMetrics, type WireStreamEventMetricsOptions } from '../../core/stream-event-wiring.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

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

function fixture(optimizerEnabled: boolean) {
  const turns = bus(); const tools = bus(); const providers = bus();
  const messages: string[] = []; const retries: string[] = [];
  let model = 'first:one'; let restored = 0;
  const optimizer = {
    enabled: optimizerEnabled,
    testFallback: () => ({ chain: [
      { position: 0, providerId: 'first', modelId: 'one', capable: true },
      { position: 1, providerId: 'second', modelId: 'two', capable: true },
    ] }),
    recordFallbackTransition() {},
    fallbackLog: [],
  };
  const result = wireStreamEventMetrics({
    events: { turns, tools, providers } as unknown as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry: { getCurrentModel: () => ({ provider: model.split(':')[0]!, registryKey: model }), setCurrentModel: (key: string) => { model = key; } },
    systemMessageRouter: { high: (line: string) => { messages.push(line); }, low() {}, userReceipt: (line: string) => { messages.push(line); } },
    metrics: createStreamMetrics(), render: () => {},
    providerOptimizer: optimizer,
    getConfiguredRegistryKey: () => { restored++; return 'first:one'; },
    retryTurn: (notice?: string) => { retries.push(notice ?? ''); return true; },
  } as WireStreamEventMetricsOptions);
  turns.emit('TURN_SUBMITTED', { turnId: 'turn-a' });
  return { turns, tools, messages, retries, restored: () => restored, close: () => { for (const unsub of result.unsubs) unsub(); } };
}

describe('provider failover is limited to failures a re-submission can fix', () => {
  test('a provider error before any tool ran fails over', async () => {
    const f = fixture(true);
    try {
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
      await flush();
      expect(f.retries).toHaveLength(1);
    } finally { f.close(); }
  });

  test('a denied call is not asked again on another provider', async () => {
    const f = fixture(true);
    try {
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Blocked by a hook', stopReason: 'hook_denied' });
      await flush();
      expect(f.retries).toEqual([]);
      expect(f.messages.some((m) => m.startsWith('[Error]'))).toBe(true);
      expect(f.messages.some((m) => m.includes('[Failover]'))).toBe(false);
    } finally { f.close(); }
  });

  test('a provider error after a tool started is surfaced instead of repeating the tool', async () => {
    const f = fixture(true);
    try {
      f.tools.emit('TOOL_EXECUTING', { callId: 'c1', tool: 'write_file', startedAt: 1 });
      f.tools.emit('TOOL_SUCCEEDED', { callId: 'c1' });
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Provider returned HTTP 500', stopReason: 'provider_error' });
      await flush();
      expect(f.retries).toEqual([]);
      expect(f.messages.some((m) => m.startsWith('[Error]'))).toBe(true);
    } finally { f.close(); }
  });

  test('the next user turn starts with no tool recorded', async () => {
    const f = fixture(true);
    try {
      f.tools.emit('TOOL_EXECUTING', { callId: 'c1', tool: 'write_file', startedAt: 1 });
      f.turns.emit('TURN_SUBMITTED', { turnId: 'turn-b' });
      f.turns.emit('TURN_ERROR', { turnId: 'turn-b', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
      await flush();
      expect(f.retries).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe('the failure class comes from the structured status when the event carries one', () => {
  // The wording reader finds nothing here, so only the status can say what this is.
  let restoreReading: () => void;
  beforeEach(() => { restoreReading = installUserErrorReading('generic'); });
  afterEach(() => { restoreReading(); });

  test('401 reads as an authentication failure even though the text names no cause', async () => {
    const f = fixture(false);
    try {
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Request failed', status: 401, stopReason: 'provider_error' });
      await flush();
      expect(f.messages[0]).toContain('Authentication failed');
    } finally { f.close(); }
  });

  test('the same text without a status stays a generic provider error', async () => {
    const f = fixture(false);
    try {
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Request failed', stopReason: 'provider_error' });
      await flush();
      expect(f.messages[0]).not.toContain('Authentication failed');
    } finally { f.close(); }
  });
});
