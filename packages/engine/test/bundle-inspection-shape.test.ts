import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrustCommandFlow, createTrustReviewTools } from '../terminal-shell/src/trust-review.js';
import { inspectVoiceBundle } from '../terminal-shell/src/voice-settings-review.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const tools = createTrustReviewTools<null>({
  listSecrets: async () => ['OPENAI_API_KEY'],
  serviceNames: () => ['github'],
  security: () => ({ plugins: [], mcpServers: [] }),
  permissionMode: () => 'safe-owner',
  serviceLabel: 'services',
});

describe('trust bundle', () => {
  test('an exported bundle is owner-only and inspects back', async () => {
    const dir = makeProjectTempDir('trust-bundle');
    const printed: string[] = [];
    const flow = createTrustCommandFlow<{ print(text: string): void }, unknown>({
      buildTrustReviewBundle: () => tools.buildTrustReviewBundle(null), formatTrustReview: String, inspectTrustBundle: tools.inspectTrustBundle,
    });
    const ports = { resolvePath: (path: string) => join(dir, path), allowExport: () => true };
    const ctx = { print: (text: string) => printed.push(text) };
    await flow(ctx, ['bundle', 'export', 'trust.json'], ports);
    expect(statSync(join(dir, 'trust.json')).mode & 0o077).toBe(0);
    await flow(ctx, ['bundle', 'inspect', 'trust.json'], ports);
    expect(printed.at(-1)).toContain('Trust Bundle Review');
    expect(printed.at(-1)).toContain('secrets stored: 1');
  });

  test('a JSON file of another kind is named as such instead of throwing', () => {
    const dir = makeProjectTempDir('trust-bundle');
    writeFileSync(join(dir, 'other.json'), '{}');
    expect(tools.inspectTrustBundle(join(dir, 'other.json'))).toContain('is not a trust bundle');
    expect(existsSync(join(dir, 'other.json'))).toBe(true);
    expect(readFileSync(join(dir, 'other.json'), 'utf-8')).toBe('{}');
  });
});

describe('voice bundle', () => {
  test('a value of the wrong shape is named as such instead of throwing', () => {
    expect(inspectVoiceBundle({})).toContain('not a voice bundle');
    expect(inspectVoiceBundle(null)).toContain('not a voice bundle');
  });
  test('a real bundle is described', () => {
    expect(inspectVoiceBundle({ version: 1, exportedAt: 1_700_000_000_000, enabled: true, notes: ['a'] })).toContain('enabled: yes');
  });
});
