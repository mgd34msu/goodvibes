import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { AdaptivePlanner } from '../sdk/src/platform/core/adaptive-planner.js';
import { ExecutionPlanManager } from '../sdk/src/platform/core/execution-plan.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { prepareConversationForTurn } from '../sdk/src/platform/core/orchestrator-turn-helpers.js';
import { readPlanningGoal } from '../sdk/src/platform/agents/planning-goal.js';
import { readArchetypeFamilies } from '../sdk/src/platform/agents/archetype-family.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); });
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  return fake.requests;
}

test('Classic prepares a conversation and local plan without semantic intent or status calls', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const conversation = new ConversationManager();
    await prepareConversationForTurn(conversation, { getCurrentModel() { throw new Error('No image capability lookup expected'); } }, 'Edit the file and run its tests.', undefined);
    expect(conversation.getMessageSnapshot()).toHaveLength(1);
    const plans = new ExecutionPlanManager('/synthetic/classic-plans');
    const parsed = await plans.parseFromMarkdown('# Work\n## Implementation\n- [x] Exact edit — finished-ish\n- [ ] Run tests — PENDING');
    expect(parsed.items?.map(item => item.status)).toEqual(['complete', 'pending']);
    expect(parsed.parseIssues).toMatchObject([{ line: 3 }]);
    parsed.assertCurrent?.();
    const goal = await readPlanningGoal({ text: 'Make the explicit owner-requested change.' });
    expect(goal).toMatchObject({ conclusion: 'unassessed', provenance: 'classic' });
    goal.assertCurrent();
  });
  expect(requests).toHaveLength(0);
});

test('Classic automatic planning uses one worker while retaining explicit owner strategy choices', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const planner = new AdaptivePlanner();
    const input = { riskScore: 0.5, latencyBudgetMs: Infinity, isMultiStep: true, remoteAvailable: false, backgroundEligible: false };
    expect(await planner.select(input)).toMatchObject({ selected: 'single', reasonCode: 'CLASSIC_SINGLE', provenance: 'classic', candidates: [] });
    planner.setMode('cohort');
    const pinned = await planner.select(input);
    expect(pinned).toMatchObject({ selected: 'cohort', reasonCode: 'PINNED_MODE', provenance: 'classic' });
    expect(pinned.decisionId).toBeUndefined(); expect(pinned.outcome).toBeUndefined();
    const families = await readArchetypeFamilies([{ name: 'custom', description: 'Owner-defined worker', tools: ['read'], isCustom: true, origin: 'local-markdown' }]);
    expect(families.readings).toEqual([{ kind: 'unclassified', provenance: 'classic' }]);
    families.assertCurrent();
  });
  expect(requests).toHaveLength(0);
});

test('Preferred retains every explicit checkbox after status-interpretation outage', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const plans = new ExecutionPlanManager('/synthetic/preferred-plans');
    const parsed = await plans.parseFromMarkdown('# Work\n- [x] First edit — finished-ish\n- [ ] Second edit — not-started-ish');
    expect(parsed.items?.map(item => item.status)).toEqual(['complete', 'pending']);
    expect(parsed.parseIssues).toHaveLength(2);
    expect(requests).toHaveLength(1);
    parsed.assertCurrent?.();
  });
});
