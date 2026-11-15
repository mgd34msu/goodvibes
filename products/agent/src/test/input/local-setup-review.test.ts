import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildSetupReviewSnapshot } from '../../input/commands/local-setup-review.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeSetupReviewContext(root: string, gaps: {
  readonly models?: readonly unknown[];
  readonly services?: Record<string, unknown>;
  readonly plugins?: readonly unknown[];
  readonly mcpServers?: readonly unknown[];
} = {}): CommandContext {
  const shellPaths = createShellPathService({
    workingDirectory: join(root, 'workspace'),
    homeDirectory: join(root, 'home'),
  });

  return {
    workspace: { shellPaths },
    platform: {
      serviceRegistry: {
        getAll: () => gaps.services ?? {},
        inspect: async () => null,
      },
      subscriptionManager: {
        list: () => [],
        listPending: () => [],
      },
      readModels: {
        security: {
          getSnapshot: () => ({
            plugins: gaps.plugins ?? [],
            mcpServers: gaps.mcpServers ?? [],
          }),
        },
      },
    },
    clients: {
      providerApi: {
        listModels: async () => gaps.models ?? [
          { id: 'model', provider: 'provider', registryKey: 'provider:model' },
        ],
      },
    },
    ops: {
      remoteRuntime: {
        listContracts: () => [],
      },
    },
    session: {
      runtime: {
        sessionId: 'session-1',
      },
    },
  } as unknown as CommandContext;
}

describe('local setup review', () => {
  test('does not treat absent host hooks or remote runners as Agent setup gaps', async () => {
    const root = makeProjectTempDir('goodvibes-agent-setup-review');
    try {
      const snapshot = await buildSetupReviewSnapshot(makeSetupReviewContext(root));
      const areas = snapshot.issues.map((issue) => issue.area);

      expect(areas).not.toContain('hooks');
      expect(areas).not.toContain('remote');
      expect(snapshot.remoteRunnerCount).toBe(0);
      expect(snapshot.managedHookCount).toBe(0);
      expect(snapshot.managedHookChainCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('still reports genuine gaps: no models, a service without credentials, a quarantined plugin and an elevated MCP server', async () => {
    const root = makeProjectTempDir('goodvibes-agent-setup-review-gaps');
    try {
      const snapshot = await buildSetupReviewSnapshot(makeSetupReviewContext(root, {
        models: [],
        services: { calendar: { authType: 'api-key' } },
        plugins: [{ quarantined: true }],
        mcpServers: [{ schemaFreshness: 'fresh', trustMode: 'allow-all' }],
      }));
      const byArea = new Map(snapshot.issues.map((issue) => [issue.area, issue]));

      expect(byArea.get('providers')).toMatchObject({ severity: 'fail', message: 'no models available' });
      expect(byArea.get('host')).toMatchObject({ severity: 'warn', message: '1 host integration configuration issue(s)' });
      expect(snapshot.hostIntegrationIssues).toEqual(['calendar: missing primary credential']);
      expect(byArea.get('plugins')).toMatchObject({ severity: 'warn', message: '1 plugin(s) quarantined' });
      expect(byArea.get('mcp')).toMatchObject({ severity: 'warn', message: '0 quarantined, 1 elevated' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
