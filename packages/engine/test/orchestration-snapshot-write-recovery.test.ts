/** A snapshot write that fails after the file was published must not strand the workstream's later writes. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { attachDebouncedWriter, loadWorkstreamSnapshot, writeWorkstreamSnapshot } from '../platform/src/platform/orchestration/persistence.js';
import type { OrchestrationEvent, Workstream } from '../platform/src/platform/orchestration/types.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test('after the lock is lost just past publication, the next write is accepted and the failed one reports false', () => {
  const root = makeProjectTempDir('snapshot-recovery'); roots.push(root);
  const path = join(root, '.goodvibes', 'orchestration', 'ws-recover.json');
  const workstream: Workstream = { id: 'ws-recover', title: 'first', schemaVersion: 1, phases: [], items: [], createdAt: 0 };
  expect(writeWorkstreamSnapshot(root, workstream, [])).toBe(true);

  const realLstat = fs.lstatSync;
  const before = realLstat(path, { bigint: true });
  // The lock check passes until the snapshot file has been replaced, then reports the lock as lost.
  const lost = spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
    if (String(target) === `${path}.lock`) {
      const now = realLstat(path, { bigint: true });
      if (now.ino !== before.ino) throw new Error('lock lost');
    }
    return (realLstat as (t: fs.PathLike, o?: unknown) => fs.Stats)(target, options);
  }) as typeof fs.lstatSync);
  try {
    workstream.title = 'second';
    expect(writeWorkstreamSnapshot(root, workstream, [])).toBe(false);
  } finally { lost.mockRestore(); }
  expect(loadWorkstreamSnapshot(root, 'ws-recover')?.workstream.title).toBe('second');
  // The simulated other holder of the lock finishes.
  fs.rmSync(`${path}.lock`, { recursive: true, force: true });

  workstream.title = 'third';
  expect(writeWorkstreamSnapshot(root, workstream, [])).toBe(true);
  expect(loadWorkstreamSnapshot(root, 'ws-recover')?.workstream.title).toBe('third');
});

test('a snapshot that cannot be written is reported to the engine when the writer is detached', () => {
  const root = makeProjectTempDir('snapshot-failure-report'); roots.push(root);
  const unwritable: Workstream = { id: '../outside', title: 'x', schemaVersion: 1, phases: [], items: [], createdAt: 0 };
  let listener: (event: OrchestrationEvent) => void = () => undefined;
  const failed: string[] = [];
  const detach = attachDebouncedWriter(
    root,
    (id) => (id === unwritable.id ? unwritable : null),
    () => [],
    (next) => { listener = next; return () => undefined; },
    0,
    (id) => { failed.push(id); listener({ type: 'workstream-persistence-failed', workstreamId: id }); },
  );
  listener({ type: 'workstream-persisted', workstreamId: unwritable.id });
  // Detaching writes what is still waiting; that write is refused.
  detach();
  expect(failed).toEqual([unwritable.id]);
});
