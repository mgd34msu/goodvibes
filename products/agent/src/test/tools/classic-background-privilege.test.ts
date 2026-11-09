import { afterEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withBackgroundPrivilegeCheck } from '../../tools/agent-harness-background-privilege.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: JudgmentPort | undefined, installed = false;
afterEach(async () => { if (installed) installJudgmentPort(previous); installed = false; await cleanupResearchScreeningFixtures(); });
function install(port: JudgmentPort) { previous = installJudgmentPort(port); installed = true; }

test('Classic background privilege ambiguity stays unknown and blocked, while native literal restrictions survive', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const observed: Array<boolean | null> = [];
    for (const [command, expected] of [['sudo true', true], ['echo sudo', null], ['sh -c "sudo true"', null], ['echo hello', false]] as const) {
      const result = await withBackgroundPrivilegeCheck(command, {}, async (privileged, current) => {
        current(); observed.push(privileged); return privileged === false ? 'continue-to-owner-admission' : 'blocked';
      });
      expect(observed.at(-1)).toBe(expected);
      expect(result).toBe(expected === false ? 'continue-to-owner-admission' : 'blocked');
    }
    expect(fake.requests).toHaveLength(0);
  });
});

test('Preferred privilege outage retains the restriction and consumes exactly once with native source ownership', async () => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const owner = researchScreeningFixture(); let consumed = 0;
    const result = await withBackgroundPrivilegeCheck('echo sudo', { sourceOwner: owner.owner }, async (privileged, current) => {
      current(); consumed++; expect(privileged).toBeNull(); return 'blocked-with-unassessed-privilege';
    });
    expect(result).toBe('blocked-with-unassessed-privilege'); expect(consumed).toBe(1);
    expect(decisionModelPolicyState().operation).toBe('classic'); expect(fake.requests.length).toBeGreaterThan(0);
  });
});

test('Preferred never repeats a consumer effect that reports unavailable after an actual semantic no', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); install(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const owner = researchScreeningFixture(); let consumed = 0;
    await expect(withBackgroundPrivilegeCheck('echo sudo', { sourceOwner: owner.owner }, async (privileged, current) => {
      current(); consumed++; expect(privileged).toBe(false);
      throw new JudgmentError('unavailable', 'Failure inside consumer after entering effect');
    })).rejects.toThrow('Failure inside consumer');
    expect(consumed).toBe(1); expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic cancellation and native owner retirement block the consumer', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const controller = new AbortController(); controller.abort(); let consumed = 0;
    const consume = async () => { consumed++; };
    await expect(withBackgroundPrivilegeCheck('echo sudo', { signal: controller.signal }, consume)).rejects.toThrow();
    await expect(withBackgroundPrivilegeCheck('echo hello', { assertCurrent: () => { throw new Error('Retired native owner'); } }, consume)).rejects.toThrow();
    expect(consumed).toBe(0); expect(fake.requests).toHaveLength(0);
  });
});
