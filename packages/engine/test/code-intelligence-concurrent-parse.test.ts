/**
 * Two parses of one path at the same moment must each answer for their own text.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CodeIntelligence } from '../platform/src/platform/intelligence/facade.ts';

const intelligence = new CodeIntelligence({});
beforeAll(async () => { await intelligence.initialize(); });
afterAll(async () => { await intelligence.dispose(); });

describe('CodeIntelligence concurrent parses', () => {
  test('simultaneous symbol reads of one path return the symbols of their own content', async () => {
    const [first, second] = await Promise.all([
      intelligence.getSymbols('/p/mod.ts', 'export function alpha(): number { return 1; }\n'),
      intelligence.getSymbols('/p/mod.ts', 'export function beta(): number { return 2; }\nexport function gamma(): number { return 3; }\n'),
    ]);
    expect(first.map((symbol) => symbol.name)).toEqual(['alpha']);
    expect(second.map((symbol) => symbol.name)).toEqual(['beta', 'gamma']);
  });

  test('syntax diagnostics and outline of one path can overlap', async () => {
    const [diagnostics, outline] = await Promise.all([
      intelligence.getSyntaxDiagnostics('/p/bad.ts', 'function ( {\n'),
      intelligence.getOutline('/p/bad.ts', 'export function ok(): void {}\n'),
    ]);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(outline.length).toBeGreaterThan(0);
  });
});
