import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.js';
import { browserDeviceCatalogMatches, readBrowserDeviceEvidence } from '../../tools/agent-harness-browser-device-readings.js';
import { browserPwaReadModelSnapshot, isCertifiedBrowserPwaCategoryRoute, isCertifiedBrowserPwaFirstRunReceipt } from '../../tools/agent-harness-browser-pwa-read-models.js';
import { certifiedDeviceLiveRecords, deviceLiveReadModelSnapshot } from '../../tools/agent-harness-device-live-read-models.js';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.js';

let prior: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(prior); });
afterAll(cleanupResearchScreeningFixtures);
const context = (readModels: unknown): CommandContext => ({ platform: { readModels }, clients: {}, ops: {} }) as unknown as CommandContext;
const publication = { schemaStatus: 'certified', schemaVersion: '1', publicationGuarantee: 'Synthetic declared scoped publication.',
  publisher: 'fixture', receiptId: 'fixture-receipt', cursor: 'one', permissionScope: 'microphone', status: 'ready', routes: { inspect: 'device action:"capability"' } };

test('Classic catalogs retain local search matches, explicit booleans, and unknown readiness without any decision traffic', async () => {
  const privacy = researchScreeningFixture(); const options = { sourceOwner: privacy.owner }; let asks = 0;
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('must not ask'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const entries = [{ id: 'camera', description: 'Camera settings' }, { id: 'voice', description: 'Voice settings' }];
    expect(await browserDeviceCatalogMatches(entries, 'camera', entry => ({ ...entry, evidence: entry }), options, 'fixture.classic.catalog')).toEqual([entries[0]!]);
    const snapshot = await browserPwaReadModelSnapshot(context({ browserPwa: {
      categoryRoutes: [
        { ...publication, id: 'unknown', categoryId: 'home', summary: 'Mobile, touch and PWA are ready according to this prose.' },
        { ...publication, id: 'native', categoryId: 'work', mobileReady: true, pwaReady: false },
      ], firstRunReceipts: [{ ...publication, id: 'first', summary: 'Works offline.' }],
    } }), options);
    expect(snapshot.categoryRoutes.map(record => record.id)).toEqual(['unknown', 'native']);
    expect(snapshot.firstRunReceipts.map(record => record.id)).toEqual(['first']);
    expect(snapshot).toMatchObject({ provenance: 'classic', semanticAssessment: 'not-evaluated', categoryRoutes: [
      { id: 'unknown', mobileReady: null, pwaReady: null },
      { id: 'native', mobileReady: true, pwaReady: false },
    ] });
    expect(snapshot.categoryRoutes[0]?.certification, JSON.stringify(snapshot.categoryRoutes[0])).toBeDefined();
    expect(isCertifiedBrowserPwaCategoryRoute(snapshot.categoryRoutes[0]!)).toBe(false);
    expect(snapshot.categoryRoutes[0]?.certification.missingSignals.join(' ')).toContain('not evaluated');
    expect(isCertifiedBrowserPwaFirstRunReceipt(snapshot.firstRunReceipts[0]!)).toBe(false);
    expect(asks).toBe(0); expect(privacy.calls).toEqual([]);
  });
});

test('Classic device discovery uses only exact ready capability declarations; prose and blocked records cannot supply a route', async () => {
  const privacy = researchScreeningFixture(); const options = { sourceOwner: privacy.owner };
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const snapshot = await deviceLiveReadModelSnapshot(context({ device: { capabilities: [
      { ...publication, id: 'exact', capabilityId: 'push-to-talk' },
      { ...publication, id: 'opaque', capabilityId: 'different', summary: 'Provides push-to-talk microphone capture.' },
      { ...publication, id: 'blocked', capabilityId: 'push-to-talk', status: 'blocked' },
    ] } }), options);
    expect(snapshot.provenance).toBe('classic');
    const matched = await certifiedDeviceLiveRecords(snapshot, 'push-to-talk', ['microphone'], options);
    expect(matched.map(record => record.id)).toEqual(['exact']);
    expect(matched[0]?.semanticAssessment).toBe('not-evaluated');
    expect(await readBrowserDeviceEvidence({ kind: 'mobile-touch', record: { mobileReady: true, metadata: { mobileReady: false } } }, options)).toBeNull();
    expect(await readBrowserDeviceEvidence({ kind: 'pwa-runtime', record: { summary: 'Definitely PWA ready' } }, options)).toBeNull();
    expect(privacy.calls).toEqual([]);
  });
});

test('Preferred preserves the first declared reading and marks remaining readiness unknown after real exhaustion', async () => {
  const privacy = researchScreeningFixture(); let asks = 0; const base = fakePort(() => noulAnswer(0.999));
  installJudgmentPort({ ...base.port, async ask(request) { asks++; if (asks === 2) throw new JudgmentError('unavailable', 'fixture exhausted'); return base.port.ask(request); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const result = await browserPwaReadModelSnapshot(context({ browserPwa: { categoryRoutes: [{ ...publication, id: 'one', categoryId: 'home', summary: 'Synthetic descriptive capability evidence.' }] } }), { sourceOwner: privacy.owner });
    expect(result).toMatchObject({ provenance: 'classic', semanticAssessment: 'partial', categoryRoutes: [expect.objectContaining({ mobileReady: true, pwaReady: null, semanticAssessment: 'partial' })] });
    expect(asks).toBe(2);
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) test(`browser/device ${kind} is not availability exhaustion`, async () => {
  const privacy = researchScreeningFixture(); const failure = new JudgmentError(kind, 'fixture failure');
  installJudgmentPort({ model: 'fixture', async ask() { throw failure; } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(readBrowserDeviceEvidence({ kind: 'mobile-touch', record: { summary: 'Unknown' } }, { sourceOwner: privacy.owner })).rejects.toThrow();
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic source replacement and cancellation still prevent publication', async () => {
  const privacy = researchScreeningFixture(); const abort = new AbortController(); abort.abort();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await expect(readBrowserDeviceEvidence({ kind: 'mobile-touch', record: { mobileReady: true } }, { sourceOwner: privacy.owner, signal: abort.signal })).rejects.toThrow();
    await expect(readBrowserDeviceEvidence({ kind: 'mobile-touch', record: { mobileReady: true } }, { sourceOwner: privacy.owner, assertCurrent() { throw new Error('fixture owner retired'); } })).rejects.toThrow();
    expect(privacy.calls).toEqual([]);
  });
});
