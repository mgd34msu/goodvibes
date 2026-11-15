/** A plan file this version can only read in part is preserved before it is rewritten. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { WorkPlanStore } from '../platform/src/platform/workflow/work-plan-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function makeStore(): WorkPlanStore {
  return new WorkPlanStore({ homeDirectory: makeProjectTempDir('gv-work-plan-lossy'), surfaceRoot: 'test-surface', projectId: 'project:test-workspace', projectRoot: '/tmp/test-workspace' });
}

function seed(store: WorkPlanStore, items: unknown[]): string {
  mkdirSync(dirname(store.filePath), { recursive: true });
  const text = JSON.stringify({ id: 'wp-fixture', projectId: 'project:test-workspace', projectRoot: '/tmp/test-workspace', title: 'Work Plan', createdAt: 1, updatedAt: 1, items });
  writeFileSync(store.filePath, text, 'utf8');
  return text;
}

describe('work plan with items this version cannot fully read', () => {
  test('the original file is preserved and the change is disclosed before the first write', () => {
    const store = makeStore();
    const original = seed(store, [
      { id: 'a', title: 'keeps', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'b', title: 'newer status', status: 'review', createdAt: 1, updatedAt: 1 },
      { id: 'c', name: 'renamed field', status: 'pending', createdAt: 1, updatedAt: 1 },
    ]);
    store.addItem('one more');

    const kept = readdirSync(dirname(store.filePath)).filter((n) => n.startsWith(`${basename(store.filePath)}.corrupt-`) && !n.endsWith('.why'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dirname(store.filePath), kept[0]!), 'utf8')).toBe(original);
    const plan = store.getActivePlan();
    expect(plan.housekeeping).toMatchObject({ droppedItems: 1, coercedItems: 1 });
    expect(store.toMarkdown(plan)).toContain('could not read');
  });

  test('a read reports the loss and leaves the file untouched', () => {
    const store = makeStore();
    const original = seed(store, [{ id: 'b', title: 'newer status', status: 'review', createdAt: 1, updatedAt: 1 }]);
    const plan = store.getActivePlan();
    expect(plan.housekeeping).toMatchObject({ recoveryRequired: true, coercedItems: 1 });
    expect(readFileSync(store.filePath, 'utf8')).toBe(original);
  });

  test('a fully understood plan is not touched', () => {
    const store = makeStore();
    seed(store, [{ id: 'a', title: 'ok', status: 'blocked', createdAt: 1, updatedAt: 1 }]);
    store.addItem('two');
    expect(readdirSync(dirname(store.filePath)).filter((n) => n.includes('.corrupt-'))).toEqual([]);
  });
});

