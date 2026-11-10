import { expect, spyOn, test } from 'bun:test';
import { createSystemOnePort, DEFAULT_MODEL } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ModelTierStore } from '../../platform/src/platform/routing/model-tiers.js';

const facts = { registryKey: 'synthetic:model', id: 'model', name: 'Synthetic model', provider: 'synthetic' };
for (const returned of [false, Promise.resolve()]) test(`actual model-tier wrapper refuses ${typeof returned} owner return before its native wire`, async () => {
  let wires = 0, guards = 0;
  const port = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: DEFAULT_MODEL, timeoutMs: 1000, signal: new AbortController().signal,
    retry: {}, fetch: async () => { wires++; throw new Error('Unexpected dispatch'); } });
  const previous = installJudgmentPort(port);
  try {
    await expect(new ModelTierStore().read(facts, { beforeAttempt: () => { guards++; return returned; } })).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(guards).toBe(1); expect(wires).toBe(0);
  } finally { installJudgmentPort(previous); }
});

test('actual model-tier wrapper preserves original synchronous receiver and cancellation before dispatch', async () => {
  let wires = 0, guards = 0;
  const controller = new AbortController();
  const port = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: DEFAULT_MODEL, timeoutMs: 1000, signal: new AbortController().signal,
    retry: {}, fetch: async () => { wires++; throw new Error('Unexpected dispatch'); } });
  const previous = installJudgmentPort(port);
  const options = { signal: controller.signal, beforeAttempt() { expect(this).toBe(options); guards++; controller.abort(); } };
  try {
    await expect(new ModelTierStore().read(facts, options)).rejects.toMatchObject({ kind: 'aborted' });
    expect(guards).toBe(1); expect(wires).toBe(0);
  } finally { installJudgmentPort(previous); }
});


test('an independently owned tier call never builds an unused in-flight key', async () => {
  let wires = 0, keyReads = 0;
  const port = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: DEFAULT_MODEL, timeoutMs: 1000, signal: new AbortController().signal,
    retry: {}, fetch: async () => { wires++; throw new Error('Unexpected dispatch'); } });
  const previous = installJudgmentPort(port);
  const tiers = new ModelTierStore();
  const originalKnown = tiers.known.bind(tiers);
  const known = spyOn(tiers, 'known').mockImplementation(captured => {
    const key = captured.registryKey;
    // Observe the actual captured facts, after the public method's clone.
    Object.defineProperty(captured, 'registryKey', { enumerable: true, configurable: true, get() { keyReads++; return key; } });
    return originalKnown(captured);
  });
  try {
    await expect(tiers.read(facts, { beforeAttempt: () => false })).rejects.toMatchObject({ kind: 'invalid-request' });
    // One genuine saved-entry lookup; no discarded in-flight-key access.
    expect(keyReads).toBe(1); expect(wires).toBe(0);
  } finally { known.mockRestore(); installJudgmentPort(previous); }
});

test('a valid synchronous original owner still publishes the actual model-tier reading', async () => {
  let wires = 0, guards = 0;
  const port = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: DEFAULT_MODEL, timeoutMs: 1000, signal: new AbortController().signal,
    retry: {}, fetch: async (_url, init) => {
      wires++;
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      expect(Object.keys(body.questions).sort()).toEqual(['frontier', 'small']);
      return Response.json({ model: DEFAULT_MODEL, answers: { frontier: { type: 'noul', noul: 0.99 }, small: { type: 'noul', noul: 0.01 } }, usage: { input_tokens: 1, output_tokens: 1 } });
    } });
  const previous = installJudgmentPort(port);
  const tiers = new ModelTierStore();
  const options = { beforeAttempt() { expect(this).toBe(options); guards++; } };
  try {
    const result = await tiers.read(facts, options);
    expect(result.tier).toBe('premium');
    expect(tiers.known(facts)).toMatchObject(result);
    expect(guards).toBe(2); expect(wires).toBe(1);
  } finally { installJudgmentPort(previous); }
});
