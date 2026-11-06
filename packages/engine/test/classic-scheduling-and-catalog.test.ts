import { afterEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { readNaturalLanguageSchedule } from '../sdk/src/platform/automation/schedule-reading.js';
import { createHookApi } from '../sdk/src/platform/hooks/hook-api.js';
import { listHookPointContracts } from '../sdk/src/platform/hooks/contracts.js';
import { findPlaybooksBySymptom } from '../sdk/src/platform/runtime/ops/index.js';

let previous: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic unavailable decision chain'); });
  previous = installJudgmentPort(fake.port); installed = true; return fake.requests;
}
const clock = { now: Date.parse('2026-11-06T12:00:00Z'), timezone: 'America/Chicago' };
const under = <T>(policy: DecisionModelPolicy, operation: () => T) => withDecisionModelPolicy(() => policy, operation);

test.each(['Classic - Off', 'Preferred'] as const)('%s explicit schedules use validated representations and no fabricated confidence', async policy => {
  const requests = outage();
  await under(policy, async () => {
    const at = await readNaturalLanguageSchedule({ ...clock, phrase: 'at 2026-11-12T14:30:00Z' });
    expect(at).toMatchObject({ kind: 'ready', confidence: null, provenance: 'classic',
      schedule: { kind: 'at', at: Date.parse('2026-11-12T14:30:00Z') } });
    const attempted = requests.length;
    expect(attempted).toBe(policy === 'Classic - Off' ? 0 : 1);
    expect(await readNaturalLanguageSchedule({ ...clock, phrase: 'every 30m' }))
      .toMatchObject({ kind: 'ready', schedule: { kind: 'every', intervalMs: 1_800_000 } });
    expect(await readNaturalLanguageSchedule({ ...clock, phrase: 'in 2h' }))
      .toMatchObject({ kind: 'ready', schedule: { kind: 'at', at: clock.now + 7_200_000 } });
    expect(await readNaturalLanguageSchedule({ ...clock, phrase: 'cron: 0 9 * * 1-5', staggerMs: 0 }))
      .toMatchObject({ kind: 'ready', schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: clock.timezone } });
    expect(requests).toHaveLength(attempted);
  });
});

test.each([
  'Do not remind me at 2026-11-12T14:30:00Z.',
  'Example: "cron 0 9 * * 1-5"; do something else.',
  'every 30m except weekends', 'in 2h and every 30m', 'every weekday at nine',
])('Classic does not extract a schedule from %s', async phrase => {
  const requests = outage();
  const result = await under('Classic - Off', () => readNaturalLanguageSchedule({ ...clock, phrase }));
  expect(result).toMatchObject({ kind: 'unknown', reason: 'decision-model-disabled', confidence: null, provenance: 'classic' });
  expect(requests).toHaveLength(0);
});

test('Classic calendar validation and cancellation do not require a model', async () => {
  const requests = outage();
  await under('Classic - Off', async () => {
    expect(await readNaturalLanguageSchedule({ ...clock, phrase: '2026-02-30T14:30:00Z' })).toMatchObject({ kind: 'unknown', reason: 'invalid' });
    expect(await readNaturalLanguageSchedule({ ...clock, phrase: 'every 0m' })).toMatchObject({ kind: 'unknown', reason: 'invalid' });
    const controller = new AbortController(); controller.abort();
    await expect(readNaturalLanguageSchedule({ ...clock, phrase: 'every 30m' }, { signal: controller.signal })).rejects.toThrow();
    await expect(readNaturalLanguageSchedule({ ...clock, phrase: 'every 30m' }, { beforeAttempt() { throw new Error('Retired source'); } })).rejects.toThrow('Retired source');
  });
  expect(requests).toHaveLength(0);
});

function hooks() {
  return createHookApi({ listContracts: listHookPointContracts,
    dispatcher: { listHooks: () => [], listChains: () => [] },
    workbench: {} as Parameters<typeof createHookApi>[0]['workbench'],
  });
}

test.each(['Classic - Off', 'Preferred'] as const)('%s hook and playbook searches list local suggestions without execution', async policy => {
  const requests = outage();
  await under(policy, async () => {
    const contracts = await hooks().contracts('intercept tool');
    expect(contracts.some(contract => contract.pattern === 'Pre:tool:*')).toBe(true);
    expect(contracts.every(contract => contract.provenance === 'classic' && contract.scoreSource === 'literal-overlap')).toBe(true);
    const attempted = requests.length;
    expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
    const playbooks = await findPlaybooksBySymptom('stuck-turn');
    expect(playbooks.some(playbook => playbook.id === 'stuck-turn')).toBe(true);
    expect(playbooks.every(playbook => playbook.provenance === 'classic')).toBe(true);
    expect(await hooks().contracts('zzzz_no_literal_match_zzzz')).toEqual([]);
    expect(requests).toHaveLength(attempted);
  });
});

test('uncertain catalog readings do not become Classic suggestions', async () => {
  const fake = fakePort(() => noulAnswer(0.5)); previous = installJudgmentPort(fake.port); installed = true;
  await under('Preferred', async () => {
    await expect(hooks().contracts('intercept tool')).rejects.toBeInstanceOf(Error);
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});
