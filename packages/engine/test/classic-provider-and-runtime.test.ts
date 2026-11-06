import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { readLocalServerIdentity, readStopReason, readsAsReasoningRejection } from '../sdk/src/platform/routing/provider-readings.js';
import { readAnthropicOutputCapRow } from '../sdk/src/platform/routing/model-limit-readings.js';
import { shouldUseOtherApi } from '../sdk/src/platform/providers/provider-error.js';
import { ProviderSetupReadings } from '../sdk/src/platform/providers/provider-setup.js';
import { prepareReasoningEffort } from '../sdk/src/platform/providers/reasoning-effort-families.js';
import { extractOpenAIStreamTextDelta, readStreamDeltaLabels } from '../sdk/src/platform/providers/openai-stream-delta.js';
import { holdsCredential } from '../sdk/src/platform/config/credential-key-reading.js';
import { readUnknownSettingForms } from '../sdk/src/platform/config/settings-unknown-forms.js';
import { readConfigEventCarriesValue } from '../sdk/src/platform/runtime/config/emit-bridge.js';
import { readBundleRisk } from '../sdk/src/platform/runtime/settings/control-plane-store.js';
import { readCommandNeeds, decideSandboxedExec } from '../sdk/src/platform/runtime/permissions/sandbox-policy.js';
import { createSandboxEscalationApprovalHandler } from '../sdk/src/platform/runtime/permissions/sandbox-escalation.js';
import { readProcessOutput } from '../terminal-shell/src/process-output-reading.js';
import { readTierPromptSupplement } from '../sdk/src/platform/providers/tier-prompts.js';
import { ProviderAccessReadings } from '../sdk/src/platform/routing/catalog-access.js';
import { readsAsBelowCacheMinimum, readsAsCopilotClaudeModel } from '../sdk/src/platform/routing/provider-cache-readings.js';
import { readCommandDiscovery } from '../sdk/src/platform/routing/command-discovery.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); });
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  return fake.requests;
}

test('Classic prompt composition, provider catalog refresh and command suggestions avoid metadata readings', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    let tiersRead = 0;
    const supplement = await readTierPromptSupplement({ registryKey: 'synthetic:model', id: 'model', name: 'Synthetic model', provider: 'synthetic' }, {
      async read() { tiersRead++; throw new Error('No metadata reading expected'); },
    }, 'test.classic.prompt', { audience: 'conversation' });
    expect(supplement).toContain('required parameters');
    expect(supplement).not.toContain('no human watching');
    expect(tiersRead).toBe(0);
    const access = await new ProviderAccessReadings().readAll([{ id: 'synthetic', name: 'Synthetic provider', envVars: [], sampleModels: ['model'] }]);
    expect(access.has('synthetic')).toBe(true); expect(access.get('synthetic')).toBeUndefined();
    expect(await readsAsCopilotClaudeModel('claude-synthetic', 'test.classic.copilot')).toBe(true);
    expect(await readsAsCopilotClaudeModel('other-model', 'test.classic.copilot')).toBe(false);
    expect(await readsAsBelowCacheMinimum('Unclassified cache failure.', 'test.classic.cache')).toBe(false);
    const commands = [{ id: 'inspect', title: 'Inspect source', description: 'Inspect a source file', aliases: ['look'], keywords: ['source'] }];
    const discovery = await readCommandDiscovery({ query: 'source', commands });
    expect(discovery).toMatchObject({ ids: ['inspect'], provenance: 'classic' });
    discovery.assertCurrent();
  });
  expect(requests).toHaveLength(0);
});

