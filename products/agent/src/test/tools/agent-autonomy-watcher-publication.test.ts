import { describe, expect, test } from 'bun:test';
import { watcherReadModelNativeFacts, watcherReadModelPublication } from '../../tools/agent-harness-autonomy-watcher-read-models.ts';
import type { CommandContext } from '../../input/command-registry.ts';

function contextWith(watchers: Record<string, unknown>): CommandContext {
  return { platform: { readModels: { watchers } }, clients: {} } as unknown as CommandContext;
}

describe('watcher records published by the host', () => {
  test('reports which lanes the host publishes, from the same capture the queue reads', () => {
    expect(watcherReadModelPublication(contextWith({}))).toEqual({ runs: false, providerSources: false, omitted: 0 });
    expect(watcherReadModelPublication(contextWith({ runs: [{ runId: 'r1', status: 'running' }] }))).toMatchObject({ runs: true, providerSources: false });
    expect(watcherReadModelPublication(contextWith({ sources: [{ sourceId: 's1', enabled: true }] }))).toMatchObject({ runs: false, providerSources: true });
  });

  test('counts records the queue will not list', () => {
    const runs = Array.from({ length: 27 }, (_, index) => ({ runId: `r${index}`, status: 'completed' }));
    expect(watcherReadModelPublication(contextWith({ runs })).omitted).toBe(7);
  });

  test('a source the owner switched off is paused, not blocked', () => {
    const facts = watcherReadModelNativeFacts(contextWith({ sources: [{ sourceId: 's1', enabled: false }, { sourceId: 's2', enabled: true }] }));
    expect(facts.map(fact => fact.status).sort()).toEqual(['paused', 'ready']);
  });
});

describe('autonomy intake refusals use the projection error classes', () => {
  test('asynchronous caller authority is held, not a plain error', async () => {
    const { autonomyIntakeSummary } = await import('../../tools/agent-harness-autonomy-intake.ts');
    const context = contextWith({});
    await expect(autonomyIntakeSummary(context, {}, { assertCurrent: (async () => {}) as unknown as () => void }))
      .rejects.toMatchObject({ name: 'ToolInputProjectionError', problem: 'held' });
  });
});

describe('autonomy intake reads the watcher records the host publishes', () => {
  async function contractStatus(watchers: Record<string, unknown>): Promise<unknown> {
    const { autonomyIntakeSummary } = await import('../../tools/agent-harness-autonomy-intake.ts');
    const summary = await autonomyIntakeSummary(contextWith(watchers), {});
    return (summary.watcherEvidenceContract as { status: string }).status;
  }

  test('the contract is needed until both run history and provider sources are published', async () => {
    expect(await contractStatus({})).toBe('contract-needed');
    expect(await contractStatus({ runs: [{ runId: 'r1', status: 'running' }] })).toBe('contract-needed');
  });

  test('the contract is ready once both are published', async () => {
    expect(await contractStatus({ runs: [{ runId: 'r1', status: 'running' }], sources: [{ sourceId: 's1', enabled: true }] })).toBe('ready');
  });

  test('a caller whose source owner changes after intake started is stale', async () => {
    const { autonomyIntakeSummary } = await import('../../tools/agent-harness-autonomy-intake.ts');
    let retained: (() => void) | undefined;
    const options = {
      sourceOwner: { id: 'first' },
      retainCurrent: (guard: () => void) => { retained = guard; },
    } as unknown as Parameters<typeof autonomyIntakeSummary>[2];
    await autonomyIntakeSummary(contextWith({}), {}, options);
    expect(retained).toBeDefined();
    expect(() => retained!()).not.toThrow();
    (options as { sourceOwner: unknown }).sourceOwner = { id: 'second' };
    expect(() => retained!()).toThrow(expect.objectContaining({ name: 'ToolInputProjectionError', problem: 'stale' }));
  });
});
