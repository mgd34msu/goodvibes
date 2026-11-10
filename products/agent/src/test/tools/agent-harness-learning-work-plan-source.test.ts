import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkPlanStore } from '@goodvibes-jev/engine/platform/platform/workflow';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { acquireLearningCuratorSource } from '../../tools/agent-harness-learning-curator-source.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'gv-learning-work-plan-')); roots.push(home);
  const workspace = join(home, 'workspace'); mkdirSync(workspace);
  const work = new WorkPlanStore({ homeDirectory: home, surfaceRoot: 'agent', projectId: 'learning-source-fixture', projectRoot: workspace });
  const context = { workspace: { shellPaths: createShellPathService({ homeDirectory: home, workingDirectory: workspace }), workPlanStore: work } };
  return { home, work, context };
}

test('the original native location getter supports readonly candidates and a fresh source after actual publication', () => {
  const f = fixture();
  const before = acquireLearningCuratorSource(f.context, {});
  expect(before.source.workItems).toEqual([]); before.assertCurrent();
  f.work.addItem('Retain the original native work plan');
  expect(existsSync(f.work.filePath)).toBe(true);
  expect(() => before.assertCurrent()).toThrow(ToolInputProjectionError);
  const after = acquireLearningCuratorSource(f.context, {});
  expect(after.source.workItems).toHaveLength(1); after.assertCurrent();
});

for (const replacement of ['own-getter', 'prototype-getter', 'backing-getter'] as const) test(`native work plan ${replacement} is refused without invoking it`, () => {
  const f = fixture(), original = Object.getOwnPropertyDescriptor(WorkPlanStore.prototype, 'filePath')!;
  let touched = 0;
  try {
    const descriptor = { configurable: true, get() { touched++; return join(f.home, 'foreign-plan'); } };
    if (replacement === 'prototype-getter') Object.defineProperty(WorkPlanStore.prototype, 'filePath', descriptor);
    else Object.defineProperty(f.work, replacement === 'own-getter' ? 'filePath' : 'selectedPath', descriptor);
    expect(() => acquireLearningCuratorSource(f.context, {})).toThrow(ToolInputProjectionError);
    expect(touched).toBe(0);
  } finally { Object.defineProperty(WorkPlanStore.prototype, 'filePath', original); }
});

test('a changed native path after an await is held even when the temporary getter is restored', async () => {
  const f = fixture(), source = acquireLearningCuratorSource(f.context, {});
  let touched = 0;
  Object.defineProperty(f.work, 'filePath', { configurable: true, get() { touched++; return join(f.home, 'foreign-plan'); } });
  Object.defineProperty(f.work, 'selectedPath', { value: join(f.home, 'foreign-plan') });
  await Promise.resolve();
  Reflect.deleteProperty(f.work, 'filePath');
  expect(() => source.assertCurrent()).toThrow(ToolInputProjectionError);
  expect(touched).toBe(0);
});
