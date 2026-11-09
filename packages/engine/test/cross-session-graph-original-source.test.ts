/** UNRUN actual persisted graph owner/version/publication regressions. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as nativeFs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { CrossSessionTaskRegistry, CrossSessionGraphUnavailableError } from '../sdk/src/platform/sessions/orchestration/registry.js';
import { GRAPH_SCHEMA_VERSION, QUARANTINE_RETENTION_MS } from '../sdk/src/platform/sessions/orchestration/registry-housekeeping.js';
import type { CrossSessionTaskRef } from '../sdk/src/platform/sessions/orchestration/types.js';

const roots: string[] = [], owners: CrossSessionTaskRegistry[] = [];
afterEach(() => { for (const owner of owners.splice(0)) { try { owner.dispose(); } catch { /* Retired owners still detach their listeners/timers. */ } } for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = makeProjectTempDir('session-graph-original'); roots.push(root); return { root, path: join(root, 'graph.json') }; }
function owner(path: string, now?: () => number) { const registry = new CrossSessionTaskRegistry(path, { sweepIntervalMs: 0, now }); owners.push(registry); return registry; }
test('a failed native publication is visible and retires further mutations rather than acknowledging an unsaved graph', () => {
  const f = fixture(), registry = owner(f.path); registry.linkTask(ref()); registry.flush();
  const original = readFileSync(f.path, 'utf8'); registry.linkTask(ref('pending'));
  const failure = spyOn(nativeFs, 'fsyncSync').mockImplementation(() => { throw new Error('fixture disk failure'); });
  try { expect(() => registry.flush()).toThrow(CrossSessionGraphUnavailableError); }
  finally { failure.mockRestore(); }
  expect(readFileSync(f.path, 'utf8')).toBe(original);
  expect(() => registry.linkTask(ref('after-failure'))).toThrow(CrossSessionGraphUnavailableError);
  expect(() => registry.flush()).toThrow(CrossSessionGraphUnavailableError);
  expect(readFileSync(f.path, 'utf8')).toBe(original);
});
function ref(taskId = 'one'): CrossSessionTaskRef { return { sessionId: 'fixture-session', taskId, title: taskId, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }; }
const future = () => JSON.stringify({ version: GRAPH_SCHEMA_VERSION + 1, future: { opaque: 'preserve' }, refs: {}, edges: [], handoffs: [] });

test('future graph remains at original selected path and adds no process resources or empty replacement', () => {
  const f = fixture(), bytes = future(), listeners = process.listenerCount('exit'); writeFileSync(f.path, bytes);
  expect(() => owner(f.path)).toThrow(CrossSessionGraphUnavailableError);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes); expect(existsSync(`${f.path}.unrecognized`)).toBe(false);
  expect(process.listenerCount('exit')).toBe(listeners); expect(readdirSync(f.root)).toEqual(['graph.json']);
});

