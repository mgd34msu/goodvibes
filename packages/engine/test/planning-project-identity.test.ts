/** UNRUN: actual saved binding, native preparation and no-write inspection. */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.ts';
import { prepareConfiguredProjectContext, createConfiguredPlanningStore, configuredPlanningStoreIdentity } from '../sdk/src/platform/knowledge/project-planning/configured-project.ts';
import { ProjectIdentityRegistry } from '../sdk/src/platform/knowledge/project-planning/project-registry.ts';
import { ProjectPlanningService } from '../sdk/src/platform/knowledge/project-planning/service.ts';
import { inspectWorkPlanProjects } from '../sdk/src/platform/knowledge/project-planning/persisted-work-plan-projects.ts';
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'planning-identity-')); roots.push(root); const workspace = join(root, 'workspace'); mkdirSync(workspace); const config = new ConfigManager({ workingDir: workspace, configDir: join(root, 'config'), surfaceRoot: 'identity-test', readOnly: true }); return { root, workspace, config }; }
test('fresh readonly inspection leaves config, store and binding registry absent', async () => {
  const f = fixture(), before = readdirSync(f.root).sort();
  expect(await prepareConfiguredProjectContext(f.config, f.workspace)).toEqual({ registration: 'unregistered', projectId: null });
  expect(readdirSync(f.root).sort()).toEqual(before); expect(existsSync(join(f.root, 'config'))).toBe(false);
});
test('simultaneous independent native preparations adopt exactly one saved identity', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([prepareConfiguredProjectContext(f.config, f.workspace, undefined, { activate: true }), prepareConfiguredProjectContext(f.config, f.workspace, undefined, { activate: true })]);
  expect(first.projectId).toBe(second.projectId); expect(first.projectId).toMatch(/^project-[a-p-]+$/);
  const store = createConfiguredPlanningStore(f.config); try { await store.init(); const selected = ProjectPlanningService.forConfiguredWorkspace(store, f.config, f.workspace); expect<unknown>((await selected.service.status()).projectId).toBe(first.projectId); } finally { await store.close(); }
  expect((await prepareConfiguredProjectContext(f.config, f.workspace)).projectId).toBe(first.projectId);
});
test('registered identity remains stable across an unrelated append without whole-registry byte fencing', async () => {
  const f = fixture(), registry = new ProjectIdentityRegistry(join(f.root, 'registry'), () => {});
  const first = await registry.activate(f.workspace, null, undefined, () => {});
  await registry.activate(join(f.root, 'other-workspace'), null, undefined, () => {});
  first.assertCurrent(); expect(registry.inspect(f.workspace)?.projectId).toBe(first.projectId);
});
test('actual selected native source replacement before initial read refuses the foreign database', async () => {
  const f = fixture(), seeded = new KnowledgeStore({ configManager: f.config }); await seeded.upsertSource({ id: 'persisted-source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' }); await seeded.close();
  await prepareConfiguredProjectContext(f.config, f.workspace, undefined, { activate: true });
  const bytes = readFileSync(seeded.storagePath); renameSync(seeded.storagePath, `${seeded.storagePath}.original`); writeFileSync(seeded.storagePath, bytes);
  expect(() => createConfiguredPlanningStore(f.config)).toThrow(); expect(readFileSync(`${seeded.storagePath}.original`)).toEqual(bytes);
});
test('a copied store/configured-project label cannot manufacture genuine native proof through changed map dispatch', async () => {
  const f = fixture(); await prepareConfiguredProjectContext(f.config, f.workspace, undefined, { activate: true });
  const real = createConfiguredPlanningStore(f.config); await real.init();
  const copied = Object.create(KnowledgeStore.prototype) as KnowledgeStore;
  Object.defineProperties(copied, Object.getOwnPropertyDescriptors(real));
  const get = WeakMap.prototype.get, set = WeakMap.prototype.set, mapGet = Map.prototype.get; let suppliedCalls = 0, held = false;
  try {
    Object.defineProperty(WeakMap.prototype, 'get', { configurable: true, writable: true, value() { suppliedCalls++; return { projectId: 'forged-project' }; } });
    Object.defineProperty(Map.prototype, 'get', { configurable: true, writable: true, value() { suppliedCalls++; return { projectId: 'forged-project' }; } });
    try { configuredPlanningStoreIdentity(copied, f.config, f.workspace); } catch { held = true; }
  } finally { WeakMap.prototype.get = get; WeakMap.prototype.set = set; Map.prototype.get = mapGet; await real.close(); }
  expect(held).toBe(true); expect(suppliedCalls).toBe(0);
});
test('same-byte binding replacement retires native selector rather than authorizing fresh proof', async () => {
  const f = fixture(), directory = join(f.root, 'registry'), registry = new ProjectIdentityRegistry(directory, () => {});
  const bound = await registry.activate(f.workspace, null, undefined, () => {}), leaf = join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!);
  const bytes = readFileSync(leaf); renameSync(leaf, `${leaf}.original`); writeFileSync(leaf, bytes, { mode: 0o600 }); expect(() => bound.assertCurrent()).toThrow();
});
test('pre-existing registry symlink cannot create bindings through a foreign parent', async () => {
  const f = fixture(), foreign = join(f.root, 'foreign'); mkdirSync(foreign); chmodSync(foreign, 0o700); symlinkSync(foreign, join(f.root, 'registry'));
  const registry = new ProjectIdentityRegistry(join(f.root, 'registry'), () => {});
  await expect(registry.activate(f.workspace, null, undefined, () => {})).rejects.toThrow(); expect(readdirSync(foreign)).toEqual([]);
});
test('unattributed old root plans are preserved while actual owned assignments remain strict', () => {
  const f = fixture(), plans = join(f.root, 'plans'); mkdirSync(plans); writeFileSync(join(plans, 'old.json'), '{unreadable'); writeFileSync(join(plans, 'unattributed.json'), JSON.stringify({ items: [] }));
  const observed = inspectWorkPlanProjects(plans, f.workspace); expect(observed.projectIds).toEqual([]); observed.assertCurrent();
  mkdirSync(join(plans, '.project-owners')); writeFileSync(join(plans, '.project-owners', '0.json'), '{}');
  expect(() => observed.assertCurrent()).toThrow(); expect(() => inspectWorkPlanProjects(plans, f.workspace)).toThrow(); expect(readFileSync(join(plans, 'old.json'), 'utf8')).toBe('{unreadable');
});
test('a new actual root ownership record invalidates the original readonly selection', () => {
  const f = fixture(), plans = join(f.root, 'plans'); mkdirSync(plans); const observed = inspectWorkPlanProjects(plans, f.workspace);
  writeFileSync(join(plans, 'other.json'), JSON.stringify({ projectRoot: f.workspace, projectId: 'saved-project' })); expect(() => observed.assertCurrent()).toThrow();
});
test('missing decision IDs retain an exact saved non-Latin title and old source identity', async () => {
  const f = fixture(), store = new KnowledgeStore({ configManager: f.config });
  try {
    const service = new ProjectPlanningService(store, { defaultProjectId: 'explicit-project' });
    const saved = await service.recordDecision({ decision: { id: 'decision-0123456789', title: '保存された判断', decision: 'Original decision' } });
    const next = await service.recordDecision({ decision: { title: '保存された判断', decision: 'Updated decision' } });
    expect(next.decision.id).toBe(saved.decision.id); expect(next.source.id).toBe(saved.source.id); expect(next.decision.createdAt).toBe(saved.decision.createdAt);
    expect((await service.listDecisions()).decisions).toHaveLength(1);
  } finally { await store.close(); }
});
test('new non-Latin decision title receives one persisted opaque identity and retry adopts it', async () => {
  const f = fixture(), store = new KnowledgeStore({ configManager: f.config });
  try {
    const service = new ProjectPlanningService(store, { defaultProjectId: 'explicit-project' });
    const first = await service.recordDecision({ decision: { title: '決定事項', decision: 'First' } });
    const second = await service.recordDecision({ decision: { title: '決定事項', decision: 'Second' } });
    expect(first.decision.id).toMatch(/^decision-[a-p-]+$/); expect(second.decision.id).toBe(first.decision.id);
  } finally { await store.close(); }
});
test('ambiguous saved titles require actual IDs and preserve both old records', async () => {
  const f = fixture(), store = new KnowledgeStore({ configManager: f.config });
  try {
    const service = new ProjectPlanningService(store, { defaultProjectId: 'explicit-project' });
    await service.recordDecision({ decision: { id: 'first', title: 'Same title', decision: 'First' } });
    await service.recordDecision({ decision: { id: 'second', title: 'Same title', decision: 'Second' } });
    await expect(service.recordDecision({ decision: { title: 'Same title', decision: 'Third' } })).rejects.toThrow('Multiple saved decisions');
    expect((await service.listDecisions()).decisions).toHaveLength(2);
  } finally { await store.close(); }
});
