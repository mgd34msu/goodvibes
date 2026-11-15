/**
 * Cross-session task registry: a refused link changes nothing, linking never
 * resets a task's status, handoffs need a real destination and release the
 * task when acknowledged, a failed write is retried instead of retiring the
 * registry, ref keys cannot collide, and damaged edges are disclosed.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as nativeFs from 'node:fs';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { CrossSessionTaskRegistry } from '../platform/src/platform/sessions/orchestration/registry.js';
import { GRAPH_SCHEMA_VERSION } from '../platform/src/platform/sessions/orchestration/registry-housekeeping.js';
import type { CrossSessionTaskRef } from '../platform/src/platform/sessions/orchestration/types.js';

const roots: string[] = [];
const owners: CrossSessionTaskRegistry[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) { try { owner.dispose(); } catch { /* a refused owner still detaches */ } }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() { const root = makeProjectTempDir('orchestration-integrity'); roots.push(root); return { path: join(root, 'graph.json') }; }
function open(path: string, sessionExists?: (id: string) => boolean) {
  const registry = new CrossSessionTaskRegistry(path, { sweepIntervalMs: 0, ...(sessionExists ? { sessionExists } : {}) });
  owners.push(registry);
  return registry;
}
function ref(taskId: string, status: CrossSessionTaskRef['status'] = 'queued', sessionId = 's1'): CrossSessionTaskRef {
  const now = Date.now();
  return { sessionId, taskId, title: taskId, status, createdAt: now, updatedAt: now };
}

test('a refused dependency leaves no new ref and keeps an existing ref as it was', () => {
  const registry = open(fixture().path);
  const result = registry.linkTask(ref('t1'), { sessionId: 's1', taskId: 'missing' });
  expect(result.ok).toBe(false);
  expect(registry.getRef('s1', 't1')).toBeUndefined();

  registry.linkTask({ ...ref('t2', 'running'), label: 'keep' });
  const before = registry.getRef('s1', 't2');
  expect(registry.linkTask({ ...ref('t2'), label: 'other' }, { sessionId: 's1', taskId: 'missing' }).ok).toBe(false);
  expect(registry.getRef('s1', 't2')).toEqual(before);
});

test('linking an already registered task keeps its status', () => {
  const registry = open(fixture().path);
  registry.linkTask(ref('t1', 'running'));
  registry.linkTask(ref('t1', 'queued'));
  expect(registry.getRef('s1', 't1')?.status).toBe('running');
});

test('a handoff to an unknown session is refused and the task is not blocked', () => {
  const registry = open(fixture().path, id => id === 's1');
  registry.linkTask(ref('t1', 'running'));
  const result = registry.initiateHandoff({ sessionId: 's1', taskId: 't1' }, 's1', 'typo');
  expect(result.ok).toBe(false);
  expect(result.error).toContain('typo');
  expect(registry.getRef('s1', 't1')?.status).toBe('running');
  expect(registry.getHandoffs()).toEqual([]);
});

test('acknowledging a handoff returns the task to the status it had', () => {
  const registry = open(fixture().path, () => true);
  registry.linkTask(ref('t1', 'running'));
  const handoff = registry.initiateHandoff({ sessionId: 's1', taskId: 't1' }, 's1', 's2');
  expect(handoff.ok).toBe(true);
  expect(registry.getRef('s1', 't1')?.status).toBe('blocked');
  expect(registry.acknowledgeHandoff(handoff.handoffId!)).toBe(true);
  expect(registry.getRef('s1', 't1')?.status).toBe('running');
});

test('a finished task cannot be handed off and no handoff is recorded', () => {
  const registry = open(fixture().path, () => true);
  registry.linkTask(ref('t1', 'completed'));
  const result = registry.initiateHandoff({ sessionId: 's1', taskId: 't1' }, 's1', 's2');
  expect(result.ok).toBe(false);
  expect(registry.getHandoffs()).toEqual([]);
  expect(registry.getRef('s1', 't1')?.status).toBe('completed');
});

test('a failed write keeps the registry usable and the next flush publishes everything', () => {
  const f = fixture();
  const registry = open(f.path);
  registry.linkTask(ref('first'));
  registry.flush();
  registry.linkTask(ref('pending'));
  const failure = spyOn(nativeFs, 'fsyncSync').mockImplementation(() => { throw new Error('fixture disk failure'); });
  try { expect(() => registry.flush()).toThrow('fixture disk failure'); }
  finally { failure.mockRestore(); }
  expect(() => registry.linkTask(ref('after'))).not.toThrow();
  registry.flush();
  const written = JSON.parse(readFileSync(f.path, 'utf8')) as { refs: Record<string, unknown> };
  expect(Object.keys(written.refs).sort()).toEqual(['s1:after', 's1:first', 's1:pending']);
});

test('session and task ids containing a colon do not collide', () => {
  const f = fixture();
  const registry = open(f.path);
  registry.linkTask(ref('c', 'queued', 'a:b'));
  registry.linkTask(ref('b:c', 'queued', 'a'));
  expect(registry.getAllRefs()).toHaveLength(2);
  registry.flush();
  registry.dispose();
  expect(open(f.path).getAllRefs()).toHaveLength(2);
});

test('a damaged edge in the stored graph is counted and disclosed', () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ version: GRAPH_SCHEMA_VERSION, snapshotAt: Date.now(), refs: {}, edges: [{ nonsense: true }], handoffs: [] }));
  const registry = open(f.path);
  expect(registry.lastReapSummary().edgesMalformed).toBe(1);
  expect(registry.lastReapSummary().total).toBe(1);
});
