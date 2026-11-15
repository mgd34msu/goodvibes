/** One bad provider file never takes the other provider files down with it. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCustomProviders } from '../platform/src/platform/providers/custom-loader.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'custom-provider-files-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function providerFile(name: string, modelOverrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: name,
    type: 'openai-compat',
    baseURL: 'http://127.0.0.1:1/v1',
    models: [{
      id: `${name}-model`,
      displayName: 'Model',
      contextWindow: 8192,
      capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
      ...modelOverrides,
    }],
  };
}
const write = (file: string, body: unknown) => writeFileSync(join(dir, file), JSON.stringify(body));

describe('loadCustomProviders', () => {
  test('a model with a string reasoningEffort skips only its file, and the warning names the file', async () => {
    write('good.json', providerFile('good'));
    write('bad.json', providerFile('bad', { reasoningEffort: 'high' }));
    const result = await loadCustomProviders({ providersDir: dir });
    expect(result.providers.map(({ config }) => config.name)).toEqual(['good']);
    expect(result.warnings.some((warning) => warning.includes("'bad.json'") && warning.includes('reasoningEffort'))).toBe(true);
  });

  test('unusable tier, headers and key types are rejected per file', async () => {
    write('good.json', providerFile('good'));
    write('tier.json', providerFile('tier', { tier: 'platinum' }));
    write('headers.json', { ...providerFile('headers'), defaultHeaders: { 'x-a': 1 } });
    write('key.json', { ...providerFile('key'), apiKey: 42 });
    const result = await loadCustomProviders({ providersDir: dir });
    expect(result.providers.map(({ config }) => config.name)).toEqual(['good']);
    expect(result.warnings).toHaveLength(3);
  });

  test('a file that names a reserved (built-in) provider is skipped with a warning', async () => {
    write('openai.json', providerFile('openai'));
    write('other.json', providerFile('other'));
    const result = await loadCustomProviders({ providersDir: dir, reservedNames: new Set(['openai']) });
    expect(result.providers.map(({ config }) => config.name)).toEqual(['other']);
    expect(result.warnings.some((warning) => warning.includes("'openai.json'") && warning.includes('built-in'))).toBe(true);
  });

  test('two files with one provider name keep the first and warn about the second', async () => {
    write('a.json', providerFile('same'));
    write('b.json', providerFile('same'));
    const result = await loadCustomProviders({ providersDir: dir });
    expect(result.providers).toHaveLength(1);
    expect(result.models).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes('already defined'))).toBe(true);
  });
});
