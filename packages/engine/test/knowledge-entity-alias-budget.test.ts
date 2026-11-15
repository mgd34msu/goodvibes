import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { MAX_ENTITY_ALIAS_REQUESTS, readKnowledgeEntityAliases } from '../platform/src/platform/knowledge/entity-aliases.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');

test('a long source with several entities is still read, capped per entity, instead of holding', async () => {
  const fake = fakePort(() => noulAnswer(0.01));
  installJudgmentPort(fake.port);
  const entities = [{ kind: 'project', title: 'Alpha' }, { kind: 'env', title: 'Beta' }, { kind: 'owner', title: 'Gamma' }];
  const distinct = Math.ceil(MAX_ENTITY_ALIAS_REQUESTS / entities.length) + 1;
  const aliases = await readKnowledgeEntityAliases(entities, { title: 'Large source', summary: words(distinct), extractionSummary: '', sections: [] });
  expect(aliases).toEqual([[], [], []]);
  expect(fake.requests).toHaveLength(entities.length * Math.floor(MAX_ENTITY_ALIAS_REQUESTS / entities.length));
});

test('classic mode makes no reading and does not hold a long source', async () => {
  const fake = fakePort(() => noulAnswer(0.01));
  installJudgmentPort(fake.port);
  const entities = [{ kind: 'project', title: 'Alpha' }, { kind: 'env', title: 'Beta' }];
  const aliases = await withDecisionModelPolicy(() => 'Classic - Off', () => readKnowledgeEntityAliases(entities, { title: 'Large source', summary: words(MAX_ENTITY_ALIAS_REQUESTS), extractionSummary: '', sections: [] }));
  expect(aliases).toEqual([[], []]);
  expect(fake.requests).toHaveLength(0);
});

test('a source within the budget is read once per entity and distinct word', async () => {
  const fake = fakePort(() => noulAnswer(0.01));
  installJudgmentPort(fake.port);
  const entities = [{ kind: 'project', title: 'Alpha' }, { kind: 'env', title: 'Beta' }];
  // Repeated words are one candidate: 5 distinct words plus the title words, each read once per entity.
  const aliases = await readKnowledgeEntityAliases(entities, { title: 'Doc', summary: 'one two one two three three four five', extractionSummary: '', sections: [] });
  expect(aliases).toEqual([[], []]);
  expect(fake.requests).toHaveLength(entities.length * 6);
});
