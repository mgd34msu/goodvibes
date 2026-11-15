import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { prepareKnowledgeScopeSelection } from '../platform/src/platform/knowledge/scope-selection.js';

const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function openStore() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-scope-verdicts-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  return store;
}
const addSource = (store: KnowledgeStore, id: string, description = 'An authored application design guide.') => store.upsertSource({
  id, connectorId: 'synthetic', sourceType: 'document', title: `Guide ${id}`, description, status: 'indexed', metadata: { knowledgeSpaceId: 'default' } });

test('a record read once is not read again until its content changes', async () => {
  const store = await openStore();
  const first = await addSource(store, 'a'); await addSource(store, 'b');
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
  expect(fake.requests).toHaveLength(2);
  const again = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
  expect(fake.requests).toHaveLength(2);
  expect(again.sources.map(record => record.id).sort()).toEqual(['a', 'b']);
  await store.upsertSource({ ...first, description: 'Only saved-search controls and repository website chrome.' });
  await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
  expect(fake.requests).toHaveLength(3);
});

test('a verdict is not reused for a different reader', async () => {
  const store = await openStore(); const source = await addSource(store, 'a');
  installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  expect((await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] })).source(source)).toBe(true);
  installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
  expect((await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] })).source(source)).toBe(false);
});

test('the per-source selection an enrichment sweep makes costs no reading for an unchanged source', async () => {
  const store = await openStore(); const source = await addSource(store, 'a'); await addSource(store, 'b');
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const select = () => prepareKnowledgeScopeSelection(store, { includeAllSpaces: true }, { kinds: ['source'], sourceIds: [source.id] });
  expect((await select()).source(source)).toBe(true);
  expect(fake.requests).toHaveLength(1);
  expect((await select()).source(source)).toBe(true);
  expect(fake.requests).toHaveLength(1);
});

test('records past the per-pass cap are selected classically without discarding the readings made, and a later pass reads only the remainder', async () => {
  const store = await openStore();
  for (const id of ['a', 'b', 'c']) await addSource(store, id);
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const first = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'], maxReadingsPerPass: 2 });
  expect(fake.requests).toHaveLength(2);
  expect(first.provenance).toBe('classic');
  expect(first.sources.map(record => record.id).sort()).toEqual(['a', 'b', 'c']);
  const second = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'], maxReadingsPerPass: 2 });
  expect(fake.requests).toHaveLength(3);
  expect(second.provenance).toBeUndefined();
});
