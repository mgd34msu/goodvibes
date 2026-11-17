import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { ProjectPlanningService } from '../platform/src/platform/knowledge/project-planning/service.ts';
import { prepareConfiguredProjectContext, createConfiguredPlanningStore } from '../platform/src/platform/knowledge/project-planning/configured-project.ts';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { normalizeSpaceComponent } from '../platform/src/platform/knowledge/spaces.ts';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.ts';
import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema-version.ts';
// The exact writer recipe is used only to construct actual old saved fixtures.
const savedDefaultId = (path: string) => `${normalizeSpaceComponent(basename(path))}-${createHash('sha256').update(path).digest('hex').slice(0,10)}`;
import { AgentConfigManager } from '../../../products/agent/src/config/host-settings.ts';
import { TuiConfigManager } from '../../../products/tui/src/config/host-settings.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(Manager: typeof ConfigManager = ConfigManager, configured = true, cardShaped = true) {
  const root = makeProjectTempDir('native-planning-reference');
  const workingDirectory = join(root, cardShaped ? 'workspace-1791693573084' : 'ordinary-native-project');
  mkdirSync(workingDirectory, { recursive: true });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = new Manager({ surfaceRoot: 'native-planning-test', configDir: join(root, 'config'),
    ...(configured ? { workingDir: workingDirectory } : {}), readOnly: true });
  const seeded = new KnowledgeStore({ configManager: config });
  await seeded.upsertSource({ id: 'saved-project-selector', connectorId: 'goodvibes-project-planning', sourceType: 'dataset', title: 'Saved project selector', status: 'indexed', metadata: { projectId: 'old-placeholder' } });
  await seeded.close();
  const raw = new SQLiteStore(seeded.storagePath); await raw.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  const projectId = savedDefaultId(workingDirectory);
  raw.run('UPDATE knowledge_sources SET metadata=? WHERE id=?', [JSON.stringify({ projectId }), 'saved-project-selector']); await raw.save(); raw.close();
  if (configured) await prepareConfiguredProjectContext(config, workingDirectory, undefined, { activate: true });
  const store = configured ? createConfiguredPlanningStore(config) : new KnowledgeStore({ configManager: config });
  await store.init(); cleanup.push(() => store.close());
  await store.upsertSource({ id: 'native-reference-fixture', connectorId: 'native-reference-fixture',
    sourceType: 'dataset', title: 'Native reference fixture', canonicalUri: 'native:reference-fixture', status: 'indexed' });
  return { root, workingDirectory, config, store, projectId, bytes: () => readFileSync(store.storagePath) };
}

for (const Manager of [ConfigManager, AgentConfigManager, TuiConfigManager]) {
  test(`${Manager.name} native composition takes the configured workspace's project`, async () => {
    const f = await fixture(Manager), before = f.bytes();
    const native = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory);
    expect(native.projectId).toBe(f.projectId);
    const result = await native.service.status();
    expect(result.projectId).toBe(f.projectId);
    expect(result.knowledgeSpaceId).toBe(`project:${f.projectId}`);
    expect(f.bytes()).toEqual(before);
  });
}

for (const configured of [false, true]) {
  test(`an authentic ${configured ? 'mismatched' : 'missing'} configured directory is refused at composition`, async () => {
    const f = await fixture(ConfigManager, configured);
    const directory = configured ? join(f.root, 'other-1791693573084') : f.workingDirectory;
    expect(() => ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, directory)).toThrow();
    // Unconfigured embedders use an explicit ordinary service/default.
    const ordinary = new ProjectPlanningService(f.store, { defaultProjectId: 'safe-explicit-project' });
    expect((await ordinary.status()).projectId).toBe('safe-explicit-project');
  });
}

test('native creation refuses a caller default override without invoking startup', async () => {
  const f = await fixture(); let calls = 0;
  const options = { waitForStartup: async () => { calls++; }, defaultProjectId: 'ordinary-forged-default' };
  expect(() => Reflect.apply(ProjectPlanningService.forConfiguredWorkspace, ProjectPlanningService,
    [f.store, f.config, f.workingDirectory, options])).toThrow(TypeError);
  expect(calls).toBe(0);
});

test('closing the actual selected store during startup holds before default response publication', async () => {
  const f = await fixture(), before = f.bytes();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { service } = ProjectPlanningService.forConfiguredWorkspace(f.store, f.config, f.workingDirectory, {
    waitForStartup: async () => { entered.resolve(); await release.promise; },
  });
  const pending = service.status(); const observed = pending.catch(error => error);
  await entered.promise; await f.store.close(); release.resolve();
  expect(await observed).toBeInstanceOf(Error); expect(f.bytes()).toEqual(before);
});
