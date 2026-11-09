/** Native setting acceptance matches the actual transport boundary. UNRUN. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';

test('actual primary endpoint edits refuse embedded credentials/query/fragment without persisting an unusable target', () => {
  const root = mkdtempSync(join(tmpdir(), 'judgment-primary-endpoint-'));
  const config = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root, homeDir: root });
  try {
    config.setDynamic('judgment.endpoint', 'https://original.example.test/v1');
    const original = readFileSync(join(root, 'settings.json'), 'utf8');
    for (const endpoint of ['https://user:pass@example.test', 'https://example.test?token=example', 'https://example.test#fragment', 'https://example.test\\private']) {
      expect(() => config.setDynamic('judgment.endpoint', endpoint)).toThrow();
      expect(config.get('judgment.endpoint')).toBe('https://original.example.test/v1');
      expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(original);
    }
    config.setDynamic('judgment.endpoint', 'http://127.0.0.1:4321');
    expect(config.get('judgment.endpoint')).toBe('http://127.0.0.1:4321');
    config.setDynamic('judgment.endpoint', ''); expect(config.get('judgment.endpoint')).toBe('');
  } finally { config.stopWatchingConfigFiles(); rmSync(root, { recursive: true, force: true }); }
});
