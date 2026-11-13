/**
 * A job the operator cancels while its provider submission is in flight must
 * stay cancelled: the tick's post-await write may not put a stale snapshot back.
 */
import { describe, expect, test } from 'bun:test';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useFailureReadings } from './_helpers/failure-readings.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { DaemonBatchManager } from '../platform/src/platform/batch/manager.js';
import { daemonBatchJobLifecycle } from '../platform/src/platform/batch/types.js';
import type { LLMProvider } from '../platform/src/platform/providers/interface.js';

function gatedProvider(outcome: 'ok' | 'reject'): { provider: LLMProvider; entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const provider = {
    name: 'openai',
    models: ['gpt-test'],
    isConfigured: () => true,
    async chat() { throw new Error('not used'); },
    batch: {
      kind: 'provider-batch',
      endpoints: ['/v1/chat/completions'],
      async createChatBatch() {
        enter();
        await gate;
        if (outcome === 'reject') throw new HttpStatusError('HTTP 401: invalid api key', { status: 401 });
        return { providerBatchId: 'pb-1', status: 'submitted' as const };
      },
      async retrieveBatch(providerBatchId: string) { return { providerBatchId, status: 'submitted' as const }; },
      async getResults() { return []; },
    },
  } as unknown as LLMProvider;
  return { provider, entered, release };
}

async function setup(provider: LLMProvider) {
  const configDir = join(tmpdir(), `gv-batch-cancel-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(configDir, { recursive: true });
  const configManager = new ConfigManager({ configDir });
  configManager.set('batch.mode', 'explicit');
  configManager.set('batch.maxDelayMs', 0);
  const registry = { getCurrentModel: () => undefined, getForModel: () => provider, getRegistered: () => provider, listProviders: () => [provider] };
  const manager = new DaemonBatchManager({ configManager, providerRegistry: registry as never });
  const job = await manager.createJob({ provider: 'openai', model: 'gpt-test', request: { messages: [{ role: 'user', content: 'hi' }] } });
  return { manager, job };
}

describe('daemon batch job lifecycle', () => {
  useFailureReadings([]);

  test('declares every status, terminals are final, queued cannot jump to completed', () => {
    expect(daemonBatchJobLifecycle.states.length).toBe(8);
    for (const s of ['completed', 'failed', 'cancelled', 'expired', 'dead_lettered'] as const) expect(daemonBatchJobLifecycle.isTerminal(s)).toBe(true);
    expect(daemonBatchJobLifecycle.can('queued', 'cancelled')).toBe(true);
    expect(daemonBatchJobLifecycle.can('queued', 'completed')).toBe(false);
  });

  test('a cancel during a successful submission is not overwritten by submitted', async () => {
    const { provider, entered, release } = gatedProvider('ok');
    const { manager, job } = await setup(provider);
    const ticking = manager.tick({ forceSubmit: true });
    await entered;
    expect((await manager.cancelJob(job.id)).status).toBe('cancelled');
    release();
    const result = await ticking;
    expect((await manager.getJob(job.id))?.status).toBe('cancelled');
    expect(result.submittedJobs).toBe(0);
  });

  test('a cancel during a failing submission is not overwritten by dead_lettered', async () => {
    const { provider, entered, release } = gatedProvider('reject');
    const { manager, job } = await setup(provider);
    const ticking = manager.tick({ forceSubmit: true });
    await entered;
    await manager.cancelJob(job.id);
    release();
    const result = await ticking;
    expect((await manager.getJob(job.id))?.status).toBe('cancelled');
    expect(result.failedJobs).toBe(0);
  });
});
