import { expect, spyOn, test } from 'bun:test';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import type { ChatRequest } from '@goodvibes-jev/engine/platform/platform/providers';
import { PairingTokenManager } from '@goodvibes-jev/engine/platform/platform/pairing';
import { NativeWorkExecutionError } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution';
import { emitTurnError } from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import { answer, createNativeWorkFixture, waitFor, type NativeWorkFixtureSettings } from '../helpers/native-work-fixture.js';

const fixture = (pairingOwner?: PairingTokenManager, retry?: NativeWorkFixtureSettings['retry']) =>
  createNativeWorkFixture(pairingOwner, { ...(retry ? { retry } : {}), contractOperator: true });

test('a cancellation refused before it changed anything lets the stopped unit run on instead of showing running forever', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture();
  let calls = 0;
  f.hold(async request => {
    calls++;
    // The first turn is the one the cancellation stops.
    if (calls === 1) await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    return answer('native execution is complete');
  });
  try {
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    await waitFor(() => calls === 1, 'foreground entered');
    // A blank reason is refused before any durable state changes.
    const refused = await execution.cancel(started.admission.key, f.authority, '   ').then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(NativeWorkExecutionError);
    expect(refused).toMatchObject({ code: 'invalid' });
    await waitFor(() => execution.status(started.admission.key, f.authority).contract?.status === 'passed', 'refused-cancel unit driven to completion');
  } finally { await f.close(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
}, 20000);

async function withFixture(retry: Parameters<typeof fixture>[1], body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture(undefined, retry);
  try { await body(f); } finally { await f.close(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
}

test('a provider failure is retried with doubling backoff and the contract carries on when a retry succeeds', async () => {
  const delays: number[] = [];
  await withFixture({ delayMs: 100, sleep: async ms => { delays.push(ms); } }, async f => {
    let calls = 0;
    f.hold(async () => { if (++calls === 1) throw new Error('Provider unavailable'); return answer('native execution is complete'); });
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    await waitFor(() => execution.status(started.admission.key, f.authority).contract?.status === 'passed', 'contract passed after a retry');
    expect(calls).toBe(2);
    expect(delays).toEqual([100]);
  });
}, 20000);

const openQuestions = (contract: { readonly escalations: readonly { readonly resolvedAt?: number | undefined }[] } | null | undefined) => (contract?.escalations ?? []).filter(item => item.resolvedAt === undefined);

test('retries are bounded: after the last one the contract pauses on its owner with one open question, never cancelled and never silently running', async () => {
  const delays: number[] = [];
  await withFixture({ delayMs: 100, sleep: async ms => { delays.push(ms); } }, async f => {
    let calls = 0;
    f.hold(async () => { calls++; throw new Error('Provider unavailable'); });
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    await waitFor(() => execution.status(started.admission.key, f.authority).contract?.status === 'awaiting-owner', 'contract paused after the retries');
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
    const contract = execution.status(started.admission.key, f.authority).contract!;
    expect(openQuestions(contract)).toHaveLength(1);
    expect(contract.escalations[0]).toMatchObject({ failurePause: true });
    expect(contract.escalations[0]!.question).toContain('failed after 4 attempts');
    expect(contract.escalations[0]!.question).toContain('Provider unavailable');
    expect(contract.completedAt).toBeUndefined();
  });
}, 20000);

test('a failure that cannot be retried pauses the contract on its owner at the first attempt, without waiting or retrying', async () => {
  const delays: number[] = [];
  await withFixture({ delayMs: 100, sleep: async ms => { delays.push(ms); } }, async f => {
    let calls = 0;
    f.hold(async () => { calls++; throw new Error('The API key was rejected'); });
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    await waitFor(() => execution.status(started.admission.key, f.authority).contract?.status === 'awaiting-owner', 'contract paused at the first failure');
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    const contract = execution.status(started.admission.key, f.authority).contract!;
    expect(openQuestions(contract)).toHaveLength(1);
    expect(contract.escalations[0]).toMatchObject({ failurePause: true });
    expect(contract.escalations[0]!.question).toContain('failed after 1 attempt');
    expect(contract.completedAt).toBeUndefined();
  });
}, 20000);

test('the owner answers retry and the turn runs again with a fresh retry budget; answering cancel then cancels', async () => {
  const delays: number[] = [];
  await withFixture({ delayMs: 100, sleep: async ms => { delays.push(ms); } }, async f => {
    let calls = 0;
    f.hold(async () => { calls++; throw new Error('Provider unavailable'); });
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    const read = () => execution.status(started.admission.key, f.authority).contract;
    await waitFor(() => read()?.status === 'awaiting-owner', 'first pause');
    const id = read()!.id; const first = openQuestions(read())[0] as { readonly id: string };
    await f.operator.reply(id, first.id, 'retry');
    await waitFor(() => calls === 8 && read()?.status === 'awaiting-owner' && openQuestions(read()).length === 1 && (openQuestions(read())[0] as { readonly id: string }).id !== first.id, 'second pause after a fresh budget');
    expect(delays).toEqual([100, 200, 400, 100, 200, 400]);
    const second = openQuestions(read())[0] as { readonly id: string };
    await f.operator.reply(id, second.id, 'cancel');
    expect(read()).toMatchObject({ status: 'cancelled', failureKind: 'owner-rejected' });
    expect(calls).toBe(8);
  });
}, 20000);

test('an owner retry lets the unit run again and the contract passes; any other answer is refused naming retry and cancel', async () => {
  await withFixture({ delayMs: 100, sleep: async () => {} }, async f => {
    let calls = 0; let healthy = false;
    f.hold(async () => { calls++; if (!healthy) throw new Error('Provider unavailable'); return answer('native execution is complete'); });
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    const read = () => execution.status(started.admission.key, f.authority).contract;
    await waitFor(() => read()?.status === 'awaiting-owner', 'paused');
    const id = read()!.id; const question = openQuestions(read())[0] as { readonly id: string };
    await expect(f.operator.reply(id, question.id, 'yes, approve the work')).rejects.toThrow(/"retry" or "cancel"/);
    expect(read()!.status).toBe('awaiting-owner');
    healthy = true;
    await f.operator.reply(id, question.id, 'retry');
    await waitFor(() => read()?.status === 'passed', 'contract passed after the owner retried');
    expect(calls).toBe(5);
    expect(openQuestions(read())).toHaveLength(0);
  });
}, 20000);

/** A pre-chat hook denial ends a turn before any completion point, so no check is produced. */
function denyChatTurns(f: Awaited<ReturnType<typeof fixture>>, denied: number) {
  const fire = f.services.hookDispatcher.fire.bind(f.services.hookDispatcher);
  let seen = 0;
  return spyOn(f.services.hookDispatcher, 'fire').mockImplementation(async event =>
    event.path === 'Pre:llm:chat' && ++seen <= denied ? { decision: 'deny', reason: 'blocked for the test' } as Awaited<ReturnType<typeof fire>> : fire(event));
}

test('a turn that ends without its completion check is asked once to finish and then passes', async () => {
  await withFixture({ delayMs: 100, sleep: async () => {} }, async f => {
    const denial = denyChatTurns(f, 1);
    const sent: string[] = [];
    f.hold(async request => { sent.push(JSON.stringify(request.messages)); return answer('native execution is complete'); });
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    await waitFor(() => execution.status(started.admission.key, f.authority).contract?.status === 'passed', 'contract passed after the nudge');
    // Only the nudged turn reached the provider, and it carried the nudge.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('no completion check was produced');
    denial.mockRestore();
  });
}, 20000);

test('a second turn without its completion check pauses the contract on its owner instead of nudging again or cancelling', async () => {
  await withFixture({ delayMs: 100, sleep: async () => {} }, async f => {
    const denial = denyChatTurns(f, 100);
    const execution = await f.activation.acquire();
    const started = await execution.start(f.target, f.authority);
    await waitFor(() => execution.status(started.admission.key, f.authority).contract?.status === 'awaiting-owner', 'contract paused after one nudge');
    const contract = execution.status(started.admission.key, f.authority).contract!;
    expect(openQuestions(contract)).toHaveLength(1);
    expect(contract.escalations[0]!.question).toContain('even after being asked once to finish');
    expect(denial.mock.calls.filter(([event]) => event.path === 'Pre:llm:chat')).toHaveLength(2);
    denial.mockRestore();
  });
}, 20000);

const unitRequests = (f: { requests: ChatRequest[] }) => f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'));

test('a provider error from another turn of the shared session does not fail a successful attempt', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const sleeps: number[] = [];
  const f = await fixture(undefined, { delayMs: 1, sleep: async ms => { sleeps.push(ms); } });
  let calls = 0;
  // The first attempt ends without finishing the unit (so the driver goes on to a second turn) while
  // another conversation's turn in the same session fails: that failure is not this attempt's.
  f.hold(async () => {
    if (calls++ > 0) return answer('native execution is complete');
    emitTurnError(f.options.runtimeBus, { sessionId: 'native-fixture', traceId: 'foreign', source: 'orchestrator' },
      { turnId: 'turn-from-another-conversation', error: 'Synthetic provider failure elsewhere', stopReason: 'provider_error' });
    return answer('');
  });
  try {
    const execution = await f.activation.acquire(); const started = await execution.start(f.target, f.authority);
    await waitFor(() => ['passed', 'failed', 'cancelled', 'paused'].includes(execution.status(started.admission.key, f.authority).contract?.status ?? ''), 'native completion');
    expect(sleeps).toEqual([]);
    expect(execution.status(started.admission.key, f.authority).contract?.status).toBe('passed');
  } finally { await f.close(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);

test('a retry after a failed attempt says it is a retry and to continue from the current state', async () => {
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const f = await fixture(undefined, { delayMs: 1, sleep: async () => {} });
  let calls = 0;
  f.hold(async () => {
    if (calls++ === 0) throw new Error('Synthetic transient provider failure');
    return answer('native execution is complete');
  });
  try {
    const execution = await f.activation.acquire(); const started = await execution.start(f.target, f.authority);
    await waitFor(() => ['passed', 'failed', 'cancelled', 'paused'].includes(execution.status(started.admission.key, f.authority).contract?.status ?? ''), 'native completion after retry');
    const requests = unitRequests(f);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('stopped because of an error');
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('continue from there; do not start over');
  } finally { await f.close(); identities.mockRestore(); benchmarks.mockRestore(); }
}, 20000);
