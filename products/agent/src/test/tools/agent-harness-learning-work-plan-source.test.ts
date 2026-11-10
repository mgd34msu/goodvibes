import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

test('a learning source reuses the actual native item read while retaining every caller check and original file', async () => {
  const f = fixture(); f.work.addItem('Actual authored source', { status: 'done', notes: 'Keep the original complete notes.' });
  const bytes = readFileSync(f.work.filePath), reading = spyOn(fs, 'readFileSync'), syncing = spyOn(fs, 'fsyncSync');
  let callers = 0;
  try {
    // No registry stand-ins are needed to exercise this genuine native owner.
    const source = acquireLearningCuratorSource({ workspace: { workPlanStore: f.work } }, { assertCurrent() { callers++; } });
    const reads = reading.mock.calls.length;
    expect(reads).toBeGreaterThan(0); expect(source.source.workItems).toHaveLength(1);
    for (let index = 0; index < 8; index++) {
      await Promise.resolve();
      const before = callers; source.assertCurrent(); expect(callers).toBeGreaterThan(before);
    }
    expect(reading.mock.calls.length).toBe(reads); expect(syncing.mock.calls).toHaveLength(0);
  } finally { reading.mockRestore(); syncing.mockRestore(); }
  expect(readFileSync(f.work.filePath)).toEqual(bytes);
});

test.each(['contents', 'same-byte-file', 'same-byte-assignment', 'method'] as const)('a retained learning source refuses actual native %s changes before reusing work', async change => {
  const f = fixture(); f.work.addItem('Original authored source');
  const source = acquireLearningCuratorSource(f.context, {});
  if (change === 'contents') f.work.addItem('Later independent source');
  else if (change === 'method') Object.defineProperty(f.work, 'listItems', { value: () => [] });
  else {
    const path = change === 'same-byte-assignment'
      ? join(f.home, '.goodvibes', 'agent', 'work-plans', '.project-owners', '0.json') : f.work.filePath;
    const bytes = readFileSync(path); renameSync(path, `${path}.retained`); writeFileSync(path, bytes);
  }
  await Promise.resolve(); expect(source.assertCurrent).toThrow();
  expect(source.source.workItems).toHaveLength(1);
  if (change === 'contents') {
    const fresh = acquireLearningCuratorSource(f.context, {}); fresh.assertCurrent();
    expect(fresh.source.workItems.map(item => item.title)).toEqual(['Original authored source', 'Later independent source']);
  }
});

test('ordinary work-plan stand-ins are freshly read and mutable returned data cannot borrow a native observation', async () => {
  const item = { id: 'authored-work', title: 'Original stand-in source', status: 'done' as const, createdAt: 1, updatedAt: 1 };
  let reads = 0;
  const work = { listItems() { reads++; return [item]; } };
  const source = acquireLearningCuratorSource({ workspace: { workPlanStore: work } }, {}), before = reads;
  await Promise.resolve(); source.assertCurrent(); expect(reads).toBeGreaterThan(before);
  item.title = 'Changed actual stand-in source';
  expect(source.assertCurrent).toThrow(ToolInputProjectionError);
});
