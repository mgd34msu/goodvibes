/** Persisted graph owner/version/publication regressions. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as nativeFs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { CrossSessionTaskRegistry, CrossSessionGraphUnavailableError } from '../platform/src/platform/sessions/orchestration/registry.js';
import { GRAPH_SCHEMA_VERSION, QUARANTINE_RETENTION_MS } from '../platform/src/platform/sessions/orchestration/registry-housekeeping.js';
import type { CrossSessionTaskRef } from '../platform/src/platform/sessions/orchestration/types.js';

const roots: string[] = [], owners: CrossSessionTaskRegistry[] = [];
afterEach(() => { for (const owner of owners.splice(0)) { try { owner.dispose(); } catch { /* Retired owners still detach their listeners/timers. */ } } for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = makeProjectTempDir('session-graph-original'); roots.push(root); return { root, path: join(root, 'graph.json') }; }
function owner(path: string, now?: () => number) { const registry = new CrossSessionTaskRegistry(path, { sweepIntervalMs: 0, now }); owners.push(registry); return registry; }
function ref(taskId = 'one'): CrossSessionTaskRef { return { sessionId: 'fixture-session', taskId, title: taskId, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }; }
const future = () => JSON.stringify({ version: GRAPH_SCHEMA_VERSION + 1, future: { opaque: 'preserve' }, refs: {}, edges: [], handoffs: [] });

