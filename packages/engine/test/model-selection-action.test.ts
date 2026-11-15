import { expect, test } from 'bun:test';
import { createModelSelectionAction } from '../terminal-shell/src/model-selection-action.ts';

function setup(failOn: string) {
  const config = new Map<string, unknown>([['helper.globalProvider', 'old-provider'], ['helper.globalModel', 'old:model'], ['helper.enabled', false], ['provider.model', 'old:model'], ['provider.reasoningEffort', 'medium']]);
  const configManager = {
    get: (key: string) => config.get(key),
    set: (key: string, value: unknown) => { if (key === failOn) throw new Error('disk full'); config.set(key, value); },
  };
  const logs: string[] = []; const registryCalls: string[] = []; let sideEffects = 0;
  const runtime = { model: 'old:model', provider: 'old-provider', reasoningEffort: 'medium' };
  const select = createModelSelectionAction(
    {
      providerRegistry: { setCurrentModel: (key: string) => { registryCalls.push(key); }, setModelContextCap: () => {} } as never,
      configManager: configManager as never,
      conversation: { log: (message: string) => { logs.push(message); } },
      runtime,
      requestRender: () => {},
      completeModelSelectionSideEffect: () => { sideEffects += 1; },
    },
    {
      setToolEnabled: () => {},
      effortModel: () => ({ id: 'm', provider: 'p' }) as never,
      publishEffortOptions: () => {},
      alwaysShowEffort: false,
      noteColor: () => '',
    },
  );
  return { select, config, logs, registryCalls, runtime, sideEffects: () => sideEffects };
}
const model = { id: 'new', provider: 'new-provider', displayName: 'New', registryKey: 'new-provider:new' };

test('a helper selection that fails part-way restores every key it wrote and skips the completion side effect', () => {
  const f = setup('helper.globalModel');
  f.select({ model, effort: 'medium', target: 'helper' });
  expect(f.config.get('helper.globalProvider')).toBe('old-provider');
  expect(f.config.get('helper.enabled')).toBe(false);
  expect(f.logs.join('\n')).toContain('previous selection was restored');
  expect(f.sideEffects()).toBe(0);
});

test('a main selection that fails after switching the registry puts the previous model back', () => {
  const f = setup('provider.model');
  f.select({ model, effort: 'medium', target: 'main' });
  expect(f.runtime.model).toBe('old:model');
  expect(f.registryCalls).toEqual(['new-provider:new', 'old:model']);
  expect(f.config.get('provider.model')).toBe('old:model');
  expect(f.sideEffects()).toBe(0);
});

test('a successful helper selection writes all three keys and completes', () => {
  const f = setup('never');
  f.select({ model, effort: 'medium', target: 'helper' });
  expect([f.config.get('helper.globalProvider'), f.config.get('helper.globalModel'), f.config.get('helper.enabled')]).toEqual(['new-provider', 'new-provider:new', true]);
  expect(f.sideEffects()).toBe(1);
});
