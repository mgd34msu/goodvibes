/**
 * Plans drafted before a contract started:
 * the runner numbers the drafted units, the planner is shown the draft, the
 * host joins the drafted text to the planner's plan, a code check holds the
 * graph to it, and `startFromPlan` runs the joined plan to a pass.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { DecompositionRunner, DecompositionRunnerRequest } from '../../platform/src/platform/core/plan-decomposition.js';
import { buildContractPlannerRequest } from '../../platform/src/platform/contract/planner.js';
import { checkDraftFidelity, numberDraft, type DraftedPlan } from '../../platform/src/platform/contract/index.js';
import { joinDraft } from '../../platform/src/platform/contract/draft-plan.js';
import { asPlan, draftUnit, plannerOutput, shapeOf, type DraftPlan } from './plan-support.js';
import { ASK, makeHarness, twoUnitPlan, waitFor, type Harness } from './runner-support.js';

let harness: Harness | undefined;
afterEach(async () => {
  const finished = harness;
  harness = undefined;
  await finished?.dispose();
});

/** The draft twoUnitPlan() keeps: the parser, then the wiring that depends on it. */
function draft(): DraftedPlan {
  return {
    goal: 'A convert command backed by a CSV parser',
    units: [
      { id: 'u1', title: 'CSV parser', brief: 'Write src/csv.ts.', dependsOn: [] },
      { id: 'u2', title: 'Wire convert', brief: 'Edit src/convert.ts.', dependsOn: ['u1'] },
    ],
  };
}

describe('numbering a draft', () => {
  test('units become u1, u2... in draft order, with their dependencies renamed', () => {
    const numbered = numberDraft({
      goal: 'g',
      units: [
        { id: 'item-a', title: 'A', brief: 'a', dependsOn: [], files: ['a.ts'], attempts: 2 },
        { id: 'item-b', title: 'B', brief: 'b', dependsOn: ['item-a'] },
      ],
    });
    expect(numbered.units).toEqual([
      { id: 'u1', title: 'A', brief: 'a', dependsOn: [], files: ['a.ts'], attempts: 2 },
      { id: 'u2', title: 'B', brief: 'b', dependsOn: ['u1'] },
    ]);
  });

  test('an unknown dependency, a repeated id and an empty draft are refused', () => {
    expect(() => numberDraft({ goal: 'g', units: [{ id: 'a', title: 'A', brief: 'a', dependsOn: ['zz'] }] })).toThrow('depends on zz');
    expect(() => numberDraft({ goal: 'g', units: [{ id: 'a', title: 'A', brief: 'a', dependsOn: [] }, { id: 'a', title: 'B', brief: 'b', dependsOn: [] }] })).toThrow('twice');
    expect(() => numberDraft({ goal: 'g', units: [] })).toThrow('at least one unit');
  });
});

