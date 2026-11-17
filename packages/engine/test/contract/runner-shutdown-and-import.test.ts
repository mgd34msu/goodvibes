/**
 * Two edges of a contract's end: an import must not replace a contract whose run is still draining,
 * and a host that is about to exit can wait for the work-plan writes the last status changes queued.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractCheckpointDir } from '../../platform/src/platform/contract/store.js';
import type { WorkPlanService } from '../../platform/src/platform/contract/index.js';
import { makeHarness, startContract, waitFor, type Harness } from './runner-support.js';

let harness: Harness | undefined;
afterEach(async () => {
  const finished = harness;
  harness = undefined;
  await finished?.dispose();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('importing a contract that has just ended', () => {
  test('is refused while the ended run is still draining, and accepted once it has settled', async () => {
    const release = deferred();
    let planning = false;
    const h = harness = makeHarness({
      contract: { isolation: 'shared' },
      scripts: {},
      planner: { async run(request) {
        planning = true;
        await new Promise<void>((resolve) => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
        await release.promise;
        return { status: 'cancelled', output: '', elapsedMs: 0, detail: 'cancelled' };
      } },
    });
    const { contract } = await startContract(h);
    await waitFor(() => planning, 'the planner to start');
    expect(h.runner.cancel(contract.id, 'stopped for the test')).toBe(true);
    const snapshot = h.runner.serializeContract(contract.id)!;
    // Forced, so only the draining run can be what refuses it.
    expect(h.runner.importContract(snapshot, true)).toBe(false);
    release.resolve();
    await h.runner.join(contract.id);
    expect(h.runner.importContract(snapshot, true)).toBe(true);
  });
});

describe('waiting for the work plan before exit', () => {
  test('flushWorkPlan resolves only after the queued work-plan writes finish', async () => {
    const gate = deferred();
    const writes: string[] = [];
    const service = {
      createWorkPlanTask: async (input: { task: { taskId?: string } }) => { await gate.promise; writes.push(input.task.taskId ?? ''); },
      updateWorkPlanTask: async (input: { taskId: string }) => { writes.push(input.taskId); },
    } as unknown as WorkPlanService;
    const h = harness = makeHarness({ contract: { isolation: 'shared' }, scripts: {}, workPlanService: service });
    await startContract(h);
    let flushed = false;
    const flushing = h.runner.flushWorkPlan!().then(() => { flushed = true; });
    // A macrotask turn lets every already-queued microtask, including an unqueued flush, run first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushed).toBe(false);
    expect(writes).toEqual([]);
    gate.resolve();
    await flushing;
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe('a contract whose checkpoint cannot be written', () => {
  test('reads with a warning instead of healthy, in both get and list, and the warning is not persisted', async () => {
    const h = harness = makeHarness({ contract: { isolation: 'shared' }, scripts: {}, planner: { async run(request) {
      await new Promise<void>((resolve) => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
      return { status: 'cancelled', output: '', elapsedMs: 0, detail: 'cancelled' };
    } } });
    const { contract } = await startContract(h);
    expect(h.store.write(contract.id)).toBe(true);
    expect(h.runner.get(contract.id)?.statusLine ?? '').not.toContain('warning');
    // A file from a newer build is refused, so the store records a failed write.
    // This process first lets go of the contract's checkpoint, as when a newer build takes it over.
    h.store.dispose();
    const path = join(contractCheckpointDir(h.root, contract.id), 'base.json');
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number };
    envelope.schemaVersion += 1;
    writeFileSync(path, JSON.stringify(envelope));
    expect(h.store.write(contract.id)).toBe(false);
    expect(h.runner.get(contract.id)?.statusLine).toContain('warning');
    expect(h.runner.list().find((entry) => entry.id === contract.id)?.statusLine).toContain('warning');
    expect(h.store.get(contract.id)?.statusLine ?? '').not.toContain('warning');
  });
});
