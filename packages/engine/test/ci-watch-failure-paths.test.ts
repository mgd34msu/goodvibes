/**
 * ci-watch-failure-paths.test.ts
 *
 * A failure after the verdict was announced still records it (no re-notify on
 * every poll), a failed delete leaves a working watch, and a failed store read
 * is retried rather than cached.
 */
import { describe, expect, test } from 'bun:test';
import { CiWatchService, CiWatchStore, type CiJob, type CiWatchSubscription } from '../platform/src/platform/ci-watch/index.ts';

const failing: CiJob[] = [{ name: 'build', status: 'completed', conclusion: 'failure' }];

describe('ci-watch failure paths', () => {
  test('a fix-session start that throws after the notification does not re-notify on the next poll', async () => {
    const notes: string[] = [];
    const service = new CiWatchService({
      source: { fetchJobs: async () => failing, fetchFailureLogs: async () => 'logs' },
      store: new CiWatchStore(':memory:'),
      notifier: async (_channel, title) => { notes.push(title); return `n${notes.length}`; },
      fixSessionStarter: async () => { throw new Error('session runtime unavailable'); },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack', triggerFixSession: true });
    const first = await service.checkWatch(watch.id);
    expect(first.notified).toBe(true);
    expect(first.fixSessionError).toContain('session runtime unavailable');
    // The delivered verdict retires the watch, so a later poll has nothing to re-notify.
    expect(await service.listWatches()).toEqual([]);
    await expect(service.checkWatch(watch.id)).rejects.toThrow('No CI watch');
    expect(notes.filter((title) => title.startsWith('CI failed'))).toHaveLength(1);
  });

  test('a watch kept after a failed repair start does not re-notify the same verdict on the next poll', async () => {
    const notes: string[] = [];
    let attempts = 0;
    const service = new CiWatchService({
      source: { fetchJobs: async () => failing, fetchFailureLogs: async () => 'logs' },
      store: new CiWatchStore(':memory:'),
      notifier: async (_channel, title) => { notes.push(title); return `n${notes.length}`; },
      autonomousRepair: async () => { attempts += 1; throw new Error('repair runtime unavailable'); },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    // A continuation keeps a failed watch alive while its repair has not started.
    const rows = (service as unknown as { subscriptions: CiWatchSubscription[] }).subscriptions;
    rows[0] = Object.freeze({ ...rows[0]!, continuationId: 'c-1' });
    const first = await service.checkWatch(watch.id);
    expect(first.notified).toBe(true);
    expect(first.retired).toBeUndefined();
    expect(first.fixSessionError).toContain('repair runtime unavailable');
    expect(await service.listWatches()).toHaveLength(1);
    const second = await service.checkWatch(watch.id);
    expect(second.notified).toBe(false);
    expect(attempts).toBe(2);
    expect(notes.filter((title) => title.startsWith('CI failed'))).toHaveLength(1);
  });

  test('a delete whose owner revoke fails leaves the watch listed and still checkable', async () => {
    let revokeFails = true;
    const service = new CiWatchService({
      source: { fetchJobs: async () => [{ name: 'build', status: 'in_progress', conclusion: null }] },
      store: new CiWatchStore(':memory:'),
      revokeOwner: async () => { if (revokeFails) throw new Error('revoke store busy'); },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    // Give the row a continuation so the delete goes through revokeOwner.
    const rows = (service as unknown as { subscriptions: CiWatchSubscription[] }).subscriptions;
    rows[0] = Object.freeze({ ...rows[0]!, continuationId: 'c-1' });
    await expect(service.deleteWatch(watch.id)).rejects.toThrow('revoke store busy');
    expect(await service.listWatches()).toHaveLength(1);
    await expect(service.checkWatch(watch.id)).resolves.toMatchObject({ notified: false });
    revokeFails = false;
    expect(await service.deleteWatch(watch.id)).toBe(true);
  });

  test('a store read that fails once is read again on the next call', async () => {
    let reads = 0;
    const store = {
      load: async () => { reads += 1; if (reads === 1) throw new Error('store locked'); return []; },
      save: async () => {},
    } as unknown as CiWatchStore;
    const service = new CiWatchService({ source: { fetchJobs: async () => [] }, store });
    await expect(service.listWatches()).rejects.toThrow('store locked');
    await expect(service.listWatches()).resolves.toEqual([]);
    expect(reads).toBe(2);
  });
});
