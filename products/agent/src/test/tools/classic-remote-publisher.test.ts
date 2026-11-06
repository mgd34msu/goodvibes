import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.js';
import { readRemotePublisherOutcomeKind, readRemotePublisherSchemaStatus } from '../../tools/agent-harness-remote-publisher-readings.js';
import { bindNativeRemoteWorkspaceDisplays, captureNativeRemoteReadModelSnapshot, currentNativeRemoteReadModelSnapshot, settleNativeRemotePublisherSemantics } from '../../tools/agent-harness-remote-read-models.js';
import { protectPersonalOpsData } from '../../tools/agent-harness-personal-ops-source.js';
import { projectSetupSmokeEvidenceFull } from '../../tools/agent-harness-setup-smoke.js';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.js';

let prior: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(prior); });
afterAll(cleanupResearchScreeningFixtures);
function fixture() {
  const privacy = researchScreeningFixture();
  const outcome = { id: 'outcome-one', runnerId: 'worker-one', kind: 'capture', schemaStatus: 'certified', status: 'succeeded',
    summary: 'Synthetic completed result.', captureId: 'capture-one', schemaVersion: '1', publicationGuarantee: 'Fixture claim.', publisher: 'fixture', receiptId: 'receipt-one', cursor: 'one' };
  const workspace = { id: 'workspace-one', runnerId: 'worker-one', schemaStatus: 'certified', status: 'ready', workspaceId: 'workspace-one',
    isolationKind: 'worktree', branch: 'fixture-branch', workspacePath: '/synthetic/worktree', publisher: 'fixture', cursor: 'one' };
  const context = { platform: { readModels: { remoteRuntime: { captureOutcomes: { records: [outcome] }, workspaces: { records: [workspace] } } } }, ops: {}, clients: {} } as unknown as CommandContext;
  const options = { sourceOwner: privacy.owner, assertCurrent() {}, assertSourceCurrent() {} };
  const projection = { projectText: projectSetupSmokeEvidenceFull, projectPath: projectSetupSmokeEvidenceFull,
    protectFields: protectPersonalOpsData,
  };
  return { privacy, outcome, workspace, context, options, projection };
}

test('Classic remote settlement preserves actual outcomes/workspaces with unassessed meanings and no decision traffic', async () => {
  const f = fixture(); let asks = 0;
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('must not ask'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const owned = captureNativeRemoteReadModelSnapshot(f.context);
    const result = await settleNativeRemotePublisherSemantics(owned.token, f.options, f.projection);
    expect(result).toMatchObject({ operationProvenance: 'classic', semanticAssessment: 'not-evaluated',
      outcomes: [expect.objectContaining({ id: 'outcome-one', status: 'succeeded', captureId: 'capture-one', kind: 'unassessed', certification: expect.objectContaining({ schemaStatus: 'unassessed' }) })],
      workspaces: [expect.objectContaining({ id: 'workspace-one', status: 'ready', branch: 'fixture-branch', certification: expect.objectContaining({ schemaStatus: 'unassessed' }) })],
    });
    expect(result.outcomes[0]?.certification.missingSignals.join(' ')).toContain('not interpreted');
    bindNativeRemoteWorkspaceDisplays(owned.token, result.workspaces);
    expect(currentNativeRemoteReadModelSnapshot(f.context, owned.token)).toBe(result);
    await expect(settleNativeRemotePublisherSemantics(owned.token, f.options, f.projection)).rejects.toThrow();
    expect(asks).toBe(0); expect(f.privacy.calls).toEqual([]);
    f.outcome.summary = 'Changed native result';
    expect(() => currentNativeRemoteReadModelSnapshot(f.context, owned.token)).toThrow();
  });
});

test('Preferred preserves a real negative schema reading when later operation interpretation exhausts', async () => {
  const f = fixture(); let asks = 0; const base = fakePort(() => noulAnswer(0.001));
  installJudgmentPort({ ...base.port, async ask(request) { asks++; if (asks === 2) throw new JudgmentError('unavailable', 'fixture exhausted'); return base.port.ask(request); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const owned = captureNativeRemoteReadModelSnapshot(f.context);
    const result = await settleNativeRemotePublisherSemantics(owned.token, f.options, f.projection);
    expect(result).toMatchObject({ operationProvenance: 'classic', semanticAssessment: 'partial',
      outcomes: [expect.objectContaining({ id: 'outcome-one', kind: 'unassessed', status: 'succeeded', semanticAssessment: 'partial', certification: expect.objectContaining({ schemaStatus: 'legacy' }) })],
      workspaces: [expect.objectContaining({ certification: expect.objectContaining({ schemaStatus: 'unassessed' }) })],
    });
    expect(asks).toBe(2);
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
    expect(currentNativeRemoteReadModelSnapshot(f.context, owned.token)).toBe(result);
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) test(`remote ${kind} retires its capture without Preferred fallback`, async () => {
  const f = fixture(); const failure = new JudgmentError(kind, 'fixture failure');
  installJudgmentPort({ model: 'fixture', async ask() { throw failure; } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const owned = captureNativeRemoteReadModelSnapshot(f.context);
    await expect(settleNativeRemotePublisherSemantics(owned.token, f.options, f.projection)).rejects.toThrow();
    expect(() => currentNativeRemoteReadModelSnapshot(f.context, owned.token)).toThrow();
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('unsettled schema evidence cannot be replaced with Classic just because another reading could fail', async () => {
  const f = fixture(); let asks = 0; const base = fakePort(() => noulAnswer(0.5));
  installJudgmentPort({ ...base.port, async ask(request) { asks++; if (asks > 1) throw new JudgmentError('unavailable', 'fixture exhausted'); return base.port.ask(request); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const owned = captureNativeRemoteReadModelSnapshot(f.context);
    await expect(settleNativeRemotePublisherSemantics(owned.token, f.options, f.projection)).rejects.toThrow();
    expect(decisionModelPolicyState().operation).toBe('decision'); expect(asks).toBe(1);
  });
});

for (const change of ['cancel', 'source'] as const) test(`remote ${change} revocation cannot activate Preferred or publish after exhaustion`, async () => {
  const f = fixture(); const abort = new AbortController();
  installJudgmentPort({ model: 'fixture', async ask() {
    if (change === 'cancel') abort.abort(); else f.outcome.status = 'failed';
    throw new JudgmentError('unavailable', 'fixture exhausted');
  } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const owned = captureNativeRemoteReadModelSnapshot(f.context);
    await expect(settleNativeRemotePublisherSemantics(owned.token, { ...f.options, signal: abort.signal }, f.projection)).rejects.toThrow();
    expect(decisionModelPolicyState().operation).toBe('decision');
    expect(() => currentNativeRemoteReadModelSnapshot(f.context, owned.token)).toThrow();
  });
});

test('Classic direct readers say unassessed rather than copying publisher claims', async () => {
  const f = fixture();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect(await readRemotePublisherSchemaStatus({ schemaStatus: 'certified' }, f.options)).toBe('unassessed');
    expect(await readRemotePublisherOutcomeKind({ kind: 'capture' }, f.options)).toBe('unassessed');
    expect(f.privacy.calls).toEqual([]);
  });
});
