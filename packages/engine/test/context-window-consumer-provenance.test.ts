import { describe, expect, test } from 'bun:test';
import { readModelContextWindow } from '../platform/src/platform/providers/context-window-reading.js';
import { createSessionRuntimeControls } from '../platform/src/platform/control-plane/routes/session-runtime.js';
import { ModelLimitsService } from '../platform/src/platform/providers/model-limits.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import { enrichModelEntries } from '../platform/src/platform/runtime/ui/model-picker/health-enrichment.js';
import { createInitialModelState } from '../platform/src/platform/runtime/store/domains/model.js';
import { createInitialProviderHealthState } from '../platform/src/platform/runtime/store/domains/provider-health.js';

const model: ModelDefinition = { id: 'm', provider: 'p', registryKey: 'p:m', displayName: 'm', description: '', selectable: true,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 8192 };
const limits = new ModelLimitsService({ cachePath: '/unused/consumer-context-limits.json' });

function picker(definition: ModelDefinition) {
  return enrichModelEntries([definition], createInitialProviderHealthState(), createInitialModelState(), new Set(),
    { getBenchmarks: () => undefined }, {
      getSyntheticModelInfoFromCatalog: () => null,
      getContextWindowForModel: (entry) => limits.getContextWindowForModel(entry),
      getKnownContextWindowForModel: (entry) => limits.getKnownContextWindowForModel(entry),
    }, () => undefined)[0]!;
}

describe('picker carries numeric budget separately from known capacity', () => {
  test('consensus retains estimate origin and a null known ceiling', () => {
    const origin = { kind: 'consensus' as const, providers: 4, agreeing: 3 };
    const entry = picker({ ...model, contextWindowProvenance: 'catalog', contextWindowOrigin: origin });
    expect(entry.contextWindow).toBe(8192);
    expect(entry.knownContextWindow).toBeNull();
    expect(entry.contextWindowOrigin).toEqual(origin);
    expect(entry.contextWindowSource).toBe('catalog');
  });
  test('accepted lower bounds survive a larger display estimate', () => {
    const entry = picker({ ...model, contextWindow: 128000, contextWindowProvenance: 'fallback', contextWindowAcceptedFloor: 24000 });
    expect(entry.contextWindow).toBe(128000);
    expect(entry.knownContextWindow).toBeNull();
    expect(entry.contextWindowAcceptedFloor).toBe(24000);
  });
  test('own-provider catalog origin remains known', () => {
    const origin = { kind: 'catalog' as const, catalogProviderId: 'p' };
    const entry = picker({ ...model, contextWindowProvenance: 'catalog', contextWindowOrigin: origin });
    expect(entry.knownContextWindow).toBe(8192);
    expect(entry.contextWindowOrigin).toEqual(origin);
  });
  test('invalid raw window gets a numeric fallback without falsely labeling OpenRouter', () => {
    const entry = picker({ ...model, contextWindow: Number.NaN });
    expect(Number.isFinite(entry.contextWindow)).toBe(true);
    expect(entry.knownContextWindow).toBeNull();
    expect(entry.contextWindowSource).toBe('fallback');
  });
  test.each(['fallback', 'accepted_floor'] as const)('%s stays nullable in the UI output', (source) => {
    const entry = picker({ ...model, contextWindowProvenance: source });
    expect(entry.knownContextWindow).toBeNull();
    expect(entry.contextWindowSource).toBe(source);
  });
});
