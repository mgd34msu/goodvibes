import { expect, test } from 'bun:test';
import { HookDispatcher } from '../platform/src/platform/hooks/dispatcher.ts';
import { TurnHookOwner } from '../platform/src/platform/hooks/turn-ownership.ts';
import type { HookCategory, HookEvent, HookPhase } from '../platform/src/platform/hooks/types.ts';

function event(phase: HookPhase, category: HookCategory, specific = 'dynamic-extension'): HookEvent {
  return { path: `${phase}:${category}:${specific}`, phase, category, specific, sessionId: 'session', timestamp: 0, payload: {} };
}

test('every category and dynamic phase path observes actual runner start and settlement, while absent hooks remain idle', async () => {
  const categories = Object.values({ tool: 'tool', file: 'file', git: 'git', agent: 'agent', compact: 'compact', llm: 'llm', mcp: 'mcp', config: 'config', budget: 'budget', session: 'session', contract: 'contract', permission: 'permission', transport: 'transport', communication: 'communication' } satisfies Record<HookCategory, HookCategory>);
  const phases = Object.values({ Pre: 'Pre', Post: 'Post', Fail: 'Fail', Change: 'Change', Lifecycle: 'Lifecycle' } satisfies Record<HookPhase, HookPhase>);
  for (const category of categories) for (const phase of phases) {
    const gate = Promise.withResolvers<string>();
    const dispatcher = new HookDispatcher({ toolLLM: { chat: () => gate.promise } });
    const observations: number[] = [];
    const detach = dispatcher.onActivity(() => observations.push(dispatcher.activeInvocationCount));
    await dispatcher.fire(event(phase, category));
    expect(observations).toEqual([0]);
    dispatcher.register(`${phase}:${category}:*`, { match: '*', type: 'prompt', prompt: 'fixture' });
    const running = dispatcher.fire(event(phase, category));
    expect(dispatcher.activeInvocationCount).toBe(1);
    gate.resolve('{"ok":true}'); await running;
    expect(observations).toEqual([0, 1, 0]);
    detach();
  }
});

test('background hooks overlap and late subscribers read their already active executions', async () => {
  const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
  let next = 0;
  const dispatcher = new HookDispatcher({ toolLLM: { chat: () => {
    const gate = gates[next++];
    if (!gate) throw new Error('Unexpected hook');
    return gate.promise;
  } } });
  dispatcher.register('*:*:*', { match: '*', type: 'prompt', prompt: 'background', async: true });
  await Promise.all([dispatcher.fire(event('Post', 'file')), dispatcher.fire(event('Change', 'communication'))]);
  expect(dispatcher.activeInvocationCount).toBe(2);
  const seen: number[] = [];
  const finished = Promise.withResolvers<void>();
  const detach = dispatcher.onActivity(() => { const count = dispatcher.activeInvocationCount; seen.push(count); if (count === 0) finished.resolve(); });
  gates[0]?.resolve('{"ok":false}');
  await Promise.resolve();
  gates[1]?.reject(new Error('synthetic runner failure'));
  await finished.promise;
  expect(seen).toEqual([2, 1, 0]);
  detach();
});

test('cancelled hook work stays active until its real provider settles and closed admission starts no work', async () => {
  const gate = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<AbortSignal>();
  const dispatcher = new HookDispatcher({ toolLLM: { chat: (_prompt, options) => {
    if (!options?.signal) throw new Error('Owned provider signal missing');
    entered.resolve(options.signal);
    return gate.promise;
  } } });
  dispatcher.register('Pre:tool:*', { match: '*', type: 'prompt', prompt: 'owned' });
  const abort = new AbortController();
  const owner = new TurnHookOwner('session', 'turn', abort.signal);
  const work = dispatcher.fire(event('Pre', 'tool'), { owner });
  const signal = await entered.promise;
  abort.abort();
  expect(signal.aborted).toBe(true);
  expect(dispatcher.activeInvocationCount).toBe(1);
  gate.resolve('{"ok":true}'); await work; await owner.closeAndDrain();
  expect(dispatcher.activeInvocationCount).toBe(0);
  await expect(dispatcher.fire(event('Pre', 'tool'), { owner })).rejects.toThrow('closed');
  expect(dispatcher.activeInvocationCount).toBe(0);
});

test('disabled and unmatched hooks do not count; throwing or removed observers never interrupt execution', async () => {
  const dispatcher = new HookDispatcher({ toolLLM: { chat: async () => '{"ok":true}' } });
  dispatcher.register('Pre:tool:*', { match: '*', type: 'prompt', prompt: 'disabled', enabled: false });
  dispatcher.onActivity(() => { throw new Error('broken observer'); });
  let updates = 0;
  const detach = dispatcher.onActivity(() => { updates++; });
  detach();
  await dispatcher.fire(event('Pre', 'tool'));
  dispatcher.register('Pre:tool:*', { match: '*', type: 'prompt', prompt: 'active' });
  expect((await dispatcher.fire(event('Pre', 'tool'))).ok).toBe(true);
  expect(dispatcher.activeInvocationCount).toBe(0);
  expect(updates).toBe(1);
});


test.each(['resolve', 'reject'])('unowned outward timeout retains its underlying provider through later %s', async outcome => {
  const gate = Promise.withResolvers<string>();
  const idle = Promise.withResolvers<void>();
  const dispatcher = new HookDispatcher({ toolLLM: { chat: () => gate.promise } });
  dispatcher.register('Post:communication:*', { match: '*', type: 'prompt', prompt: 'unowned', timeout: 0.01 });
  const result = await dispatcher.fire(event('Post', 'communication'));
  expect(result.ok).toBe(false);
  expect(result.error).toContain('timed out');
  expect(dispatcher.activeInvocationCount).toBe(1);
  const detach = dispatcher.onActivity(() => { if (dispatcher.activeInvocationCount === 0) idle.resolve(); });
  if (outcome === 'resolve') gate.resolve('{"ok":true}');
  else gate.reject(new Error('provider finally failed'));
  await idle.promise;
  expect(dispatcher.activeInvocationCount).toBe(0);
  detach();
});

test('an outward HTTP error still retains its live response-body drain', async () => {
  const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); body.resolve(controller); } }), { status: 503 });
  } });
  const dispatcher = new HookDispatcher();
  dispatcher.register('Fail:transport:*', { match: '*', type: 'http', url: server.url.href, allowInternal: true });
  try {
    const work = dispatcher.fire(event('Fail', 'transport'));
    const stream = await body.promise;
    expect((await work).ok).toBe(false);
    expect(dispatcher.activeInvocationCount).toBe(1);
    // Attach after the initial idle notification to observe actual work settlement.
    const settled = Promise.withResolvers<void>();
    const stop = dispatcher.onActivity(() => { if (dispatcher.activeInvocationCount === 0) settled.resolve(); });
    stream.close(); await settled.promise;
    expect(dispatcher.activeInvocationCount).toBe(0);
    stop();
  } finally { await server.stop(true); }
});