describe('the draft fidelity check', () => {
  test('a plan that keeps every drafted unit and dependency, adding only the integration unit, passes', () => {
    expect(checkDraftFidelity(asPlan(twoUnitPlan()), draft())).toEqual([]);
    const onlyParser: DraftedPlan = { goal: 'g', units: [draft().units[0]!] };
    expect(checkDraftFidelity(asPlan(twoUnitPlan()), onlyParser)).toEqual([]);
  });

  test('the drafted title, brief, files and attempts replace what the planner wrote; a missing unit is named', () => {
    const plan = twoUnitPlan();
    plan.groups[0]!.units[0]!.brief = 'Write a parser somewhere.\n';
    plan.groups[0]!.units[0]!.title = 'Parser';
    plan.groups[0]!.units[0]!.files = ['src/elsewhere.ts'];
    const drafted: DraftedPlan = { goal: 'g', units: [{ ...draft().units[0]!, files: ['src/csv.ts'], attempts: 3 }] };
    const joined = joinDraft(asPlan(plan), drafted);
    expect(joined.groups[0]!.units[0]).toMatchObject({ title: 'CSV parser', brief: 'Write src/csv.ts.', files: ['src/csv.ts'], attempts: 3 });
    expect(checkDraftFidelity(joined, drafted)).toEqual([]);
    const missing = checkDraftFidelity(joined, { ...draft(), units: [...draft().units, { id: 'u3', title: 'Docs', brief: 'Document it.', dependsOn: [] }] });
    expect(missing.map((problem) => [problem.code, problem.targetId])).toEqual([['draft-changed', 'u3']]);
  });

  test('an added unit that is not the integration unit is refused', () => {
    const plan = twoUnitPlan();
    plan.groups[0]!.units.push(draftUnit('u9', { title: 'Extra' }));
    expect(checkDraftFidelity(asPlan(plan), draft()).map((problem) => problem.targetId)).toEqual(['u9']);
  });

  test('a drafted dependency must survive, inside a group or through the group order', () => {
    const sameGroupKept: DraftPlan = {
      goal: 'g',
      criteria: [{ id: 'c1', text: 't', quote: 'q' }],
      groups: [{
        id: 'g1', title: 'All', goal: 'All', kind: 'work', dependsOn: [], criteria: [],
        units: [
          draftUnit('u1', { title: 'CSV parser', brief: 'Write src/csv.ts.' }),
          draftUnit('u2', { title: 'Wire convert', brief: 'Edit src/convert.ts.', dependsOn: ['u1'] }),
        ],
      }],
    };
    expect(checkDraftFidelity(asPlan(sameGroupKept), draft())).toEqual([]);
    const sameGroupJoined = structuredClone(sameGroupKept);
    sameGroupJoined.groups[0]!.units[1]!.dependsOn = [];
    expect(joinDraft(asPlan(sameGroupJoined), draft()).groups[0]!.units[1]!.dependsOn).toEqual(['u1']);
    const apart: DraftPlan = structuredClone(sameGroupKept);
    const second = apart.groups[0]!.units.pop()!;
    second.dependsOn = [];
    apart.groups.push({ id: 'g2', title: 'Wire', goal: 'Wire', kind: 'work', dependsOn: [], criteria: [], units: [second] });
    expect(checkDraftFidelity(joinDraft(asPlan(apart), draft()), draft()).map((problem) => problem.targetId)).toEqual(['u2']);
  });
});

describe('the planner request', () => {
  test('shows the drafted plan and the rules for keeping it', () => {
    const request = buildContractPlannerRequest({
      ask: 'Launch the approved plan.',
      shape: shapeOf(),
      config: { defaultAttempts: 1, maxUnits: 64 },
      draftPlan: draft(),
      repositoryMap: 'README.md',
    });
    expect(request).toContain('## The plan already drafted');
    expect(request).toContain('"brief": "Write src/csv.ts."');
    expect(request).toContain('Add no units except the integration unit');
  });
});

describe('startFromPlan', () => {
  test('runs the joined plan to a pass; a planner that reworded a drafted brief is not sent back', async () => {
    const prompts: string[] = [];
    const changed = twoUnitPlan();
    changed.groups[0]!.units[0]!.brief = 'Write a parser.';
    const planner: DecompositionRunner = {
      run: async (request: DecompositionRunnerRequest) => {
        prompts.push(request.userPrompt);
        const plan = changed;
        return { status: 'completed', output: plannerOutput(plan), elapsedMs: 1, agentId: `planner-${prompts.length}` };
      },
    };
    const h = makeHarness({
      planner,
      scripts: {
        u1: () => [{ files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' }, text: 'Parser written.' }],
        u2: () => [{ files: { 'src/convert.ts': 'import { parse } from "./csv";\n' }, text: 'Convert wired.' }],
      },
    });
    harness = h;
    const { contract, owner } = (await h.runner.startFromPlan({
      ask: ASK,
      sessionId: 'session-1',
      origin: 'proposal',
      projectRoot: h.root,
      draft: {
        goal: 'A convert command backed by a CSV parser',
        units: [
          { id: 'item-parser', title: 'CSV parser', brief: 'Write src/csv.ts.', dependsOn: [] },
          { id: 'item-wire', title: 'Wire convert', brief: 'Edit src/convert.ts.', dependsOn: ['item-parser'] },
        ],
      },
    }));
    expect(owner.contractRole).toBe('owner');
    expect(contract.draftPlan?.units.map((unit) => [unit.id, unit.dependsOn])).toEqual([['u1', []], ['u2', ['u1']]]);
    await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(h.store.get(contract.id)?.status ?? ''), 'the contract to settle', 15_000);
    expect(h.store.get(contract.id)?.escalations).toEqual([]);
    expect(h.store.get(contract.id)?.status).toBe('passed');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## The plan already drafted');
    const done = h.store.get(contract.id)!;
    expect(done.origin).toBe('proposal');
    expect(done.decisions[0]!.reason).toContain('2 drafted units');
    expect(done.units.map((unit) => unit.brief)).toEqual(['Write src/csv.ts.', 'Edit src/convert.ts.']);
  }, 20_000);
});
