import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { registerInboxSurface } from '@goodvibes-jev/engine/platform/platform/intake';
import type { DaemonInboxFactory } from '../../runtime/daemon-handler-composition.js';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/store';
import { createFeatureFlagManager, RuntimeEventBus } from '../../runtime/index.js';
import { createRuntimeServices } from '../../runtime/services.js';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const inboxFactory = (context: Parameters<typeof registerInboxSurface>[0], _routing: unknown, options: Parameters<DaemonInboxFactory>[2]) =>
  registerInboxSurface(context, { ...options, adapters: new Map() });

/** The broker's single continuation slot; last writer wins, so only one owner may write it. */
const runnerOf = (broker: object): unknown => Reflect.get(broker, 'continuationRunner');

test('the service graph leaves continuation to the daemon facade, which installs the one runner', async () => {
  const root = makeOwnedTempDir('daemon-continuation-owner');
  const workingDir = join(root, 'workspace'), homeDir = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  const standalone = await createRuntimeServices({
    inboxFactory, runtimeStore: createRuntimeStore(), runtimeBus: new RuntimeEventBus(),
    configManager: new ConfigManager({ surfaceRoot: 'tui', configDir: join(homeDir, '.goodvibes', 'daemon'), workingDir, homeDir }),
    workingDir, homeDirectory: homeDir, featureFlags: createFeatureFlagManager(), getConversationTitle: () => 'continuation owner',
  });
  try { expect(runnerOf(standalone.sessionBroker)).toBeNull(); }
  finally { await standalone.close(); }

  const fixture = await startDaemonFixture({ root: makeOwnedTempDir('daemon-continuation-facade'), inboxFactory });
  try { expect(runnerOf(fixture.services.sessionBroker)).toBeFunction(); }
  finally { await fixture.stop(); }
});
