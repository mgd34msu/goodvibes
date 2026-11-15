/**
 * The failover billing line: which billing class the switch left and joined,
 * read from the providers' declared setup after the switch, on its own line.
 * Failover never waits for it; facts that are missing, replaced or invalidated
 * while they were read say Unknown or nothing, never a guessed class.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { wireStreamEventMetrics, createStreamMetrics, type WireStreamEventMetricsOptions } from '../../core/stream-event-wiring.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const flush = () => new Promise<void>(r => setTimeout(r, 0));
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
function bus() {
  const callbacks = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  return {
    on(type: string, callback: (event: Record<string, unknown>) => void) { const set = callbacks.get(type) ?? new Set(); set.add(callback); callbacks.set(type, set); return () => { set.delete(callback); }; },
    emit(type: string, value: Record<string, unknown> = {}) { for (const callback of [...callbacks.get(type) ?? []]) callback({ type, ...value }); },
  };
}
function installSetupReader(wait?: Promise<void>) {
  const fake = fakePort((name, _q, state) => noulAnswer((name === 'api_key' && String(state).includes('Direct provider API key')) || (name === 'subscription' && String(state).includes('Stored subscription session')) ? 0.99 : 0.01));
  installJudgmentPort({ ...fake.port, async ask(request) { await wait; return fake.port.ask(request); } });
  return fake;
}
function fixture(options: { noIdentity?: boolean } = {}) {
  const turns = bus(), tools = bus(), providers = bus(); const messages: string[] = [], retries: string[] = [];
  const instances = { first: {}, second: {} };
  let model = 'first:one', session = 'session-a';
  const wiring = wireStreamEventMetrics({
    events: { turns, tools, providers } as unknown as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 }, metrics: createStreamMetrics(), render: () => {},
    getSessionId: () => session,
    providerRegistry: {
      getCurrentModel: () => ({ provider: model.split(':')[0]!, registryKey: model }),
      setCurrentModel: key => { model = key; },
      getRegistered: options.noIdentity ? undefined : id => instances[id as keyof typeof instances],
      describeRuntime: async id => ({ setup: { description: id === 'first' ? 'Direct provider API key' : 'Stored subscription session' } }),
    },
    providerOptimizer: { enabled: true, fallbackLog: [], testFallback: () => ({ chain: [{ providerId: 'first', modelId: 'one', capable: true, position: 0 }, { providerId: 'second', modelId: 'two', capable: true, position: 1 }] }), recordFallbackTransition() {} },
    systemMessageRouter: { high: text => { messages.push(text); }, low() {}, userReceipt: text => { messages.push(text); } },
    // As in main.ts: the rollback clears the transcript, then the notice is posted.
    retryTurn: notice => { messages.length = 0; messages.push(notice); retries.push(notice); return true; },
  });
  turns.emit('TURN_SUBMITTED', { turnId: 'a' });
  return { turns, providers, messages, retries, instances, wiring,
    error: () => turns.emit('TURN_ERROR', { turnId: 'a', error: 'throttled', status: 429, stopReason: 'provider_error' }),
    session: () => { session = 'b'; },
    billing: () => messages.filter(m => m.startsWith('[Failover] billing:')),
    close: () => { for (const unsubscribe of wiring.unsubs) unsubscribe(); } };
}

describe('the failover billing line', () => {
  test('failover does not wait for setup facts; the billing line follows it', async () => {
    const held = gate(); installSetupReader(held.promise); const f = fixture();
    try {
      f.error();
      expect(f.retries).toHaveLength(1);
      expect(f.messages).toEqual(f.retries);
      held.release(); await flush();
      expect(f.billing()).toEqual(['[Failover] billing: API key → Subscription: billing class changed']);
    } finally { f.close(); }
  });

  for (const boundary of ['new-turn', 'new-session', 'dispose', 'providers-changed'] as const) {
    test(`a billing reading still pending at ${boundary} adds nothing`, async () => {
      const held = gate(); installSetupReader(held.promise); const f = fixture();
      try {
        f.error();
        if (boundary === 'new-turn') { f.wiring.startNewTurn(); f.turns.emit('TURN_SUBMITTED', { turnId: 'b' }); }
        if (boundary === 'new-session') f.session();
        if (boundary === 'dispose') f.close();
        if (boundary === 'providers-changed') f.providers.emit('PROVIDERS_CHANGED', { added: [], removed: [], updated: ['second'] });
        held.release(); await flush();
        expect(f.billing()).toEqual([]);
      } finally { f.close(); }
    });
  }

  test('without a live instance lookup both sides are Unknown and nothing is read', async () => {
    const reader = installSetupReader(); const f = fixture({ noIdentity: true });
    try {
      f.error(); await flush();
      expect(f.billing()).toEqual(['[Failover] billing: Unknown → Unknown']);
      expect(reader.requests).toHaveLength(0);
    } finally { f.close(); }
  });

  test('a provider replaced while its facts were read is Unknown', async () => {
    const held = gate(); installSetupReader(held.promise); const f = fixture();
    try {
      f.error(); f.instances.second = {}; held.release(); await flush();
      expect(f.billing()).toEqual(['[Failover] billing: API key → Unknown']);
    } finally { f.close(); }
  });

  for (const [variant, line] of [
    ['unknown-from', '[Failover] billing: Unknown → Subscription'],
    ['unknown-to', '[Failover] billing: API key → Unknown'],
    ['known-same', '[Failover] billing: API key → API key'],
    ['known-different', '[Failover] billing: API key → Subscription: billing class changed'],
  ] as const) {
    test(`a billing change is claimed only between two known, different classes: ${variant}`, async () => {
      if (variant === 'known-same') installJudgmentPort(fakePort(name => noulAnswer(name === 'api_key' ? 0.99 : 0.01)).port);
      else installSetupReader();
      const f = fixture();
      if (variant === 'unknown-from') f.instances.first = undefined as unknown as object;
      if (variant === 'unknown-to') f.instances.second = undefined as unknown as object;
      try {
        f.error(); await flush();
        expect(f.billing()).toEqual([line]);
      } finally { f.close(); }
    });
  }
});
