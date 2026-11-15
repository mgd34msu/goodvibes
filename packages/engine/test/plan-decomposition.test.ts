/**
 * Agent-driven goal decomposition service (core/plan-decomposition.ts).
 *
 * Exercises the whole honesty contract: a contract-valid agent output becomes
 * an 'agent'-provenance proposal with usage/cost/elapsed; malformed output
 * gets exactly ONE repair attempt and then the run is held (JudgmentHeldError)
 * with a reason carried on the 'fallback' outcome; timeout/kill report reason
 * 'cancelled'; a dependency cycle is rejected; config can force the heuristic
 * path. The LLM
 * transport is not touched, a stubbed DecompositionRunner supplies canned
 * agent output, mirroring how the platform's orchestrator-turn-loop tests script a
 * fake provider.
 */
import { describe, expect, test } from 'bun:test';
import { useCoreReadings } from './_helpers/core-readings.ts';
const readings = useCoreReadings({ strategy: 'cohort' });
import { AdaptivePlanner, type PlannerInputs } from '../platform/src/platform/core/adaptive-planner.js';
import {
  decomposeGoal,
  parseDecomposition,
  toRawDecomposition,
  type DecompositionRunner,
  type DecompositionRunResult,
  type DecompositionRunnerRequest,
  type DecompositionServiceConfig,
  type DecompositionOutcome,
  type DecomposeGoalRequest,
} from '../platform/src/platform/core/plan-decomposition.js';

const BOUNDS = { maxTurns: 6, tokenCeiling: 120_000, wallTimeoutMs: 60_000 };
const AGENT_CONFIG: DecompositionServiceConfig = { mode: 'agent', bounds: BOUNDS };

const DECOMPOSE_INPUTS: PlannerInputs = {
  riskScore: 0.1,
  latencyBudgetMs: Infinity,
  isMultiStep: true,
  remoteAvailable: false,
  backgroundEligible: false,
  taskDescription: 'goal',
};

const SINGLE_INPUTS: PlannerInputs = {
  riskScore: 0.95,
  latencyBudgetMs: 1_000,
  isMultiStep: false,
  remoteAvailable: false,
  backgroundEligible: false,
  taskDescription: 'goal',
};

const REQUEST: DecomposeGoalRequest = { goal: 'Build a feature', workingDir: '/repo' };

function completed(output: string, usage?: DecompositionRunResult['usage']): DecompositionRunResult {
  return { status: 'completed', output, elapsedMs: 1234, ...(usage ? { usage } : {}) };
}

function scriptedRunner(results: DecompositionRunResult[]): { runner: DecompositionRunner; calls: DecompositionRunnerRequest[] } {
  const calls: DecompositionRunnerRequest[] = [];
  let i = 0;
  return {
    calls,
    runner: {
      async run(req: DecompositionRunnerRequest): Promise<DecompositionRunResult> {
        calls.push(req);
        const r = results[Math.min(i, results.length - 1)]!;
        i += 1;
        return r;
      },
    },
  };
}

const VALID_JSON = JSON.stringify({
  phases: [{ title: 'Build' }, { title: 'Verify' }],
  items: [
    { title: 'Implement API', brief: 'write the endpoint', ordinal: 1, phase: 'Build' },
    { title: 'Test API', brief: 'cover the endpoint', ordinal: 2, phase: 'Verify', dependsOn: ['Implement API'] },
  ],
});

const USAGE = { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1000 };

describe('parseDecomposition: strict validation', () => {
  test('accepts a contract-valid object and orders items by ordinal', () => {
    const out = JSON.stringify({
      items: [
        { title: 'B', brief: 'b', ordinal: 2 },
        { title: 'A', brief: 'a', ordinal: 1 },
      ],
    });
    const parsed = parseDecomposition(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.raw!.workItems.map((w) => w.title)).toEqual(['A', 'B']);
  });

  test('extracts JSON from a ```json fence', () => {
    const parsed = parseDecomposition('Here you go:\n```json\n' + VALID_JSON + '\n```\nDone.');
    expect(parsed.ok).toBe(true);
    expect(parsed.raw!.workItems).toHaveLength(2);
  });

  test('rejects empty items', () => {
    const parsed = parseDecomposition(JSON.stringify({ items: [] }));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toContain('items');
  });

  test('rejects an empty brief', () => {
    const parsed = parseDecomposition(JSON.stringify({ items: [{ title: 'A', brief: '   ', ordinal: 1 }] }));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toContain('brief');
  });

  test('rejects a non-finite ordinal', () => {
    const parsed = parseDecomposition(JSON.stringify({ items: [{ title: 'A', brief: 'a', ordinal: 'x' }] }));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toContain('ordinal');
  });

  test('rejects text with no JSON object', () => {
    const parsed = parseDecomposition('I could not produce a plan.');
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toContain('JSON');
  });

  test('resolves dependsOn given as an ordinal', () => {
    const raw = toRawDecomposition({
      items: [
        { title: 'A', brief: 'a', ordinal: 1 },
        { title: 'B', brief: 'b', ordinal: 2, dependsOn: [1] },
      ],
    });
    const b = raw.workItems.find((w) => w.title === 'B')!;
    expect(b.dependsOn).toEqual(['A']);
  });
});

