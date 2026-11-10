import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWorkPlanItems, captureWorkPlanLocation, WorkPlanStore } from '../platform/src/platform/workflow/work-plan-store.ts';
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

test('a native item observation reads once without publication and checks its original source without rereading', () => {
  const store = fixture(); store.addItem('Actual retained work', { linked: { agentId: 'native-agent' } });
  const before = readFileSync(store.filePath), read = spyOn(fs, 'readFileSync'), sync = spyOn(fs, 'fsyncSync');
  try {
    const observed = captureWorkPlanItems(store);
    if (!observed) throw new Error('Expected the genuine native item observation.');
    expect(observed.items.map(item => item.title)).toEqual(['Actual retained work']);
    expect(Object.isFrozen(observed.items)).toBe(true); expect(Object.isFrozen(observed.items[0])).toBe(true);
    expect(Object.isFrozen(observed.items[0]?.linked)).toBe(true);
    const reads = read.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    for (let index = 0; index < 20; index++) observed.assertCurrent();
    expect(read.mock.calls.length).toBe(reads); expect(sync.mock.calls).toHaveLength(0);
  } finally { read.mockRestore(); sync.mockRestore(); }
  expect(readFileSync(store.filePath)).toEqual(before);
});

test('an empty native observation creates nothing and cannot adopt later actual work', () => {
  const store = fixture(), observed = captureWorkPlanItems(store);
  if (!observed) throw new Error('Expected the genuine native item observation.');
  expect(observed.items).toEqual([]); expect(existsSync(join(store.homeDirectory, '.goodvibes'))).toBe(false);
  store.addItem('Later independent work');
  expect(() => observed.assertCurrent()).toThrow(); expect(observed.items).toEqual([]);
  expect(captureWorkPlanItems(store)?.items.map(item => item.title)).toEqual(['Later independent work']);
});

test.each(['contents', 'equal-byte-replacement', 'assignment'] as const)('native observation refuses original %s changes', kind => {
  const store = fixture(); store.addItem('Actual retained work');
  const observed = captureWorkPlanItems(store);
  if (!observed) throw new Error('Expected the genuine native item observation.');
  if (kind === 'contents') store.addItem('Newer actual work');
  else {
    const path = kind === 'assignment' ? join(store.homeDirectory, '.goodvibes', 'test', 'work-plans', '.project-owners', '0.json') : store.filePath;
    const original = readFileSync(path); renameSync(path, `${path}.retained`); writeFileSync(path, original);
  }
  expect(() => observed.assertCurrent()).toThrow(); expect(observed.items.map(item => item.title)).toEqual(['Actual retained work']);
});

test('copied stores and changed native methods cannot mint or retain native item observations', () => {
  const store = fixture(), observed = captureWorkPlanItems(store);
  if (!observed) throw new Error('Expected the genuine native item observation.');
  expect(captureWorkPlanItems(Object.assign(Object.create(WorkPlanStore.prototype), store))).toBeUndefined();
  expect(captureWorkPlanItems(new Proxy(store, { getPrototypeOf() { throw new Error('Must not invoke a borrowed proxy'); } }))).toBeUndefined();
  Object.defineProperty(store, 'listItems', { value: () => [] });
  expect(captureWorkPlanItems(store)).toBeUndefined(); expect(() => observed.assertCurrent()).toThrow();
});

test('borrowed reflection and array helpers cannot hide a changed native item reader', () => {
  const store = fixture(), observed = captureWorkPlanItems(store);
  if (!observed) throw new Error('Expected the genuine native item observation.');
  const keys = Object.getOwnPropertyDescriptor(Reflect, 'ownKeys'), every = Object.getOwnPropertyDescriptor(Array.prototype, 'every');
  if (!keys || !every) throw new Error('Missing original native helper descriptors.');
  let captured: ReturnType<typeof captureWorkPlanItems>, retired: unknown;
  try {
    Object.defineProperty(Reflect, 'ownKeys', { ...keys, value: () => [] });
    Object.defineProperty(Array.prototype, 'every', { ...every, value: () => true });
    Object.defineProperty(store, 'listItems', { value: () => [] });
    captured = captureWorkPlanItems(store);
    try { observed.assertCurrent(); } catch (error) { retired = error; }
  } finally {
    Object.defineProperty(Reflect, 'ownKeys', keys); Object.defineProperty(Array.prototype, 'every', every);
  }
  expect(captured).toBeUndefined(); expect(retired).toBeInstanceOf(ToolInputProjectionError);
});
