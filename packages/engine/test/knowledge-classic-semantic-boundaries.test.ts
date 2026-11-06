import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { prepareHomeGraphTriageReadings } from '../sdk/src/platform/knowledge/home-graph/triage/reader.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { filterFactsForQuery, hasFeatureIntentForQuery } from '../sdk/src/platform/knowledge/semantic/answer-fact-selection.js';
import { readAnswerSourceRanking, sourceRankingContent } from '../sdk/src/platform/knowledge/semantic/answer-source-ranking.js';
import { captureAnswerReadingPorts } from '../sdk/src/platform/knowledge/semantic/answer-reading-ports.js';
import { verifyKnowledgeAnswer } from '../sdk/src/platform/knowledge/semantic/answer-verification/reader.js';
import { localKnowledgeSourceSpans } from '../sdk/src/platform/knowledge/semantic/answer-excerpts/prepare.js';
import { createKnowledgeFactQualityReader, semanticFactText } from '../sdk/src/platform/knowledge/semantic/fact-quality.js';
import { readKnowledgeBattery, extractedSentenceKind } from '../sdk/src/platform/knowledge/semantic/repair-decisions.js';
import { createRepairSourceAuthorityReader } from '../sdk/src/platform/knowledge/semantic/repair-source-authority/reader.js';
import { createRepairSubjectSelectionReader } from '../sdk/src/platform/knowledge/semantic/repair-subject-selection/reader.js';
import { createRepairFactUsefulnessReader, createKnowledgePageFactUsefulnessReader } from '../sdk/src/platform/knowledge/semantic/repair-usefulness/reader.js';
import { createWebGapReadings } from '../sdk/src/platform/knowledge/semantic/web-gap-repair/reader.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined, installed = false;
afterEach(async () => {
  if (installed) installJudgmentPort(previous); installed = false;
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function forbidModelAccess() {
  const calls = { requests: 0, metadata: 0 };
  previous = installJudgmentPort({
    get model(): never { calls.metadata++; throw new Error('Classic borrowed a decision model'); },
    get recorder(): never { calls.metadata++; throw new Error('Classic borrowed a semantic recorder'); },
    async ask() { calls.requests++; throw new Error('Classic asked a decision model'); },
  });
  installed = true;
  return calls;
}
const classic = <T>(work: () => T) => withDecisionModelPolicy(() => 'Classic - Off', work);

test('Classic keeps native source storage and quotations while semantic APIs stop before generation or writes', async () => {
  const calls = forbidModelAccess(); let generations = 0;
  await classic(async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-classic-semantic-boundaries-')); roots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
    const source = await store.upsertSource({ id: 'literal-source', connectorId: 'fixture', sourceType: 'document',
      title: 'Literal source', summary: 'Keep this complete warning.', status: 'indexed', metadata: {} });
    const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text',
      excerpt: 'Hold reset. Do not disconnect power until the light stops blinking.', metadata: {} });
    const fact = await store.upsertNode({ id: 'owner-draft', kind: 'fact', slug: 'owner-draft', title: 'Owner note',
      status: 'draft', sourceId: source.id, metadata: { value: 'Literal owner value' } });
    const before = readFileSync(store.storagePath), rows = JSON.stringify(store.status());
    const llm = {
      async completeJson() { generations++; return null; },
      async completeText() { generations++; return null; },
    };
    for (const operation of [
      () => enrichKnowledgeSource({ store, llm }, source),
      () => filterFactsForQuery('What does this source say?', [fact]),
      () => hasFeatureIntentForQuery('What features are available?'),
      () => readAnswerSourceRanking([{ score: 1, source }], [fact], 'What is supported?'),
      () => verifyKnowledgeAnswer({ query: 'What does this source say?',
        evidence: [{ reference: 'evidence-1', text: extraction.excerpt ?? '' }],
        candidates: [{ id: 'generated', text: 'A proposed answer.' }] }),
      () => readKnowledgeBattery(extractedSentenceKind, { text: extraction.excerpt ?? '', candidate: 'Hold reset.' }),
      () => prepareHomeGraphTriageReadings([]),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'decision-models-disabled' });
    for (const operation of [
      () => captureAnswerReadingPorts(),
      () => createKnowledgeFactQualityReader(store, { spaceId: 'default', query: 'Native inspection', subjects: [] }),
      () => createRepairSourceAuthorityReader(),
      () => createRepairSubjectSelectionReader(),
      () => createRepairFactUsefulnessReader(),
      () => createKnowledgePageFactUsefulnessReader(),
      () => createWebGapReadings({ signal: new AbortController().signal, assertCurrent() {} }),
    ]) expect(operation).toThrow('semantic knowledge');

    const spans = localKnowledgeSourceSpans(source, extraction);
    expect(spans.find(span => span.field === 'extraction.excerpt')).toMatchObject({
      text: extraction.excerpt, start: 0, end: extraction.excerpt?.length,
    });
    expect(sourceRankingContent(source).title).toBe('Literal source');
    expect(semanticFactText(fact)).toBe('Owner note\nLiteral owner value');
    expect(JSON.stringify(store.status())).toBe(rows);
    expect(readFileSync(store.storagePath)).toEqual(before);
    expect(generations).toBe(0);
  });
  expect(calls).toEqual({ requests: 0, metadata: 0 });
});

test('retained semantic readers cannot use a new Classic scope as an assessment capability', async () => {
  const calls = forbidModelAccess();
  const readers = withDecisionModelPolicy(() => 'Default - On', () => ({
    authority: createRepairSourceAuthorityReader(),
    subjects: createRepairSubjectSelectionReader(),
    repair: createRepairFactUsefulnessReader(),
    page: createKnowledgePageFactUsefulnessReader(),
    web: createWebGapReadings({ signal: new AbortController().signal, assertCurrent() {} }),
  }));
  await classic(async () => {
    for (const reader of [readers.authority, readers.subjects, readers.repair, readers.page]) {
      expect(reader.assertCurrent).toThrow('semantic knowledge');
      await expect(reader.read([])).rejects.toMatchObject({ code: 'decision-models-disabled' });
    }
    expect(readers.web.assertCurrent).toThrow('semantic knowledge');
  });
  expect(calls).toEqual({ requests: 0, metadata: 0 });
});
