/**
 * `/settings set` routes a key to the runtime that owns it. Reset must route the
 * same way, or it clears a local copy the owner never reads and reports success.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ConfigManager } from '../../config/index.ts';
import { installAgentDaemonConfigClient, isDaemonOwnedConfigKey } from '../../config/daemon-config-routing.ts';
import { resetHarnessSetting, setHarnessSetting } from '../../agent/harness-control.ts';
import { formatHarnessMutation } from '../../agent/harness-mutation-format.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
function agentConfig(): ConfigManager {
  const root = makeProjectTempDir('gv-agent-settings-routing');
  roots.push(root);
  return new ConfigManager({ homeDir: root, surfaceRoot: 'agent' });
}

function daemonClient(owns: (key: string) => boolean, stored: Map<string, unknown> = new Map()) {
  return {
    stored,
    ownsKey: mock(owns),
    set: mock(async (key: string, value: unknown) => { stored.set(key, value); }),
    get: mock(async (key: string) => stored.get(key)),
    snapshot: mock(async (): Promise<Record<string, unknown> | null> => null),
  };
}

beforeEach(() => installAgentDaemonConfigClient(null));
afterEach(() => {
  installAgentDaemonConfigClient(null);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('reset routes by ownership', () => {
  test('a daemon-owned key is reset by writing its default to the daemon, and the answer names the daemon', async () => {
    const config = agentConfig();
    const key = 'surfaces.telegram.botUsername';
    const stored = new Map<string, unknown>([[key, 'old_bot']]);
    const client = daemonClient(isDaemonOwnedConfigKey, stored);
    installAgentDaemonConfigClient(client);
    const schemaDefault = config.getSchema().find((entry) => entry.key === key)!.default;

    const result = await resetHarnessSetting(config, null, key);

    expect(client.set).toHaveBeenCalledWith(key, schemaDefault);
    expect(result.action).toBe('reset');
    expect(result.scope).toBe('daemon');
    expect(result.appliedBy).toBe('daemon');
    expect(result.current).toBe(schemaDefault);
    expect(formatHarnessMutation(result)).toContain('applied by daemon');
  });

  test('an unreachable daemon makes the reset fail instead of clearing the local copy and succeeding', async () => {
    const config = agentConfig();
    const client = daemonClient(isDaemonOwnedConfigKey);
    client.set.mockImplementation(async () => { throw new Error('daemon unreachable'); });
    installAgentDaemonConfigClient(client);

    await expect(resetHarnessSetting(config, null, 'surfaces.telegram.botUsername')).rejects.toThrow(/daemon unreachable/);
  });

  test('an agent-owned key is still reset locally and never touches the daemon', async () => {
    const config = agentConfig();
    const client = daemonClient(() => false);
    installAgentDaemonConfigClient(client);
    await setHarnessSetting(config, null, 'display.theme', 'nord');

    const result = await resetHarnessSetting(config, null, 'display.theme');

    expect(client.set).not.toHaveBeenCalled();
    expect(result.previous).toBe('nord');
    expect(result.current).toBe(config.getSchema().find((entry) => entry.key === 'display.theme')!.default);
  });
});

describe('a companion row that cannot be written', () => {
  test('the main value is reported as set, with a note that the companion did not move', async () => {
    const config = agentConfig();
    // The companion row is owned by an unreachable daemon; the main row is local.
    const client = daemonClient((key) => key.startsWith('voice.wake.surfaces.'));
    client.set.mockImplementation(async () => { throw new Error('daemon unreachable'); });
    installAgentDaemonConfigClient(client);

    const result = await setHarnessSetting(config, null, 'voice.wake.enabled', true);

    expect(result.current).toBe(true);
    const stored: unknown = config.get('voice.wake.enabled' as never);
    expect(stored).toBe(true);
    expect(result.alsoSet).toBeUndefined();
    expect(result.alsoSetFailed).toContain('daemon unreachable');
    expect(formatHarnessMutation(result)).toContain('warning voice.wake.enabled was set, but its companion row did not change');
  });
});
