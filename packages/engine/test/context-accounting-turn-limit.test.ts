/** context_accounting reports turns used and warns the model at 80% of its turn limit. */
import { expect, test } from 'bun:test';
import {
  ContextAccountingHolder,
  createContextAccountingTool,
  type ContextAccountingSource,
} from '../platform/src/platform/tools/context-accounting/index.js';
import { formatTurnLimitWarning } from '../platform/src/platform/agents/turn-budget.js';

function source(used: number, limit: number | null): ContextAccountingSource {
  return {
    scope: 'worker',
    getTurnInjections: () => [],
    getTokenState: () => ({ measured: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, lastInputTokens: 1, contextWindow: 100 }),
    getCompactionState: () => ({ isCompacting: false }),
    getTurnState: () => ({ used, limit }),
  };
}

async function run(used: number, limit: number | null) {
  const holder = new ContextAccountingHolder();
  holder.setSource(source(used, limit));
  return JSON.parse((await createContextAccountingTool(holder).execute({})).output!) as { turns: { used: number; remaining?: number; warning?: string } };
}

test('below 80% the turns are reported without a warning', async () => {
  const out = await run(7, 10);
  expect(out.turns).toEqual({ used: 7, limit: 10, remaining: 3 } as never);
});

test('at 80% the result tells the model to finish', async () => {
  const out = await run(8, 10);
  // The runner's own sentence for turn 8 of 10, so the model is never told two different counts.
  expect(out.turns.warning).toBe(formatTurnLimitWarning(8, 10));
  expect((await run(100, null)).turns.warning).toBeUndefined();
});

test('concurrent workers each see their own source through one shared holder, with their run state', async () => {
  const holder = new ContextAccountingHolder();
  const tool = createContextAccountingTool(holder);
  const worker = (name: string, used: number): ContextAccountingSource => ({
    ...source(used, 10), scope: name, getRunState: () => ({ mode: 'working', toolCalls: used * 2, activeChildren: 1 }),
  });
  const ask = (name: string, used: number) => holder.runWithSource(worker(name, used), async () => {
    await Promise.resolve();
    return JSON.parse((await tool.execute({})).output!) as { scope: string; turns: { used: number }; run: { toolCalls: number } };
  });
  const [a, b] = await Promise.all([ask('worker-a', 2), ask('worker-b', 9)]);
  expect([a.scope, a.turns.used, a.run.toolCalls]).toEqual(['worker-a', 2, 4]);
  expect([b.scope, b.turns.used, b.run.toolCalls]).toEqual(['worker-b', 9, 18]);
  const unbound = JSON.parse((await tool.execute({})).output!) as { available: boolean };
  expect(unbound.available).toBe(false);
});
