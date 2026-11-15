import { afterAll, describe, expect, test } from 'bun:test';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { fieldInputValue, invalidInputFields, readInputFields, reviewRecordEntries } from '../../tools/agent-harness-personal-ops-runner.ts';
import { PERSONAL_OPS_LIVE_READ_TEMPLATE, describeLiveRecord, personalOpsReadRunRoute } from '../../tools/agent-harness-personal-ops-records.ts';
import type { PersonalOpsLiveRecord } from '../../tools/agent-harness-personal-ops-types.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);

describe('personal ops input fields', () => {
  const sample = { limit: 10, unreadOnly: false, labels: ['inbox'], query: 'x' };

  test('objects, arrays and numbers keep their JSON form instead of becoming text', () => {
    const fields = readInputFields({ filter: { from: 'a@b.test' }, tags: ['a', 'b'], max: 5, flag: true }, {});
    expect(fields).toEqual({ filter: { from: 'a@b.test' }, tags: ['a', 'b'], max: 5, flag: true });
  });

  test('a string-typed sample turns a scalar into text, and text takes the type of a typed sample', () => {
    expect(readInputFields({ query: 5, limit: '7', unreadOnly: 'yes', labels: 'a, b' }, sample)).toEqual({ query: '5', limit: 7, unreadOnly: true, labels: ['a', 'b'] });
  });

  test('empty, null and non-JSON values are left out', () => {
    expect(readInputFields({ a: '  ', b: null, c: undefined, d: () => 1, e: Number.NaN }, {})).toEqual({});
  });

  test('a boolean word that is neither yes nor no is kept as text so it can be reported', () => {
    expect(fieldInputValue('false', true)).toBe(false);
    expect(fieldInputValue('maybe', true)).toBe('maybe');
    expect(invalidInputFields({ unreadOnly: 'maybe', limit: 'many', labels: 'x', query: 'ok' }, sample)).toEqual([
      { field: 'unreadOnly', expected: 'boolean' },
      { field: 'limit', expected: 'number' },
      { field: 'labels', expected: 'list' },
    ]);
    expect(invalidInputFields({ unreadOnly: false, limit: 3, labels: ['a'] }, sample)).toEqual([]);
  });
});

describe('saved review cards', () => {
  test('a repeated subject keeps each card paired with its own id', async () => {
    const screening = researchScreeningFixture();
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const entries = await reviewRecordEntries([
        { id: '1', subject: 'Re: Weekly sync' },
        { id: '2', subject: 'Re: Weekly sync' },
        { id: '3', subject: 'Budget' },
      ], 5, { sourceOwner: screening.owner });
      expect(entries).toEqual([
        { label: 'Re: Weekly sync', id: '1' },
        { label: 'Re: Weekly sync', id: '2' },
        { label: 'Budget', id: '3' },
      ]);
    });
  });

  test('the same id twice is one card, and a card with only a label is identified by it', async () => {
    const screening = researchScreeningFixture();
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const entries = await reviewRecordEntries([{ id: '1', subject: 'A' }, { id: '1', subject: 'A again' }, { subject: 'No id' }], 5, { sourceOwner: screening.owner });
      expect(entries).toEqual([{ label: 'A', id: '1' }, { label: 'No id', id: 'No id' }]);
    });
  });
});

describe('personal ops routes', () => {
  const record: PersonalOpsLiveRecord = {
    id: 'schedule-create', label: 'Create reminder', status: 'ready', summary: 'Create a reminder.',
    userRoute: 'Agent Workspace -> Personal Ops -> Reminders',
    modelRoute: 'schedule action:"remind" message:"..." scheduleKind:"..." scheduleValue:"..."',
  };

  test('a record route is returned whole in both views', () => {
    for (const includeParameters of [false, true]) expect(describeLiveRecord(record, includeParameters).modelRoute).toBe(record.modelRoute);
  });

  test('the live read route does not offer confirm as a grant', () => {
    expect(personalOpsReadRunRoute('inbox', 'rec-1')).toBe('personal_ops action:"read" laneId:"inbox" recordId:"rec-1" fields:{...}');
    expect(PERSONAL_OPS_LIVE_READ_TEMPLATE).not.toContain('confirm');
  });
});
