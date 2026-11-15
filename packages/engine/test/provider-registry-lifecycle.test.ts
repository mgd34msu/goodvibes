import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegistrableProvider } from '../platform/src/platform/providers/interface.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';
import { providerAdapterKind } from '../platform/src/platform/providers/adapter-kind.ts';
import { makeProvider, makeRegistry, writeCustomProvider } from './_helpers/provider-registry-double.ts';

describe('runtime provider unregister', () => {
  test('an earlier owner unregistering does not remove the provider that replaced it', () => {
    const registry = makeRegistry();
    const first = makeProvider('plugin-x', ['m1']);
    const second = makeProvider('plugin-x', ['m2']);
    const unregisterFirst = registry.registerRuntimeProvider({ provider: first });
    const unregisterSecond = registry.registerRuntimeProvider({ provider: second });
    unregisterFirst();
    expect(registry.tryGet('plugin-x')).toBe(second);
    unregisterSecond();
    expect(registry.tryGet('plugin-x')).toBeUndefined();
  });
});

describe('custom providers that are removed', () => {
  function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-provider-lifecycle-'));
    return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
  }

  test('deleting a custom provider file removes the provider on reload', () => withRoot(async (root) => {
    writeCustomProvider(root, 'foo', 'foo-model');
    const registry = makeRegistry(root);
    const first = await registry.loadCustomProviders();
    expect(first.added).toContain('foo:foo-model');
    expect(registry.tryGet('foo')).toBeDefined();
    unlinkSync(join(root, 'providers', 'foo.json'));
    const second = await registry.loadCustomProviders();
    expect(second.removed).toContain('foo:foo-model');
    expect(registry.tryGet('foo')).toBeUndefined();
  }));

  test('a custom file named like a built-in is refused and leaves the built-in and its adapter kind alone', () => withRoot(async (root) => {
    const registry = makeRegistry(root);
    const builtin = { ...makeProvider('shadowed', []), adapterKind: 'anthropic', modelSource: { kind: 'catalog-backed' } } as unknown as RegistrableProvider;
    registry.register(builtin);
    writeCustomProvider(root, 'shadowed', 'custom-model');
    const result = await registry.loadCustomProviders();
    expect(result.warnings.some((warning) => warning.includes("'shadowed' is a built-in provider name"))).toBe(true);
    expect(registry.tryGet('shadowed')).toBe(builtin);
    expect(providerAdapterKind('shadowed')).toBe('anthropic');
    unlinkSync(join(root, 'providers', 'shadowed.json'));
    await registry.loadCustomProviders();
    expect(registry.tryGet('shadowed')).toBe(builtin);
    expect(providerAdapterKind('shadowed')).toBe('anthropic');
  }));

  test('a deleted custom provider with nothing to restore leaves no adapter kind behind', () => withRoot(async (root) => {
    const registry = makeRegistry(root);
    writeCustomProvider(root, 'lonely', 'lonely-model');
    await registry.loadCustomProviders();
    expect(providerAdapterKind('lonely')).toBe('openai-compat');
    unlinkSync(join(root, 'providers', 'lonely.json'));
    await registry.loadCustomProviders();
    expect(providerAdapterKind('lonely')).toBeUndefined();
  }));

  test('a runtime provider of the same name is left alone when the custom file goes', () => withRoot(async (root) => {
    const registry = makeRegistry(root);
    writeCustomProvider(root, 'both', 'custom-model');
    await registry.loadCustomProviders();
    const runtime = makeProvider('both', ['r1']);
    registry.registerRuntimeProvider({ provider: runtime, replace: true });
    unlinkSync(join(root, 'providers', 'both.json'));
    await registry.loadCustomProviders();
    expect(registry.tryGet('both')).toBe(runtime);
  }));
});

describe('custom provider startup load', () => {
  test('a failed first load is logged instead of vanishing', async () => {
    const registry = makeRegistry();
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      registry.loadCustomProviders = async () => { throw new Error('providers directory unreadable'); };
      registry.initCustomProviders();
      await registry.ready();
      expect(warn.mock.calls.some(([message]) => String(message).includes('providers directory unreadable'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
