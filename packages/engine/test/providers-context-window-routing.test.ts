/**
 * Context window routing tests.
 *
 * Proves that getContextWindowForModel uses the resolved context window
 * with correct priority: a stated window (provider_api, configured_cap) beats
 * the OpenRouter cache, which beats the static registry value.
 */
import { afterEach, describe, test, expect } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { ModelLimitsService } from '@goodvibes-jev/engine/platform/platform/providers';
import { resolveContextWindow } from '@goodvibes-jev/engine/platform/platform/providers';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'test-model',
    provider: 'test-provider',
    registryKey: 'test-provider:test-model',
    displayName: 'Test Model',
    description: '',
    contextWindow: 32_768,
    selectable: true,
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: false,
      multimodal: false,
    },
    ...overrides,
  };
}

function makeModelLimitsService(): ModelLimitsService {
  const root = makeProjectTempDir('gv-model-limits');
  tempRoots.push(root);
  return new ModelLimitsService({
    cachePath: join(root, 'model-limits.json'),
  });
}

/** A service whose on-disk OpenRouter cache lists one model with a 131_072 window. */
function makeModelLimitsServiceWithOpenRouterEntry(): ModelLimitsService {
  const root = makeProjectTempDir('gv-model-limits');
  tempRoots.push(root);
  const cachePath = join(root, 'model-limits.json');
  writeFileSync(cachePath, JSON.stringify({
    version: 1,
    fetchedAt: Date.now(),
    ttlMs: 24 * 60 * 60 * 1000,
    models: { 'meta-llama/llama-3.1-8b-instruct': { contextLength: 131_072, maxOutputTokens: null, supportedParameters: [] } },
  }), 'utf-8');
  const service = new ModelLimitsService({ cachePath });
  service.init();
  return service;
}

const OPENROUTER_ID = 'meta-llama/llama-3.1-8b-instruct';

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// provider_api provenance is highest priority in getContextWindowForModel
// ---------------------------------------------------------------------------

describe('getContextWindowForModel: provider_api provenance', () => {
  test('uses contextWindow directly when provenance is provider_api', () => {
    const modelLimitsService = makeModelLimitsService();
    const model = makeModel({
      contextWindow: 131_072,
      contextWindowProvenance: 'provider_api',
    });
    // Even without OpenRouter cache, the provider_api value should be used.
    const result = modelLimitsService.getContextWindowForModel(model);
    expect(result).toBe(131_072);
  });

  test('uses contextWindow directly when provenance is provider_api (large context)', () => {
    const modelLimitsService = makeModelLimitsService();
    const model = makeModel({
      contextWindow: 1_048_576,
      contextWindowProvenance: 'provider_api',
    });
    const result = modelLimitsService.getContextWindowForModel(model);
    expect(result).toBe(1_048_576);
  });

  test('provider_api wins over a different OpenRouter cache entry for the same model', () => {
    const modelLimitsService = makeModelLimitsServiceWithOpenRouterEntry();
    const withoutProvenance = makeModel({ id: OPENROUTER_ID, contextWindow: 32_768 });
    // Control: the cache is loaded and does answer for this id.
    expect(modelLimitsService.getContextWindowForModel(withoutProvenance)).toBe(131_072);

    const stated = makeModel({ id: OPENROUTER_ID, contextWindow: 32_768, contextWindowProvenance: 'provider_api' });
    expect(modelLimitsService.getContextWindowForModel(stated)).toBe(32_768);
  });

  test('falls through to contextWindow when no provenance and no OpenRouter cache', () => {
    const modelLimitsService = makeModelLimitsService();
    const model = makeModel({
      contextWindow: 16_384,
      // No contextWindowProvenance
    });
    // Without OpenRouter cache loaded, falls back to static value.
    const result = modelLimitsService.getContextWindowForModel(model);
    expect(result).toBe(16_384);
  });
});

// ---------------------------------------------------------------------------
// configured_cap and fallback provenance
// ---------------------------------------------------------------------------

describe('getContextWindowForModel: configured_cap and fallback', () => {
  test('configured_cap is authoritative over an OpenRouter cache entry', () => {
    const modelLimitsService = makeModelLimitsServiceWithOpenRouterEntry();
    const model = makeModel({
      id: OPENROUTER_ID,
      contextWindow: 65_536,
      contextWindowProvenance: 'configured_cap',
    });
    expect(modelLimitsService.getContextWindowForModel(model)).toBe(65_536);
  });

  test('fallback provenance falls through to registry value', () => {
    const modelLimitsService = makeModelLimitsService();
    const model = makeModel({
      contextWindow: 8_192,
      contextWindowProvenance: 'fallback',
    });
    const result = modelLimitsService.getContextWindowForModel(model);
    expect(result).toBe(8_192);
  });
});

// ---------------------------------------------------------------------------
// resolveContextWindow integration: correct model building
// ---------------------------------------------------------------------------

describe('resolveContextWindow + ModelDefinition integration', () => {
  test('building a ModelDefinition with provider_api provenance sets correct contextWindow', () => {
    const modelLimitsService = makeModelLimitsService();
    const apiContextLength = 200_000;
    const configuredContextWindow = 32_768;

    const resolved = resolveContextWindow('llama-3', apiContextLength, configuredContextWindow);
    expect(resolved.provenance).toBe('provider_api');

    const model = makeModel({
      contextWindow: resolved.tokens,
      contextWindowProvenance: resolved.provenance,
    });

    // getContextWindowForModel should return the API-reported value
    const effective = modelLimitsService.getContextWindowForModel(model);
    expect(effective).toBe(200_000);
  });

  test('building with fallback provenance still yields non-zero context window', () => {
    const modelLimitsService = makeModelLimitsService();
    const resolved = resolveContextWindow('unknown-local-model', null, 0);
    expect(resolved.provenance).toBe('fallback');
    expect(resolved.tokens).toBeGreaterThan(0);

    const model = makeModel({
      contextWindow: resolved.tokens,
      contextWindowProvenance: resolved.provenance,
    });

    const effective = modelLimitsService.getContextWindowForModel(model);
    expect(effective).toBeGreaterThan(0);
  });
});
