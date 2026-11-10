import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWorkPlanLocation, WorkPlanStore } from '../platform/src/platform/workflow/work-plan-store.ts';
import { ToolInputProjectionError } from '../platform/src/platform/tools/input-projection.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'work-plan-observation-')); roots.push(homeDirectory);
  return new WorkPlanStore({ homeDirectory, surfaceRoot: 'test', projectId: 'actual-project', projectRoot: homeDirectory });
}

test('the actual native location can be observed before and after its first ordinary publication', async () => {
  const store = fixture(), current = captureWorkPlanLocation(store);
  await Promise.resolve(); current();
  store.addItem('Actual saved work'); current();
  expect(store.listItems({ readOnly: true })).toHaveLength(1);
});

for (const kind of ['own-getter', 'backing-getter', 'prototype-getter'] as const) test(`${kind} is never invoked during capture or a retained check`, async () => {
  const store = fixture(), current = captureWorkPlanLocation(store);
  const owner = kind === 'prototype-getter' ? WorkPlanStore.prototype : store;
  const key = kind === 'backing-getter' ? 'selectedPath' : 'filePath';
  const original = Object.getOwnPropertyDescriptor(owner, key); let calls = 0;
  try {
    Object.defineProperty(owner, key, { configurable: true, get() { calls++; return '/foreign'; } });
    await Promise.resolve();
    expect(() => current()).toThrow(ToolInputProjectionError);
    expect(() => captureWorkPlanLocation(store)).toThrow(ToolInputProjectionError);
    expect(calls).toBe(0);
  } finally { if (original) Object.defineProperty(owner, key, original); else Reflect.deleteProperty(owner, key); }
});

test('a copied or prototype-forged store cannot borrow the native getter exemption', () => {
  const store = fixture();
  const copy = Object.assign(Object.create(WorkPlanStore.prototype), store);
  expect(() => captureWorkPlanLocation(copy)).toThrow(ToolInputProjectionError);
  const proxy = new Proxy(store, { getOwnPropertyDescriptor() { throw new Error('Proxy must not execute'); } });
  expect(() => captureWorkPlanLocation(proxy)).toThrow(ToolInputProjectionError);
});

test('a retained location refuses backing data replacement after an await', async () => {
  const store = fixture(), current = captureWorkPlanLocation(store);
  Object.defineProperty(store, 'selectedPath', { value: join(store.homeDirectory, 'foreign') });
  await Promise.resolve(); expect(() => current()).toThrow(ToolInputProjectionError);
});

test('ordinary stand-ins remain data-only and keep exact descriptors and ancestry', async () => {
  const store = { filePath: '/ordinary' }, current = captureWorkPlanLocation(store);
  await Promise.resolve(); current(); store.filePath = '/changed';
  expect(() => current()).toThrow(ToolInputProjectionError);
  let calls = 0;
  const borrowed = Object.defineProperty({}, 'filePath', { get() { calls++; return '/foreign'; } });
  expect(() => captureWorkPlanLocation(borrowed)).toThrow(ToolInputProjectionError); expect(calls).toBe(0);
  const withoutLocation = { listItems: () => [] }, absent = captureWorkPlanLocation(withoutLocation);
  absent(); Object.defineProperty(withoutLocation, 'filePath', { value: '/later' });
  expect(() => absent()).toThrow(ToolInputProjectionError);
});

test('completed invocation restrictions retire while native source custody and a fresh next invocation remain live', async () => {
  const store = fixture(); let active = true;
  const effects = { assertCurrent() { if (!active) throw new Error('Original invocation retired'); } };
  store.addItem('First original invocation', {}, effects); active = false;
  await Promise.resolve();
  expect(store.listItems({ readOnly: true }).map(item => item.title)).toEqual(['First original invocation']);
  const before = readFileSync(store.filePath);
  expect(() => store.addItem('Rejected retired invocation', {}, effects)).toThrow('Original invocation retired');
  expect(readFileSync(store.filePath)).toEqual(before);
  let nextActive = true;
  store.addItem('Fresh independent invocation', {}, { assertCurrent() { if (!nextActive) throw new Error('Next invocation retired'); } });
  nextActive = false;
  expect(store.listItems({ readOnly: true })).toHaveLength(2);
  // Detaching an operation restriction cannot detach the original assignment.
  const assignment = join(store.homeDirectory, '.goodvibes', 'test', 'work-plans', '.project-owners', '0.json');
  renameSync(assignment, `${assignment}.retained`);
  expect(() => store.listItems({ readOnly: true })).toThrow();
});

test('retirement during original selection still refuses before directory creation or publication', () => {
  const store = fixture(); let checks = 0;
  expect(() => store.addItem('Never admitted', {}, { assertCurrent() {
    if (++checks === 2) throw new Error('Selection retired');
  } })).toThrow('Selection retired');
  expect(existsSync(join(store.homeDirectory, '.goodvibes'))).toBe(false);
});