describe('decomposeGoal: agent path success', () => {
  test('valid agent output yields an agent-provenance proposal with usage/cost/elapsed', async () => {
    const { runner, calls } = scriptedRunner([completed(VALID_JSON, USAGE)]);
    const outcomes: DecompositionOutcome[] = [];
    const result = await decomposeGoal(REQUEST, new AdaptivePlanner(), DECOMPOSE_INPUTS, AGENT_CONFIG, runner, {
      estimateCostUsd: (u) => u.totalTokens * 0.00001,
      onOutcome: (o) => outcomes.push(o),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.attempt).toBe('initial');
    expect(result.issues).toHaveLength(0);
    expect(result.proposal.decomposedBy).toBe('agent');
    expect(result.proposal.workItems).toHaveLength(2);
    expect(result.proposal.agentUsage).toEqual(USAGE);
    expect(result.proposal.agentCostUsd).toBeCloseTo(0.01, 6);
    expect(result.proposal.elapsedMs).toBe(1234);
    expect(result.proposal.fallbackReason).toBeUndefined();
    expect(outcomes[0]).toMatchObject({ kind: 'agent', itemCount: 2, repaired: false });
  });

  test('a single-item agent output is accepted (no forced multi-item)', async () => {
    const one = JSON.stringify({ items: [{ title: 'Do it', brief: 'the whole thing', ordinal: 1 }] });
    const { runner } = scriptedRunner([completed(one, USAGE)]);
    const result = await decomposeGoal(REQUEST, new AdaptivePlanner(), DECOMPOSE_INPUTS, AGENT_CONFIG, runner);
    expect(result.proposal.decomposedBy).toBe('agent');
    expect(result.proposal.workItems).toHaveLength(1);
  });
});

describe('decomposeGoal: repair then accept', () => {
  test('malformed initial output, valid repair → agent proposal, repaired=true, two runner calls', async () => {
    const { runner, calls } = scriptedRunner([completed('no json here'), completed(VALID_JSON, USAGE)]);
    const outcomes: DecompositionOutcome[] = [];
    const result = await decomposeGoal(REQUEST, new AdaptivePlanner(), DECOMPOSE_INPUTS, AGENT_CONFIG, runner, {
      onOutcome: (o) => outcomes.push(o),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.attempt).toBe('repair');
    expect(calls[1]!.userPrompt).toContain('rejected');
    expect(result.proposal.decomposedBy).toBe('agent');
    expect(outcomes[0]).toMatchObject({ kind: 'agent', repaired: true });
  });
});

describe('decomposeGoal: a failed planning run is held, with the reason reported', () => {
  const HELD = 'operation remains unexecuted';

  async function held(runner: DecompositionRunner | null): Promise<DecompositionOutcome[]> {
    const outcomes: DecompositionOutcome[] = [];
    await expect(decomposeGoal(REQUEST, new AdaptivePlanner(), DECOMPOSE_INPUTS, AGENT_CONFIG, runner, {
      onOutcome: (o) => outcomes.push(o),
    })).rejects.toThrow(HELD);
    expect(outcomes).toHaveLength(1);
    return outcomes;
  }

  test('malformed after one repair → held with a malformed-output reason after exactly one repair', async () => {
    const { runner, calls } = scriptedRunner([completed('garbage'), completed('still garbage')]);
    const outcomes = await held(runner);
    expect(calls).toHaveLength(2); // exactly one repair attempt
    expect(outcomes[0]).toMatchObject({ kind: 'fallback', reason: expect.stringContaining('malformed agent output after repair'), elapsedMs: 2468 });
  });

  test('cancelled run (timeout/kill) → held with reason "cancelled (detail)", no repair', async () => {
    const { runner, calls } = scriptedRunner([
      { status: 'cancelled', output: '', elapsedMs: 60_000, detail: 'wall-timeout 60000ms', usage: USAGE },
    ]);
    const outcomes = await held(runner);
    expect(calls).toHaveLength(1); // no repair on cancellation
    expect(outcomes[0]).toMatchObject({ kind: 'fallback', reason: 'cancelled (wall-timeout 60000ms)', usage: USAGE, elapsedMs: 60_000 });
  });

  test('failed run (agent error) → held with reason "agent error: detail"', async () => {
    const { runner } = scriptedRunner([{ status: 'failed', output: '', elapsedMs: 5, detail: 'boom' }]);
    const outcomes = await held(runner);
    expect(outcomes[0]).toMatchObject({ kind: 'fallback', reason: 'agent error: boom', elapsedMs: 5 });
  });

  test('a runner that throws → held with reason "spawn error: message"', async () => {
    const runner: DecompositionRunner = {
      async run() { throw new Error('kaboom'); },
    };
    const outcomes = await held(runner);
    expect(outcomes[0]).toMatchObject({ kind: 'fallback', reason: 'spawn error: kaboom' });
  });

  test('dependency cycle is rejected → repair still cyclic → held with the issue kinds', async () => {
    const cyclic = JSON.stringify({
      items: [
        { title: 'A', brief: 'a', ordinal: 1, dependsOn: ['B'] },
        { title: 'B', brief: 'b', ordinal: 2, dependsOn: ['A'] },
      ],
    });
    const { runner, calls } = scriptedRunner([completed(cyclic), completed(cyclic)]);
    const outcomes = await held(runner);
    expect(calls).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ kind: 'fallback', reason: expect.stringContaining('invalid agent decomposition after repair') });
  });

  test('no runner available → held with the no-runtime reason', async () => {
    const outcomes = await held(null);
    expect(outcomes[0]).toEqual({ kind: 'fallback', reason: 'no planning agent runtime available' });
  });
});

