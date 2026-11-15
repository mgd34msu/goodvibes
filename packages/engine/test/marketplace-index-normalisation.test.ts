/**
 * marketplace-index-normalisation.test.ts
 *
 * A parsed marketplace index hands on a lowercase pin and rejects malformed
 * counts, so what reaches the install review is what the pin check compares.
 */
import { describe, expect, test } from 'bun:test';
import { parseMarketplaceIndex } from '../platform/src/platform/runtime/ecosystem/marketplace-index.js';

function index(overrides: { sha256?: string; toolCount?: number; location?: string; kind?: string } = {}) {
  return {
    version: 1,
    bundles: [{
      id: 'b',
      name: 'B',
      version: '1.0.0',
      kind: 'plugin',
      summary: 'A bundle',
      source: { kind: overrides.kind ?? 'file', location: overrides.location ?? './b.json', sha256: overrides.sha256 ?? 'a'.repeat(64) },
      capabilities: { runtime: [], toolCount: overrides.toolCount ?? 0, hookCount: 0, configDomainCount: 0, channelCount: 0, highRisk: false },
    }],
  };
}

describe('parseMarketplaceIndex', () => {
  test('returns the pin in lowercase', () => {
    const result = parseMarketplaceIndex(index({ sha256: 'ABCDEF'.repeat(10) + 'ABCD' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.index.bundles[0]!.source.sha256).toBe('abcdef'.repeat(10) + 'abcd');
  });

  test('rejects negative, fractional and NaN counts', () => {
    for (const toolCount of [-1, 1.5, Number.NaN]) {
      expect(parseMarketplaceIndex(index({ toolCount })).ok).toBe(false);
    }
  });

  test('rejects a url source whose location is not an absolute URL', () => {
    expect(parseMarketplaceIndex(index({ kind: 'url', location: 'not a url' })).ok).toBe(false);
    expect(parseMarketplaceIndex(index({ kind: 'url', location: 'https://example.com/b.json' })).ok).toBe(true);
  });
});
