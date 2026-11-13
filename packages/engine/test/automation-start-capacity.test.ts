import { expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { automationMutationFixture } from './_helpers/automation-mutation-fixture.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

test('terminal history quota never prunes running jobs or frees their capacity', async () => {
  const dir = makeProjectTempDir('automation-active-history');
  const f = automationMutationFixture(dir);
  try {
    f.config.set('automation.maxConcurrentRuns', 2);
    f.config.set('automation.runHistoryLimit', 1);
    const job = await f.create();
    await f.manager.start();
    const first = await f.manager.runNow(job.id);
    const second = await f.manager.runNow(job.id);
    expect(first.status).toBe('running');
    expect(second.status).toBe('running');
    expect(f.manager.getSchedulerCapacity().slotsInUse).toBe(2);
    await expect(f.manager.runNow(job.id)).rejects.toThrow('concurrency limit');
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('asynchronous startup reserves the configured slot and transfers it to the running record', async () => {
  const dir = makeProjectTempDir('automation-start-capacity');
  const f = automationMutationFixture(dir);
  let release!: () => void;
  const blocked = new Promise<void>(yes => { release = yes; });
  try {
    f.config.set('automation.maxConcurrentRuns', 1);
    const a = await f.create('a'), b = await f.create('b');
    await f.manager.start();
    const start = spyOn(f.broker, 'start').mockImplementation(() => blocked);
    try {
      const first = f.manager.runNow(a.id);
      await Promise.resolve(); await Promise.resolve();
      expect(f.manager.getSchedulerCapacity().slotsInUse).toBe(1);
      await expect(f.manager.runNow(b.id)).rejects.toThrow('concurrency limit');
      release();
      const run = await first;
      expect(run.status).toBe('running');
      expect(f.manager.getSchedulerCapacity().slotsInUse).toBe(1);
    } finally { release(); start.mockRestore(); }
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

const internals = (manager: unknown) => manager as { running: boolean; reconcileTimer: unknown };

test('a start that is still loading when the manager is stopped does not start it afterwards', async () => {
  const dir = makeProjectTempDir('automation-stop-during-start');
  const f = automationMutationFixture(dir);
  let release!: () => void;
  const blocked = new Promise<void>(yes => { release = yes; });
  const load = f.store.load.bind(f.store);
  const tap = spyOn(f.store, 'load').mockImplementation(async () => { await blocked; return load(); });
  try {
    const starting = f.manager.start();
    f.manager.stop();
    release();
    await starting;
    expect(internals(f.manager).running).toBe(false);
    expect(internals(f.manager).reconcileTimer).toBeNull();
  } finally { release(); tap.mockRestore(); await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a start made after that stop runs under its own lifetime', async () => {
  const dir = makeProjectTempDir('automation-restart-during-start');
  const f = automationMutationFixture(dir);
  let release!: () => void;
  const blocked = new Promise<void>(yes => { release = yes; });
  const load = f.store.load.bind(f.store);
  const tap = spyOn(f.store, 'load').mockImplementation(async () => { await blocked; return load(); });
  try {
    const stale = f.manager.start();
    f.manager.stop();
    const restarted = f.manager.start();
    release();
    await Promise.all([stale, restarted]);
    expect(internals(f.manager).running).toBe(true);
    expect(internals(f.manager).reconcileTimer).not.toBeNull();
  } finally { release(); tap.mockRestore(); await f.close(); rmSync(dir, { recursive: true, force: true }); }
});
