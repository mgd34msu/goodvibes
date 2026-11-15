import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { memoryRefinementCatalogStatus, memoryRefinementSummary, runMemoryRefinement } from '../../tools/agent-harness-memory-refinement.ts';

type Task = { readonly id: string; readonly spaceId: string; readonly state: string; readonly gapId?: string; readonly subjectId?: string; readonly rejectedSourceUrls?: readonly string[] };

function task(id: string, state: string, extra: Partial<Task> = {}): Task {
  return { id, spaceId: 'agent', state, trace: [], createdAt: 1, updatedAt: 1, ...extra } as Task;
}

function withService(service: Record<string, unknown>): CommandContext {
  return { extensions: { agentKnowledgeService: service } } as unknown as CommandContext;
}

function listing(tasks: readonly Task[]) {
  return { listRefinementTasks: (limit?: number) => tasks.slice(0, limit) };
}

const run = (over: Record<string, unknown>) => ({
  scannedGaps: 4, createdGaps: 0, repairableGaps: 0, suppressedGaps: 0, skippedGaps: 0, searched: 0, ingestedSources: 0,
  linkedRepairs: 0, blockedGaps: 0, closedGaps: 0, queuedTasks: 0, taskIds: [], ingestedSourceIds: [], errors: [], ...over,
});

describe('memory refinement status counts', () => {
  test('closed, suppressed and cancelled tasks are each counted once and agree with the total', () => {
    const status = memoryRefinementCatalogStatus(withService(listing([
      task('a', 'closed'), task('b', 'closed'), task('c', 'cancelled'), task('d', 'suppressed'), task('e', 'failed'),
    ])));
    expect(status.taskCounts).toMatchObject({ total: 5, closed: 2, cancelled: 1, suppressed: 1, failed: 1, attention: 1 });
  });

  test('a state with no tasks reads as zero rather than missing', () => {
    const status = memoryRefinementCatalogStatus(withService(listing([task('a', 'detected')])));
    expect(status.taskCounts).toMatchObject({ closed: 0, suppressed: 0, cancelled: 0 });
  });

  test('a read that fills the task cap says the counts may be partial', () => {
    const tasks = Array.from({ length: 1_000 }, (_, index) => task(`t${index}`, 'detected'));
    const status = memoryRefinementCatalogStatus(withService(listing(tasks)));
    expect(status.taskCountsTruncated).toBe(true);
    expect(memoryRefinementCatalogStatus(withService(listing(tasks.slice(0, 3)))).taskCountsTruncated).toBeUndefined();
  });
});

describe('memory refinement inspection scope', () => {
  const tasks = [task('t1', 'detected', { gapId: 'g1', subjectId: 's1' }), task('t2', 'blocked', { gapId: 'g2', subjectId: 's2' })];

  test('gapIds narrows tasks and counts to that gap', () => {
    const summary = memoryRefinementSummary(withService(listing(tasks)), { gapIds: ['g1'] }) as { tasks: { taskId: string }[]; taskCounts: Record<string, number>; scope: unknown };
    expect(summary.tasks.map((entry) => entry.taskId)).toEqual(['t1']);
    expect(summary.taskCounts).toMatchObject({ total: 1, attention: 0 });
    expect(summary.scope).toEqual({ gapIds: ['g1'] });
  });

  test('sourceIds narrows tasks to the source', () => {
    const summary = memoryRefinementSummary(withService(listing(tasks)), { sourceIds: ['s2'] }) as { tasks: { taskId: string }[] };
    expect(summary.tasks.map((entry) => entry.taskId)).toEqual(['t2']);
  });
});

describe('memory refinement run status', () => {
  test.each([['truncated', { truncated: true }], ['budgetExhausted', { budgetExhausted: true }]])('a run that stopped early (%s) is not reported as completed', async (_name, flags) => {
    const result = await runMemoryRefinement(withService({ runRefinement: async () => run(flags) }), {});
    expect(result.status).toBe('completed-with-attention');
    expect(result.partial).toBe(true);
    expect((result.nextRoutes as Record<string, unknown>).continueRun).toContain('run_refinement');
  });

  test('a run that finished everything is completed, and an unreported effective limit is omitted', async () => {
    const result = await runMemoryRefinement(withService({ runRefinement: async () => run({}) }), {});
    expect(result.status).toBe('completed');
    expect(result.partial).toBeUndefined();
    expect(result.result).not.toHaveProperty('effectiveLimit');
  });

  test('an effective limit the service reports is passed through', async () => {
    const result = await runMemoryRefinement(withService({ runRefinement: async () => run({ effectiveLimit: 7 }) }), {});
    expect((result.result as Record<string, unknown>).effectiveLimit).toBe(7);
  });
});

describe('memory refinement parameters', () => {
  test('rejected source URLs from the web are shortened and capped like the assessed ones', () => {
    const urls = Array.from({ length: 9 }, (_, index) => `https://example.test/${index}/${'x'.repeat(400)}`);
    const summary = memoryRefinementSummary(withService(listing([task('t1', 'detected', { rejectedSourceUrls: urls })])), { includeParameters: true }) as { tasks: { rejectedSourceUrls: string[] }[] };
    const shown = summary.tasks[0]?.rejectedSourceUrls ?? [];
    expect(shown).toHaveLength(5);
    expect(shown.every(url => url.length <= 130)).toBe(true);
  });
});