describe('decomposeGoal: configured / gated heuristic (not a fallback)', () => {
  test('configured single-item mode still requires Jev to select a single task', async () => {
    readings.set({ strategy: 'single' });
    const { runner, calls } = scriptedRunner([completed(VALID_JSON, USAGE)]);
    const outcomes: DecompositionOutcome[] = [];
    const result = await decomposeGoal(REQUEST, new AdaptivePlanner(), DECOMPOSE_INPUTS, { mode: 'heuristic', bounds: BOUNDS }, runner, {
      onOutcome: (o) => outcomes.push(o),
    });
    expect(calls).toHaveLength(0); // the agent is never spawned
    expect(result.proposal.decomposedBy).toBe('heuristic');
    expect(result.proposal.fallbackReason).toBeUndefined();
    expect(outcomes[0]).toEqual({ kind: 'heuristic-configured' });
  });

  test('gate declines to decompose → single-item heuristic, no agent, no fallbackReason', async () => {
    const { runner, calls } = scriptedRunner([completed(VALID_JSON, USAGE)]);
    const outcomes: DecompositionOutcome[] = [];
    readings.set({ strategy: 'single' });
    const result = await decomposeGoal(REQUEST, new AdaptivePlanner(), SINGLE_INPUTS, AGENT_CONFIG, runner, {
      onOutcome: (o) => outcomes.push(o),
    });
    expect(calls).toHaveLength(0);
    expect(result.proposal.decomposedBy).toBe('heuristic');
    expect(result.proposal.fallbackReason).toBeUndefined();
    expect(outcomes[0]!.kind).toBe('gate-declined');
  });
});

describe('parseDecomposition: malformed dependency edges', () => {
  const withDependencies = (dependencies: unknown) => JSON.stringify({
    items: [{ title: 'A', brief: 'a', ordinal: 1 }, { title: 'B', brief: 'b', ordinal: 2 }],
    dependencies,
  });

  test('a null edge and an edge without "from" come back as errors naming the edge, never as a throw', () => {
    for (const bad of [[null], [{ to: 'a' }], [{ from: 'a', to: '' }], [{ from: {}, to: 'a' }]]) {
      const parsed = parseDecomposition(withDependencies(bad));
      expect(parsed.ok).toBe(false);
      expect(parsed.errors.join(' ')).toContain('dependencies[0]');
    }
  });

  test('a non-array "dependencies" value is rejected', () => {
    const parsed = parseDecomposition(withDependencies({ from: 'A', to: 'B' }));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(' ')).toContain('"dependencies" must be an array');
  });

  test('well-formed edges with titles or ordinals still parse', () => {
    const parsed = parseDecomposition(withDependencies([{ from: 'B', to: 'A' }, { from: 2, to: 1 }]));
    expect(parsed.ok).toBe(true);
  });

  test('decomposeGoal runs one repair for a malformed edge and accepts the repaired output', async () => {
    const { runner, calls } = scriptedRunner([completed(withDependencies([null])), completed(VALID_JSON, USAGE)]);
    const outcomes: DecompositionOutcome[] = [];
    const result = await decomposeGoal(REQUEST, new AdaptivePlanner(), DECOMPOSE_INPUTS, AGENT_CONFIG, runner, {
      onOutcome: (o) => outcomes.push(o),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.attempt).toBe('repair');
    expect(calls[1]!.userPrompt).toContain('dependencies[0]');
    expect(result.proposal.decomposedBy).toBe('agent');
    expect(outcomes).toHaveLength(1);
  });
});

describe('decomposeGoal: caller seams reach the runner', () => {
  test('signal, route and onStarted are forwarded to the planning agent', async () => {
    const { runner, calls } = scriptedRunner([completed(VALID_JSON, USAGE)]);
    const controller = new AbortController();
    const route = { model: 'm', provider: 'p' };
    const onStarted = () => {};
    controller.abort();
    await decomposeGoal({ ...REQUEST, signal: controller.signal, route, onStarted }, new AdaptivePlanner(), DECOMPOSE_INPUTS, AGENT_CONFIG, runner);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[0]!.route).toBe(route);
    expect(calls[0]!.onStarted).toBe(onStarted);
  });
});
