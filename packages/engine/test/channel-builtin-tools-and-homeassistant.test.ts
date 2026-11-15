/**
 * Agent channel tools that act on the outside world say so, and Home Assistant
 * resolves its event type and access token by one rule everywhere.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { listBuiltinTools } from '../platform/src/platform/channels/builtin/descriptors.ts';
import { listBuiltinAgentTools } from '../platform/src/platform/channels/builtin/rendering.ts';
import {
  buildHomeAssistantManifest,
  resolveHomeAssistantAccessToken,
  resolveHomeAssistantEventType,
} from '../platform/src/platform/channels/builtin/homeassistant.ts';

describe('agent channel tools', () => {
  test('tools that actuate devices, edit allowlists or run account actions are flagged and say so to the agent', () => {
    const tools = listBuiltinAgentTools({ listTools: listBuiltinTools, runTool: async () => ({}) } as never, 'homeassistant' as never);
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool.definition.description]));
    for (const name of ['homeassistant_call_service', 'homeassistant_fire_event', 'homeassistant_allowlist_edit', 'homeassistant_account_action']) {
      expect(byName.get(name)).toContain('only when the owner asked');
    }
    expect(byName.get('homeassistant_states')).not.toContain('only when the owner asked');
    expect(listBuiltinTools('slack' as never).find((tool) => tool.name === 'slack_allowlist_edit')?.metadata.dangerous).toBe(true);
    expect(listBuiltinTools('slack' as never).find((tool) => tool.name === 'slack_status')?.metadata.dangerous).toBeUndefined();
  });
});

describe('Home Assistant configuration', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['HOMEASSISTANT_ACCESS_TOKEN', 'HOME_ASSISTANT_ACCESS_TOKEN', 'HA_ACCESS_TOKEN'];
  beforeEach(() => { for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; } });
  afterEach(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

  const config = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

  test('an empty event type means the default in the manifest and in publishing', () => {
    const configManager = config({ 'surfaces.homeassistant.eventType': '' });
    expect(resolveHomeAssistantEventType(configManager)).toBe('goodvibes_message');
    expect(buildHomeAssistantManifest({ configManager } as never).events.outboundEventType).toBe('goodvibes_message');
    expect(resolveHomeAssistantEventType(config({ 'surfaces.homeassistant.eventType': 'custom_event' }))).toBe('custom_event');
  });

  test('a configured token reference that does not resolve does not fall back to the environment', async () => {
    process.env.HA_ACCESS_TOKEN = 'environment-token';
    const deps = {
      configManager: config({ 'surfaces.homeassistant.accessToken': 'goodvibes://secrets/goodvibes/MISSING_HA_TOKEN' }),
      secretsManager: { get: async () => null, getGlobalHome: () => '/nonexistent-goodvibes-home' },
    };
    await expect(resolveHomeAssistantAccessToken(deps as never)).rejects.toThrow('surfaces.homeassistant.accessToken');
  });

  test('with nothing configured the environment token is used', async () => {
    process.env.HA_ACCESS_TOKEN = 'environment-token';
    expect(await resolveHomeAssistantAccessToken({ configManager: config({}) } as never)).toBe('environment-token');
  });
});
