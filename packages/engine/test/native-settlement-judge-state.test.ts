// Proves: The state the verifier of finished work expects its unit judge to have been sent is the state the real unit judge sends, so work the decision model passed settles as done.
// Red when: The verifier's expected unit-judge state stops equalling the state the real unit check sends the decision model (goal, judged criteria, output, evidence), so every settlement with a decision model fails its provenance check and finished work stays in progress in the ledger.
/**
 * The real unit check (the real judge and its request builder) runs against a decision model that records what it is
 * sent and answers every yes/no question no; the state it recorded is compared with the one the settlement verifier
 * builds independently for the same unit and evidence. The decision model is the only stand-in.
 */
import { expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes/judgment/testing';
import { CHECK_SITES, runUnitCheck } from '../platform/src/platform/contract/check.ts';
import { trimEvidence } from '../platform/src/platform/contract/evidence.ts';
import type { ContractUnit } from '../platform/src/platform/contract/types.ts';
import { emptyWorkItemUsage } from '../platform/src/platform/orchestration/types.ts';
import { unitJudgeState } from '../platform/src/platform/workflow/work-ledger/native-execution-verifier.ts';

test('the verifier\'s expectation of the unit judge\'s state equals the state the real unit check sends', async () => {
  const unit: ContractUnit = {
    id: 'native', groupId: 'native', title: 'Frozen native acceptance', goal: 'Write a watering note for the alpha garden', brief: 'Write a watering note for the alpha garden',
    role: 'research', dependsOn: [], files: [], attempts: 1,
    criteria: [
      { id: 'native.c0', text: 'The note names the beds that need water', quote: 'beds', origin: 'stated', serves: [], disposition: 'judged', status: 'unread', readings: [] },
      { id: 'native.c1', text: 'The note says how often to water', quote: 'often', origin: 'stated', serves: [], disposition: 'judged', status: 'unread', readings: [] },
    ],
    status: 'checking', agentIds: [], checks: [], nudges: [], fixRounds: 0, freshAgents: 0, transportRetries: 0, touchedPaths: [], usage: emptyWorkItemUsage(),
  };
  const evidence = trimEvidence({ output: 'Water beds 1 and 3 every second day.', changes: [{ path: 'notes/watering.md', diff: 'notes/watering.md\nWater beds 1 and 3 every second day.' }], commands: [] }, unit);
  const decisionModel = fakePort((_name, question) => question.type === 'noul' ? noulAnswer(0.02) : undefined);
  const outcome = await runUnitCheck({
    contract: { shape: undefined, nativeSource: undefined }, unit, trigger: 'completion', evidence,
    settings: { acceptanceStakes: 'high', evidenceNudgeLimit: 2, stallLimit: 3, maxNudgesPerUnit: 3 }, now: 1, checkPort: decisionModel.port,
  });
  expect(outcome.discarded).toBe(false);
  const sent = decisionModel.requests.find((request) => request.context?.site === CHECK_SITES.judge);
  expect(sent).toBeDefined();
  expect(unitJudgeState(unit, evidence)).toEqual(JSON.parse(JSON.stringify(sent!.state)));
});
