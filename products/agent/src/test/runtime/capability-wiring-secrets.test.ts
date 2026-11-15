import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes-jev/engine/platform/platform/google';
import { resetCapabilityIndexForTests } from '../../capabilities/capability-index.ts';
import { wireCapabilityIndex } from '../../runtime/bootstrap-capability-wiring.ts';
import { createAgentCapabilityTool } from '../../tools/agent-capability-tool.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createToolRegistryDouble } from '../helpers/tool-registry-double.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** A connected Google account: client id in config, client secret and refresh token in the encrypted store. */
const STORED = new Set([GOOGLE_SECRET_KEYS.oauthClientSecret, GOOGLE_SECRET_KEYS.oauthRefreshToken]);

let home = '';

function registryWithGoogle() {
  const registry = createToolRegistryDouble();
  registry.register({ definition: { name: 'google', description: '', parameters: { type: 'object', properties: {} } }, execute: async () => ({ success: true, output: '' }) } as never);
  return registry;
}

function secretsManager(keys: ReadonlySet<string>) {
  return {
    resolveLocalCredentialSnapshot: (key: string) =>
      keys.has(key) ? { state: 'resolved', value: 'stored-value' } : { state: 'missing' },
  };
}

const configManager = { get: (key: string) => (key === GOOGLE_CONFIG_KEYS.oauthClientId ? 'client-id' : undefined) };
const commandContext = {} as unknown as CommandContext;

describe('capability wiring reads the secret store', () => {
  beforeEach(() => {
    home = makeProjectTempDir('capability-wiring-secrets');
    resetCapabilityIndexForTests();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    resetCapabilityIndexForTests();
  });

  test('boot wiring reports email and calendar ready for a stored credential', () => {
    const report = wireCapabilityIndex({
      toolRegistry: registryWithGoogle() as never,
      commandContext,
      configManager,
      secretsManager: secretsManager(STORED),
      homeDirectory: home,
      workingDirectory: home,
    });
    expect(report.ready).toContain('email.send');
    expect(report.ready).toContain('email.read');
    expect(report.ready).toContain('calendar.read');
  });

  test('boot wiring without a secret store never reports the account ready', () => {
    const report = wireCapabilityIndex({
      toolRegistry: registryWithGoogle() as never,
      commandContext,
      configManager,
      homeDirectory: home,
      workingDirectory: home,
    });
    expect(report.ready).not.toContain('email.send');
  });

  test('the live capability tool sees a credential connected after boot', async () => {
    const keys = new Set<string>();
    const context = {
      workspace: { shellPaths: { homeDirectory: home, workingDirectory: home } },
      platform: { configManager },
    } as unknown as CommandContext;
    wireCapabilityIndex({
      toolRegistry: registryWithGoogle() as never,
      commandContext: context,
      configManager,
      secretsManager: secretsManager(keys),
      homeDirectory: home,
      workingDirectory: home,
    });
    const tool = createAgentCapabilityTool({
      toolRegistry: registryWithGoogle() as never,
      commandContext: context,
      configManager,
      secretsManager: secretsManager(keys),
    });
    const before = (await tool.execute({ subject: 'calendar' }, {} as never)) as { output: string };
    STORED.forEach((key) => keys.add(key));
    const after = (await tool.execute({ subject: 'calendar' }, {} as never)) as { output: string };
    expect(before.output).toContain('not ready yet');
    expect(after.output).toContain('available now');
  });
});
