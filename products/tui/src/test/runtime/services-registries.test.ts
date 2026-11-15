/**
 * The TUI composes one MCP registry and one sandbox session registry: the
 * client's. MCP tools in the main turn therefore run under the permission host
 * and elicitation handler the client composition wires, not a second registry
 * that has neither.
 */
import { prepareConfiguredProjectContext } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createRuntimeServices } from '../../runtime/services.ts';
import { seedBenchmarkCacheFixture } from '../helpers/benchmark-cache-fixture.ts';

test('the exposed MCP registry has the permission host and elicitation handler wired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-registries-'));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  seedBenchmarkCacheFixture({ workingDirectory: root, homeDirectory: root, surfaceRoot: 'tui' });
  await prepareConfiguredProjectContext(configManager, root, 'knowledge-wiki.sqlite', { activate: true });
  const services = createRuntimeServices({ configManager, workingDir: root, homeDirectory: root, modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
  try {
    // The registry keeps both privately; they are what ties an MCP connect and
    // call to config invalidation, session teardown and server input requests.
    expect(Reflect.get(services.mcpRegistry, 'permissionHost')).toBeDefined();
    expect(Reflect.get(services.mcpRegistry, 'elicitationHandler')).not.toBeNull();
  } finally {
    services.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
