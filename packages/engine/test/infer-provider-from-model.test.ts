import { describe, expect, test } from 'bun:test';
import { BUILTIN_COMPAT_PROVIDERS } from '../platform/src/platform/providers/builtin-catalog.js';
import { inferProviderFromModel } from '../terminal-shell/src/cli-command-catalog.js';

describe('inferProviderFromModel', () => {
  test('every catalog provider id names its provider', () => {
    for (const entry of BUILTIN_COMPAT_PROVIDERS) {
      expect(inferProviderFromModel(`${entry.id}:some-model`)).toBe(entry.id);
    }
  });

  test('the subscription login and local providers name their provider', () => {
    expect(inferProviderFromModel('openai-subscriber:gpt-5')).toBe('openai-subscriber');
    expect(inferProviderFromModel('ollama:llama3:8b')).toBe('ollama');
  });

  test('a colon inside a model id is not a provider qualifier', () => {
    expect(inferProviderFromModel('llama3:8b')).toBeUndefined();
    expect(inferProviderFromModel('some-model:free')).toBeUndefined();
  });
});
