import { describe, expect, it } from 'bun:test';
import {
  formatProviderModel,
  getModelIdFromProviderModel,
  getProviderIdFromModel,
} from '../../config/provider-model.ts';
import { DEFAULT_CONFIG } from '@goodvibes-jev/engine/platform/platform/config';

const defaultProviderId = getProviderIdFromModel(DEFAULT_CONFIG.provider.model);

describe('getProviderIdFromModel', () => {
  it('extracts provider from valid provider:model strings', () => {
    expect(getProviderIdFromModel('anthropic:claude-3-5-sonnet-20241022')).toBe('anthropic');
    expect(getProviderIdFromModel('openai:gpt-4o')).toBe('openai');
  });

  it('reads a bare value as the provider id', () => {
    expect(getProviderIdFromModel('gpt-4o')).toBe('gpt-4o');
  });

  it('returns the default provider for an empty string', () => {
    const result = getProviderIdFromModel('');
    expect(result).toBe(defaultProviderId);
  });

  it('returns the default provider for null/undefined', () => {
    expect(getProviderIdFromModel(null)).toBe(defaultProviderId);
    expect(getProviderIdFromModel(undefined)).toBe(defaultProviderId);
  });
});

describe('getModelIdFromProviderModel', () => {
  it('extracts model from provider:model strings', () => {
    expect(getModelIdFromProviderModel('anthropic:claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022');
    expect(getModelIdFromProviderModel('openai:gpt-4o')).toBe('gpt-4o');
  });

  it('returns full string for bare model (no provider prefix)', () => {
    expect(getModelIdFromProviderModel('gpt-4o')).toBe('gpt-4o');
  });

  it('falls back to the default model half for an empty value', () => {
    expect(getModelIdFromProviderModel('')).toBe(getModelIdFromProviderModel(DEFAULT_CONFIG.provider.model));
  });
});

describe('formatProviderModel', () => {
  it('formats provider:model correctly', () => {
    expect(formatProviderModel('anthropic', 'claude-3-5-sonnet-20241022')).toBe('anthropic:claude-3-5-sonnet-20241022');
  });

  it('qualifies a model id that carries its own colon', () => {
    expect(formatProviderModel('ollama', 'llama3:8b')).toBe('ollama:llama3:8b');
    expect(formatProviderModel('ollama', 'ollama:llama3:8b')).toBe('ollama:llama3:8b');
  });

  it('returns model alone when provider is empty', () => {
    expect(formatProviderModel('', 'gpt-4o')).toBe('gpt-4o');
  });
});
