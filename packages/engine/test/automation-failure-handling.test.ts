/**
 * Failure and recovery behaviour of the automation manager: runs that fail to
 * start, retry policy, one-shot completion, manual-run claims, delivery of
 * failures, artifact attachments and event reporting.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { settleRunOver } from './_helpers/automation-settle.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationDeliveryManager } from '../platform/src/platform/automation/delivery-manager.ts';
import { executeCheckinJob } from '../platform/src/platform/automation/checkin-execution.ts';
import { ownedAutomationJob, AutomationJobMutationStaleError } from '../platform/src/platform/automation/job-mutations.ts';
import type { AutomationJob } from '../platform/src/platform/automation/jobs.ts';
import { scheduleAutomationFailureFollowUp } from '../platform/src/platform/automation/manager-runtime-delivery.ts';
import { toggleAutomationJobEnabled } from '../platform/src/platform/automation/manager-runtime-job-mutations.ts';
import { AutomationManager } from '../platform/src/platform/automation/manager-runtime.ts';
import { recordAutomationMissedRun } from '../platform/src/platform/automation/manager-runtime-missed.ts';
import { scheduleAutomationJob } from '../platform/src/platform/automation/manager-runtime-scheduling.ts';
import type { AutomationRun } from '../platform/src/platform/automation/runs.ts';
import { AutomationJobStore } from '../platform/src/platform/automation/store/jobs.ts';
import type { AutomationRunStore } from '../platform/src/platform/automation/store/runs.ts';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function makeJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  const now = Date.now();
  return {
    id: 'job-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    name: 'Nightly digest',
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'every', intervalMs: 3_600_000 },
    execution: { target: { kind: 'background' }, prompt: 'write the digest' },
    delivery: {
      mode: 'surface',
      targets: [{ kind: 'surface', surfaceKind: 'webhook', address: 'https://example.test/hook' }],
      fallbackTargets: [],
      includeSummary: false,
      includeTranscript: false,
      includeLinks: false,
    },
    failure: {
      action: 'disable',
      maxConsecutiveFailures: 1,
      cooldownMs: 60_000,
      retryPolicy: { maxAttempts: 3, delayMs: 0, strategy: 'fixed' },
      disableAfterFailures: true,
    },
    source: { id: 'source-1', kind: 'manual', label: 'test', enabled: true, createdAt: now, updatedAt: now, metadata: {} },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
    ...overrides,
  } as AutomationJob;
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  const now = Date.now();
  return {
    id: 'run-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    jobId: 'job-1',
    status: 'failed',
    triggeredBy: { id: 'source-1', kind: 'manual', label: 'test', enabled: true, createdAt: now, updatedAt: now, metadata: {} },
    target: { kind: 'background' },
    execution: { target: { kind: 'background' }, prompt: 'write the digest' },
    queuedAt: now,
    startedAt: now,
    forceRun: false,
    dueRun: false,
    attempt: 1,
    deliveryIds: [],
    ...overrides,
  } as AutomationRun;
}

const allFlags = { isEnabled: () => true };
const routeBindings = {
  start: async () => undefined,
  getBinding: () => undefined,
  captureReplyTarget: async () => undefined,
  patchBinding: async () => undefined,
} as unknown as RouteBindingManager;

interface HarnessOptions {
  readonly jobs?: readonly AutomationJob[];
  readonly runs?: readonly AutomationRun[];
  readonly spawnTask?: (input: unknown) => string;
  readonly saveRuns?: () => Promise<void>;
  readonly jobStore?: unknown;
}

async function harness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gv-automation-failure-'));
  const jobs = (options.jobs ?? [makeJob()]).map((job) => ownedAutomationJob(job, 'fixture-revision'));
  const noticeMessages: string[] = [];
  const normalDeliveries: string[] = [];
  const cancelled: string[] = [];
  const events: string[] = [];
  const bus = new RuntimeEventBus();
  bus.onDomain('automation', (envelope) => { events.push((envelope.payload as { type: string }).type); });
  const deliveryManager = {
    deliverText: async (_job: AutomationJob, _run: AutomationRun, message: string) => {
      noticeMessages.push(message);
      return [{ status: 'sent' }];
    },
    deliverJobRun: async (_job: AutomationJob, run: AutomationRun) => {
      normalDeliveries.push(run.id);
      return [];
    },
  } as unknown as AutomationDeliveryManager;
  const savedRuns: AutomationRun[][] = [];
  const manager = new AutomationManager({
    configManager: new ConfigManager({ configDir: dir }),
    routeBindings,
    sessionBroker: { start: async () => undefined, appendSystemMessage: async () => undefined } as never,
    featureFlags: allFlags,
    runtimeBus: bus,
    deliveryManager,
    spawnTask: (options.spawnTask ?? (() => 'agent-1')) as never,
    cancelTask: (agentId) => { cancelled.push(agentId); },
    jobStore: (options.jobStore ?? { load: async () => ({ version: 1, jobs }), save: async () => undefined }) as never,
    runStore: {
      load: async () => ({ version: 1, runs: options.runs ?? [] }),
      save: async (runs: AutomationRun[]) => { savedRuns.push(runs); await options.saveRuns?.(); },
    } as unknown as AutomationRunStore,
  });
  cleanup.push(() => { manager.stop(); rmSync(dir, { recursive: true, force: true }); });
  await manager.start();
  return { manager, noticeMessages, normalDeliveries, cancelled, events };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('retry policy', () => {
  function context(job: AutomationJob) {
    return {
      jobs: new Map([[job.id, job]]),
      retryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
      deliveryManager: null,
      activeRunCount: () => 0,
      maxConcurrentRuns: () => 1,
      executeJob: async () => makeRun(),
      saveJobs: async () => undefined,
      scheduleJob: () => undefined,
      deliverFailureNotice: () => undefined,
      emitRunFailed: () => undefined,
    };
  }

  test('a job that never set execution.maxAttempts retries as many times as its retry policy says', () => {
    const job = makeJob({ failure: { ...makeJob().failure, action: 'retry' } });
    const second = context(job);
    scheduleAutomationFailureFollowUp(second, job, makeRun({ attempt: 2 }), true);
    expect(second.retryTimers.size).toBe(1);
    const exhausted = context(job);
    scheduleAutomationFailureFollowUp(exhausted, job, makeRun({ attempt: 3 }), true);
    expect(exhausted.retryTimers.size).toBe(0);
    for (const timer of second.retryTimers.values()) clearTimeout(timer);
  });

  test('an explicit execution.maxAttempts still overrides the retry policy', () => {
    const base = makeJob();
    const job = makeJob({ execution: { ...base.execution, maxAttempts: 1 }, failure: { ...base.failure, action: 'retry' } });
    const ctx = context(job);
    scheduleAutomationFailureFollowUp(ctx, job, makeRun({ attempt: 1 }), true);
    expect(ctx.retryTimers.size).toBe(0);
  });

  test('a one-shot job that completed before its retry fires is still retried', () => {
    jest.useFakeTimers();
    try {
      const base = makeJob();
      const job = makeJob({ failure: { ...base.failure, action: 'retry', retryPolicy: { maxAttempts: 2, delayMs: 0, strategy: 'fixed' } } });
      const ctx = context(job);
      let retried = 0;
      ctx.executeJob = async () => { retried += 1; return makeRun(); };
      scheduleAutomationFailureFollowUp(ctx, job, makeRun({ attempt: 1 }), true);
      ctx.jobs.set(job.id, { ...job, enabled: false, status: 'paused', pausedReason: 'one-shot-complete' });
      jest.advanceTimersByTime(1_000);
      expect(retried).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a job an operator or the failure threshold paused is not retried', () => {
    jest.useFakeTimers();
    try {
      const base = makeJob();
      const job = makeJob({ failure: { ...base.failure, action: 'retry', retryPolicy: { maxAttempts: 2, delayMs: 0, strategy: 'fixed' } } });
      const ctx = context(job);
      let retried = 0;
      ctx.executeJob = async () => { retried += 1; return makeRun(); };
      scheduleAutomationFailureFollowUp(ctx, job, makeRun({ attempt: 1 }), true);
      ctx.jobs.set(job.id, { ...job, enabled: false, status: 'paused', pausedReason: 'operator-disabled' });
      jest.advanceTimersByTime(1_000);
      expect(retried).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a run that fails to start', () => {
  test('is announced, reported as auto-disabled when the threshold is hit, and still fails the caller', async () => {
    const h = await harness({ spawnTask: () => { throw new Error('model provider unreachable'); } });
    await expect(h.manager.runNow('job-1')).rejects.toThrow('model provider unreachable');
    await flush();
    expect(h.noticeMessages).toHaveLength(1);
    expect(h.noticeMessages[0]).toContain('Automation failure: Nightly digest');
    expect(h.noticeMessages[0]).toContain('model provider unreachable');
    expect(h.events).toContain('AUTOMATION_JOB_AUTO_DISABLED');
    expect(h.manager.getJob('job-1')?.enabled).toBe(false);
  });

  test('cancels an agent that was spawned before the run could be recorded', async () => {
    let failSave = true;
    const h = await harness({
      spawnTask: () => 'agent-9',
      saveRuns: async () => {
        if (!failSave) return;
        failSave = false;
        throw new Error('disk full');
      },
    });
    await expect(h.manager.runNow('job-1')).rejects.toThrow('disk full');
    expect(h.cancelled).toEqual(['agent-9']);
    const [run] = h.manager.listRuns('job-1');
    expect(run?.status).toBe('failed');
    expect(run?.agentId).toBe('agent-9');
  });
});

describe('manual runs of a job that needs its source owner', () => {
  const operation = { sourceOf: () => ({ goal: 'Run the nightly digest', criteria: [] }), assertCurrent() {} };

  test('a failed start does not block the next manual run', async () => {
    const base = makeJob();
    let attempts = 0;
    const h = await harness({
      jobs: [makeJob({
        execution: { ...base.execution, requiresSourceOwner: true },
        failure: { ...base.failure, disableAfterFailures: false },
      })],
      spawnTask: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first start fails');
        return 'agent-2';
      },
    });
    await expect(h.manager.runNow('job-1', operation as never)).rejects.toThrow('first start fails');
    const run = await h.manager.runNow('job-1', operation as never);
    expect(run.status).toBe('running');
    expect(run.agentId).toBe('agent-2');
  });
});

describe('retrying a run', () => {
  test('only a failed, cancelled or missed run can be retried', async () => {
    const h = await harness({ runs: [makeRun({ id: 'run-live', status: 'running', agentId: 'agent-live' })] });
    await expect(h.manager.retryRun('run-live')).rejects.toThrow('is running');
  });
});

describe('one message per failed run', () => {
  test('a failed remote run reaches the job targets once, as the failure notice', async () => {
    const h = await harness({ runs: [makeRun({ id: 'run-remote', status: 'running' })] });
    const run = await h.manager.recordExternalRunResult('run-remote', { status: 'failed', error: 'remote worker crashed' });
    await flush();
    expect(run?.status).toBe('failed');
    expect(h.noticeMessages).toHaveLength(1);
    expect(h.normalDeliveries).toEqual([]);
  });

  test('a completed remote run is delivered as the ordinary run message', async () => {
    const h = await harness({ runs: [makeRun({ id: 'run-remote', status: 'running' })] });
    await h.manager.recordExternalRunResult('run-remote', { status: 'completed', result: 'done' });
    await flush();
    expect(h.normalDeliveries).toEqual(['run-remote']);
    expect(h.noticeMessages).toEqual([]);
  });
});

describe('one-shot jobs', () => {
  function schedulingContext(job: AutomationJob, overrides: Record<string, unknown> = {}) {
    const jobs = new Map([[job.id, job]]);
    const missed: number[] = [];
    return {
      jobs,
      missed,
      context: {
        configManager: { get: () => 30 },
        jobs,
        timers: new Map<string, ReturnType<typeof setTimeout>>(),
        heartbeatWakes: new Map(),
        running: () => true,
        saveJobs: async () => undefined,
        activeRunCount: () => 0,
        maxConcurrentRuns: () => 4,
        executeJob: async () => makeRun(),
        recordMissedRun: (_job: AutomationJob, plannedRunAt: number) => { missed.push(plannedRunAt); },
        ...overrides,
      },
    };
  }

  test('one that is past its catch-up window is recorded as missed and then completed, not left enabled', () => {
    const planned = Date.now() - 2 * 3_600_000;
    const job = makeJob({ schedule: { kind: 'at', at: planned }, nextRunAt: planned });
    const { jobs, missed, context } = schedulingContext(job);
    scheduleAutomationJob(context as never, job);
    expect(missed).toEqual([planned]);
    const stored = jobs.get(job.id)!;
    expect(stored.enabled).toBe(false);
    expect(stored.pausedReason).toBe('one-shot-complete');
    expect(stored.nextRunAt).toBeUndefined();
    for (const timer of context.timers.values()) clearTimeout(timer);
  });

  test('one that already ran is completed without a missed record', () => {
    const planned = Date.now() - 2 * 3_600_000;
    const job = makeJob({ schedule: { kind: 'at', at: planned }, nextRunAt: planned, lastRunAt: planned + 1_000 });
    const { jobs, missed, context } = schedulingContext(job);
    scheduleAutomationJob(context as never, job);
    expect(missed).toEqual([]);
    expect(jobs.get(job.id)?.pausedReason).toBe('one-shot-complete');
  });

  test('one whose time has passed cannot be enabled, and says why', async () => {
    const job = makeJob({ enabled: false, status: 'paused', schedule: { kind: 'at', at: Date.now() - 60_000 } });
    const committed: AutomationJob[] = [];
    const context = {
      configManager: { get: () => undefined },
      jobs: new Map([[job.id, job]]),
      commitJob: async (_previous: AutomationJob | undefined, next: AutomationJob) => { committed.push(next); return next; },
      scheduleJob: () => undefined,
      syncJobToRuntime: () => undefined,
      emitJobCreated: () => undefined,
      emitJobUpdated: () => undefined,
    };
    const result = await toggleAutomationJobEnabled(context as never, job.id, true);
    expect(result?.enabled).toBe(false);
    expect(result?.pausedReason).toBe('schedule-expired');
    expect(committed).toHaveLength(1);
  });
});

describe('overlapping occurrences', () => {
  test('a timer that fires while a run of the job is in flight skips that occurrence and arms the next', async () => {
    const dueAt = Date.now() - 1;
    const job = makeJob({ nextRunAt: dueAt });
    const jobs = new Map([[job.id, job]]);
    let executed = 0;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const context = {
      configManager: { get: () => 30 },
      jobs,
      timers,
      heartbeatWakes: new Map(),
      running: () => true,
      saveJobs: async () => undefined,
      activeRunCount: () => 0,
      maxConcurrentRuns: () => 4,
      executeJob: async () => { executed += 1; return makeRun(); },
      hasRunningRun: () => true,
    };
    cleanup.push(() => { for (const timer of timers.values()) clearTimeout(timer); });
    scheduleAutomationJob(context as never, job);
    // Yield to the event loop until the due timer has run; no elapsed time is asserted.
    for (let i = 0; i < 500 && (jobs.get(job.id)?.nextRunAt ?? 0) <= Date.now(); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(executed).toBe(0);
    expect(jobs.get(job.id)!.nextRunAt!).toBeGreaterThan(Date.now());
  });
});

describe('heartbeat wakes', () => {
  test('a due job whose previous run is still running is not started again', async () => {
    const base = makeJob();
    let spawned = 0;
    const h = await harness({
      jobs: [makeJob({ nextRunAt: Date.now() - 1, execution: { ...base.execution, wakeMode: 'next-heartbeat' } })],
      runs: [makeRun({ id: 'run-live', status: 'running', agentId: 'agent-live' })],
      spawnTask: () => { spawned += 1; return 'agent-2'; },
    });
    const result = await h.manager.triggerHeartbeat();
    expect(spawned).toBe(0);
    expect(result.processed).toHaveLength(0);
    expect(result.pending.map((wake) => wake.jobId)).toEqual(['job-1']);
  });
});

describe('a job changed by someone else', () => {
  test('a refused update refreshes the job, so the next update works from its current revision', async () => {
    const stored = ownedAutomationJob(makeJob({ name: 'Edited elsewhere' }), 'rev-outside');
    let commits = 0, changedElsewhere = false;
    const h = await harness({
      jobStore: {
        load: async () => ({ version: 1, jobs: [changedElsewhere ? stored : ownedAutomationJob(makeJob(), 'rev-1')] }),
        save: async () => undefined,
        assertCurrent() {},
        commit: async (_id: string, expected: string | null) => {
          commits += 1;
          if (expected !== 'rev-outside') throw new AutomationJobMutationStaleError();
        },
      },
    });
    expect(h.manager.getJob('job-1')?.name).toBe('Nightly digest');
    changedElsewhere = true;
    await expect(h.manager.updateJob('job-1', { name: 'Mine' })).rejects.toBeInstanceOf(AutomationJobMutationStaleError);
    expect(h.manager.getJob('job-1')?.name).toBe('Edited elsewhere');
    const updated = await h.manager.updateJob('job-1', { name: 'Mine' });
    expect(updated?.name).toBe('Mine');
    expect(commits).toBe(2);
  });
});

describe('the job store after an outside change', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'gv-automation-store-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, path: join(dir, 'automation-jobs.json') };
  }

  test('a whole-snapshot save absorbs the change instead of failing from then on', async () => {
    const { path } = fixture();
    const store = new AutomationJobStore(path);
    await store.save([makeJob({ id: 'a' })]);
    await store.load();
    const external = ownedAutomationJob(makeJob({ id: 'external', name: 'Written elsewhere' }), 'external-revision');
    writeFileSync(path, JSON.stringify({ version: 1, jobs: [external] }));
    await store.save([makeJob({ id: 'a', name: 'Renamed' })]);
    const ids = (await new AutomationJobStore(path).load()).jobs.map((job) => job.id).sort();
    expect(ids).toEqual(['a', 'external']);
    await store.save([makeJob({ id: 'a', name: 'Renamed again' })]);
  });

  test('a conditional commit after an outside change fails once, then works against what is on disk', async () => {
    const { path } = fixture();
    const store = new AutomationJobStore(path);
    const first = ownedAutomationJob(makeJob({ id: 'a' }), 'rev-1');
    await store.save([first]);
    await store.load();
    const external = ownedAutomationJob(makeJob({ id: 'a', name: 'Edited elsewhere' }), 'rev-2');
    writeFileSync(path, JSON.stringify({ version: 1, jobs: [external] }));
    const next = ownedAutomationJob(makeJob({ id: 'a', name: 'Mine' }), 'rev-3');
    await expect(store.commit('a', 'rev-1', next)).rejects.toBeInstanceOf(AutomationJobMutationStaleError);
    await store.commit('a', 'rev-2', next);
    expect((await new AutomationJobStore(path).load()).jobs[0]?.name).toBe('Mine');
  });
});

describe('delivery', () => {
  function deliveryManager(options: { readonly artifacts?: Record<string, number>; readonly router: (request: { attachments?: Array<{ artifactId: string }> }) => Promise<string>; readonly bus?: RuntimeEventBus }) {
    const manager = new AutomationDeliveryManager({
      routeBindings,
      featureFlags: allFlags,
      deliveryRouter: { setControlPlaneGateway() {}, deliver: options.router } as never,
      ...(options.artifacts ? { artifactStore: { get: (id: string) => (id in options.artifacts! ? { id, createdAt: options.artifacts![id] } : null) } as never } : {}),
      ...(options.bus ? { runtimeBus: options.bus } : {}),
    });
    return manager;
  }

  test('only artifacts created since the run started are attached from a run result', async () => {
    const startedAt = 1_000_000;
    const sent: string[][] = [];
    const manager = deliveryManager({
      artifacts: { 'artifact-old': startedAt - 5_000, 'artifact-new': startedAt + 5 },
      router: async (request) => { sent.push((request.attachments ?? []).map((entry) => entry.artifactId)); return 'ok'; },
    });
    await manager.deliverJobRun(makeJob(), makeRun({
      status: 'completed', startedAt,
      result: { artifactIds: ['artifact-old', 'artifact-new', 'artifact-unknown'] },
    }));
    expect(sent).toEqual([['artifact-new']]);
  });

  test('nothing is attached when there is no store to confirm ownership', async () => {
    const sent: string[][] = [];
    const manager = deliveryManager({ router: async (request) => { sent.push((request.attachments ?? []).map((entry) => entry.artifactId)); return 'ok'; } });
    await manager.deliverJobRun(makeJob(), makeRun({ status: 'completed', result: { artifactIds: ['artifact-any'] } }));
    expect(sent).toEqual([[]]);
  });

  test('a target that used every try is reported as dead-lettered, and its failure as final', async () => {
    const base = makeJob();
    const job = makeJob({ failure: { ...base.failure, retryPolicy: { maxAttempts: 2, delayMs: 0, strategy: 'fixed' } } });
    const bus = new RuntimeEventBus();
    const seen: Array<{ type: string; retryable?: boolean; attempts?: number }> = [];
    bus.onDomain('deliveries', (envelope) => { seen.push(envelope.payload as never); });
    const manager = deliveryManager({
      bus,
      router: async () => { throw new HttpStatusError('HTTP 503: upstream unavailable', { status: 503 }); },
    });
    const attempts = await manager.deliverJobRun(job, makeRun({ status: 'completed' }));
    expect(attempts.map((attempt) => attempt.status)).toEqual(['dead_lettered']);
    const deadLettered = seen.filter((event) => event.type === 'DELIVERY_DEAD_LETTERED');
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0]?.attempts).toBe(2);
    expect(seen.find((event) => event.type === 'DELIVERY_FAILED')?.retryable).toBe(false);
  });

  test('a failure report that throws does not stop delivery to the remaining targets', async () => {
    const base = makeJob();
    const job = makeJob({
      delivery: {
        ...base.delivery,
        targets: [
          { kind: 'surface', surfaceKind: 'webhook', address: 'https://example.test/one' },
          { kind: 'surface', surfaceKind: 'webhook', address: 'https://example.test/two' },
        ],
      },
    });
    const bus = {
      emit(_domain: string, envelope: { payload: { type: string } }) {
        if (envelope.payload.type === 'DELIVERY_FAILED') throw new Error('subscriber failed');
      },
    } as unknown as RuntimeEventBus;
    const targets: string[] = [];
    const manager = deliveryManager({
      bus,
      router: async (request) => {
        targets.push((request as unknown as { target: { address: string } }).target.address);
        throw new HttpStatusError('HTTP 404: gone', { status: 404 });
      },
    });
    const attempts = await manager.deliverJobRun(job, makeRun({ status: 'completed' }));
    expect(targets).toEqual(['https://example.test/one', 'https://example.test/two']);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'failed']);
  });
});

describe('check-in runs', () => {
  test('a delivered check-in stays completed when saving its run fails afterwards', async () => {
    const job = makeJob({ kind: 'checkin' } as Partial<AutomationJob>);
    const runs = new Map<string, AutomationRun>();
    const jobs = new Map([[job.id, job]]);
    const context = {
      runs,
      jobs,
      onRunRecorded: () => undefined,
      emitRunQueued: () => undefined,
      emitRunStarted: () => undefined,
      emitRunCompleted: () => undefined,
      emitRunFailed: () => undefined,
      pruneRunHistory: () => undefined,
      saveJobs: async () => undefined,
      saveRuns: async () => { throw new Error('disk full'); },
      syncRunToRuntime: () => undefined,
      syncJobToRuntime: () => undefined,
      settleRun: settleRunOver({ jobs, runs }),
    };
    const run = await executeCheckinJob(
      context as never,
      async () => ({ outcome: 'delivered', summary: 'Sent the morning note', deliveryId: 'delivery-7' }),
      job, 'scheduled', true, 1,
    );
    expect(run.status).toBe('completed');
    expect(run.deliveryIds).toEqual(['delivery-7']);
    expect(runs.get(run.id)?.status).toBe('completed');
    expect(jobs.get(job.id)?.failureCount).toBe(0);
  });
});

describe('missed runs', () => {
  test('a failed save of the missed record is reported, not left as an unhandled rejection', async () => {
    const runs = new Map<string, AutomationRun>();
    const run = recordAutomationMissedRun({
      runs,
      saveRuns: async () => { throw new Error('disk full'); },
      syncRunToRuntime: () => undefined,
      deliverFailureNotice: () => undefined,
      pruneRunHistory: () => undefined,
    }, makeJob(), Date.now() - 3_600_000);
    await flush();
    expect(run.status).toBe('missed');
    expect(runs.get(run.id)).toBe(run);
  });
});
