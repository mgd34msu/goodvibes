import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WorkPlanStore, type WorkPlanStoreOptions } from '../platform/src/platform/workflow/work-plan-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

function options(projectId = 'project:test', projectRoot = '/projects/test'): WorkPlanStoreOptions {
  return { homeDirectory: makeProjectTempDir('work-plan-location-'), surfaceRoot: 'test', projectId, projectRoot };
}
const directory = (o: WorkPlanStoreOptions) => join(o.homeDirectory, '.goodvibes', o.surfaceRoot, 'work-plans');
function saveOldPlan(o: WorkPlanStoreOptions, filename: string): string {
  mkdirSync(directory(o), { recursive: true });
  const path = join(directory(o), filename), time = Date.now();
  writeFileSync(path, JSON.stringify({ id: 'wp-existing', projectId: o.projectId, projectRoot: o.projectRoot,
    title: 'Existing work', createdAt: time, updatedAt: time,
    items: [{ id: 'wpi-existing', title: 'Keep this work', status: 'pending', createdAt: time, updatedAt: time }] }));
  return path;
}

describe('exact work-plan project ownership', () => {
  test('two opens before the first item share the same persistent assignment and plan ID', () => {
    const o = options(), first = new WorkPlanStore(o), second = new WorkPlanStore(o);
    expect(second.filePath).toBe(first.filePath);
    expect(second.getActivePlan().id).toBe(first.getActivePlan().id);
    second.addItem('Created by the second opener');
    expect(first.listItems().map(item => item.title)).toEqual(['Created by the second opener']);
  });

  test('sanitization collisions, equal IDs under different roots, and very long IDs remain separate', () => {
    const o = options(), projects = [o,
      { ...o, projectId: 'project/test' }, { ...o, projectRoot: '/projects/other' },
      { ...o, projectId: `project:${'long'.repeat(10_000)}` }];
    const stores = projects.map(project => new WorkPlanStore(project));
    stores.forEach((store, index) => store.addItem(`Work ${index}`));
    expect(new Set(stores.map(store => store.filePath)).size).toBe(projects.length);
    stores.forEach((store, index) => {
      expect(Buffer.byteLength(basename(store.filePath))).toBeLessThan(100);
      expect(new WorkPlanStore(projects[index]!).listItems().map(item => item.title)).toEqual([`Work ${index}`]);
    });
  });

  for (const filename of ['project-test.json', `${'a'.repeat(80)}-0123456789abcdef.json`]) {
    test(`adopts existing ${filename.length > 30 ? 'digest-suffixed' : 'short'} filenames using their recorded owner`, () => {
      const o = options(), path = saveOldPlan(o, filename), original = readFileSync(path);
      const store = new WorkPlanStore(o);
      expect(store.filePath).toBe(path);
      expect(store.getActivePlan().id).toBe('wp-existing');
      expect(store.listItems().map(item => item.title)).toEqual(['Keep this work']);
      expect(readFileSync(path)).toEqual(original);
      expect(new WorkPlanStore(o).filePath).toBe(path);
    });
  }

  test('a colliding old filename belonging to another project is not adopted or changed', () => {
    const o = options(), oldPath = saveOldPlan(o, 'project-test.json'), original = readFileSync(oldPath);
    const other = new WorkPlanStore({ ...o, projectRoot: '/projects/other' });
    expect(other.filePath).not.toBe(oldPath);
    other.addItem('Other project');
    expect(readFileSync(oldPath)).toEqual(original);
    expect(new WorkPlanStore(o).filePath).toBe(oldPath);
  });

  test('an assigned file whose project changed is refused without quarantine or overwrite', () => {
    const o = options(), store = new WorkPlanStore(o);
    store.addItem('Current work');
    const document = JSON.parse(readFileSync(store.filePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(store.filePath, JSON.stringify({ ...document, projectRoot: '/projects/foreign' }));
    const foreign = readFileSync(store.filePath);
    expect(() => store.listItems()).toThrow('different project');
    expect(() => store.addItem('Must not overwrite')).toThrow('different project');
    expect(readFileSync(store.filePath)).toEqual(foreign);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable assigned plan is not returned as empty or overwritten', () => {
    const store = new WorkPlanStore(options()); store.addItem('Preserve');
    const original = readFileSync(store.filePath);
    chmodSync(store.filePath, 0o000);
    try {
      expect(() => store.getActivePlan()).toThrow();
      expect(() => store.addItem('Must not overwrite')).toThrow();
    } finally { chmodSync(store.filePath, 0o600); }
    expect(readFileSync(store.filePath)).toEqual(original);
  });

  test('unreadable older files stay untouched and their recovery paths survive reopening', () => {
    const o = options(); mkdirSync(directory(o), { recursive: true });
    const path = join(directory(o), 'old-project.json'), partial = '{"items":[{"title":"unfinished';
    writeFileSync(path, partial);
    for (let i = 0; i < 2; i++) {
      const store = new WorkPlanStore(o);
      expect(store.getActivePlan().unassignedPlanPaths).toEqual([path]);
      expect(store.toMarkdown()).toContain(path);
      expect(readFileSync(path, 'utf8')).toBe(partial);
      store.addItem(`New item ${i}`);
    }
  });

  test('corrupt project assignments cannot silently allocate a replacement plan', () => {
    const o = options(), first = new WorkPlanStore(o); first.addItem('Preserve');
    const path = join(directory(o), '.project-owners', '0.json'), original = readFileSync(first.filePath);
    writeFileSync(path, '{"version":');
    expect(() => new WorkPlanStore(o)).toThrow('project assignment is unreadable');
    expect(readFileSync(first.filePath)).toEqual(original);
    expect(readdirSync(join(directory(o), '.project-owners'))).toEqual(['0.json']);
  });

  test('a lost assignment beneath a saved native plan cannot reset or reassign the plan', () => {
    const o = options(), first = new WorkPlanStore(o); first.addItem('Preserve');
    const original = readFileSync(first.filePath);
    unlinkSync(join(directory(o), '.project-owners', '0.json'));
    expect(() => new WorkPlanStore(o)).toThrow('project assignment is missing');
    expect(() => new WorkPlanStore({ ...o, projectRoot: '/projects/other' })).toThrow('project assignment is missing');
    expect(readFileSync(first.filePath)).toEqual(original);
  });

  test('simultaneous first opens in separate processes converge on one assignment per exact project', async () => {
    const o = options(), start = join(o.homeDirectory, 'start');
    const modulePath = new URL('../platform/src/platform/workflow/work-plan-store.ts', import.meta.url).href;
    const script = `import { existsSync, writeFileSync } from 'node:fs';
      import { WorkPlanStore } from ${JSON.stringify(modulePath)};
      const [raw, ready, start] = process.argv.slice(1);
      writeFileSync(ready, 'ready');
      const deadline = Date.now() + 10000;
      while (!existsSync(start)) { if (Date.now() > deadline) throw new Error('Barrier timed out'); await Bun.sleep(10); }
      const store = new WorkPlanStore(JSON.parse(raw));
      const plan = store.getActivePlan();
      console.log(JSON.stringify({ path: store.filePath, id: plan.id }));`;
    const specs = Array.from({ length: 6 }, (_, index) => ({ ...o, projectRoot: index % 2 ? '/projects/other' : o.projectRoot }));
    const ready = specs.map((_, index) => join(o.homeDirectory, `ready-${index}`));
    const children = specs.map((spec, index) => Bun.spawn([process.execPath, '--eval', script, JSON.stringify(spec), ready[index]!, start],
      { stdout: 'pipe', stderr: 'pipe' }));
    const output = children.map(async child => ({ code: await child.exited,
      stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }));
    try {
      const deadline = Date.now() + 10000;
      while (!ready.every(path => existsSync(path))) {
        if (Date.now() > deadline) throw new Error('Work plan children did not reach their barrier');
        await Bun.sleep(10);
      }
      writeFileSync(start, 'start');
      const results = await Promise.all(output);
      expect(results.map(result => [result.code, result.stderr])).toEqual(specs.map(() => [0, '']));
      const assigned = results.map(result => JSON.parse(result.stdout) as { path: string; id: string });
      expect(new Set(assigned.map(result => result.path)).size).toBe(2);
      for (let index = 0; index < assigned.length; index++) {
        expect(assigned[index]).toEqual(assigned[index % 2]);
        expect(new WorkPlanStore(specs[index]!).filePath).toBe(assigned[index]!.path);
      }
      expect(readdirSync(join(directory(o), '.project-owners')).sort()).toEqual(['0.json', '1.json']);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(output);
    }
  }, 30_000);
});
