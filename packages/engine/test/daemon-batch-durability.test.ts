import { describe, expect, test } from 'bun:test';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import {
  BATCH_SUBMISSION_METADATA_KEY,
  BATCH_TERMINAL_RETENTION_COUNT,
  BATCH_TERMINAL_RETENTION_MS,
  DaemonBatchManager,
  MAX_BATCH_REQUEST_BYTES,
} from '../platform/src/platform/batch/manager.js';
import type { DaemonBatchJob } from '../platform/src/platform/batch/types.js';
import type {
  LLMProvider,
  ProviderBatchChatRequest,
  ProviderBatchPollResult,
  ProviderBatchResult,
  ProviderBatchStatus,
} from '../platform/src/platform/providers/interface.js';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.js';

interface Rig {
  readonly manager: DaemonBatchManager;
  readonly storePath: string;
  readonly config: ConfigManager;
}

interface ScriptedProvider {
  readonly provider: LLMProvider;
  readonly requests: ProviderBatchChatRequest[];
  create: (requests: readonly ProviderBatchChatRequest[], index: number) => Promise<{ providerBatchId: string; status: ProviderBatchStatus }>;
  retrieve: (id: string) => Promise<{ providerBatchId: string; status: ProviderBatchStatus; resultAvailable: boolean }>;
  results: (id: string) => Promise<readonly ProviderBatchResult[]>;
}

function succeeded(customId: string): ProviderBatchResult {
  return {
    customId,
    status: 'succeeded',
    response: { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' },
  };
}

function scriptedProvider(): ScriptedProvider {
  const requests: ProviderBatchChatRequest[] = [];
  let created = 0;
  const script: ScriptedProvider = {
    requests,
    provider: undefined as unknown as LLMProvider,
    create: async () => ({ providerBatchId: `pb-${created}`, status: 'submitted' }),
    retrieve: async (id) => ({ providerBatchId: id, status: 'completed', resultAvailable: true }),
    results: async () => requests.map((request) => succeeded(request.customId)),
  };
  const provider: LLMProvider = {
    name: 'openai',
    models: ['gpt-test'],
    isConfigured: () => true,
    async chat() {
      throw new Error('not used');
    },
    batch: {
      kind: 'provider-batch',
      endpoints: ['/v1/chat/completions'],
      async createChatBatch(input) {
        created += 1;
        requests.push(...input.requests);
        return script.create(input.requests, created);
      },
      retrieveBatch: (id) => script.retrieve(id),
      getResults: (id) => script.results(id),
    },
  };
  return Object.assign(script, { provider });
}

function registryFor(provider: LLMProvider): Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'getRegistered' | 'listProviders'> {
  return {
    getCurrentModel: () => ({
      id: 'gpt-test',
      provider: 'openai',
      registryKey: 'openai:gpt-test',
      displayName: 'GPT Test',
      description: 'test model',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
      contextWindow: 128_000,
      selectable: true,
      tier: 'standard',
    }),
    getForModel: () => provider,
    getRegistered: () => provider,
    listProviders: () => [provider],
  };
}

function rig(provider: LLMProvider, settings: Record<string, number> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'gv-batch-durability-'));
  mkdirSync(dir, { recursive: true });
  const config = new ConfigManager({ configDir: dir });
  config.set('batch.mode', 'explicit');
  config.set('batch.maxDelayMs', 0);
  for (const [key, value] of Object.entries(settings)) config.set(key as 'batch.maxDelayMs', value);
  const storePath = join(dir, 'batch-jobs.json');
  return { manager: new DaemonBatchManager({ configManager: config, providerRegistry: registryFor(provider), storePath }), storePath, config };
}

const request = { messages: [{ role: 'user' as const, content: 'hi' }] };

/** The job directory beside the store name. */
function jobDir(storePath: string): string {
  return storePath.slice(0, -'.json'.length);
}

