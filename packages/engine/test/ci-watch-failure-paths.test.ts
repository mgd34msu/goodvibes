/**
 * ci-watch-failure-paths.test.ts
 *
 * A failure after the verdict was announced still records it (no re-notify on
 * every poll), a repair that failed to start is not tried on every poll, a
 * watch with no verdict ends, a green per-job view waits for the workflow
 * runs, a failed delete leaves a working watch, and a failed store read is
 * retried rather than cached.
 */
import { describe, expect, test } from 'bun:test';
import { CiWatchService, CiWatchStore, type CiJob, type CiWatchSubscription } from '../platform/src/platform/ci-watch/index.ts';
import { CI_WATCH_IDLE_MS } from '../platform/src/platform/ci-watch/service.ts';
import { CiTargetGoneError } from '../platform/src/platform/ci-watch/types.ts';

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

  test('a repair that failed to start is neither announced again nor tried on every poll', async () => {
    const notes: string[] = [];
    let attempts = 0;
    const service = new CiWatchService({
      source: { fetchJobs: async () => failing, fetchFailureLogs: async () => 'logs' },
      store: new CiWatchStore(':memory:'),
      notifier: async (_channel, title) => { notes.push(title); return `n${notes.length}`; },
      recoverOwner: () => ({ assertCurrent: () => {}, sourceOf: () => ({ goal: 'g' }) }) as never,
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
    await service.checkWatch(watch.id);
    expect(second.notified).toBe(false);
    expect(second.fixSessionError).toContain('tried again after');
    expect(attempts).toBe(1);
    expect(notes.filter((title) => title.startsWith('CI failed'))).toHaveLength(1);
  });

  test('a refused repair is final: the watch ends with one notice and is not judged again', async () => {
    const notes: string[] = [];
    let attempts = 0;
    const service = new CiWatchService({
      source: { fetchJobs: async () => failing, fetchFailureLogs: async () => 'logs' },
      store: new CiWatchStore(':memory:'),
      notifier: async (_channel, title) => { notes.push(title); return `n${notes.length}`; },
      recoverOwner: () => ({ assertCurrent: () => {}, sourceOf: () => ({ goal: 'g' }) }) as never,
      autonomousRepair: async () => { attempts += 1; return { error: 'CI repair denied by owner policy (config_deny)', refused: true }; },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    const rows = (service as unknown as { subscriptions: CiWatchSubscription[] }).subscriptions;
    rows[0] = Object.freeze({ ...rows[0]!, continuationId: 'c-1' });
    const result = await service.checkWatch(watch.id);
    expect(result).toMatchObject({ retired: true, fixSessionError: 'CI repair denied by owner policy (config_deny)' });
    expect(await service.listWatches()).toEqual([]);
    expect(attempts).toBe(1);
    expect(notes).toEqual(['CI failed, o/r', 'CI repair not started, o/r']);
  });

  test('a watch with no verdict ends after its time with one notice saying why', async () => {
    let now = 1_000;
    const notes: string[] = [];
    const service = new CiWatchService({
      source: { fetchJobs: async () => [] },
      store: new CiWatchStore(':memory:'),
      notifier: async (_channel, _title, body) => { notes.push(body); return 'n'; },
      now: () => now,
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    expect(watch.expiresAt).toBe(1_000 + CI_WATCH_IDLE_MS);
    expect((await service.checkWatch(watch.id)).retired).toBeUndefined();
    now += CI_WATCH_IDLE_MS;
    const ended = await service.checkWatch(watch.id);
    expect(ended).toMatchObject({ retired: true });
    expect(ended.endedReason).toContain('last seen: unknown');
    expect(notes).toHaveLength(1);
    expect(await service.listWatches()).toEqual([]);
  });

  test('a branch that no longer exists ends its watch at once', async () => {
    const notes: string[] = [];
    const service = new CiWatchService({
      source: { fetchJobs: async () => { throw new CiTargetGoneError('GitHub has no commit for "gone" in o/r (HTTP 422)', 422); } },
      store: new CiWatchStore(':memory:'),
      notifier: async (_channel, title) => { notes.push(title); return 'n'; },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'gone', deliveryChannel: 'slack' });
    expect(await service.checkWatch(watch.id)).toMatchObject({ retired: true, endedReason: 'GitHub has no commit for "gone" in o/r (HTTP 422)' });
    expect(notes).toEqual(['CI no verdict, o/r']);
    expect(await service.listWatches()).toEqual([]);
  });

  test('every created job passing is not a pass while a workflow run on the commit is still going', async () => {
    let runStatus = 'in_progress';
    const notes: string[] = [];
    const service = new CiWatchService({
      source: {
        fetchJobs: async () => [{ name: 'build', status: 'completed', conclusion: 'success', headSha: 'abc1234' }],
        fetchWorkflowRuns: async () => [{ name: 'ci', status: runStatus, conclusion: runStatus === 'completed' ? 'success' : null }],
      },
      store: new CiWatchStore(':memory:'),
      notifier: async (_channel, title) => { notes.push(title); return 'n'; },
    });
    const watch = await service.createWatch({ repo: 'o/r', ref: 'main', deliveryChannel: 'slack' });
    expect((await service.checkWatch(watch.id)).report.overall).toBe('pending');
    expect(notes).toEqual([]);
    runStatus = 'completed';
    expect((await service.checkWatch(watch.id)).report.overall).toBe('passed');
    expect(notes).toEqual(['CI passed, o/r']);
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
