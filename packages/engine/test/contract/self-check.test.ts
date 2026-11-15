/** What a unit's agent can read about its own criteria without ending its turn. */
import { describe, expect, test } from 'bun:test';
import { describeUnitSelfCheck } from '../../platform/src/platform/contract/index.js';
import { createContractSelfCheckTool } from '../../platform/src/platform/tools/contract-self-check/index.js';
import { withCallingAgent } from '../../platform/src/platform/agents/calling-agent.js';
import { makeContract, makeCriterion, makeUnit } from './fixtures.js';

const reading = (overrides: Record<string, unknown>) => ({ checkId: 'u1.k1', at: 10, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', decisionId: undefined, ...overrides }) as never;

describe('a unit agent reading its own criteria', () => {
  test('sees each criterion as the last check read it, with the reason it gave, and which check that was', () => {
    const unit = makeUnit({
      agentIds: ['agent-7'], activeAgentId: 'agent-7', status: 'nudged',
      criteria: [
        makeCriterion({ id: 'u1.c1', text: 'Quoted fields may hold commas', status: 'unmet', readings: [reading({ rationale: 'only part of it is shown; the rest is missing.', severity: 'major' })] }),
        makeCriterion({ id: 'u1.c2', text: 'Empty fields parse as empty strings', status: 'met', readings: [reading({ verdict: 'met', rationale: 'stale reason', probabilityUnmet: 0.05 })] }),
        makeCriterion({ id: 'u1.c3', text: 'Not judged here', disposition: 'excluded' }),
      ],
      checks: [{ id: 'u1.k1', at: 10, trigger: 'completion', result: 'nudge', problems: ['unmet'], goal: { probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act' }, quality: {}, decisionIds: [] } as never],
    });
    const result = describeUnitSelfCheck([makeContract({ id: 'ctr-1', units: [unit] })], 'agent-7');
    if (!result.found) throw new Error('the unit should be found');
    const { selfCheck } = result;
    expect(selfCheck).toMatchObject({ contractId: 'ctr-1', unitId: 'u1', unitStatus: 'nudged', asOfCheck: { id: 'u1.k1', result: 'nudge' }, problems: ['unmet'] });
    expect(selfCheck.criteria.map((criterion) => criterion.id)).toEqual(['u1.c1', 'u1.c2']);
    expect(selfCheck.criteria[0]).toMatchObject({ verdict: 'unmet', why: 'only part of it is shown; the rest is missing.', severity: 'major' });
    // A met criterion carries no reason or severity: there is nothing left to show.
    expect(selfCheck.criteria[1]!.why).toBeUndefined();
    expect(selfCheck.criteria[1]!.severity).toBeUndefined();
    expect(selfCheck.note).toContain('u1.k1');
  });

  test('before any check, says nothing has been read yet', () => {
    const unit = makeUnit({ agentIds: ['agent-7'], activeAgentId: 'agent-7' });
    const result = describeUnitSelfCheck([makeContract({ units: [unit] })], 'agent-7');
    if (!result.found) throw new Error('the unit should be found');
    expect(result.selfCheck.asOfCheck).toBeNull();
    expect(result.selfCheck.criteria[0]).toMatchObject({ status: 'unread', verdict: null });
    expect(result.selfCheck.note).toContain('No check has read this unit yet');
  });

  test('an agent that works on no unit is told so rather than shown another unit', () => {
    const unit = makeUnit({ agentIds: ['agent-7'], activeAgentId: 'agent-7' });
    const result = describeUnitSelfCheck([makeContract({ units: [unit] })], 'agent-other');
    expect(result).toMatchObject({ found: false });
    if (!result.found) expect(result.reason).toContain('agent-other');
  });
});

describe('the contract_self_check tool', () => {
  const unit = makeUnit({ agentIds: ['agent-7'], activeAgentId: 'agent-7' });
  const tool = createContractSelfCheckTool({ list: () => [makeContract({ id: 'ctr-1', units: [unit] })] });

  test('answers for the agent the host says is calling, and for no other', async () => {
    const own = await withCallingAgent('agent-7', () => tool.execute({}));
    expect(own.success).toBe(true);
    expect(JSON.parse(own.output ?? '{}')).toMatchObject({ contractId: 'ctr-1', unitId: 'u1' });
    const other = await withCallingAgent('agent-other', () => tool.execute({}));
    expect(other.success).toBe(false);
    expect(other.error).toContain('agent-other');
  });

  test('says so when no agent is calling instead of guessing a unit', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('no agent is calling');
  });
});