/** The jobs a restart would read. */
function onDisk(storePath: string): Record<string, DaemonBatchJob> {
  const dir = jobDir(storePath);
  const jobs: Record<string, DaemonBatchJob> = {};
  if (!existsSync(dir)) return jobs;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.result.json')) continue;
    const job = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as DaemonBatchJob;
    jobs[job.id] = job;
  }
  return jobs;
}

function finishedJob(id: string, completedAt: number): DaemonBatchJob {
  return {
    id,
    provider: 'openai',
    model: 'gpt-test',
    status: 'completed',
    createdAt: completedAt,
    updatedAt: completedAt,
    completedAt,
    attempts: 1,
    request,
  };
}

describe('batch store loading', () => {
  test('two first callers share one store, so neither job is lost', async () => {
    const script = scriptedProvider();
    const { manager, storePath } = rig(script.provider, { 'batch.maxDelayMs': 3_600_000 });
    const [a, b] = await Promise.all([
      manager.createJob({ request }),
      manager.createJob({ request }),
    ]);
    const listed = (await manager.listJobs()).map((job) => job.id).sort();
    expect(listed).toEqual([a.id, b.id].sort());
    expect(Object.keys(onDisk(storePath)).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('provider batch durability', () => {
  test('a provider batch is on disk before the next one is created', async () => {
    const script = scriptedProvider();
    const { manager, storePath } = rig(script.provider, { 'batch.maxJobsPerProviderBatch': 1 });
    const first = await manager.createJob({ request });
    const second = await manager.createJob({ request });
    const seenOnDisk: Array<DaemonBatchJob | undefined> = [];
    script.retrieve = async (id) => ({ providerBatchId: id, status: 'running', resultAvailable: false });
    script.create = async (_requests, index) => {
      if (index === 2) {
        const stored = onDisk(storePath);
        seenOnDisk.push(stored[first.id], stored[second.id]);
      }
      return { providerBatchId: `pb-${index}`, status: 'submitted' };
    };
    await manager.tick({ forceSubmit: true });
    const [firstOnDisk, secondOnDisk] = seenOnDisk;
    const batched = [firstOnDisk, secondOnDisk].filter((job) => job?.providerBatchId === 'pb-1');
    expect(batched).toHaveLength(1);
    expect(batched[0]?.status).toBe('submitted');
  });

  test('a batch the provider rejects counts as failed jobs, not submitted ones', async () => {
    const script = scriptedProvider();
    script.create = async () => ({ providerBatchId: 'pb-x', status: 'failed' });
    const { manager } = rig(script.provider);
    const job = await manager.createJob({ request });
    const tick = await manager.tick({ forceSubmit: true });
    expect((await manager.getJob(job.id))?.status).toBe('failed');
    expect(tick.failedJobs).toBe(1);
    expect(tick.submittedJobs).toBe(0);
  });
});

describe('a completed provider batch that omits a job', () => {
  test('the omitted job fails instead of being polled forever', async () => {
    const script = scriptedProvider();
    const { manager } = rig(script.provider);
    const jobs = [await manager.createJob({ request }), await manager.createJob({ request }), await manager.createJob({ request })];
    script.results = async () => [succeeded(jobs[0]!.id), succeeded(jobs[1]!.id)];
    const tick = await manager.tick({ forceSubmit: true });
    expect((await manager.getJob(jobs[0]!.id))?.status).toBe('completed');
    expect((await manager.getJob(jobs[1]!.id))?.status).toBe('completed');
    const missing = await manager.getJob(jobs[2]!.id);
    expect(missing?.status).toBe('failed');
    expect(missing?.error?.message).toContain('no result');
    expect(tick.failedJobs).toBe(1);
  });
});

describe('an unreadable failure does not stall the rest of the tick', () => {
  test('an unreadable poll failure on one batch still polls the next', async () => {
    forgetFailureReadings();
    const previous = installJudgmentPort(undefined);
    try {
      const script = scriptedProvider();
      const { manager } = rig(script.provider, { 'batch.maxJobsPerProviderBatch': 1 });
      const first = await manager.createJob({ request });
      const second = await manager.createJob({ request });
      script.retrieve = async (id) => {
        if (id === 'pb-1') throw new Error('something unusual happened');
        return { providerBatchId: id, status: 'completed', resultAvailable: true };
      };
      script.results = async () => [succeeded(second.id)];
      await manager.tick({ forceSubmit: true });
      expect((await manager.getJob(first.id))?.status).toBe('submitted');
      expect((await manager.getJob(second.id))?.status).toBe('completed');
    } finally {
      installJudgmentPort(previous);
    }
  });

  test('an unreadable submission failure still polls batches already submitted', async () => {
    forgetFailureReadings();
    const previous = installJudgmentPort(undefined);
    try {
      const script = scriptedProvider();
      script.retrieve = async (id) => ({ providerBatchId: id, status: 'running', resultAvailable: false });
      const { manager } = rig(script.provider);
      const paid = await manager.createJob({ request });
      await manager.tick({ forceSubmit: true });
      expect((await manager.getJob(paid.id))?.status).toBe('running');

      script.create = async () => {
        throw new Error('something unusual happened');
      };
      script.retrieve = async (id) => ({ providerBatchId: id, status: 'completed', resultAvailable: true });
      script.results = async () => [succeeded(paid.id)];
      const waiting = await manager.createJob({ request });
      await manager.tick({ forceSubmit: true });
      expect((await manager.getJob(paid.id))?.status).toBe('completed');
      const still = await manager.getJob(waiting.id);
      expect(still?.status).toBe('queued');
      expect(still?.attempts).toBe(1);
    } finally {
      installJudgmentPort(previous);
    }
  });
});

describe('flush while a tick is running', () => {
  test('the flushed job is submitted by a forced tick that follows the running one', async () => {
    const script = scriptedProvider();
    script.retrieve = async (id) => ({ providerBatchId: id, status: 'running', resultAvailable: false });
    const { manager } = rig(script.provider, { 'batch.maxDelayMs': 3_600_000 });
    const early = await manager.createJob({ request, flush: true });
    expect(early.status).not.toBe('queued');

    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inPoll = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    script.retrieve = async (id) => {
      entered();
      await gate;
      return { providerBatchId: id, status: 'running', resultAvailable: false };
    };
    const running = manager.tick();
    await inPoll;
    const flushed = manager.createJob({ request, flush: true });
    release();
    await running;
    expect((await flushed).status).not.toBe('queued');
  });
});

describe('store growth', () => {
  test('finished jobs beyond the retention count or age are removed, and an idle tick writes nothing', async () => {
    const script = scriptedProvider();
    const { manager, storePath } = rig(script.provider);
    const nowMs = Date.now();
    const dir = jobDir(storePath);
    mkdirSync(dir, { recursive: true });
    const write = (job: DaemonBatchJob) => writeFileSync(join(dir, `${job.id}.json`), JSON.stringify(job));
    for (let i = 0; i < BATCH_TERMINAL_RETENTION_COUNT + 100; i += 1) write(finishedJob(`recent-${i}`, nowMs - i));
    write(finishedJob('stale', nowMs - BATCH_TERMINAL_RETENTION_MS - 1000));

    await manager.tick();
    const kept = Object.keys(onDisk(storePath));
    expect(kept).toHaveLength(BATCH_TERMINAL_RETENTION_COUNT);
    expect(kept).not.toContain('stale');
    expect(kept).toContain('recent-0');

    const internals = manager as unknown as { files: { save: (job: DaemonBatchJob) => void } };
    let writes = 0;
    const original = internals.files.save.bind(internals.files);
    internals.files.save = (job) => {
      writes += 1;
      original(job);
    };
    await manager.tick();
    expect(writes).toBe(0);
  });

  test('a request over the size limit is refused for any source', async () => {
    const script = scriptedProvider();
    const { manager } = rig(script.provider);
    await expect(manager.createJob({
      request: { messages: [{ role: 'user', content: 'x'.repeat(MAX_BATCH_REQUEST_BYTES + 1) }] },
    })).rejects.toMatchObject({ code: 'BATCH_REQUEST_TOO_LARGE' });
  });
});

describe('a daemon that stopped during a provider submission', () => {
  function submittingJob(id: string, submissionId: string): DaemonBatchJob {
    const at = Date.now() - 1000;
    return { id, provider: 'openai', model: 'gpt-test', status: 'submitting', createdAt: at, updatedAt: at, submittedAt: at, submissionId, attempts: 0, request };
  }

  function leaveSubmitting(storePath: string, job: DaemonBatchJob): void {
    mkdirSync(jobDir(storePath), { recursive: true });
    writeFileSync(join(jobDir(storePath), `${job.id}.json`), JSON.stringify(job));
  }

  test('a batch the provider accepted is found by its submission id and not paid for again', async () => {
    const script = scriptedProvider();
    script.retrieve = async (id) => ({ providerBatchId: id, status: 'running', resultAvailable: false });
    const lookups: string[] = [];
    Object.assign(script.provider.batch!, {
      findBatchByMetadata: async (key: string, value: string): Promise<ProviderBatchPollResult | null> => {
        lookups.push(`${key}=${value}`);
        return { providerBatchId: 'pb-accepted', status: 'submitted', resultAvailable: false };
      },
    });
    const { manager, storePath } = rig(script.provider);
    leaveSubmitting(storePath, submittingJob('batch-job-crashed', 'sub-1'));

    await manager.tick();
    expect(script.requests).toHaveLength(0);
    expect(lookups).toEqual([`${BATCH_SUBMISSION_METADATA_KEY}=sub-1`]);
    const job = await manager.getJob('batch-job-crashed');
    expect(job?.providerBatchId).toBe('pb-accepted');
    expect(onDisk(storePath)['batch-job-crashed']?.providerBatchId).toBe('pb-accepted');
  });

  test('a provider that cannot be asked gets no second submission; the job fails with what to check', async () => {
    const script = scriptedProvider();
    const { manager, storePath } = rig(script.provider);
    leaveSubmitting(storePath, submittingJob('batch-job-crashed', 'sub-2'));

    await manager.tick({ forceSubmit: true });
    expect(script.requests).toHaveLength(0);
    const job = await manager.getJob('batch-job-crashed');
    expect(job?.status).toBe('failed');
    expect(job?.error?.code).toBe('BATCH_SUBMISSION_UNCONFIRMED');
  });

  test('the submission id is on disk before the provider is called', async () => {
    const script = scriptedProvider();
    const { manager, storePath } = rig(script.provider);
    const job = await manager.createJob({ request });
    let seen: DaemonBatchJob | undefined;
    script.create = async () => {
      seen = onDisk(storePath)[job.id];
      return { providerBatchId: 'pb-1', status: 'submitted' };
    };
    await manager.tick({ forceSubmit: true });
    expect(seen?.status).toBe('submitting');
    expect(typeof seen?.submissionId).toBe('string');
  });
});

describe('a store row that cannot be read', () => {
  test('is moved aside and the other jobs are still served', async () => {
    const script = scriptedProvider();
    const { manager, storePath } = rig(script.provider);
    const good = finishedJob('batch-job-good', Date.now());
    writeFileSync(storePath, JSON.stringify({ version: 1, jobs: { 'batch-job-good': good, 'batch-job-bad': { id: 'other' } } }));

    expect((await manager.listJobs()).map((job) => job.id)).toEqual(['batch-job-good']);
    const quarantined = JSON.parse(readFileSync(`${jobDir(storePath)}.invalid.json`, 'utf-8')) as { entries: { source: string }[] };
    expect(quarantined.entries.map((entry) => entry.source)).toEqual([`${storePath}#batch-job-bad`]);
    expect(existsSync(storePath)).toBe(false);
  });
});
