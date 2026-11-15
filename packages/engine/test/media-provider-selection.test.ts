import { afterEach, beforeEach, expect, test } from 'bun:test';
import { MediaProviderRegistry } from '../platform/src/platform/media/provider-registry.js';
import { ensureBuiltinMediaProviders } from '../platform/src/platform/media/builtin-providers.js';

const KEYS = ['BYTEPLUS_API_KEY', 'RUNWAYML_API_SECRET', 'RUNWAY_API_KEY', 'MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'FAL_KEY', 'FAL_API_KEY', 'COMFY_BASE_URL', 'COMFY_API_KEY'];
const saved = new Map<string, string | undefined>();
beforeEach(() => { for (const key of KEYS) { saved.set(key, process.env[key]); delete process.env[key]; } });
afterEach(() => { for (const key of KEYS) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

const anthropicOnly = {
  describeRuntime: async () => null,
  getCurrentModel: () => ({ provider: 'anthropic', capabilities: { multimodal: true } }),
  getForModel: () => { throw new Error('not used'); },
  listModels: () => [{ provider: 'anthropic', registryKey: 'anthropic:claude', id: 'claude', displayName: 'Claude', selectable: true, capabilities: { multimodal: true } }],
};

function builtins(): MediaProviderRegistry {
  const registry = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(registry, { readContent: async () => { throw new Error('not used'); } } as never, anthropicOnly as never);
  return registry;
}

test('an unscoped image lookup lands on the provider that accepts any multimodal model', () => {
  expect(builtins().findProvider('understand')?.id).toBe('builtin:image-understanding');
});

test('an unscoped generation lookup skips providers that are not configured', () => {
  process.env['FAL_KEY'] = 'synthetic-key';
  expect(builtins().findProvider('generate')?.id).toBe('fal');
});

test('an explicit provider id is still honoured even when it is not configured', () => {
  expect(builtins().findProvider('generate', 'byteplus')?.id).toBe('byteplus');
});
