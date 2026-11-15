import { expect, test } from 'bun:test';
import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { buildFilteredModels } from '../terminal-shell/src/model-picker-filter.ts';
import { buildConfiguredViaMap, resolveSecretProviderIds } from '../terminal-shell/src/model-picker-auth-facts.ts';

const model = (provider: string, id: string): ModelDefinition => ({
  id, provider, registryKey: `${provider}:${id}`, displayName: id, description: '',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 8192, selectable: true, tier: 'free',
});
const params = (models: ModelDefinition[], recentIds: string[], pinnedIds: string[] = []) => ({
  models, configuredProviders: new Set<string>(), pinnedIds: new Set(pinnedIds), recentIds, query: '', categoryFilter: 'all' as const, capabilityFilter: 'none' as const,
  availableOnly: false, benchmarkSort: 'none' as const, groupBy: 'provider' as const, benchmarkStore: { getBenchmarks: () => null } as never,
  providerRegistry: { getSyntheticModelInfoFromCatalog: () => null } as never,
});

test('two models sharing an id across providers both stay in the list when that id is recent', () => {
  const first = model('ollama', 'llama3'); const second = model('custom', 'llama3'); const other = model('x', 'other');
  const { result } = buildFilteredModels(params([other, first, second], ['llama3']), null);
  expect(result).toHaveLength(3);
  expect(result[0]).toBe(first);
  expect(result).toContain(second);
});

test('a pinned id is not duplicated into the recent group', () => {
  const pinned = model('a', 'one'); const plain = model('b', 'two');
  const { result } = buildFilteredModels(params([plain, pinned], ['one', 'one', 'two'], ['one']), null);
  expect(result.map((entry) => entry.registryKey)).toEqual(['a:one', 'b:two']);
});

test('a key stored under its environment-style name makes the provider show as secrets', async () => {
  const vault = new Map([['OPENAI_API_KEY', 'sk-live'], ['MY_LOCAL_API_KEY', ''], ['EXTRA_NAME', 'v']]);
  const secrets = { get: async (name: string) => vault.get(name) ?? null };
  const ids = await resolveSecretProviderIds(() => ['openai', 'my-local', 'google', 'plain'], secrets, (id) => (id === 'google' ? ['EXTRA_NAME'] : []));
  expect([...ids].sort()).toEqual(['google', 'openai']);
  const via = buildConfiguredViaMap(['openai', 'plain'], new Set(['openai', 'plain']), { list: () => [] }, ids);
  expect(via.get('openai')).toBe('secrets');
  expect(via.get('plain')).toBe('env');
});

test('a key stored under a provider\'s declared environment name (not <ID>_API_KEY) shows as secrets by default', async () => {
  const secrets = { get: async (name: string) => (name === 'HF_API_KEY' ? 'hf-live' : null) };
  const ids = await resolveSecretProviderIds(() => ['huggingface', 'openai'], secrets);
  expect([...ids]).toEqual(['huggingface']);
});
