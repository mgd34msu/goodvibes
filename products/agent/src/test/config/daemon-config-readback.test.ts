import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigManager } from '../../config/index.ts';
import { installAgentDaemonConfigClient, routeConfigWrite } from '../../config/daemon-config-routing.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

afterEach(() => installAgentDaemonConfigClient(null));

describe('daemon-owned config write read-back', () => {
  test('a read-back that fails after the daemon applied the write still reports the write as applied', async () => {
    const home = makeProjectTempDir('gv-config-readback');
    const sets: unknown[] = [];
    // Only the three members routeConfigWrite touches; the rest of DaemonConfigClient is irrelevant here.
    installAgentDaemonConfigClient({
      ownsKey: () => true,
      set: async (_key: string, value: unknown) => { sets.push(value); },
      get: async () => { throw new Error('connection reset'); },
    } as never);

    const outcome = await routeConfigWrite(new ConfigManager({ homeDir: home, surfaceRoot: 'agent' }), 'surfaces.telegram.botUsername', 'agent_bot');

    expect(sets).toEqual(['agent_bot']);
    expect(outcome.appliedBy).toBe('daemon');
    expect(outcome.value).toBe('agent_bot');
    expect(outcome.reason).toContain('reading it back failed');
  });
});
