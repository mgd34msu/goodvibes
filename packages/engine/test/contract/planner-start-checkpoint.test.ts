import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { createAgentManagerDecompositionRunner } from '../../platform/src/platform/agents/planner-decomposition-runner.js';
import { contractPath, type Contract, type NativeContractSource } from '../../platform/src/platform/contract/index.js';
import { makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

const source: NativeContractSource = {
  sourceId: 'checkpoint-work', sourceRevision: '1', inputRevision: 'input-1',
  criteriaId: 'checkpoint-criteria', criteriaRevision: '1',
  goal: 'Deliver the exact parser', criteria: ['Preserve every documented parser input'],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function checkpoint(root: string, id: string): Contract {
  return (JSON.parse(readFileSync(contractPath(root, id), 'utf8')) as { contract: Contract }).contract;
}

for (const native of [false, true]) test(`${native ? 'native' : 'ordinary'} active repair planner is checkpointed before completion and cancellation joins cleanup`, async () => {
  // Shared placement over a plain directory exercises the real runner/store
  // without creating a Git repository, input generation, worktree or commit.
  const root = mkdtempSync(join(tmpdir(), 'planner-start-checkpoint-'));
  const firstOutput = deferred(), cleanup = deferred(), cleanupStarted = deferred();
  const plannerIds: string[] = [];
  let cleaned = false;
  let harness: Harness | undefined;
  try {
    const h: Harness = makeHarness({ root, recordNative: native, contract: { isolation: 'shared' }, scripts: {},
      planner: { run: request => createAgentManagerDecompositionRunner({ agentManager: h.manager, pollIntervalMs: 1 }).run(request) },
      executeAgent: async (record, context) => {
        plannerIds.push(record.id);
        record.status = 'running';
        if (plannerIds.length === 1) {
          await firstOutput.promise;
          record.fullOutput = 'Initial planner result is not a readable plan';
          record.status = 'completed';
          record.completedAt = Date.now();
          return;
        }
        const signal = context.manager.getCancellationSignal(record.id)!;
        try {
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
        } finally {
          cleanupStarted.resolve();
          await cleanup.promise;
          cleaned = true;
        }
      },
    });
    harness = h;
    const { contract } = await startContract(h, native ? { nativeSource: source } : {});
    await waitFor(() => h.store.get(contract.id)?.plannerAgentIds.length === 1, 'first planner checkpoint');
    const first = checkpoint(root, contract.id);
    expect(first.status).toBe('planning');
    expect(first.plannerAgentIds).toEqual([plannerIds[0]!]);
    expect(h.manager.getStatus(plannerIds[0]!)?.status).toBe('running');
    expect(first.units).toEqual([]);

    firstOutput.resolve();
    await waitFor(() => h.store.get(contract.id)?.plannerAgentIds.length === 2, 'replacement planner checkpoint');
    const active = checkpoint(root, contract.id);
    expect(active.status).toBe('planning');
    expect(active.plannerAgentIds).toEqual(plannerIds);
    expect(new Set(active.plannerAgentIds).size).toBe(2);
    expect(h.manager.getStatus(plannerIds[0]!)?.status).toBe('completed');
    expect(h.manager.getStatus(plannerIds[1]!)?.status).toBe('running');
    expect(active.units).toEqual([]);
    if (native) expect(active.nativeDecisions!.spent.plan).toBe(2);

    expect(h.runner.cancel(contract.id, 'test cancellation during repair planning')).toBe(true);
    await cleanupStarted.promise;
    let joined = false;
    const joining = h.runner.join(contract.id).then(() => { joined = true; });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    expect(joined).toBe(false);
    expect(h.manager.getStatus(plannerIds[1]!)?.status).toBe('cancelled');
    cleanup.resolve();
    await joining;
    const ended = checkpoint(root, contract.id);
    expect(cleaned).toBe(true);
    expect(ended.status).toBe('cancelled');
    expect(ended.plannerAgentIds).toEqual(plannerIds);
    expect(ended.units).toEqual([]);
  } finally {
    firstOutput.resolve(); cleanup.resolve();
    if (harness) {
      for (const item of harness.runner.list({ includeTerminal: true })) {
        harness.runner.cancel(item.id, 'test cleanup');
        await harness.runner.join(item.id);
      }
      harness.dispose();
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('unlimited native planning stops an A/B/A rejected-plan cycle without imposing an attempt count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-planner-cycle-'));
  const outputs = ['Unreadable proposal A', 'Unreadable proposal B', 'Unreadable proposal A'];
  let calls = 0;
  let harness: Harness | undefined;
  try {
    const h = harness = makeHarness({ root, recordNative: true, contract: { isolation: 'shared' }, scripts: {},
      planner: { async run(request) {
        const index = calls++;
        if (index >= outputs.length) throw new Error('An unchanged rejected plan must not launch another repair');
        const agentId = `native-planner-${index}`;
        await request.onStarted?.(agentId);
        return { status: 'completed', output: outputs[index]!, elapsedMs: 0, agentId };
      } },
    });
    const { contract } = await startContract(h, { nativeSource: source });
    await waitFor(() => h.store.get(contract.id)?.status === 'failed', 'native repeated-plan refusal');
    await h.runner.join(contract.id);
    const ended = checkpoint(root, contract.id);
    expect(calls).toBe(3);
    expect(ended.nativeDecisions!.spent.plan).toBe(3);
    expect(ended.error).toContain('repeated a plan already returned for revision');
    expect(ended.nativeDecisions!.history.filter(item => item.stage === 'plan').map(item => item.decision.outcome)).toEqual(['revise', 'revise']);
    expect(ended.plannerAgentIds).toEqual(['native-planner-0', 'native-planner-1', 'native-planner-2']);
    expect(ended.nativeSource).toEqual(source);
    expect(ended.criteria.map(criterion => criterion.text)).toEqual([...source.criteria]);
    expect(ended.escalations).toEqual([]);
    expect(ended.units).toEqual([]);
  } finally {
    if (harness) {
      for (const item of harness.runner.list({ includeTerminal: true })) {
        harness.runner.cancel(item.id, 'test cleanup');
        await harness.runner.join(item.id);
      }
      harness.dispose();
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('native revision of a valid plan cannot resample acceptance for the identical proposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-valid-plan-cycle-'));
  const plan = { ...oneUnitPlan(1), goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] };
  const output = plannerOutput(plan);
  let calls = 0, dispositions = 0;
  let harness: Harness | undefined;
  try {
    const h = harness = makeHarness({ root, recordNative: true, contract: { isolation: 'shared' }, scripts: {},
      planner: { async run(request) {
        const agentId = `native-valid-planner-${calls++}`;
        if (calls > 2) throw new Error('An identical revised proposal must not launch another planner');
        await request.onStarted?.(agentId);
        return { status: 'completed', output, elapsedMs: 0, agentId };
      } },
      port: context => {
        const actionId = (context.state['binding'] as { actionId?: string } | undefined)?.actionId;
        if (context.name !== 'disposition' || !actionId?.includes(':plan:')) return undefined;
        dispositions++;
        // If a second disposition is reached, act would execute the unchanged
        // proposal which the first decision explicitly sent back for revision.
        return choiceAnswer(context.question, dispositions === 1 ? 'revise_0' : 'act', 0.99);
      },
    });
    const { contract } = await startContract(h, { nativeSource: source });
    await waitFor(() => h.store.get(contract.id)?.status === 'failed', 'unchanged valid native proposal refusal');
    await h.runner.join(contract.id);
    const ended = checkpoint(root, contract.id);
    expect(calls).toBe(2);
    expect(dispositions).toBe(1);
    expect(ended.error).toContain('repeated a plan already returned for revision');
    expect(ended.nativeDecisions!.spent.plan).toBe(2);
    expect(ended.nativeDecisions!.history.filter(item => item.stage === 'plan').map(item => item.decision.outcome)).toEqual(['revise']);
    const checks = h.events.filter(event => event.type === 'CONTRACT_PLAN_CHECKED');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every(event => event.passed && event.problems.length === 0)).toBe(true);
    expect(ended.nativeSource).toEqual(source);
    expect(ended.criteria.map(criterion => criterion.text)).toEqual([...source.criteria]);
    expect(ended.escalations).toEqual([]);
    expect(ended.units).toEqual([]);
  } finally {
    if (harness) {
      for (const item of harness.runner.list({ includeTerminal: true })) {
        harness.runner.cancel(item.id, 'test cleanup');
        await harness.runner.join(item.id);
      }
      harness.dispose();
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
