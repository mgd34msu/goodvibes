import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionModelsDisabledError, decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { PostalAddressHeldError, readConfigSettingForDisplay } from '../sdk/src/platform/config/postal-address.ts';
import { OwnerProfileStore } from '../sdk/src/platform/owner-profile/store.ts';
import { createProfilePostalReader } from '../sdk/src/platform/owner-profile/postal-reading.ts';
import type { PostalProviders } from '../sdk/src/platform/owner-profile/postal-proposer.ts';

const roots: string[] = [];
let previous: JudgmentPort | undefined;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const parts = { name: null, line1: '10 Downing St', line2: null, city: 'London', region: null, postalCode: 'SW1A 2AA', country: 'UK' };
function fixture(source = '10 Downing St, London SW1A 2AA, UK') {
  const root = mkdtempSync(join(tmpdir(), 'postal-reading-')); roots.push(root);
  const path = join(root, 'profile.md'); writeFileSync(path, `# Owner\n\n## Commerce\nshipping address: ${source}\n`);
  const store = new OwnerProfileStore({ path }); store.loadSync();
  mkdirSync(join(root, 'cfg'));
  const config = new ConfigManager({ surfaceRoot: 'daemon', homeDir: root, configDir: join(root, 'cfg') });
  let calls = 0, revision = 0, wrong = false, decisions = 0;
  let proposalError: unknown;
  const provider = { async chat() { calls += 1; if (proposalError !== undefined) throw proposalError; return { content: JSON.stringify(parts), toolCalls: [], stopReason: 'completed' }; } };
  const providers = { getCurrentModel: () => ({ id: 'fixture', registryKey: 'fixture:fixture', provider: 'fixture' }),
    getForModel: () => provider, getModelRegistryRevision: () => revision } as unknown as PostalProviders;
  const port: JudgmentPort = { model: 'fixture', async ask(request) {
    decisions++;
    const answers = Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: wrong ? 0.9 : 0.01 }]));
    return { answers, model: 'fixture', requestedModel: 'fixture', requestId: undefined, latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } } as never;
  } };
  previous = installJudgmentPort(port); installed = true;
  const reader = createProfilePostalReader(store, () => config.get('profile.consumerFallback'), providers);
  config.attachProfilePostalFallback(reader);
  return { store, config, reader, calls: () => calls, decisions: () => decisions, failProposal: (error: unknown) => { proposalError = error; }, replaceModel: () => { revision += 2; }, reject: () => { wrong = true; } };
}

describe('prepared profile postal readings', () => {
  test('UK source is proposed and all populated/absent fields are verified; stored config wins', async () => {
    const f = fixture(); f.config.set('payments.shippingAddress.name', 'Owner');
    const prepared = await f.config.preparePostalAddress('shipping');
    expect(prepared.value?.name).toBe('Owner');
    expect(prepared.value?.line1).toBe('10 Downing St');
    expect(prepared.value?.postalCode).toBe('SW1A 2AA');
    expect(f.calls()).toBe(1); prepared.assertCurrent();
    expect(f.config.getRaw().payments.shippingAddress.postalCode).toBe('');
  });
  test('same-content reload and configuration ABA retire prepared values', async () => {
    const f = fixture(); const first = await f.config.preparePostalAddress('shipping');
    f.store.loadSync(); expect(first.assertCurrent).toThrow();
    const second = await f.config.preparePostalAddress('shipping');
    f.config.set('profile.consumerFallback', false); f.config.set('profile.consumerFallback', true);
    expect(second.assertCurrent).toThrow(PostalAddressHeldError);
  });
  test('provider incarnation changes retire already verified values', async () => {
    const f = fixture(); const prepared = await f.config.preparePostalAddress('shipping');
    f.replaceModel(); expect(prepared.assertCurrent).toThrow();
  });
  test('verifier rejection is held, never a missing address', async () => {
    const f = fixture(); f.reject(); await expect(f.config.preparePostalAddress('shipping')).rejects.toThrow(PostalAddressHeldError);
  });
  test('missing billing is null and never invokes a producer', async () => {
    const f = fixture(); expect((await f.config.preparePostalAddress('billing')).value).toBeNull(); expect(f.calls()).toBe(0);
  });
  test('cancelled caller cannot generate and held UI row is explicit', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.reader('shipping', { signal: controller.signal })).rejects.toThrow(PostalAddressHeldError);
    expect(f.calls()).toBe(0);
    const display = readConfigSettingForDisplay(() => { throw new PostalAddressHeldError(); });
    expect(display.value).toBeUndefined(); expect(display.held).toBeDefined();
  });
});

test('stored Classic policy prepares only native configured fields with zero proposal or decision calls', async () => {
  const f = fixture(); f.config.set('judgment.policy', 'Classic - Off');
  f.config.set('payments.shippingAddress.name', 'Explicit owner');
  f.config.set('payments.shippingAddress.line1', '42 Declared Lane');
  const prepared = await f.config.preparePostalAddress('shipping');
  expect(prepared).toMatchObject({ provenance: 'classic', profileAssessment: 'not-evaluated', value: {
    name: 'Explicit owner', line1: '42 Declared Lane', line2: '', city: '', region: '', postalCode: '', country: '',
  } });
  expect(f.calls()).toBe(0); expect(f.decisions()).toBe(0); prepared.assertCurrent();
  f.config.set('payments.shippingAddress.city', 'Declared town'); expect(prepared.assertCurrent).toThrow();
});

test('Classic prose profile address reports its limitation and never invents empty parsed parts', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const f = fixture();
    await expect(f.reader('shipping', {})).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect((await f.config.preparePostalAddress('shipping')).value).toBeNull();
    expect(f.calls()).toBe(0); expect(f.decisions()).toBe(0);
    const missing = await f.reader('billing', {}); expect(missing.value).toBeNull(); missing.assertCurrent();
  });
});

test('Preferred exhausted address verifier retains native configured fields and never repeats the proposer', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const f = fixture(); f.config.set('payments.shippingAddress.name', 'Explicit owner'); let decisions = 0;
    installJudgmentPort({ model: 'fixture', async ask() { decisions++; throw new JudgmentError('unavailable', 'Synthetic exhausted decision chain'); } });
    const prepared = await f.config.preparePostalAddress('shipping');
    expect(prepared).toMatchObject({ provenance: 'classic', profileAssessment: 'not-evaluated', value: { name: 'Explicit owner', line1: '', city: '' } });
    expect(decisionModelPolicyState().operation).toBe('classic'); expect(f.calls()).toBe(1); expect(decisions).toBe(1);
    prepared.assertCurrent();
    await f.config.preparePostalAddress('shipping'); expect(f.calls()).toBe(1); expect(decisions).toBe(1);
  });
});

test('Preferred ordinary proposal-provider failure cannot masquerade as decision-model exhaustion', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const f = fixture(); f.failProposal(new JudgmentError('unavailable', 'Synthetic content-provider outage'));
    await expect(f.config.preparePostalAddress('shipping')).rejects.toBeInstanceOf(PostalAddressHeldError);
    expect(decisionModelPolicyState().operation).toBe('decision'); expect(f.calls()).toBe(1); expect(f.decisions()).toBe(0);
  });
});

test('Preferred genuine address verification refusal is held without using Classic stored-only fallback', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const f = fixture(); f.reject();
    await expect(f.config.preparePostalAddress('shipping')).rejects.toBeInstanceOf(PostalAddressHeldError);
    expect(decisionModelPolicyState().operation).toBe('decision'); expect(f.calls()).toBe(1);
  });
});
