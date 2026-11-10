/** UNRUN: original native paths, no-write inspection and publication ownership. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkPlanStore } from '../platform/src/platform/workflow/work-plan-store.ts';
import { resolveWorkPlanLocation } from '../platform/src/platform/workflow/work-plan-location.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'work-plan-readonly-')); roots.push(root); const options = { homeDirectory: root, surfaceRoot: 'test', projectId: 'actual-project', projectRoot: '/actual/workspace' }; return { root, options, directory: join(root, '.goodvibes', 'test', 'work-plans') }; }
test('constructing and inspecting a fresh readonly plan creates no assignment, directory or pretend saved ID', () => {
  const f = fixture(), before = readdirSync(f.root), store = new WorkPlanStore(f.options), projection = store.getActivePlan({ readOnly: true });
  expect(projection.registration).toBe('unregistered'); expect(projection.id).toBe(''); expect(projection.items).toEqual([]);
  expect(readdirSync(f.root)).toEqual(before); expect(existsSync(f.directory)).toBe(false);
});
test('readonly old-plan lookup preserves exact bytes and leaves assignment metadata absent', () => {
  const f = fixture(); mkdirSync(f.directory, { recursive: true }); const path = join(f.directory, 'actual-old-name.json');
  const raw = JSON.stringify({ id: 'saved-plan', projectId: f.options.projectId, projectRoot: f.options.projectRoot, title: 'Saved plan', items: [], createdAt: 1, updatedAt: 1 }); writeFileSync(path, raw);
  const store = new WorkPlanStore(f.options); expect(store.getActivePlan({ readOnly: true }).id).toBe('saved-plan'); expect(store.filePath).toBe(path);
  expect(readFileSync(path, 'utf8')).toBe(raw); expect(readdirSync(f.directory)).toEqual(['actual-old-name.json']);
});
test('two readonly openers freeze a shared real assignment only when actual work begins', () => {
  const f = fixture(), first = new WorkPlanStore(f.options), second = new WorkPlanStore(f.options);
  expect(existsSync(f.directory)).toBe(false); first.addItem('First saved work'); second.addItem('Second saved work');
  expect(first.filePath).toBe(second.filePath); expect(first.getActivePlan().id).toBe(second.getActivePlan().id); expect(first.listItems().map(item => item.title)).toEqual(['First saved work', 'Second saved work']);
});
test('initial readonly discovery can observe another genuine first activation without making its own effects', () => {
  const f = fixture(); let activated = false, effects = 0, saved: string | undefined, bytes: Buffer | undefined;
  const selected = resolveWorkPlanLocation(f.directory, f.options, { readOnly: true, onEffect() { effects++; }, assertCurrent() {
    if (activated) return; activated = true;
    const writer = new WorkPlanStore(f.options); writer.addItem('Genuine concurrent first work');
    saved = writer.filePath; bytes = readFileSync(saved);
  } });
  expect(activated).toBe(true); expect(selected.path).toBe(saved!); expect(selected.registered).toBe(true); expect(effects).toBe(0);
  selected.assertCurrent(); expect(readFileSync(selected.path)).toEqual(bytes!);
  expect(readdirSync(join(f.directory, '.project-owners'))).toEqual(['0.json']);
});
test('a returned missing readonly view cannot adopt a later genuine activation', () => {
  const f = fixture(), selected = resolveWorkPlanLocation(f.directory, f.options, { readOnly: true });
  const writer = new WorkPlanStore(f.options); writer.addItem('Later work'); const bytes = readFileSync(writer.filePath);
  expect(() => selected.assertCurrent()).toThrow(); expect(selected.registered).toBe(false);
  expect(readFileSync(writer.filePath)).toEqual(bytes);
});
test.each(['physical', 'alias'] as const)('initial readonly retry never adopts a replaced original %s parent', kind => {
  const f = fixture(), original = join(f.root, 'original'), foreign = join(f.root, 'foreign'), alias = join(f.root, 'selected');
  mkdirSync(original); mkdirSync(foreign); if (kind === 'alias') symlinkSync(original, alias);
  const home = kind === 'alias' ? alias : original, directory = join(home, '.goodvibes', 'test', 'work-plans'); let changed = false;
  expect(() => resolveWorkPlanLocation(directory, { ...f.options, homeDirectory: home }, { readOnly: true, assertCurrent() {
    if (changed) return; changed = true;
    if (kind === 'alias') { rmSync(alias); symlinkSync(foreign, alias); }
    else { renameSync(original, `${original}.retained`); mkdirSync(original); }
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'foreign.json'), 'Foreign preserved bytes');
  } })).toThrow();
  expect(readFileSync(join(directory, 'foreign.json'), 'utf8')).toBe('Foreign preserved bytes');
  expect(readdirSync(directory)).toEqual(['foreign.json']);
});
test('same-size original assignment replacement during a borrowed effect cannot publish through its copied JSON', () => {
  const f = fixture(), store = new WorkPlanStore(f.options); store.addItem('Existing'); const oldBytes = readFileSync(store.filePath), assignment = join(f.directory, '.project-owners', '0.json'); let replaced = false;
  expect(() => store.addItem('Must not publish', {}, { onEffect() { if (replaced) return; replaced = true; const bytes = readFileSync(assignment); renameSync(assignment, `${assignment}.retained`); writeFileSync(assignment, bytes); } })).toThrow();
  expect(readFileSync(store.filePath)).toEqual(oldBytes); expect(existsSync(`${assignment}.retained`)).toBe(true);
});
test('a replaced original parent withholds publication and foreign temporary cleanup', () => {
  const f = fixture(); let replaced = false; const foreignStage = '.assign-foreign.tmp';
  expect(() => resolveWorkPlanLocation(f.directory, f.options, { onEffect() {
    const owners = join(f.directory, '.project-owners'); if (replaced || !existsSync(owners) || !readdirSync(owners).some(name => name.endsWith('.tmp'))) return;
    replaced = true; renameSync(owners, `${owners}.retained`); mkdirSync(owners); writeFileSync(join(owners, foreignStage), 'foreign');
  } })).toThrow();
  expect(readFileSync(join(f.directory, '.project-owners', foreignStage), 'utf8')).toBe('foreign'); expect(existsSync(join(f.directory, '.project-owners', '0.json'))).toBe(false);
});
test('an original temporary replaced by another inode is never published or removed', () => {
  const f = fixture(); let foreign: string | undefined;
  expect(() => resolveWorkPlanLocation(f.directory, f.options, { onEffect() {
    const owners = join(f.directory, '.project-owners'); if (foreign || !existsSync(owners)) return; const name = readdirSync(owners).find(name => name.endsWith('.tmp')); if (!name) return;
    foreign = join(owners, name); renameSync(foreign, `${foreign}.retained`); writeFileSync(foreign, 'foreign');
  } })).toThrow();
  if (!foreign) throw Error('Missing actual stage replacement'); expect(readFileSync(foreign, 'utf8')).toBe('foreign'); expect(existsSync(join(f.directory, '.project-owners', '0.json'))).toBe(false);
});
test('owned assignment permissions stay private under a permissive process umask', () => {
  const f = fixture(), previous = process.umask(0);
  try { const store = new WorkPlanStore(f.options); store.addItem('Private'); expect(Number(lstatSync(join(f.directory, '.project-owners', '0.json')).mode) & 0o777).toBe(0o600); }
  finally { process.umask(previous); }
});

test('a derived internal native-plan directory alias is refused before outside read or write', () => {
  const f = fixture(), foreign = join(f.root, 'foreign'); mkdirSync(f.directory, { recursive: true }); mkdirSync(foreign);
  const payload = JSON.stringify({ id: 'foreign-plan', projectId: f.options.projectId, projectRoot: f.options.projectRoot, title: 'Outside', items: [] }); writeFileSync(join(foreign, '0.json'), payload);
  symlinkSync(foreign, join(f.directory, '.native-plans'));
  expect(() => new WorkPlanStore(f.options)).toThrow(); expect(readFileSync(join(foreign, '0.json'), 'utf8')).toBe(payload); expect(readdirSync(foreign)).toEqual(['0.json']);
});
test('changing an originally missing internal native directory into an alias retires the original store', () => {
  const f = fixture(), store = new WorkPlanStore(f.options), foreign = join(f.root, 'foreign'); mkdirSync(f.directory, { recursive: true }); mkdirSync(foreign);
  writeFileSync(join(foreign, 'sentinel'), 'outside'); symlinkSync(foreign, join(f.directory, '.native-plans'));
  expect(() => store.addItem('Must not write outside')).toThrow(); expect(readdirSync(foreign)).toEqual(['sentinel']);
});
