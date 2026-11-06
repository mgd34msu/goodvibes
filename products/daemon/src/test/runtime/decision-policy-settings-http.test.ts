import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import { DECISION_MODEL_POLICY_HEADER, readDecisionModelPolicyHeader } from '@goodvibes-jev/engine/errors';
import { useGatewayFixture } from '../helpers/gateway-fixture.js';

const fixture = useGatewayFixture({ hostSessions: false,
  configure(config) { config.set('judgment.policy', 'Classic - Off'); },
});

test('policy setting writes keep their real acknowledgement and the next request observes the persisted policy', async () => {
  const f = fixture();
  const decisions = spyOn(f.services.judgment.port, 'ask').mockImplementation(async () => { throw new Error('Unexpected setting decision'); });
  try {
    for (const policy of ['Preferred', 'Default - On', 'Classic - Off'] as const) {
      const route = WEBUI_METHOD_ROUTES['config.set'];
      const response = await f.fetch(route.path, {
        method: route.method, body: JSON.stringify({ key: 'judgment.policy', value: policy }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(response.headers.get(DECISION_MODEL_POLICY_HEADER)).toBeNull();
      expect(f.services.configManager.get('judgment.policy')).toBe(policy);
      const persisted = new ConfigManager({ surfaceRoot: 'tui', configDir: join(f.homeDirectory, '.goodvibes', 'daemon'),
        homeDir: f.homeDirectory, workingDir: f.workingDirectory });
      expect(persisted.get('judgment.policy')).toBe(policy);
      const statusRoute = WEBUI_METHOD_ROUTES['control.status'];
      const observed = await f.fetch(statusRoute.path, { method: statusRoute.method });
      expect(observed.status, await observed.text()).toBe(200);
      expect(readDecisionModelPolicyHeader(observed.headers)).toMatchObject({ policy,
        operation: policy === 'Classic - Off' ? 'classic' : 'decision', reason: policy === 'Classic - Off' ? 'selected' : null });
    }
    expect(decisions).not.toHaveBeenCalled();
  } finally { decisions.mockRestore(); }
});
