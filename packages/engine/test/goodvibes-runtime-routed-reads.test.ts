/**
 * The goodvibes runtime tools answer one question one way: integrations and summary read daemon-owned
 * settings from the daemon like config_get does, a local reset that did not take effect is a failure, and
 * array settings are redacted element by element.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { createGoodVibesContextTool, createGoodVibesSettingsTool } from '../platform/src/platform/tools/goodvibes-runtime/index.js';
import { redactConfigValue } from '../platform/src/platform/tools/goodvibes-runtime/credential-redaction.js';
import { useConfigReadings } from './_helpers/config-readings.ts';

useConfigReadings({});

const roots: string[] = [];
const dir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const runningDaemon = { host: '127.0.0.1', port: 3421 };
const daemonAnswers = (config: Record<string, unknown>): typeof fetch =>
  (async () => new Response(JSON.stringify(config), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

function contextTool(h: string, extra: { cloudflareAuthToken?: () => string | null } = {}) {
  const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
  return createGoodVibesContextTool({
    configManager,
    providerRegistry: { getCurrentModel: () => null, listProviders: () => [], listModels: () => [], getConfiguredProviderIds: () => [] } as never,
    toolRegistry: { list: () => [] } as never,
    workingDirectory: h,
    surfaceRoot: 'agent',
    configRouting: {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: daemonAnswers({ surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } } }),
    },
    ...extra,
  });
}
const surfaceEntry = async (tool: ReturnType<typeof contextTool>, surface: string) => {
  const result = await tool.execute({ mode: 'integrations' });
  expect(result.success).toBe(true);
  const body = JSON.parse(result.output!) as { configuredSurfaces: Array<{ surface: string; settings: Record<string, unknown>; sources: Record<string, { owner: string }>; unavailable?: string[] }> };
  return body.configuredSurfaces.find((entry) => entry.surface === surface)!;
};

describe('integrations', () => {
  test('a daemon-owned surface setting set only in the daemon is shown, with its owner, like config_get shows it', async () => {
    const tool = contextTool(dir('gv-integrations-'));
    const entry = await surfaceEntry(tool, 'telegram');
    expect(entry.settings.botUsername).toBe('goodvibes_agent_bot');
    expect(entry.sources.botUsername!.owner).toBe('daemon');
    const direct = JSON.parse((await tool.execute({ mode: 'config_get', key: 'surfaces.telegram.botUsername' })).output!);
    expect(direct.settings[0].value).toBe(entry.settings.botUsername);
  });

  test('an unreachable daemon lists the setting as unavailable instead of showing a default as the value', async () => {
    const h = dir('gv-integrations-down-');
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const tool = createGoodVibesContextTool({
      configManager,
      providerRegistry: { getCurrentModel: () => null, listProviders: () => [], listModels: () => [], getConfiguredProviderIds: () => [] } as never,
      toolRegistry: { list: () => [] } as never,
      workingDirectory: h,
      surfaceRoot: 'agent',
      configRouting: { hostsDaemon: false, daemonHomeDir: h, readRuntimeRecord: () => runningDaemon,
        fetchImpl: (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch },
    });
    const entry = await surfaceEntry(tool, 'telegram');
    expect(entry.unavailable).toContain('botUsername');
    expect(entry.settings.botUsername).toBeNull();
  });
});

describe('cloudflare status', () => {
  test('the daemon auth token counts as the operator token when none is stored, as on the daemon status route', async () => {
    const h = dir('gv-cloudflare-');
    const without = JSON.parse((await contextTool(h).execute({ mode: 'cloudflare_status' })).output!);
    expect(without.cloudflare.configured?.workerToken).toBe(false);
    const withToken = JSON.parse((await contextTool(h, { cloudflareAuthToken: () => 'daemon-token' }).execute({ mode: 'cloudflare_status' })).output!);
    expect(withToken.cloudflare.configured?.workerToken).toBe(true);
    expect(JSON.stringify(withToken)).not.toContain('daemon-token');
  });
});

describe('local reset', () => {
  test('a reset the store did not take is a failure that names the store and the value it still holds', async () => {
    const h = dir('gv-reset-');
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    configManager.set('display.theme', 'nord');
    // A store that ignores the removal: the in-process object says "reset" while the file still holds the value.
    configManager.reset = () => {};
    const result = await createGoodVibesSettingsTool({ configManager }).execute({ mode: 'reset', key: 'display.theme', confirm: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('still holds "nord"');
    expect(result.error).toContain(configManager.getConfigPath());
  });

  test('a reset with nothing shadowing it still succeeds', async () => {
    const h = dir('gv-reset-ok-');
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    configManager.set('display.theme', 'nord');
    const result = await createGoodVibesSettingsTool({ configManager }).execute({ mode: 'reset', key: 'display.theme', confirm: true });
    expect(result.success).toBe(true);
  });
});

describe('redaction', () => {
  test('a credential-looking string inside an array setting is not shown as is', async () => {
    const shown = await redactConfigValue('mcp.headers', ['Authorization: Bearer sk-live-abcdef0123456789']);
    expect(JSON.stringify(shown)).not.toContain('sk-live-abcdef0123456789');
  });

  test('an array of ordinary strings is shown', async () => {
    expect(await redactConfigValue('some.list', ['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });
});