test('a future graph stays at its original path, is not replaced, and every change is refused', () => {
  const f = fixture(), bytes = future(), listeners = process.listenerCount('exit'); writeFileSync(f.path, bytes);
  const registry = owner(f.path);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes); expect(existsSync(`${f.path}.unrecognized`)).toBe(false);
  expect(process.listenerCount('exit')).toBe(listeners); expect(readdirSync(f.root)).toEqual(['graph.json']);
  expect(() => registry.linkTask(ref())).toThrow(CrossSessionGraphUnavailableError);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('future replacement refuses every mutation before changing the in-memory graph', () => {
  const f = fixture(), registry = owner(f.path); registry.linkTask(ref());
  const before = registry.snapshot(), bytes = future(); writeFileSync(f.path, bytes);
  for (const mutate of [
    () => registry.linkTask(ref('second')),
    () => registry.propagateStatus('fixture-session', 'one', 'completed'),
    () => registry.initiateHandoff({ sessionId: 'fixture-session', taskId: 'one' }, 'fixture-session', 'destination'),
    () => registry.acknowledgeHandoff('missing'),
    () => registry.withdrawHandoff('missing'),
    () => registry.cancel({ sessionId: 'fixture-session', taskId: 'one', scope: 'task', requestedAt: Date.now() }),
    () => registry.reap(),
  ]) expect(mutate).toThrow(CrossSessionGraphUnavailableError);
  expect(registry.snapshot().refs).toEqual(before.refs); expect(registry.getHandoffs()).toEqual([]);
  registry.dispose(); expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('two registries over one file share every change and a handoff between them completes', () => {
  const f = fixture(), first = owner(f.path), second = owner(f.path);
  expect(first.linkTask(ref('a')).ok).toBe(true);
  expect(second.getAllRefs().map(entry => entry.taskId)).toEqual(['a']);
  expect(second.linkTask({ ...ref('b'), sessionId: 'other-session' }).ok).toBe(true);
  expect(first.getAllRefs().map(entry => entry.taskId).sort()).toEqual(['a', 'b']);
  expect(owner(f.path).getAllRefs()).toHaveLength(2);

  const handoff = first.initiateHandoff({ sessionId: 'fixture-session', taskId: 'a' }, 'fixture-session', 'other-session');
  expect(handoff.ok).toBe(true);
  expect(second.handoffsAwaiting('other-session').map(entry => entry.handoffId)).toEqual([handoff.handoffId!]);
  expect(second.getRef('fixture-session', 'a')?.status).toBe('blocked');
  expect(second.acknowledgeHandoff(handoff.handoffId!, 'fixture-session')).toBe(false);
  expect(second.acknowledgeHandoff(handoff.handoffId!, 'other-session')).toBe(true);
  expect(first.getRef('fixture-session', 'a')?.status).toBe('running');
  expect(first.handoffsAwaiting('other-session')).toEqual([]);

  const again = first.initiateHandoff({ sessionId: 'fixture-session', taskId: 'a' }, 'fixture-session', 'other-session');
  expect(second.withdrawHandoff(again.handoffId!, 'other-session').ok).toBe(false);
  const withdrawn = first.withdrawHandoff(again.handoffId!, 'fixture-session');
  expect(withdrawn.ok).toBe(true); expect(withdrawn.status).toBe('running');
  expect(second.getRef('fixture-session', 'a')?.status).toBe('running');
  expect(second.getHandoffs().map(entry => entry.handoffId)).toEqual([handoff.handoffId!]);
});

test('a failed write changes nothing in memory or on disk, and the next change is saved', () => {
  const f = fixture(), registry = owner(f.path); registry.linkTask(ref());
  const original = readFileSync(f.path, 'utf8');
  const failure = spyOn(nativeFs, 'fdatasyncSync').mockImplementation(() => { throw new Error('fixture disk failure'); });
  try { expect(() => registry.linkTask(ref('pending'))).toThrow('could not be saved'); }
  finally { failure.mockRestore(); }
  expect(readFileSync(f.path, 'utf8')).toBe(original); expect(registry.getRef('fixture-session', 'pending')).toBeUndefined();
  registry.linkTask(ref('after-failure'));
  expect(Object.keys(JSON.parse(readFileSync(f.path, 'utf8')).refs).sort()).toEqual(['fixture-session:after-failure', 'fixture-session:one']);
});

test('borrowing selects only the same original graph, including an existing parent alias and absent child directories', () => {
  const f = fixture(), selected = join(f.root, 'workspace'); mkdirSync(selected);
  const alias = join(f.root, 'alias'); symlinkSync(selected, alias);
  const path = join(selected, 'sessions', 'graph.json'), registry = owner(path);
  expect(registry.borrowForGraphPath(path)).toBe(registry);
  expect(registry.borrowForGraphPath(join(alias, 'sessions', 'graph.json'))).toBe(registry);
  expect(registry.borrowForGraphPath(join(selected, 'other', 'graph.json'))).toBeUndefined();
  expect(registry.borrowForGraphPath(join(selected, 'sessions', 'different.json'))).toBeUndefined();
  expect(existsSync(join(selected, 'sessions'))).toBe(false);
});

test('a source changed inside the owner-existence callback is not hydrated or reap-published', () => {
  const f = fixture(), seed = owner(f.path); seed.linkTask({ ...ref(), updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }); seed.dispose();
  const bytes = future(); let changed = false;
  const registry = new CrossSessionTaskRegistry(f.path, { sweepIntervalMs: 0, sessionExists() { if (!changed) { changed = true; writeFileSync(f.path, bytes); } return false; } });
  owners.push(registry);
  expect(changed).toBe(true); expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  expect(() => registry.linkTask(ref('next'))).toThrow(CrossSessionGraphUnavailableError);
});

test('older valid graph versions retain refs and the native writer uses isolated atomic publication', () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify({ version: 0, snapshotAt: Date.now(), refs: { 'fixture-session:one': ref() }, edges: [], handoffs: [] }));
  const registry = owner(f.path); expect(registry.getAllRefs()).toHaveLength(1);
  registry.linkTask(ref('two')); expect(owner(f.path).getAllRefs()).toHaveLength(2);
  expect(readdirSync(f.root).filter(name => name.includes('.tmp'))).toEqual([]);
});

test('a second corrupt source never overwrites the first retained forensic file', () => {
  const f = fixture(); writeFileSync(f.path, 'first torn'); const original = owner(f.path); original.dispose();
  const forensic = readFileSync(`${f.path}.unrecognized`, 'utf8'); writeFileSync(f.path, 'second torn');
  expect(() => owner(f.path).linkTask(ref())).toThrow(CrossSessionGraphUnavailableError);
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
  const registry = owner(path); registry.linkTask(ref()); renameSync(directory, `${directory}-original`); mkdirSync(directory);
  const bytes = future(); writeFileSync(path, bytes); expect(() => registry.linkTask(ref('other'))).toThrow(CrossSessionGraphUnavailableError);
  expect(readFileSync(path, 'utf8')).toBe(bytes); expect(readFileSync(join(`${directory}-original`, 'graph.json'), 'utf8')).toContain('one');
});
