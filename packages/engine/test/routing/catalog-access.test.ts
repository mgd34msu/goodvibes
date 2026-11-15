import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ProviderAccessReadings, providerAccessFrom } from '../../platform/src/platform/routing/catalog-access.js';
import { transformModelsDevResponse } from '../../platform/src/platform/providers/model-catalog-cache.js';
import { withDecisionModelPolicy } from '../../platform/src/platform/runtime/decision-policy.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const yes = { kind: 'yes-no' as const, probability: 0.95, verdict: 'yes' as const, outcome: 'act' as const };
const no = { kind: 'yes-no' as const, probability: 0.05, verdict: 'no' as const, outcome: 'act' as const };
const unsure = { kind: 'yes-no' as const, probability: 0.5, verdict: 'uncertain' as const, outcome: 'escalate' as const };

describe('provider access composition', () => {
  test('plan, metered and unsettled', () => {
    expect(providerAccessFrom({ plan: yes })).toBe('subscription');
    expect(providerAccessFrom({ plan: no })).toBe('metered');
    expect(providerAccessFrom({ plan: unsure })).toBeUndefined();
    expect(providerAccessFrom({ plan: { ...no, outcome: 'confirm' } })).toBeUndefined();
  });
});

describe('catalog tiers', () => {
  const feed = {
    metered: { id: 'metered', name: 'Metered', env: ['M_KEY'], models: { a: { id: 'a', cost: { input: 0, output: 0 } }, b: { id: 'b', cost: { input: 1, output: 2 } } } },
    plan: { id: 'plan', name: 'Plan', env: ['P_KEY'], models: { c: { id: 'c', cost: { input: 0, output: 0 } } } },
    unsettled: { id: 'unsettled', name: 'Unsettled', env: [], models: { d: { id: 'd', cost: { input: 0, output: 0 } } } },
  };

  test('zero cost is free only for a provider read as metered', () => {
    const access = new Map([['metered', 'metered' as const], ['plan', 'subscription' as const], ['unsettled', undefined]]);
    const tiers = Object.fromEntries(transformModelsDevResponse(feed, access).map((model) => [model.id, model.tier]));
    expect(tiers).toEqual({ a: 'free', b: 'paid', c: 'subscription', d: 'paid' });
  });
});

describe('access readings', () => {
  const providers = [
    { id: 'x', name: 'X Coding Plan', envVars: ['X'], sampleModels: ['m'] },
    { id: 'y', name: 'Y Cloud', envVars: ['Y'], sampleModels: ['n'] },
  ];
  const planPort = () => fakePort((_name: string, _question, state: EntryType) =>
    noulAnswer(JSON.stringify(state).includes('Coding Plan') ? 0.95 : 0.05));

  test('each provider is read once per set of facts, remembered on disk, and a local address is never asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-access-'));
    try {
      const { port, requests } = planPort();
      installJudgmentPort(port);
      const path = join(dir, 'provider-access.json');
      const local = { id: 'lm', name: 'LM', api: 'http://127.0.0.1:1234/v1', envVars: [], sampleModels: [] };
      const first = await new ProviderAccessReadings({ path }).readAll([...providers, local]);
      expect(first.get('x')).toBe('subscription');
      expect(first.get('y')).toBe('metered');
      expect(first.get('lm')).toBe('local');
      expect(requests).toHaveLength(2);
      const again = await new ProviderAccessReadings({ path }).readAll([...providers, { id: 'z', name: 'Z', envVars: [], sampleModels: [] }]);
      expect(again.get('x')).toBe('subscription');
      expect(requests).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('remembered readings answer under Classic with no request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-access-'));
    try {
      const path = join(dir, 'provider-access.json');
      installJudgmentPort(planPort().port);
      await new ProviderAccessReadings({ path }).readAll(providers);
      const { port, requests } = planPort();
      installJudgmentPort(port);
      await withDecisionModelPolicy(() => 'Classic - Off', async () => {
        const access = await new ProviderAccessReadings({ path }).readAll(providers);
        expect(access.get('x')).toBe('subscription');
        expect(access.get('y')).toBe('metered');
      });
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readings that completed are kept when another fails, and only the failed one is asked again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-access-'));
    try {
      const path = join(dir, 'provider-access.json');
      const many = Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, envVars: [], sampleModels: [] }));
      const failing = fakePort((_name: string, _question, state: EntryType) => {
        if (JSON.stringify(state).includes('"P4"')) throw new Error('reading failed');
        return noulAnswer(0.05);
      });
      installJudgmentPort(failing.port);
      await expect(new ProviderAccessReadings({ path }).readAll(many)).rejects.toThrow('reading failed');
      expect(existsSync(path)).toBe(true);
      const saved = Object.keys((JSON.parse(readFileSync(path, 'utf-8')) as { entries: Record<string, unknown> }).entries);
      expect(saved).not.toContain('p4');
      const { port, requests } = planPort();
      installJudgmentPort(port);
      const access = await new ProviderAccessReadings({ path }).readAll(many);
      expect(requests).toHaveLength(many.length - saved.length);
      expect(access.get('p4')).toBe('metered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
