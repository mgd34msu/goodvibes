import { afterAll, expect, test } from 'bun:test';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ProtectedSource, ProtectedSourceOwner, SourceScreeningHold } from '@goodvibes-jev/engine/platform/platform/security';
import { withModelReadingSource } from '../../tools/agent-harness-model-reading-source.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
const source = { query: 'build notes', catalog: [{ id: 'ordinary-candidate', description: 'An ordinary build note.' }] };
const reasons = ['route-unavailable', 'protected-input', 'malformed', 'unsettled', 'cancelled', 'stale', 'capacity', 'busy'] satisfies SourceScreeningHold[];

function authoredResult(value: unknown, beforeRelease?: () => Promise<void>) {
  const native = researchScreeningFixture();
  const handles: ProtectedSource[] = [], released: ProtectedSource[] = [];
  const owner: ProtectedSourceOwner = {
    ...native.owner,
    capture(parts) { const handle = native.owner.capture(parts); handles.push(handle); return handle; },
    async screen() { return value as Awaited<ReturnType<ProtectedSourceOwner['screen']>>; },
    async release(handle) {
      await beforeRelease?.();
      await native.owner.release(handle);
      if (handles.includes(handle as ProtectedSource)) released.push(handle as ProtectedSource);
    },
  };
  let consumptions = 0;
  const read = () => withModelReadingSource(source, { sourceOwner: owner }, async captured => { consumptions++; return captured; });
  return { native, handles, released, read, consumptions: () => consumptions };
}
async function refusal(read: () => Promise<unknown>): Promise<ToolInputProjectionError> {
  try { await read(); }
  catch (error) {
    if (!(error instanceof ToolInputProjectionError)) throw error;
    expect(error.problem).toBe('held'); expect(error.message).toBe('Tool input projection held.');
    expect(Object.keys(error).sort()).toEqual(['name', 'problem']); return error;
  }
  throw new Error('An unaccepted source reached consumption');
}

for (const reason of reasons) test(`structured source preserves only the finite owner hold ${reason}`, async () => {
  const fixture = authoredResult(Object.freeze({ status: 'held', reason }));
  const error = await refusal(fixture.read);
  const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
  expect(descriptor).toMatchObject({ enumerable: false, configurable: false, writable: false });
  expect(descriptor?.value).toEqual({ code: 'source-screening-held', reason });
  expect(Object.isFrozen(descriptor?.value)).toBe(true);
  expect(fixture.consumptions()).toBe(0); expect(fixture.native.calls).toHaveLength(0);
  expect(fixture.handles).toHaveLength(1); expect(fixture.released).toEqual(fixture.handles);
});

test('structured source never coerces private, unknown or proxy hold reasons', async () => {
  let invoked = 0;
  const hostile = { toString() { invoked++; return 'private-reason'; }, toJSON() { invoked++; return 'private-reason'; } };
  const proxy = new Proxy({}, { get() { invoked++; throw new Error('private-reason'); }, getPrototypeOf() { invoked++; throw new Error('private-reason'); } });
  for (const reason of ['private-reason', '__proto__', 'toString', 42, null, undefined, hostile, proxy]) {
    const fixture = authoredResult({ status: 'held', reason });
    const error = await refusal(fixture.read);
    expect(Object.hasOwn(error, 'cause')).toBe(false); expect(JSON.stringify(error)).not.toContain('private-reason');
    expect(fixture.consumptions()).toBe(0); expect(fixture.native.calls).toHaveLength(0);
    expect(fixture.released).toEqual(fixture.handles);
  }
  expect(invoked).toBe(0);
});

test('structured source refuses result and receipt getters/proxies before they run', async () => {
  let invoked = 0;
  const trap = () => { invoked++; throw new Error('private-result'); };
  // Promise assimilation may ask for then; only the result admission traps are
  // hostile, matching the actual awaited dependency boundary under review.
  const proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const receiptProxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  for (const value of [
    Object.defineProperty({ reason: 'unsettled' }, 'status', { get: trap }),
    Object.defineProperty({ status: 'held' }, 'reason', { get: trap }),
    Object.defineProperty({ status: 'settled' }, 'receipt', { get: trap }),
    { status: 'held', reason: 'unsettled', extra: 'private-result' },
    { status: 'settled', receipt: null }, { status: 'settled', receipt: trap },
    { status: 'settled', receipt: receiptProxy }, { status: 'unknown', reason: 'unsettled' },
    Object.create({ status: 'held', reason: 'unsettled' }), proxy, null, 42,
  ]) {
    const fixture = authoredResult(value), error = await refusal(fixture.read);
    expect(Object.hasOwn(error, 'cause')).toBe(false); expect(JSON.stringify(error)).not.toContain('private-result');
    expect(fixture.consumptions()).toBe(0); expect(fixture.native.calls).toHaveLength(0);
    expect(fixture.released).toEqual(fixture.handles);
  }
  expect(invoked).toBe(0);
});

test('structured hold waits for the actual captured handle release before reporting refusal', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fixture = authoredResult({ status: 'held', reason: 'unsettled' }, async () => { entered.resolve(); await release.promise; });
  let finished = false;
  const reading = refusal(fixture.read).then(error => { finished = true; return error; });
  try {
    await entered.promise;
    expect(finished).toBe(false); expect(fixture.handles).toHaveLength(1); expect(fixture.released).toEqual([]);
    expect(fixture.consumptions()).toBe(0);
  } finally { release.resolve(); }
  const error = await reading;
  expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toEqual({ code: 'source-screening-held', reason: 'unsettled' });
  expect(fixture.released).toEqual(fixture.handles);
});

test('a plain forged settled receipt cannot authorize structured source consumption', async () => {
  const fixture = authoredResult({ status: 'settled', receipt: {} });
  // Shape admission grants no authority: the unchanged native project method
  // must authenticate the receipt against its actual captured source handle.
  await expect(fixture.read()).rejects.toThrow();
  expect(fixture.consumptions()).toBe(0); expect(fixture.native.calls).toHaveLength(0);
  expect(fixture.handles).toHaveLength(1); expect(fixture.released).toEqual(fixture.handles);
});

test('genuine structured uncertainty preserves the native unsettled cause without consumption', async () => {
  const native = researchScreeningFixture({ complete: 0.5 }); let consumed = 0;
  const error = await refusal(() => withModelReadingSource(source, { sourceOwner: native.owner }, async () => { consumed++; }));
  expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toEqual({ code: 'source-screening-held', reason: 'unsettled' });
  expect(native.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
  expect(consumed).toBe(0);
});

test('a genuine settled native receipt is projected and permits the original complete structured source', async () => {
  const native = researchScreeningFixture(); let consumed = 0;
  const result = await withModelReadingSource(source, { sourceOwner: native.owner }, async captured => { consumed++; return captured; });
  expect(result).toEqual(source); expect(consumed).toBe(1);
  expect(native.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
});