test('Classic provider setup, ordinary streaming and error handling require no decision requests', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const setup = await new ProviderSetupReadings().read({ providerId: 'synthetic-provider', runtime: {
      auth: { mode: 'api-key', configured: true },
    } });
    expect(setup).toMatchObject({ setupClass: 'api-key', provenance: 'classic' });
    expect(await readLocalServerIdentity({ port: 12345, headers: {}, modelIds: [] }, 'test.classic.discovery')).toBe('unknown');
    await prepareReasoningEffort('high', { modelId: 'synthetic-unknown-model' }, 'test.classic.effort');
    expect(await readAnthropicOutputCapRow('synthetic-unknown-model', 'test.classic.cap')).toBeNull();
    const chunk = { choices: [{ delta: { content: [{ type: 'text', text: 'An ordinary answer.' }] } }] };
    await readStreamDeltaLabels(chunk, 'test.classic.stream');
    expect(extractOpenAIStreamTextDelta(chunk).content).toEqual(['An ordinary answer.']);
    expect(await readStopReason('undocumented-stop', 'test.classic.stop')).toBe('unknown');
    expect(await readsAsReasoningRejection('Unclassified provider failure', 'test.classic.reasoning-error')).toBe(false);
    expect(await shouldUseOtherApi({ status: 404, message: 'No endpoint' }, 'test.classic.other-api')).toBe(true);
    expect(await shouldUseOtherApi({ status: 400, message: 'Unclassified validation error' }, 'test.classic.other-api')).toBe(false);
  });
  expect(requests).toHaveLength(0);
});

test('Preferred unknown stop interpretation falls back after outage and makes no later decision requests', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    expect(await readStopReason('undocumented-stop', 'test.preferred.stop')).toBe('unknown');
    const attempted = requests.length;
    expect(attempted).toBeGreaterThan(0);
    expect(await readStopReason('another-undocumented-stop', 'test.preferred.stop')).toBe('unknown');
    expect(requests).toHaveLength(attempted);
  });
});

test('Classic settings preserve unknown keys, mask undeclared fields and report unassessed risk', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect(await holdsCredential('custom.unclassified', '', 'test.classic.credential')).toBe(true);
    expect(await readConfigEventCarriesValue('custom.unclassified')).toBe(false);
    expect(await readUnknownSettingForms('synthetic-settings.json', [{ section: 'provider', name: 'futureModel', key: 'provider.futureModel' }]))
      .toMatchObject([{ key: 'provider.futureModel', action: 'skipped' }]);
    expect(await readBundleRisk([{
      key: 'provider.model', previousValue: 'old', nextValue: 'new', changed: true,
      locked: false, source: 'test', reason: 'Owner-staged change',
    }], 'test.classic.bundle')).toBe('unassessed');
    expect(await readBundleRisk([], 'test.classic.bundle')).toBe('low');
  });
  expect(requests).toHaveLength(0);
});

test('Classic sandbox checks retain owner approval even with advisory auto-approval enabled', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const needs = await readCommandNeeds('synthetic-command');
    expect(needs).toEqual({ needsNetwork: null, needsPrivilege: null, provenance: 'classic' });
    expect(decideSandboxedExec({ command: 'synthetic-command', needs, sandboxActive: true, egressAllowlist: ['*'], baseEffectWhenNotSandboxed: 'ask' }).effect).toBe('ask');
    let approvals = 0, receipts = 0;
    const handler = createSandboxEscalationApprovalHandler(async ({ request }) => {
      approvals++;
      expect(request.analysis.reasons.join(' ')).toContain('Classic operation');
      return { approved: true };
    }, { config: { enabled: true, autoApprove: true }, onReceipt() { receipts++; } });
    const result = await handler({ command: 'synthetic-command', sandbox: 'test', boundary: 'Owned test boundary', escalations: ['network'], policyReasons: [] });
    expect(result.approved).toBe(true);
    expect(result.judgmentReceipt).toBeUndefined();
    expect(approvals).toBe(1); expect(receipts).toBe(0);
  });
  expect(requests).toHaveLength(0);
});

test('Classic process output stays raw and unclassified with cancellation still enforced', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const lifetime = new AbortController();
    const reading = await readProcessOutput({ lines: [{ id: 'line-1', stream: 'stdout', text: 'Server on 12345', raw: 'Server on 12345' }], partials: { stdout: '', stderr: '' }, done: false }, ['line-1'], { authoritySignal: lifetime.signal });
    expect(reading.provenance).toBe('classic');
    expect(reading.port).toBeUndefined(); expect(reading.errors.get('line-1')).toBeUndefined();
    reading.recordPublication(); lifetime.abort();
    expect(reading.assertAuthorityCurrent).toThrow();
  });
  expect(requests).toHaveLength(0);
});
