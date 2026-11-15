/** The Agent's own settings tool refuses owner-only writes before any admission or effect. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA, type ConfigSetting } from '@goodvibes-jev/engine/platform/platform/config';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../../input/command-registry.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { describeProjectionFailure } from '../../tools/agent-projection-failure.ts';
import { createPreferredSettingsProjector, SettingsWriteRefusedError, settingsThrownFailure } from '../../tools/agent-settings-admission.ts';
import { ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = makeProjectTempDir('settings-owner-only'); roots.push(root);
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'agent', homeDir: home, workingDir: workspace, configDir: join(home, '.goodvibes', 'agent') });
  const schema: ConfigSetting[] = ['surfaces.ntfy.baseUrl', 'surfaces.ntfy.token']
    .map(key => CONFIG_SCHEMA.find(row => row.key === key)!);
  config.getSchema = () => schema;
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
  const context = { platform: { configManager: config, secretsManager: null }, extensions: { toolRegistry: registry }, clients: {},
    session: { runtime: { sessionId: 'owner-only-session' } } } as unknown as CommandContext;
  const projector = createPreferredSettingsProjector(context.platform, undefined, { registry, context });
  return { projector };
}

async function refusal(args: Record<string, unknown>): Promise<string> {
  const { projector } = fixture();
  try { await projector.project({ callId: 'owner-only', name: 'settings', args, assertCurrent() {} }); }
  catch (thrown) {
    expect(thrown).toBeInstanceOf(SettingsWriteRefusedError);
    const failure = settingsThrownFailure('mutation', thrown);
    expect(failure.success).toBe(false);
    return failure.error;
  }
  throw new Error('the write was admitted');
}

test('a credential destination cannot be redirected through the settings tool', async () => {
  const message = await refusal({ action: 'set', key: 'surfaces.ntfy.baseUrl', value: 'https://attacker.example' });
  expect(message).toContain('surfaces.ntfy.baseUrl');
  expect(message).toContain('Nothing was changed');
});

test('a credential key cannot point at another key\'s stored secret', async () => {
  const message = await refusal({ action: 'set', key: 'surfaces.ntfy.token', value: 'goodvibes://secrets/goodvibes/ANTHROPIC_API_KEY' });
  expect(message).toContain('may only point at its own stored secret');
});

test('the agent is told the owner-only reason through the projection-failure describer and the error detail', async () => {
  const { projector } = fixture();
  let thrown: unknown;
  try { await projector.project({ callId: 'owner-only', name: 'settings', args: { action: 'set', key: 'surfaces.ntfy.baseUrl', value: 'https://attacker.example' }, assertCurrent() {} }); }
  catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(SettingsWriteRefusedError);
  const error = thrown as SettingsWriteRefusedError;
  expect(describeProjectionFailure(error)).toContain(error.refusal);
  // The orchestrator describer reads problem and detail only.
  expect(error.detail).toBe(error.refusal);
  expect(error.refusal).toContain('surfaces.ntfy.baseUrl');
});
