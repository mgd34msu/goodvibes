/**
 * The TUI main-turn tool registry applies the turn permission manager's per-file
 * read decision to search results, so `find` cannot return the content of a file
 * the read tool would withhold. Built on the real runtime services in a temp home.
 */
import { prepareConfiguredProjectContext } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createTuiTurnPermissionManager, registerTuiTurnTools } from '../../runtime/turn-tool-composition.ts';
import { seedBenchmarkCacheFixture } from '../helpers/benchmark-cache-fixture.ts';

async function withComposition(run: (ctx: { root: string; services: ReturnType<typeof createRuntimeServices>; registry: ToolRegistry; manager: ReturnType<typeof createTuiTurnPermissionManager> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tui-turn-tools-'));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  seedBenchmarkCacheFixture({ workingDirectory: root, homeDirectory: root, surfaceRoot: 'tui' });
  await prepareConfiguredProjectContext(configManager, root, 'knowledge-wiki.sqlite', { activate: true });
  const services = createRuntimeServices({ configManager, workingDir: root, homeDirectory: root, modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
  try {
    const manager = createTuiTurnPermissionManager(services, async () => 'trusted');
    const registry = new ToolRegistry(manager);
    registerTuiTurnTools(registry, services, { resolveSessionId: () => 'turn-tools' });
    await run({ root, services, registry, manager });
  } finally {
    services.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

async function findContent(registry: ToolRegistry, root: string): Promise<string> {
  const find = registry.list().find((tool) => tool.definition.name === 'find');
  if (!find) throw new Error('find is not registered');
  const result = await find.execute({ queries: [{ id: 'q', mode: 'content', path: root, pattern: 'API_KEY' }] });
  return result.output ?? result.error ?? '';
}

test('find content results leave out a file the turn permission manager withholds', async () => {
  await withComposition(async ({ root, registry, manager }) => {
    writeFileSync(join(root, 'notes.txt'), 'API_KEY=visible-value\n');
    writeFileSync(join(root, 'secrets.cfg'), 'API_KEY=withheld-value\n');
    const readAccess = spyOn(manager, 'readAccess').mockImplementation(async (path: string) => (path.endsWith('secrets.cfg') ? 'restricted' : 'allow'));
    const output = await findContent(registry, root);
    expect(readAccess).toHaveBeenCalled();
    expect(output).toContain('visible-value');
    expect(output).not.toContain('withheld-value');
  });
}, 30000);

test('goodvibes_context counts a Cloudflare token held in the runtime secret store', async () => {
  await withComposition(async ({ registry, services }) => {
    // The tool's output screening asks whether a value is credential material; answer no.
    const previous = installJudgmentPort(fakePort(() => noulAnswer(0.001)).port);
    try {
      const get = spyOn(services.secretsManager, 'get').mockImplementation(async (key: string) => (key === 'CLOUDFLARE_API_TOKEN' ? 'stored-token-value' : null));
      const tool = registry.list().find((candidate) => candidate.definition.name === 'goodvibes_context');
      if (!tool) throw new Error('goodvibes_context is not registered');
      const result = await tool.execute({ mode: 'cloudflare_status' });
      expect(result.error).toBeUndefined();
      expect(get).toHaveBeenCalled();
      expect(result.success).toBe(true);
      const status = JSON.parse(result.output ?? '{}') as { cloudflare?: { configured?: { apiToken?: boolean } } };
      expect(status.cloudflare?.configured?.apiToken).toBe(true);
      expect(result.output).not.toContain('stored-token-value');
    } finally { installJudgmentPort(previous); }
  });
}, 30000);
