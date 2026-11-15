/**
 * Voice provider registry, and which built-in providers offer speech-to-text
 * and realtime once the built-ins are registered.
 */

import { describe, expect, test } from 'bun:test';
import { ensureBuiltinVoiceProviders } from '../platform/src/platform/voice/builtin-providers.js';
import { VoiceProviderRegistry } from '../platform/src/platform/voice/provider-registry.js';

const MOCK_PROVIDER = {
  id: 'test-stt-provider',
  label: 'Test STT Provider',
  capabilities: ['stt' as const],
};

describe('platform/voice: behavior smoke', () => {
  test('register + get returns the registered provider', () => {
    const registry = new VoiceProviderRegistry();
    registry.register(MOCK_PROVIDER);
    // VoiceProviderRegistry.get() returns null on miss, not undefined
    const found = registry.get(MOCK_PROVIDER.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(MOCK_PROVIDER.id);
    expect(found?.label).toBe(MOCK_PROVIDER.label);
  });

  test('list includes the registered provider', () => {
    const registry = new VoiceProviderRegistry();
    registry.register(MOCK_PROVIDER);
    const all = registry.list();
    expect(all).toBeInstanceOf(Array);
    const ids = all.map((p) => p.id);
    expect(ids).toContain(MOCK_PROVIDER.id);
  });

  test('findProvider by capability returns the mock provider', () => {
    const registry = new VoiceProviderRegistry();
    registry.register(MOCK_PROVIDER);
    const found = registry.findProvider('stt');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(MOCK_PROVIDER.id);
  });

  test('get on unknown id returns null (not undefined)', () => {
    const registry = new VoiceProviderRegistry();
    const result = registry.get('unknown-provider-id');
    expect(result).toBeNull();
  });

  test('the built-ins register every cloud route and expose STT and realtime through capability lookup', () => {
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    expect(registry.list().map((p) => p.id).sort()).toEqual(
      ['deepgram', 'elevenlabs', 'google', 'microsoft', 'openai', 'vydra'],
    );
    const withCapability = (capability: 'stt' | 'realtime') =>
      registry.list().filter((p) => p.capabilities.includes(capability)).map((p) => p.id).sort();
    expect(withCapability('stt')).toEqual(['deepgram', 'elevenlabs', 'google', 'openai']);
    expect(withCapability('realtime')).toEqual(['elevenlabs', 'openai']);
    expect(registry.findProvider('realtime')).not.toBeNull();
  });

  test('registering the built-ins twice replaces rather than duplicates', () => {
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const first = registry.list().length;
    ensureBuiltinVoiceProviders(registry);
    expect(registry.list()).toHaveLength(first);
  });
});
