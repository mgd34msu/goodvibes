/** Original snapshot frames survive awaits without adopting foreign files. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileObservationIdentity } from '../platform/src/platform/utils/file-observation.js';
import { writeFileAtomic } from '../platform/src/platform/utils/atomic-json-store.js';
import { deserializeWorkstream, loadWorkstreamSnapshot, retainNewWorkstreamSnapshot, serializeWorkstreamSnapshot, writeWorkstreamSnapshot } from '../platform/src/platform/orchestration/persistence.js';
import type { Workstream } from '../platform/src/platform/orchestration/types.js';
import { createOrchestrationEngine } from '../platform/src/platform/orchestration/engine.js';
import { createOrchestrationHarness, engineerReportOutput, makeFakeConfigManager } from './_helpers/orchestration-harness.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
const roots: string[] = [];
const owners: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of owners.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function engineAt(root: string) {
  const h = createOrchestrationHarness();
  const engine = createOrchestrationEngine({ projectRoot: root, agentManager: h.agentManager, configManager: makeFakeConfigManager(), runtimeBus: h.bus,
    createWorktree: () => h.worktree, skipClaimVerification: true });
  owners.push(async () => {
    for (const record of h.spawnedRecords) if (record.status === 'running') h.completeAgent(record.id, engineerReportOutput({}));
    engine.dispose(); await engine.join();
  });
  return { engine, h };
}
const make = (): Workstream => ({ id: 'ws-owned', title: 'Original', schemaVersion: 1, phases: [], items: [], createdAt: 0 });
function fixture() { const root = makeProjectTempDir('snapshot-owner'); roots.push(root); return { root, path: join(root, '.goodvibes', 'orchestration', 'ws-owned.json') }; }

test('the retained original absence cannot adopt a valid foreign snapshot appearing across an await', async () => {
  const f = fixture(), original = make(); retainNewWorkstreamSnapshot(f.root, original);
  await Promise.resolve();
  const foreign = serializeWorkstreamSnapshot({ ...original, title: 'Foreign original' }, [])!;
  writeFileAtomic(f.path, foreign);
  writeWorkstreamSnapshot(f.root, original, []);
  expect(fs.readFileSync(f.path, 'utf8')).toBe(foreign);
  expect(() => retainNewWorkstreamSnapshot(f.root, make())).toThrow('already exists');
});

test('a copied model cannot cold-adopt a saved target; a native load carries its own read frame', () => {
  const f = fixture(), original = make(); writeWorkstreamSnapshot(f.root, original, []);
  const before = fs.readFileSync(f.path, 'utf8');
  writeWorkstreamSnapshot(f.root, { ...original, title: 'Copied replacement' }, []);
  expect(fs.readFileSync(f.path, 'utf8')).toBe(before);
  const loaded = loadWorkstreamSnapshot(f.root, original.id); expect(loaded).not.toBeNull();
  const resumed = deserializeWorkstream(loaded!.workstream); resumed.title = 'Native resumed title';
  writeWorkstreamSnapshot(f.root, resumed, []);
  expect(loadWorkstreamSnapshot(f.root, original.id)?.workstream.title).toBe('Native resumed title');
  expect(fs.existsSync(`${f.path}.lock`)).toBe(false);
});

test('a same-byte physical replacement retires an actual read frame permanently', () => {
  const f = fixture(), original = make(); writeWorkstreamSnapshot(f.root, original, []);
  const loaded = loadWorkstreamSnapshot(f.root, original.id)!;
  const resumed = deserializeWorkstream(loaded.workstream);
  const bytes = fs.readFileSync(f.path); writeFileAtomic(f.path, bytes);
  const replacement = fs.statSync(f.path, { bigint: true });
  resumed.title = 'Must not replace another generation';
  writeWorkstreamSnapshot(f.root, resumed, []);
  writeWorkstreamSnapshot(f.root, resumed, []);
  expect(fs.statSync(f.path, { bigint: true }).ino).toBe(replacement.ino);
  expect(fs.readFileSync(f.path)).toEqual(bytes);
});

test('a late foreign leaf between the final guard and exclusive native publication is preserved', () => {
  const f = fixture(), original = make(); retainNewWorkstreamSnapshot(f.root, original);
  const selected = join(fs.realpathSync(join(f.root, '.goodvibes', 'orchestration')), 'ws-owned.json');
  const actualLink = fs.linkSync; let inserted = false;
  const link = spyOn(fs, 'linkSync').mockImplementation((source, target) => {
    if (target === selected && !inserted) { inserted = true; fs.writeFileSync(f.path, 'Foreign final-window bytes', { flag: 'wx', mode: 0o644 }); }
    return actualLink(source, target);
  });
  try {
    writeWorkstreamSnapshot(f.root, original, []);
    expect(inserted).toBe(true);
    expect(fs.readFileSync(f.path, 'utf8')).toBe('Foreign final-window bytes');
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(join(f.root, '.goodvibes', 'orchestration')).filter(name => name.includes('.tmp-'))).toEqual([]);
  } finally { link.mockRestore(); }
});

test('retiring a native read parent alias never writes through its replacement', () => {
  const f = fixture(), directory = join(f.root, '.goodvibes', 'orchestration');
  fs.mkdirSync(directory, { recursive: true });
  const first = join(f.root, 'first'), second = join(f.root, 'second');
  fs.renameSync(directory, first); fs.mkdirSync(second); fs.symlinkSync(first, directory, 'dir');
  const original = make(); writeWorkstreamSnapshot(f.root, original, []);
  const loaded = loadWorkstreamSnapshot(f.root, original.id)!, resumed = deserializeWorkstream(loaded.workstream);
  const bytes = fs.readFileSync(join(first, 'ws-owned.json'));
  fs.unlinkSync(directory); fs.symlinkSync(second, directory, 'dir');
  resumed.title = 'Must not follow new alias'; writeWorkstreamSnapshot(f.root, resumed, []);
  expect(fs.readdirSync(second)).toEqual([]);
  expect(fs.readFileSync(join(first, 'ws-owned.json'))).toEqual(bytes);
});


test('a later WeakMap method override cannot manufacture native snapshot ownership for a copied model', () => {
  const f = fixture(), original = make(); writeWorkstreamSnapshot(f.root, original, []);
  const bytes = fs.readFileSync(f.path), directory = fs.realpathSync(join(f.root, '.goodvibes', 'orchestration'));
  const fabricated = { selection: f.path, path: join(directory, 'ws-owned.json'), physical: fileObservationIdentity(f.path),
    parent: { canonical: directory, assertCurrent() {} } };
  const override = spyOn(WeakMap.prototype, 'get').mockReturnValue(fabricated);
  try { writeWorkstreamSnapshot(f.root, { ...original, title: 'Forged copied owner' }, []); }
  finally { override.mockRestore(); }
  expect(fs.readFileSync(f.path)).toEqual(bytes);
});


test('actual engine creation checks the saved destination before announcing groups or replacing history', async () => {
  const f = fixture(), original = make(); writeWorkstreamSnapshot(f.root, original, []);
  const bytes = fs.readFileSync(f.path), { engine } = engineAt(f.root), events: string[] = [];
  engine.on(event => events.push(event.type));
  expect(() => engine.createWorkstream({ id: original.id, title: 'Replacement', isolation: 'worktree',
    phases: [{ role: 'engineer', kind: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] } }],
    items: [{ id: 'unit', title: 'attempt', task: 'task', attempts: 2 }] })).toThrow('already exists');
  expect(engine.listWorkstreams()).toEqual([]); expect(await engine.listHeldMergeGroups()).toEqual([]);
  expect(events).toEqual([]); expect(fs.readFileSync(f.path)).toEqual(bytes);
});

test('the actual debounced engine writer retains creation absence through phase execution and disposal', async () => {
  const f = fixture(), { engine, h } = engineAt(f.root);
  const stream = engine.createWorkstream({ id: 'ws-owned', title: 'Original',
    phases: [{ role: 'engineer', kind: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] } }],
    items: [{ id: 'unit', title: 'unit', task: 'task' }] });
  const foreign = serializeWorkstreamSnapshot({ ...make(), title: 'Late foreign original' }, [])!;
  writeFileAtomic(f.path, foreign);
  engine.start(stream.id); h.completeAgent(stream.items[0]!.agentId!, engineerReportOutput({}));
  await engine.join(); engine.dispose();
  expect(fs.readFileSync(f.path, 'utf8')).toBe(foreign);
});

test('actual native resume keeps its original read frame for the resumed model', () => {
  const f = fixture(), original = make(); writeWorkstreamSnapshot(f.root, original, []);
  const { engine } = engineAt(f.root);
  expect(engine.resumeWorkstream(original.id)).toBe(true);
  const resumed = engine.getWorkstream(original.id)!;
  resumed.title = 'Resumed owner publication'; writeWorkstreamSnapshot(f.root, resumed, []);
  expect(loadWorkstreamSnapshot(f.root, original.id)?.workstream.title).toBe('Resumed owner publication');
  const bytes = fs.readFileSync(f.path); writeFileAtomic(f.path, bytes);
  resumed.title = 'Retired owner'; writeWorkstreamSnapshot(f.root, resumed, []);
  expect(fs.readFileSync(f.path)).toEqual(bytes);
});

test('an import requeue event cannot reentrantly publish another creator for the same ID', async () => {
  const f = fixture(), first = engineAt(f.root);
  const original = first.engine.createWorkstream({ id: 'ws-owned', title: 'Original',
    phases: [{ role: 'engineer', kind: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] } }],
    items: [{ id: 'unit', title: 'unit', task: 'task' }] });
  first.engine.start(original.id);
  const interrupted = first.engine.serializeWorkstream(original.id)!;
  first.h.completeAgent(original.items[0]!.agentId!, engineerReportOutput({})); await first.engine.join(); first.engine.dispose();
  const { engine } = engineAt(f.root); let refused = false;
  engine.on(event => {
    if (event.type !== 'item-requeued') return;
    try { engine.createWorkstream({ id: original.id, title: 'Reentrant replacement', phases: [], items: [] }); }
    catch (error) { refused = error instanceof RangeError; }
  });
  expect(engine.importWorkstream(interrupted)).toBe(true);
  expect(refused).toBe(true); expect(engine.getWorkstream(original.id)?.title).toBe('Original');
  expect(engine.getWorkstream(original.id)?.items[0]?.state).toBe('pending');
});
