import { afterEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tokenStore } from './client-lifetime';
import { useProviderModelOptions } from './use-provider-model-options';

const catalog = [{ providerId: 'inceptionlabs', models: ['model-fixture'] }, { providerId: 'openai', models: ['other'] }];
function mount(provider: unknown) {
  let result!: ReturnType<typeof useProviderModelOptions>;
  function Caller() {
    result = useProviderModelOptions(provider, catalog);
    return <div>{result.models.map(model => model.registryKey).join(',')}</div>;
  }
  const host = document.createElement('div'); const root = createRoot(host); let mounted = true;
  flushSync(() => root.render(<Caller />));
  return { result: () => result, unmount() { if (mounted) { mounted = false; flushSync(() => root.unmount()); } } };
}
afterEach(async () => { await tokenStore.clearToken(); });

test('a custom provider with no declared base shows only its own models', async () => {
  await tokenStore.setToken('fixture-browser-owner');
  const h = mount({ providerId: 'custom-adapter', models: [{ id: 'own-model' }] });
  try { expect(h.result().models.map(model => model.registryKey)).toEqual(['custom-adapter:own-model']); } finally { h.unmount(); }
});

test('a declared alias or catalog id shows that catalog provider\'s models', async () => {
  await tokenStore.setToken('fixture-browser-owner');
  for (const provider of [{ providerId: 'inception' }, { providerId: 'custom-adapter', catalogProviderId: 'inceptionlabs' }]) {
    const h = mount(provider);
    try { expect(h.result().models.map(model => model.registryKey)).toEqual(['inceptionlabs:model-fixture']); } finally { h.unmount(); }
  }
});

test('unmount revokes a detached selection handler', async () => {
  await tokenStore.setToken('fixture-browser-owner');
  const h = mount({ providerId: 'inception' });
  const detached = h.result(); expect(detached.hasCurrentModel('inceptionlabs:model-fixture')).toBe(true);
  h.unmount(); expect(detached.hasCurrentModel('inceptionlabs:model-fixture')).toBe(false);
});
