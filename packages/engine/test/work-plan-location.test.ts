import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WorkPlanStore, type WorkPlanStoreOptions } from '../platform/src/platform/workflow/work-plan-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

function options(projectId = 'project:test', projectRoot = '/projects/test'): WorkPlanStoreOptions {
  return { homeDirectory: makeProjectTempDir('work-plan-location-'), surfaceRoot: 'test', projectId, projectRoot };
}
const directory = (o: WorkPlanStoreOptions) => join(o.homeDirectory, '.goodvibes', o.surfaceRoot, 'work-plans');
const planText = (o: WorkPlanStoreOptions, title: string) => JSON.stringify({ id: 'wp-existing', projectId: o.projectId, projectRoot: o.projectRoot,
  title: 'Existing work', createdAt: 1, updatedAt: 1, items: [{ id: 'wpi-existing', title, status: 'pending', createdAt: 1, updatedAt: 1 }] });

describe('work-plan location', () => {
  test('two opens share one plan, and projects whose names look alike never share a file', () => {
    const o = options(), first = new WorkPlanStore(o), second = new WorkPlanStore(o);
    expect(second.filePath).toBe(first.filePath);
    second.addItem('Created by the second opener');
    expect(first.listItems().map(item => item.title)).toEqual(['Created by the second opener']);
    const projects = [o, { ...o, projectId: 'project/test' }, { ...o, projectRoot: '/projects/other' }, { ...o, projectId: `project:${'long'.repeat(10_000)}` }];
    const paths = projects.map(project => new WorkPlanStore(project).filePath);
    expect(new Set(paths).size).toBe(projects.length);
    for (const path of paths) expect(Buffer.byteLength(basename(path))).toBeLessThan(100);
  });

  test('an earlier build\'s assignment table is imported once with every saved item, then retired', () => {
    const o = options(), other = { ...o, projectId: 'project:other', projectRoot: '/projects/other' }, dir = directory(o);
    mkdirSync(join(dir, '.project-owners'), { recursive: true }); mkdirSync(join(dir, '.native-plans'));
    writeFileSync(join(dir, '.native-plans', '0.json'), planText(o, 'Saved in a numbered slot'));
    writeFileSync(join(dir, '.project-owners', '0.json'), JSON.stringify({ version: 1, ...o, planId: 'wp-existing', planFile: '.native-plans/0.json', unassignedFiles: [] }));
    writeFileSync(join(dir, 'older-name.json'), planText(other, 'Saved before the table'));
    writeFileSync(join(dir, 'unattributed.json'), '{"items":[]}');

    const store = new WorkPlanStore(o);
    expect(store.listItems().map(item => item.title)).toEqual(['Saved in a numbered slot']);
    expect(new WorkPlanStore(other).listItems().map(item => item.title)).toEqual(['Saved before the table']);
    expect(existsSync(join(dir, '.project-owners'))).toBe(false);
    expect(existsSync(join(dir, '.native-plans'))).toBe(false);
    expect(store.getActivePlan().unassignedPlanPaths).toEqual([join(dir, 'unattributed.json')]);
    expect(readdirSync(dir).filter(name => name.endsWith('.json')).length).toBe(3);
  });
});
