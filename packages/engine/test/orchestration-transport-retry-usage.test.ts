/** A phase retried after a transport failure still accounts for the tokens the failed attempt used. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrationEngine } from '../platform/src/platform/orchestration/engine.js';
import { createOrchestrationHarness, engineerReportOutput } from './_helpers/orchestration-harness.js';
import { useFailureReadings } from './_helpers/failure-readings.js';

useFailureReadings([['socket hang up', { category: 'network', transientNetwork: true }]]);

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'orch-retry-usage-')); });
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

/** Yield macrotasks until the condition holds; the retry waits on a timer, so microtask flushing is not enough. */
async function until(condition: () => boolean): Promise<void> {
  for (let turns = 0; !condition(); turns += 1) {
    if (turns > 10_000) throw new Error('condition never became true');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe('transport retry', () => {
  test('the failed attempt\'s tokens are added to the retry\'s', async () => {
    const h = createOrchestrationHarness();
    const configManager = {
      get: (): unknown => undefined,
      getCategory: (category: string): unknown => (category === 'contract'
        ? { maxFixRounds: 5, autoCommit: true, transportRetryLimit: 1, transportRetryDelayMs: 0, gates: [] }
        : undefined),
    } as unknown as Parameters<typeof createOrchestrationEngine>[0]['configManager'];
    const engine = createOrchestrationEngine({
      agentManager: h.agentManager, configManager, runtimeBus: h.bus, projectRoot, persist: false,
      skipClaimVerification: true, createWorktree: () => h.worktree,
    });
    const ws = engine.createWorkstream({
      title: 'goal',
      phases: [{ role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
      items: [{ id: 'a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await until(() => h.spawnedRecords.length === 1);
    h.agentStore.get('agent-1')!.usage = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 };
    h.failAgent('agent-1', 'socket hang up');
    await until(() => h.spawnedRecords.length === 2);
    h.completeAgent('agent-2', engineerReportOutput({}), { inputTokens: 7, outputTokens: 0 });
    await until(() => ws.items[0]!.state === 'passed');

    expect(ws.items[0]!.usage.inputTokens).toBe(107);
    engine.dispose(); await engine.join();
  });
});
