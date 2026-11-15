import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import {
  appendGoodVibesRuntimeAwarenessPrompt,
  createGoodVibesContextTool,
  createGoodVibesSettingsTool,
} from '../platform/src/platform/tools/goodvibes-runtime/index.js';
import { isSecretBearingConfigKey } from '../platform/src/platform/config/secret-bearing-config-keys.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { useConfigReadings } from './_helpers/config-readings.ts';

function makeConfigManager(): ConfigManager {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-runtime-tool-'));
  return new ConfigManager({
    configDir: join(root, 'config'),
    homeDir: join(root, 'home'),
    workingDir: join(root, 'workspace'),
    surfaceRoot: 'goodvibes',
  });
}

function makeProviderRegistry() {
  return {
    getCurrentModel: () => ({
      id: 'gpt-5.5',
      provider: 'openai',
      registryKey: 'openai:gpt-5.5',
      displayName: 'GPT-5.5',
    }),
    listProviders: () => [{ name: 'openai' }],
    listModels: () => [{ id: 'gpt-5.5', provider: 'openai', registryKey: 'openai:gpt-5.5' }],
    getConfiguredProviderIds: () => ['openai'],
  };
}

function makeDeps(configManager = makeConfigManager()) {
  return {
    configManager,
    providerRegistry: makeProviderRegistry() as never,
    toolRegistry: new ToolRegistry(),
    workingDirectory: configManager.getWorkingDirectory() ?? '',
    homeDirectory: configManager.getHomeDirectory() ?? '',
    surfaceRoot: 'goodvibes',
  };
}

