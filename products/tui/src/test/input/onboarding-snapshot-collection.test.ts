import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { collectOnboardingSnapshotForHandler } from '../../input/handler-interactions.ts';
import type { InputHandlerLike } from '../../input/handler-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('onboarding snapshot collection', () => {
  test('the open-time snapshot includes legacy daemon detection, not the empty fallback', async () => {
    root = makeProjectTempDir('onboarding-snapshot-collection');
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const handler = {
      uiServices: {
        environment: { shellPaths: createShellPathService({ workingDirectory: workspace, homeDirectory: home }), homeDirectory: home },
        platform: {
          configManager: new ConfigManager({ surfaceRoot: 'tui', homeDir: home, workingDir: workspace }),
          subscriptionManager: { list: () => [], listPending: () => [], get: () => null, getPending: () => null },
          secretsManager: {},
          localUserAuthManager: {},
          serviceRegistry: { getAll: () => ({}) },
          surfaceRegistry: { syncConfiguredSurfaces: () => [] },
        },
        // Unusable on purpose: the optional account section records an issue and the rest still collects.
        providers: { providerRegistry: {} },
      },
    } as unknown as InputHandlerLike;

    const snapshot = await collectOnboardingSnapshotForHandler(handler);

    // The fallback used when no detector is supplied has an empty path; a real detection names the unit file.
    expect(snapshot.legacyDaemon.path).toContain(home);
    expect(snapshot.legacyDaemon.present).toBe(false);
  });
});
