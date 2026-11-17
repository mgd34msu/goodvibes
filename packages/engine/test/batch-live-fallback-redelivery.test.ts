/**
 * A provider that cannot batch runs a queued request live, and that request
 * is paid. A Cloudflare queue redelivers a message whose first delivery was
 * not acknowledged in time, which is what a long live request causes: the
 * redelivery must get the first request's job, never a second paid request.
 * Real settings manager and job store; the provider is a stand-in that counts
 * the chat requests it is sent and answers when the proof lets it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonBatchManager } from '../platform/src/platform/batch/manager.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ChatResponse, LLMProvider } from '../platform/src/platform/providers/interface.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('batch live fallback', () => {
  test('a queue message redelivered while its live request runs is one provider request and one job', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-batch-live-redelivery-'));
    roots.push(root);
    const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir: join(root, 'config') });
    configManager.set('batch.mode', 'explicit');
    configManager.set('batch.fallback', 'live');

    let requests = 0;
    let answer: (response: ChatResponse) => void = () => {};
    const provider = {
      name: 'plain',
      chat: () => {
        requests += 1;
        return new Promise<ChatResponse>((resolve) => { answer = resolve; });
      },
    } as unknown as LLMProvider;
    const manager = new DaemonBatchManager({
      configManager,
      providerRegistry: {
        getCurrentModel: () => ({ provider: 'plain', id: 'plain-model' }) as never,
        getForModel: () => provider,
        getRegistered: () => provider,
        listProviders: () => [provider],
      },
    });

    const input = {
      provider: 'plain',
      model: 'plain-model',
      request: { messages: [{ role: 'user' as const, content: 'Summarise the release notes.' }] },
      source: { kind: 'cloudflare-queue' as const, id: 'queue-message-1' },
    };
    const first = manager.createJob(input);
    const redelivered = manager.createJob(input);
    // Both deliveries are past admission; the provider has been asked once.
    for (let step = 0; step < 1_000 && requests === 0; step += 1) await Promise.resolve();
    expect(requests).toBe(1);

    answer({ content: 'Notes summarised.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' } as unknown as ChatResponse);
    const [a, b] = await Promise.all([first, redelivered]);
    expect(b.id).toBe(a.id);
    expect(a.status).toBe('completed');

    // A delivery after the job is stored finds it too.
    const late = await manager.createJob(input);
    expect(late.id).toBe(a.id);
    expect(requests).toBe(1);
    expect((await manager.listJobs()).length).toBe(1);
  });
});
