/**
 * A planner run that fails to finish is an outage to wait out, not a plan the planner returned twice:
 * the repeat guard watches only plans, and the decision text that records an accepted plan reads correctly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { planContract, type ContractPlannerDeps } from '../../platform/src/platform/contract/planner.js';
import type { Contract } from '../../platform/src/platform/contract/index.js';
import { makeContract } from './fixtures.js';
import { makeHarness, startContract, waitFor } from './runner-support.js';
import { ASK, configReader, planningPort, plannerOutput, PLANNER_ROUTE, scriptedRunner, shapeOf, validPlan, type AnswerContext } from './plan-support.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function install(override?: (context: AnswerContext) => unknown): void {
  installJudgmentPort(planningPort(override).port);
}

function shaped(): Contract {
  return makeContract({ ask: ASK, status: 'shaping', goal: '', criteria: [], groups: [], units: [], shape: shapeOf() });
}

function harness(results: Parameters<typeof scriptedRunner>[0], contractSettings: Record<string, unknown> = {}) {
  const scripted = scriptedRunner(results);
  const waits: number[] = [];
  const deps: ContractPlannerDeps = {
    decompositionRunner: scripted.runner,
    routeSelector: async () => PLANNER_ROUTE,
    configManager: configReader(contractSettings, { 'planner.maxTurns': 9 }),
    emit: () => {},
    repositoryMap: async () => 'Repository map: src/ (3 files)',
    now: () => 5_000,
    wait: async (ms) => { waits.push(ms); },
  };
  return { deps, requests: scripted.requests, waits };
}

describe('planning with the default repair limit', () => {
  test('two identical planner failures are retried with a back-off, and the next plan is accepted', async () => {
    install();
    const contract = shaped();
    const { deps, requests, waits } = harness([{ status: 'failed', detail: 'the planner agent failed: provider overloaded' }, { status: 'failed', detail: 'the planner agent failed: provider overloaded' }, plannerOutput(validPlan())]);
    const outcome = await planContract(contract, deps);
    expect(outcome.kind).toBe('accepted');
    expect(requests).toHaveLength(3);
    expect(waits).toEqual([250, 500]);
  });

  test('the same unresolved plan returned twice still ends the contract', async () => {
    install(({ name }) => (name === 'unquoted_2' ? noulAnswer(0.9) : undefined));
    const contract = shaped();
    const { deps, requests } = harness([plannerOutput(validPlan())]);
    const outcome = await planContract(contract, deps);
    expect(outcome.kind).toBe('failed');
    expect(requests).toHaveLength(2);
    expect(contract.failureKind).toBe('planning');
  });
});

describe('the decision that records an accepted plan', () => {
  test('counts two excluded criteria as "criteria"', async () => {
    install(({ name, state }) => (name === 'topology_only' && /convert|JSON formatter/.test(String(state['criterion'])) ? noulAnswer(0.95) : undefined));
    const contract = shaped();
    await planContract(contract, harness([plannerOutput(validPlan())]).deps);
    const excluded = contract.criteria.filter((criterion) => criterion.disposition === 'excluded').length;
    expect(excluded).toBe(2);
    expect(contract.decisions.at(-1)!.reason).toContain('2 criteria excluded: requires an agent arrangement');
    expect(contract.decisions.at(-1)!.reason).not.toContain('criteriona');
  });
});

describe('native planning', () => {
  test('identical planner failures are retried; only a plan returned twice is refused as a repeat', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-planner-outage-'));
    let calls = 0;
    const source = { sourceId: 'outage-work', sourceRevision: '1', inputRevision: 'input-1', criteriaId: 'outage-criteria', criteriaRevision: '1',
      goal: 'Deliver the exact parser', criteria: ['Preserve every documented parser input'] };
    const h = makeHarness({ root, recordNative: true, contract: { isolation: 'shared' }, scripts: {},
      wait: async () => {},
      planner: { async run(request) {
        const index = calls++;
        const agentId = `outage-planner-${index}`;
        await request.onStarted?.(agentId);
        return index < 2
          ? { status: 'failed', detail: 'the planner agent failed: provider overloaded', output: '', elapsedMs: 0, agentId }
          : { status: 'completed', output: 'Unreadable proposal', elapsedMs: 0, agentId };
      } },
    });
    try {
      const { contract } = await startContract(h, { nativeSource: source });
      await waitFor(() => h.store.get(contract.id)?.status === 'failed', 'the repeated plan to be refused');
      await h.runner.join(contract.id);
      // Two failures, then the same unreadable plan twice: the refusal comes from the plan, after four runs.
      expect(calls).toBe(4);
      expect(h.store.get(contract.id)?.error).toContain('repeated a plan already returned for revision');
    } finally {
      h.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
