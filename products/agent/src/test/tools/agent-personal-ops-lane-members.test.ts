import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { createClassicProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { personalOpsLaneMembers } from '../../tools/agent-harness-personal-ops-readings.ts';
import { withUnassessed } from '../../tools/agent-harness-personal-ops-lanes.ts';
import type { PersonalOpsLane } from '../../tools/agent-harness-personal-ops-types.ts';
import { partitionInvokableMethods } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const describeMethod = (method: { id: string; description: string }) => ({ id: method.id, description: method.description, evidence: method });

describe('Classic lane membership', () => {
  // The schedule methods say "schedule" in their text, never "reminders".
  const methods = [
    { id: 'automation.schedules.create', description: 'Create a schedule.' },
    { id: 'automation.jobs.list', description: 'List automation jobs.' },
    { id: 'tasks.list', description: 'List tasks.' },
    { id: 'email.inbox.list', description: 'List the inbox.' },
    { id: 'calendar.events.list', description: 'List calendar events.' },
  ];

  test('the reminders lane holds the schedule methods although no method text says reminders', async () => {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const owner = createClassicProtectedSourceOwner({ ownerId: 'lane-members', revision: '1', signal: new AbortController().signal, assertCurrent() {} });
      try {
        const members = await personalOpsLaneMembers(methods, 'reminders', describeMethod, { sourceOwner: owner });
        expect(members.map((method) => method.id)).toEqual(['automation.schedules.create']);
        expect((await personalOpsLaneMembers(methods, 'inbox', describeMethod, { sourceOwner: owner })).map((method) => method.id)).toEqual(['email.inbox.list']);
        expect((await personalOpsLaneMembers(methods, 'tasks', describeMethod, { sourceOwner: owner })).map((method) => method.id)).toEqual(['tasks.list']);
      } finally { await owner.close(); }
    });
  });
});

describe('Classic connector lane membership', () => {
  test('connector entries are identified by server name, so Classic keeps every connector instead of emptying the lane', async () => {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const owner = createClassicProtectedSourceOwner({ ownerId: 'lane-connectors', revision: '1', signal: new AbortController().signal, assertCurrent() {} });
      try {
        const servers = [{ id: 'work-mail', description: 'mail tools' }, { id: 'team-cal', description: 'calendar tools' }];
        const members = await personalOpsLaneMembers(servers, 'inbox', describeMethod, { sourceOwner: owner }, undefined, false);
        expect(members.map((entry) => entry.id)).toEqual(['work-mail', 'team-cal']);
        expect(await personalOpsLaneMembers(servers, 'inbox', describeMethod, { sourceOwner: owner })).toEqual([]);
      } finally { await owner.close(); }
    });
  });
});

describe('semantic lane membership with an unsettled reading', () => {
  const methods = [
    { id: 'sure', description: 'Plainly belongs.' },
    { id: 'borderline', description: 'Relates to both reminders and schedules.' },
    { id: 'other', description: 'Plainly does not belong.' },
  ];
  const probability: Record<string, number> = { sure: 0.99, borderline: 0.5, other: 0.01 };

  test('one uncertain method is left out and reported instead of failing the lane', async () => {
    installJudgmentPort(fakePort((_name, _question, raw) => {
      const state = raw as { candidate: { name: string } };
      return noulAnswer(probability[state.candidate.name] ?? 0.01);
    }).port);
    let unassessed: readonly string[] = [];
    const members = await personalOpsLaneMembers(methods, 'reminders', describeMethod, { sourceOwner: ordinaryResearchOwner() },
      (entries) => { unassessed = entries.map((entry) => entry.id); });
    expect(members.map((method) => method.id)).toEqual(['sure']);
    expect(unassessed).toEqual(['borderline']);
  });

  test('the lane partition carries the unassessed ids and is unchanged when there are none', () => {
    const entries = [{ id: 'a', invokable: true }, { id: 'b', invokable: false }] as never;
    expect(partitionInvokableMethods(entries)).toEqual({ available: ['a'], unavailable: ['b'] });
    expect(partitionInvokableMethods(entries, ['z', 'y']).unassessed).toEqual(['y', 'z']);
  });
});

describe('lane report of unassessed methods', () => {
  const lane = { id: 'reminders', label: 'Reminders', signals: ['one'] } as unknown as PersonalOpsLane;

  test('a lane names the methods whose reading could not be settled, and is untouched when there are none', () => {
    expect(withUnassessed(lane, undefined)).toBe(lane);
    expect(withUnassessed(lane, [])).toBe(lane);
    const annotated = withUnassessed(lane, ['a.method', 'b.method']);
    expect(annotated.signals).toHaveLength(2);
    expect(annotated.signals[1]).toContain('2 method(s) not assessed');
    expect(annotated.signals[1]).toContain('a.method, b.method');
  });
});