describe('GoodVibes runtime tools', () => {
  // Values under keys the declared list does not name are read for
  // credential material; none of this block's values reads as one.
  useConfigReadings({});

  test('goodvibes_context returns redacted settings and never raw secrets', async () => {
    const configManager = makeConfigManager();
    configManager.set('surfaces.homeassistant.accessToken', 'goodvibes://secrets/goodvibes/HASS_TOKEN');
    const tool = createGoodVibesContextTool(makeDeps(configManager));

    const result = await tool.execute({
      mode: 'config_get',
      key: 'surfaces.homeassistant.accessToken',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('"redacted": true');
    expect(result.output).not.toContain('HASS_TOKEN');
  });

  test('goodvibes_settings changes normal settings through ConfigManager validation', async () => {
    const configManager = makeConfigManager();
    const tool = createGoodVibesSettingsTool({ configManager });

    const result = await tool.execute({
      mode: 'set',
      key: 'display.theme',
      value: 'catppuccin',
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(configManager.get('display.theme')).toBe('catppuccin');
  });

  test('goodvibes_settings rejects unknown, non-string and noncanonical new palette values without mutation', async () => {
    const configManager = makeConfigManager();
    configManager.set('display.theme', 'nord');
    const before = readFileSync(configManager.getConfigPath(), 'utf-8');
    const changes: unknown[] = [];
    configManager.subscribe('display.theme', (next) => { changes.push(next); });
    const tool = createGoodVibesSettingsTool({ configManager });
    for (const value of ['midnight', ' NORD ', 'DRACULA', ' VAPORWAVE ', 12, false, null, [], {}]) {
      const result = await tool.execute({ mode: 'set', key: 'display.theme', value, confirm: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid value for display.theme');
      expect(result.output).toBeUndefined();
      expect(configManager.get('display.theme')).toBe('nord');
      expect(readFileSync(configManager.getConfigPath(), 'utf-8')).toBe(before);
      expect(changes).toEqual([]);
    }
  });

  test('goodvibes_context exposes the exact palette enum and fresh default', async () => {
    const result = await createGoodVibesContextTool(makeDeps()).execute({ mode: 'config_schema', key: 'display.theme' });
    expect(result.success).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as { settings: Array<{ key: string; type: string; default: unknown; enumValues: string[] }> };
    expect(output.settings).toHaveLength(1);
    expect(output.settings[0]).toMatchObject({ key: 'display.theme', type: 'enum', default: 'goodvibes', enumValues: [
      'goodvibes', 'goodvibes-neon', 'catppuccin', 'tokyonight', 'dracula', 'nord', 'gruvbox',
      'one-dark', 'rosepine', 'solarized', 'github', 'system', 'vaporwave',
    ] });
  });

  test('goodvibes_settings refuses raw credential persistence', async () => {
    const configManager = makeConfigManager();
    const tool = createGoodVibesSettingsTool({ configManager });

    const result = await tool.execute({
      mode: 'set',
      key: 'surfaces.slack.botToken',
      value: 'xoxb-raw-token-value',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing to persist a raw credential');
    expect(configManager.get('surfaces.slack.botToken')).toBe('');
  });

  test('runtime awareness prompt tells models to inspect harness state', () => {
    const prompt = appendGoodVibesRuntimeAwarenessPrompt('Base prompt');
    expect(prompt).toContain('goodvibes_context');
    expect(prompt).toContain('Do not spawn agents or start contracts');
  });
});

describe('what the runtime tools show of a stored value', () => {
  // The value stored under surfaces.ntfy.topic reads as credential material;
  // every other value reads as not one.
  const log = useConfigReadings({ credentials: ['surfaces.ntfy.topic'] });
  const valueReadings = () => log.requests.filter((request) => typeof (request.state as { value?: unknown }).value === 'string');

  test('a value read as credential material is redacted under a key the declared list does not name', async () => {
    const configManager = makeConfigManager();
    configManager.set('surfaces.ntfy.topic', 'tk_live_8Fq2Lm9Xv4Rz7Pw');
    const result = await createGoodVibesContextTool(makeDeps(configManager)).execute({ mode: 'config_get', key: 'surfaces.ntfy.topic' });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('tk_live_8Fq2Lm9Xv4Rz7Pw');
    expect(result.output).toContain('"source": "credential-like-value"');
    expect(valueReadings().map((request) => (request.state as { key: string }).key)).toContain('surfaces.ntfy.topic');
  });

  test('a value read as not credential material is shown as stored', async () => {
    const configManager = makeConfigManager();
    configManager.set('display.theme', 'catppuccin');
    const result = await createGoodVibesContextTool(makeDeps(configManager)).execute({ mode: 'config_get', key: 'display.theme' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('"value": "catppuccin"');
  });

  test('a declared credential key is redacted without reading its value, and a secret reference is never read', async () => {
    const configManager = makeConfigManager();
    configManager.set('surfaces.slack.botToken', 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN');
    const result = await createGoodVibesContextTool(makeDeps(configManager)).execute({ mode: 'config_get', key: 'surfaces.slack.botToken' });

    expect(result.output).toContain('"source": "goodvibes-secret-ref"');
    expect(valueReadings()).toHaveLength(0);
  });

  const customStringKeys = (configManager: ConfigManager, count: number): string[] => configManager.getSchema()
    .filter((setting) => setting.type === 'string' && setting.validate === undefined && !isSecretBearingConfigKey(setting.key) && setting.key !== 'surfaces.ntfy.topic')
    .map((setting) => setting.key)
    .filter((key) => { try { configManager.set(key as never, `custom-${key}` as never); return configManager.get(key as never) === `custom-${key}`; } catch { return false; } })
    .slice(0, count);

  test('a full config dump reads each distinct value once, and a second dump reads none', async () => {
    const configManager = makeConfigManager();
    const keys = customStringKeys(configManager, 50);
    expect(keys.length).toBeGreaterThan(10);
    const tool = createGoodVibesContextTool(makeDeps(configManager));
    const before = valueReadings().length;
    await tool.execute({ mode: 'config_get', includeSchema: false });
    const first = valueReadings().length - before;
    expect(first).toBeGreaterThanOrEqual(keys.length);
    await tool.execute({ mode: 'config_get', includeSchema: false });
    expect(valueReadings().length - before).toBe(first);
  });

  test('limit bounds a config dump and says how much was left out', async () => {
    const result = await createGoodVibesContextTool(makeDeps()).execute({ mode: 'config_get', limit: 10, includeSchema: false });
    const body = JSON.parse(result.output!) as { settings: unknown[]; truncated?: { returned: number; total: number } };
    expect(body.settings).toHaveLength(10);
    expect(body.truncated?.returned).toBe(10);
    expect(body.truncated!.total).toBeGreaterThan(10);
  });

  test('a value read while decision models were off is read again when they are on', async () => {
    const configManager = makeConfigManager();
    configManager.set('surfaces.ntfy.topic', 'plainlooking-topic-9aB3xQ');
    const tool = createGoodVibesContextTool(makeDeps(configManager));
    const classic = await withDecisionModelPolicy(() => 'Classic - Off', () => tool.execute({ mode: 'config_get', key: 'surfaces.ntfy.topic' }));
    expect(classic.output).toContain('plainlooking-topic-9aB3xQ');
    const decided = await tool.execute({ mode: 'config_get', key: 'surfaces.ntfy.topic' });
    expect(decided.output).not.toContain('plainlooking-topic-9aB3xQ');
  });

  test('the schema default is not read: it is the same text on every install', async () => {
    const result = await createGoodVibesContextTool(makeDeps()).execute({ mode: 'config_schema', category: 'display' });

    expect(result.success).toBe(true);
    expect(valueReadings()).toHaveLength(0);
  });
});
