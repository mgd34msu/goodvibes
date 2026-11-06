import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { externalMemoryLiveProviderRecords, externalMemoryReceiptEvidence, setupStatusFromLiveRecord } from '../../tools/agent-harness-memory-external-providers.js';
import { readMemoryCredentialState, readMemoryLiveStatus, readMemoryPublicText, readMemoryReceiptMember, readMemoryRouteRole, readMemorySchemaCertified, selectMemoryProvider } from '../../tools/agent-harness-memory-provider-readings.js';
import { describeMemoryProvider, memoryPostureSummary } from '../../tools/agent-harness-memory-posture.js';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.js';
import { makeFixture } from './agent-harness-tool-fixture.js';

let prior: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(prior); });
afterAll(cleanupResearchScreeningFixtures);
function fixture() {
  const privacy = researchScreeningFixture();
  const record = { providerId: 'honcho', label: 'Synthetic backend', status: 'ready', configured: true, reachable: false, enabled: true,
    routes: { read: 'Some provider description' }, sourceCount: 2, recordCount: 3, schemaStatus: 'certified',
    description: 'Ordinary complete synthetic metadata.' };
  const snapshot = { providers: [record] }; const source = { getSnapshot: () => snapshot };
  const artifact = { id: 'receipt-one', filename: 'receipt.json', createdAt: 1, metadata: {
    purpose: 'external-memory-provider-receipt', providerId: 'honcho', operation: 'sync', status: 'completed', receiptId: 'provider-receipt-one' } };
  const records = [artifact];
  const context = { platform: { readModels: { memory: { externalProviders: source } }, artifactStore: { list: () => [...records] } } };
  return { privacy, record, records, context, options: { sourceOwner: privacy.owner } };
}

test('Classic provider inspection retains native facts and exact-purpose receipts with explicit unassessed interpretation', async () => {
  const f = fixture(); let asks = 0;
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('must not ask'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const providers = await externalMemoryLiveProviderRecords(f.context, f.options);
    expect(providers).toMatchObject([{ providerId: 'honcho', operationProvenance: 'classic', semanticAssessment: 'not-evaluated',
      configured: true, reachable: false, sourceCount: 2, recordCount: 3, status: 'unknown', credentialState: null,
      readReady: null, readRoute: null, certification: { schemaStatus: 'unassessed' } }]);
    expect(setupStatusFromLiveRecord(providers[0]!)).toBe('unassessed');
    const receipts = await externalMemoryReceiptEvidence(f.context, f.options);
    expect(receipts).toMatchObject([{ artifactId: 'receipt-one', providerId: 'honcho', operation: 'sync', status: 'unassessed',
      operationProvenance: 'classic', certification: { schemaStatus: 'unassessed' } }]);
    expect(asks).toBe(0); expect(f.privacy.calls).toEqual([]);
  });
});

test('Classic direct readers do not invent credential/schema/membership results, and provider selection requires an exact id', async () => {
  const f = fixture();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect(await readMemoryRouteRole({ record: f.record, container: 'routes', field: 'read', value: f.record.routes.read }, f.options)).toEqual({ role: 'unassessed', form: 'none' });
    expect(await readMemoryCredentialState(f.record, f.options)).toBeNull();
    expect(await readMemoryLiveStatus(f.record, f.options)).toBe('unknown');
    expect(await readMemoryReceiptMember({ description: 'Memory receipt example' }, f.options)).toBeNull();
    expect(await readMemorySchemaCertified(f.record, f.options)).toBeNull();
    expect(await readMemoryPublicText('Ordinary provider metadata.', f.options)).toBe('Ordinary provider metadata.');
    const providers = [{ id: 'honcho', label: 'Synthetic provider' }, { id: 'other', label: 'Synthetic other' }];
    expect(await selectMemoryProvider(providers, 'HONCHO', f.options)).toBe(providers[0]);
    expect(await selectMemoryProvider(providers, 'Synthetic provider', f.options)).toBeUndefined();
    expect(await selectMemoryProvider([], 'honcho', f.options)).toBeUndefined();
    expect(f.privacy.calls).toEqual([]);
  });
});

test('Preferred actual exhaustion retains a prior negative credential verdict and keeps later readers Classic', async () => {
  const f = fixture(); let asks = 0;
  const base = fakePort((name, question) => { expect(name).toBe('state'); return choiceAnswer(question, 'missing', 0.999); });
  installJudgmentPort({ ...base.port, async ask(request) { asks++; if (asks > 1) throw new JudgmentError('unavailable', 'fixture exhausted'); return base.port.ask(request); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    expect(await readMemoryCredentialState(f.record, f.options)).toBe('missing');
    expect(await readMemorySchemaCertified(f.record, f.options)).toBeNull();
    expect(await readMemoryLiveStatus(f.record, f.options)).toBe('unknown');
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
    expect(asks).toBe(2);
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) test(`memory ${kind} is not Preferred availability exhaustion`, async () => {
  const f = fixture(); const failure = new JudgmentError(kind, 'fixture failure');
  installJudgmentPort({ model: 'fixture', async ask() { throw failure; } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(readMemorySchemaCertified(f.record, f.options)).rejects.toThrow();
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('retained native provider/receipt guards still reject later source changes in Classic', async () => {
  const f = fixture(); const guards: Array<() => void> = [];
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await externalMemoryLiveProviderRecords(f.context, { ...f.options, retainCurrent: guard => { guards.push(guard); } });
    for (const guard of guards) guard();
    f.record.description = 'Changed native source';
    expect(() => { for (const guard of guards) guard(); }).toThrow();
  });
});

test('Classic full memory posture and exact provider detail expose the limitation without installed or local decision requests', async () => {
  const f = fixture(); const harness = makeFixture(); let asks = 0;
  Object.defineProperty(harness.context.platform, 'readModels', { configurable: true, value: f.context.platform.readModels });
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('must not ask'); } });
  try {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const summary = await memoryPostureSummary(harness.context, { includeParameters: true }, f.options);
      expect(summary).toMatchObject({ operationProvenance: 'classic', externalInterpretation: 'unassessed' });
      expect(await describeMemoryProvider(harness.context, { providerId: 'honcho', includeParameters: true }, f.options)).toMatchObject({ status: 'found', provider: {
        operationProvenance: 'classic', liveRecord: { providerId: 'honcho', certification: { schemaStatus: 'unassessed' } },
        setupGuide: { status: 'unassessed', contractChecklist: expect.arrayContaining([expect.objectContaining({ id: 'bounded-read-search', status: 'unassessed' })]) },
      } });
      expect(asks).toBe(0); expect(f.privacy.calls).toEqual([]);
    });
  } finally { harness.cleanup(); }
});

for (const change of ['cancel', 'source'] as const) test(`memory ${change} revocation prevents fallback after an availability error`, async () => {
  const f = fixture(); const abort = new AbortController();
  installJudgmentPort({ model: 'fixture', async ask() {
    if (change === 'cancel') abort.abort(); else f.record.description = 'Changed during reading';
    throw new JudgmentError('unavailable', 'fixture exhausted');
  } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(readMemorySchemaCertified(f.record, { ...f.options, signal: abort.signal })).rejects.toThrow();
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Default missing configuration remains a missing decision port rather than an unassessed Classic answer', async () => {
  const f = fixture();
  await withDecisionModelPolicy(() => 'Default - On', async () => {
    await expect(readMemorySchemaCertified(f.record, f.options)).rejects.toMatchObject({ name: 'JudgmentPortMissingError' });
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});