test('future replacement refuses every mutation before changing the in-memory graph and shutdown detaches', () => {
  const f = fixture(), registry = owner(f.path); registry.linkTask(ref()); registry.flush();
  const before = registry.snapshot(), bytes = future(); writeFileSync(f.path, bytes);
  for (const mutate of [
    () => registry.linkTask(ref('second')),
    () => registry.propagateStatus('fixture-session', 'one', 'completed'),
    () => registry.initiateHandoff({ sessionId: 'fixture-session', taskId: 'one' }, 'fixture-session', 'destination'),
    () => registry.acknowledgeHandoff('missing'),
    () => registry.cancel({ sessionId: 'fixture-session', taskId: 'one', scope: 'task', requestedAt: Date.now() }),
    () => registry.reap(), () => registry.flush(),
  ]) expect(mutate).toThrow(CrossSessionGraphUnavailableError);
  expect(registry.snapshot().refs).toEqual(before.refs); expect(registry.getHandoffs()).toEqual([]);
  expect(() => registry.dispose()).toThrow(CrossSessionGraphUnavailableError);
  expect(registry._exitHandler).toBeNull(); expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('pending debounce cannot publish stale graph bytes over a newly selected future file', async () => {
  const f = fixture(), registry = owner(f.path); registry.linkTask(ref());
  const bytes = future(); writeFileSync(f.path, bytes);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(readFileSync(f.path, 'utf8')).toBe(bytes); expect(existsSync(`${f.path}.unrecognized`)).toBe(false);
});

test('another current-version graph writer retires stale local memory instead of losing the winning update', () => {
  const f = fixture(), first = owner(f.path), stale = owner(f.path);
  first.linkTask(ref('winning')); first.flush(); const bytes = readFileSync(f.path, 'utf8');
  expect(() => stale.linkTask(ref('losing'))).toThrow(CrossSessionGraphUnavailableError);
  expect(stale.getAllRefs()).toEqual([]); expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  first.linkTask(ref('next')); first.flush(); expect(owner(f.path).getAllRefs().map(entry => entry.taskId).sort()).toEqual(['next', 'winning']);
});

test('a source changed inside the owner-existence callback cannot be hydrated or reap-published', () => {
  const f = fixture(), seed = owner(f.path); seed.linkTask({ ...ref(), updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }); seed.flush(); seed.dispose();
  const bytes = future(); let changed = false;
  expect(() => new CrossSessionTaskRegistry(f.path, { sweepIntervalMs: 0, sessionExists() { if (!changed) { changed = true; writeFileSync(f.path, bytes); } return false; } })).toThrow(CrossSessionGraphUnavailableError);
  expect(changed).toBe(true); expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('older valid graph versions retain refs and the native writer uses isolated atomic publication', () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify({ version: 0, snapshotAt: Date.now(), refs: { 'fixture-session:one': ref() }, edges: [], handoffs: [] }));
  const registry = owner(f.path); expect(registry.getAllRefs()).toHaveLength(1);
  registry.linkTask(ref('two')); registry.flush(); expect(owner(f.path).getAllRefs()).toHaveLength(2);
  expect(readdirSync(f.root).filter(name => name.includes('.tmp'))).toEqual([]);
});

test('a second corrupt source never overwrites the first retained forensic file', () => {
  const f = fixture(); writeFileSync(f.path, 'first torn'); const original = owner(f.path); original.dispose();
  const forensic = readFileSync(`${f.path}.unrecognized`, 'utf8'); writeFileSync(f.path, 'second torn');
  expect(() => owner(f.path)).toThrow(CrossSessionGraphUnavailableError);
  expect(readFileSync(f.path, 'utf8')).toBe('second torn'); expect(readFileSync(`${f.path}.unrecognized`, 'utf8')).toBe(forensic);
});

test('old future quarantine is preserved instead of aged out by a runtime unable to understand it', () => {
  const f = fixture(), path = `${f.path}.unrecognized`, bytes = future(); writeFileSync(path, bytes);
  const old = Date.now() - QUARANTINE_RETENTION_MS - 1000; utimesSync(path, old / 1000, old / 1000);
  owner(f.path); expect(readFileSync(path, 'utf8')).toBe(bytes);
});

test('quarantine replacement during the clock callback is retained even when the original was expired', () => {
  const f = fixture(), path = `${f.path}.unrecognized`; writeFileSync(path, 'old torn');
  const old = Date.now() - QUARANTINE_RETENTION_MS - 1000; utimesSync(path, old / 1000, old / 1000);
  const bytes = future(); let changed = false;
  owner(f.path, () => { if (!changed) { changed = true; renameSync(path, `${path}.original`); writeFileSync(path, bytes); } return Date.now(); });
  expect(readFileSync(path, 'utf8')).toBe(bytes); expect(readFileSync(`${path}.original`, 'utf8')).toBe('old torn');
});

test('quarantine symlink cannot authorize deleting its separate selected target', () => {
  const f = fixture(), target = join(f.root, 'foreign'), bytes = 'preserve foreign evidence'; writeFileSync(target, bytes);
  symlinkSync(target, `${f.path}.unrecognized`); owner(f.path);
  expect(readFileSync(target, 'utf8')).toBe(bytes); expect(existsSync(`${f.path}.unrecognized`)).toBe(true);
});

test('retiring the original selected parent refuses mutation and preserves the replacement graph', () => {
  const f = fixture(), directory = join(f.root, 'store'); mkdirSync(directory); const path = join(directory, 'graph.json');
  const registry = owner(path); registry.linkTask(ref()); registry.flush(); renameSync(directory, `${directory}-original`); mkdirSync(directory);
  const bytes = future(); writeFileSync(path, bytes); expect(() => registry.linkTask(ref('other'))).toThrow(CrossSessionGraphUnavailableError);
  expect(readFileSync(path, 'utf8')).toBe(bytes); expect(readFileSync(join(`${directory}-original`, 'graph.json'), 'utf8')).toContain('one');
});
