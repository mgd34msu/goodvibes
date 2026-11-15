/**
 * ci-watch-delivery-recovery.test.ts, what a CI watch does when the work around
 * its verdict fails: creating the watch, retiring it, and claiming a repair.
 */
import { describe, expect, test } from 'bun:test';
import { CiWatchService, type CiJob, type CiWatchStore, type CiWatchSubscription } from '../platform/src/platform/ci-watch/index.ts';

const passing: CiJob[] = [{ name: 'build', status: 'completed', conclusion: 'success' }];

function memoryStore(options: { failSaves?: number } = {}): Pick<CiWatchStore, 'load' | 'save'> & { saves: number } {
  let failures = options.failSaves ?? 0;
  const store = {
    saves: 0,
    load: async () => [] as CiWatchSubscription[],
    save: async () => {
      if (failures > 0) { failures -= 1; throw new Error('the watch file is not writable'); }
      store.saves += 1;
    },
  };
  return store;
}

describe('creating a watch', () => {
  test('a watch that could not be saved does not keep polling, and trying again does not leave two', async () => {
    const service = new CiWatchService({ source: { fetchJobs: async () => passing }, store: memoryStore({ failSaves: 1 }) });
    await expect(service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' })).rejects.toThrow('not writable');
    expect(await service.listWatches()).toEqual([]);
    await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    expect(await service.listWatches()).toHaveLength(1);
  });
});

describe('retiring a watch whose verdict was delivered', () => {
  test('a failure after the notification does not send it again on the next poll', async () => {
    const notes: string[] = [];
    let revokeFails = true;
    const service = new CiWatchService({
      source: { fetchJobs: async () => passing },
      store: memoryStore(),
      notifier: async (_channel, title) => { notes.push(title); return `n${notes.length}`; },
      revokeOwner: async () => { if (revokeFails) throw new Error('revoke store busy'); },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    // A watch with a continuation is revoked when it retires.
    const rows = (service as unknown as { subscriptions: CiWatchSubscription[] }).subscriptions;
    rows[0] = Object.freeze({ ...rows[0]!, continuationId: 'c-1' });

    await expect(service.checkWatch(watch.id)).rejects.toThrow('revoke store busy');
    expect(notes).toHaveLength(1);

    revokeFails = false;
    const second = await service.checkWatch(watch.id);
    expect(notes).toHaveLength(1);
    expect(second).toMatchObject({ notified: true, retired: true });
    expect(await service.listWatches()).toEqual([]);
  });

  test('a later, different verdict is still announced', async () => {
    const notes: string[] = [];
    let jobs: CiJob[] = passing;
    let revokeFails = true;
    const service = new CiWatchService({
      source: { fetchJobs: async () => jobs, fetchFailureLogs: async () => 'logs' },
      store: memoryStore(),
      notifier: async (_channel, title) => { notes.push(title); return `n${notes.length}`; },
      revokeOwner: async () => { if (revokeFails) throw new Error('revoke store busy'); },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    const rows = (service as unknown as { subscriptions: CiWatchSubscription[] }).subscriptions;
    rows[0] = Object.freeze({ ...rows[0]!, continuationId: 'c-1' });
    await expect(service.checkWatch(watch.id)).rejects.toThrow('revoke store busy');
    jobs = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    revokeFails = false;
    await service.checkWatch(watch.id).catch(() => undefined);
    expect(notes.map((title) => title.slice(0, 9))).toEqual(['CI passed', 'CI failed']);
  });
});

describe('claiming a repair', () => {
  test('the claim table never fills up for good', async () => {
    let run = 0;
    let failing = true;
    const claims: boolean[] = [];
    const service = new CiWatchService({
      source: {
        fetchJobs: async () => failing
          ? [{ name: 'build', status: 'completed', conclusion: 'failure', headSha: 'sha', runId: `run-${run}`, jobId: 'job' }]
          : [{ name: 'build', status: 'in_progress', conclusion: null }],
        fetchFailureLogs: async () => 'logs',
      },
      store: memoryStore(),
      autonomousRepair: async (request) => {
        try { request.claimRepair(); claims.push(true); return { sessionId: 'session' }; } catch (error) { claims.push(false); throw error; }
      },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    // Each failing run with a new run id is a new failure to repair; a pending
    // check between them lets the next failure count as a change.
    for (let round = 0; round < 10_050; round++) {
      run = round;
      failing = true; await service.checkWatch(watch.id);
      failing = false; await service.checkWatch(watch.id);
    }
    expect(claims).toHaveLength(10_050);
    expect(claims.every(Boolean)).toBe(true);
  });
});
