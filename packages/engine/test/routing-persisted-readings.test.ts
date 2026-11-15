import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ModelTierStore, type ModelFacts } from '../platform/src/platform/routing/model-tiers.ts';
import { ProviderAccessReadings, type ProviderFacts } from '../platform/src/platform/routing/catalog-access.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const facts: ModelFacts = { registryKey: 'fixture:small', id: 'small', name: 'Small fixture', provider: 'fixture' };

function smallModelPort(model?: string) {
  const fake = fakePort((name) => noulAnswer(name === 'small' ? 0.99 : 0.01));
  return { requests: fake.requests, port: model === undefined ? fake.port : { ...fake.port, model } as JudgmentPort };
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('ModelTierStore on disk', () => {
  test('readings saved by one process are still known to the next while the decision model is unchanged', async () => {
    const path = join(makeProjectTempDir('tier-store'), 'model-tiers.json');
    const first = smallModelPort();
    installJudgmentPort(first.port);
    expect((await new ModelTierStore({ path }).read(facts)).tier).toBe('economy');
    const reads = first.requests.length;
    expect(reads).toBeGreaterThan(0);

    const second = smallModelPort();
    installJudgmentPort(second.port);
    expect(new ModelTierStore({ path }).known(facts)?.tier).toBe('economy');
    expect(second.requests).toHaveLength(0);
  });

  test('readings made by another decision model are dropped', async () => {
    const path = join(makeProjectTempDir('tier-store'), 'model-tiers.json');
    installJudgmentPort(smallModelPort().port);
    await new ModelTierStore({ path }).read(facts);

    installJudgmentPort(smallModelPort('another-model').port);
    expect(new ModelTierStore({ path }).known(facts)).toBeUndefined();
  });

  test('an entry with an impossible tier is dropped when the file is loaded', async () => {
    const path = join(makeProjectTempDir('tier-store'), 'model-tiers.json');
    installJudgmentPort(smallModelPort().port);
    await new ModelTierStore({ path }).read(facts);
    const file = JSON.parse(readFileSync(path, 'utf-8')) as { entries: Record<string, { tier: string }> };
    file.entries[facts.registryKey]!.tier = 'bogus';
    file.entries['fixture:null'] = null as never;
    writeFileSync(path, JSON.stringify(file));

    const store = new ModelTierStore({ path });
    expect(store.known(facts)).toBeUndefined();
    expect(store.lastReading('fixture:null')).toBeUndefined();
  });
});

describe('ProviderAccessReadings on disk', () => {
  const provider: ProviderFacts = { id: 'p', name: 'P', envVars: [], sampleModels: [] };
  const answering = (local: number, plan: number) => fakePort((name) => noulAnswer(name === 'local' ? local : plan)).port;

  test('an entry with an access value outside the known ones is read again rather than trusted', async () => {
    const path = join(makeProjectTempDir('access-store'), 'provider-access.json');
    installJudgmentPort(answering(0.99, 0.01));
    expect((await new ProviderAccessReadings({ path }).readAll([provider])).get('p')).toBe('local');
    const file = JSON.parse(readFileSync(path, 'utf-8')) as { entries: Record<string, { access: string }> };
    file.entries['p']!.access = 'bogus';
    file.entries['q'] = null as never;
    writeFileSync(path, JSON.stringify(file));

    installJudgmentPort(answering(0.01, 0.01));
    expect((await new ProviderAccessReadings({ path }).readAll([provider])).get('p')).toBe('metered');
  });
});
