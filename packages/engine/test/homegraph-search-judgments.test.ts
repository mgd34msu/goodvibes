import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { JudgmentInputError } from '../platform/src/platform/gate/judgment-input.js';
import { HomeGraphService } from '../platform/src/platform/knowledge/home-graph/service.js';
import { readHomeGraphSearchState } from '../platform/src/platform/knowledge/home-graph/search.js';
import { HOME_GRAPH_ASK_SHORTLIST, readHomeGraphSearchSelection } from '../platform/src/platform/knowledge/home-graph/search-judgments.js';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import type { KnowledgeSourceType } from '../platform/src/platform/knowledge/types.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const spaceId = 'homeassistant:search-readings';
const query = 'How do I reset the router?';
const body = 'Hold the recessed switch for ten seconds to restore factory network settings.';
const roots: string[] = [], services: HomeGraphService[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  installJudgmentPort(previous);
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(semantic = false, generate: () => Promise<string> = async () => body) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-search-readings-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const semanticService = semantic ? new KnowledgeSemanticService(store, { llm: {
    async completeJson() { throw new Error('No enrichment in this synthetic fixture'); }, async completeText() { return generate(); },
  }, isBackgroundPaused: () => true }) : undefined;
  const service = new HomeGraphService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }), semanticService ? { semanticService } : {});
  services.push(service); return { store, service, semanticService };
}
async function source(store: KnowledgeStore, id: string, title: string, text: string, options: {
  sourceType?: KnowledgeSourceType; summary?: string; tags?: string[]; space?: string;
} = {}) {
  const metadata = { knowledgeSpaceId: options.space ?? spaceId };
  const row = await store.upsertSource({ id, connectorId: 'fixture', sourceType: options.sourceType ?? 'document', title,
    summary: options.summary, status: 'indexed', tags: options.tags, metadata });
  await store.upsertExtraction({ sourceId: id, extractorId: 'fixture', format: 'text', sections: [text], metadata });
  return row;
}
function readings(options: { evidence?: Readonly<Record<string, number>>; spans?: readonly string[];
  objects?: readonly string[]; intent?: number; readability?: number } = {}) {
  const fake = fakePort((name, question, state) => {
    const candidate = (state as { candidate?: { title?: string; text?: string } }).candidate;
    if (name === 'useful') return noulAnswer(options.evidence?.[candidate?.title ?? ''] ?? 0.01);
    if (name === 'excerptUseful') return noulAnswer((options.spans ?? [body]).includes(candidate?.text ?? '') ? 0.99 : 0.01);
    if (name === 'integrationIntent') return noulAnswer(options.intent ?? 0.01);
    if (name === 'concreteObject') return noulAnswer(0.99);
    if (name === 'integrationObject') return noulAnswer(0.01);
    if (name === 'aligned') return noulAnswer(options.objects?.includes(candidate?.title ?? '') ? 0.99 : 0.01);
    if (name === 'readable') return noulAnswer(options.readability ?? 0.99);
    if (name === 'match' || name === 'supported' || name === 'attached') return noulAnswer(0.99);
    if (name === 'fidelity') return choiceAnswer(question, 'supported', 0.97);
    if (name === 'preferred') return choiceAnswer(question, 'generated', 0.99);
    if (name === 'enough' || name === 'complete') return noulAnswer(0.99);
    if (name === 'features' || name === 'gapSubject' || name === 'sameQuestion') return noulAnswer(0.01);
    throw new Error(`Unscripted search fixture: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
function select(f: Awaited<ReturnType<typeof fixture>>, question = { query, limit: 8 }) {
  return readHomeGraphSearchSelection({ store: f.store, spaceId, query: question, state: readHomeGraphSearchState(f.store, spaceId) });
}
function records(store: KnowledgeStore) {
  return JSON.stringify({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() });
}

describe('Home Graph full-candidate search judgments (authored synthetic proof)', () => {
  test.each([false, true])('executable ask retrieves a paraphrase without lexical overlap, semantic=%s', async (semantic) => {
    const f = await fixture(semantic);
    await source(f.store, 'advertisement', 'Official router reset manual support', 'Buy now. Instructions are not provided here.', { sourceType: 'manual', tags: ['manual', 'router', 'reset'] });
    const useful = await source(f.store, 'recovery', 'Recovery procedure', body, { sourceType: 'other' });
    const fake = readings({ evidence: { 'Recovery procedure': 0.99 } });
    const answer = await f.service.ask({ knowledgeSpaceId: spaceId, query, limit: 1 });
    expect(answer.results.map((item) => item.id)).toEqual([useful.id]);
    expect(answer.answer.text).toContain(body);
    expect(answer.answer.text).not.toContain('Buy now');
    expect(fake.requests.filter((request) => request.context?.site === 'engine.knowledge.answer-evidence-relevance')
      .some((request) => JSON.stringify(request.state).includes('Official router reset manual support'))).toBe(true);
    if (!semantic) { expect(answer.results[0]!.score).toBe(0); expect(answer.answer.confidence).toBe(0); }
  });
  test('same reader ranks accepted rows across source types and keeps deterministic ties on repeat', async () => {
    const f = await fixture();
    await source(f.store, 'first', 'High-weight manual', body, { sourceType: 'manual' });
    await source(f.store, 'second', 'Unboosted note', body, { sourceType: 'other' });
    readings({ evidence: { 'High-weight manual': 0.82, 'Unboosted note': 0.99 } });
    expect((await select(f)).results.map((row) => row.id)).toEqual(['second', 'first']);
    expect((await select(f)).results.map((row) => row.id)).toEqual(['second', 'first']);
    readings({ evidence: { 'High-weight manual': 0.99, 'Unboosted note': 0.99 } });
    const originalOrder = readHomeGraphSearchState(f.store, spaceId).sources.map((row) => row.id);
    expect((await select(f)).results.map((row) => row.id)).toEqual(originalOrder);
  });
  test('decision-model requests for one question stay at the shortlist however large the home is', async () => {
    const f = await fixture();
    const useful = await source(f.store, 'last', 'Router reset procedure', body);
    for (let index = 0; index < 104; index++) await source(f.store, `noise-${index}`, `Unrelated ${index}`, 'A packaging color specification.');
    const fake = readings({ evidence: { 'Router reset procedure': 0.99 } });
    const answer = await f.service.ask({ knowledgeSpaceId: spaceId, query, limit: 1 });
    expect(answer.results.map((row) => row.id)).toEqual([useful.id]);
    expect(fake.requests.filter((request) => request.context?.site === 'engine.knowledge.answer-evidence-relevance')).toHaveLength(HOME_GRAPH_ASK_SHORTLIST);
    expect(answer.candidates).toEqual({ total: 105, considered: HOME_GRAPH_ASK_SHORTLIST, unread: 0 });
  });
  test('a candidate whose reading does not settle is left out and counted, not fatal', async () => {
    const f = await fixture();
    const useful = await source(f.store, 'useful', 'Recovery procedure', body);
    await source(f.store, 'unsure', 'Ambiguous note', 'Something about switches.');
    readings({ evidence: { 'Recovery procedure': 0.99, 'Ambiguous note': 0.5 } });
    const answer = await f.service.ask({ knowledgeSpaceId: spaceId, query, limit: 2 });
    expect(answer.results.map((row) => row.id)).toEqual([useful.id]);
    expect(answer.candidates?.unread).toBe(1);
  });
  test('full source tails and late exceptions survive old field/excerpt clamps', async () => {
    const f = await fixture();
    const text = `${'Context line. '.repeat(400)}\n\nThe optional backup powers standby for twelve hours.\n\nActive use lasts two hours; the primary device does not include this accessory.`;
    await source(f.store, 'qualified', 'Operating duration', text);
    const fake = readings({ evidence: { 'Operating duration': 0.99 }, spans: [text] });
    const answer = await f.service.ask({ knowledgeSpaceId: spaceId, query: 'How long can the device run?', limit: 1 });
    expect(answer.answer.text).toContain(text);
    expect(answer.results[0]!.excerpt).toBe(text);
    expect(fake.requests.filter((request) => 'excerptUseful' in request.questions)
      .some((request) => (request.state as { candidate: { text: string } }).candidate.text === text)).toBe(true);
  });
  test('settled empty excerpt never revives source summary or description', async () => {
    const f = await fixture();
    await source(f.store, 'empty', 'Source identity', body, { summary: 'An unselected claim must not reappear.' });
    const fake = readings({ evidence: { 'Source identity': 0.99 }, spans: [] });
    const answer = await f.service.ask({ knowledgeSpaceId: spaceId, query });
    expect(answer.results[0]!.excerpt).toBe('');
    expect(answer.answer.text).toBe('- Source identity');
    expect(answer.answer.text).not.toContain('unselected');
    expect(answer.results[0]!.summary).toBe('An unselected claim must not reappear.');
    // Readability is stored with the extraction; a search asks no readability question.
    expect(fake.requests.some((request) => 'readable' in request.questions)).toBe(false);
  });
  test.each([false, true])('settled empty search stays empty through answer composition, semantic=%s', async (semantic) => {
    const f = await fixture(semantic); await source(f.store, 'denied', 'Unrelated source', body);
    const fake = readings(); const before = records(f.store);
    const answer = await f.service.ask({ knowledgeSpaceId: spaceId, query });
    expect(answer.results).toEqual([]); expect(answer.answer.sources).toEqual([]);
    expect(answer.answer.text).toContain('No Home Graph knowledge matched');
    expect(fake.requests.filter((request) => request.context?.site === 'engine.knowledge.answer-evidence-relevance')).toHaveLength(1);
    if (!semantic) expect(records(f.store)).toBe(before);
    else expect(f.store.listSources().map((row) => row.id)).toEqual(['denied']);
  });
  test('configured answer cannot revive rejected large linked sources', async () => {
    const f = await fixture(true);
    const object = await seedHomeAssistantObservation(f.store, { id: 'router', slug: 'router', title: 'Network controller', kind: 'ha_entity', status: 'active', metadata: { knowledgeSpaceId: spaceId } });
    const selected = await source(f.store, 'recovery', 'Recovery procedure', body);
    for (let index = 0; index < 8; index++) {
      const row = await source(f.store, `decoy-${index}`, `Decoy ${index}`, 'x'.repeat(128 * 1024));
      await f.store.upsertEdge({ fromKind: 'source', fromId: row.id, toKind: 'node', toId: object.id, relation: 'has_manual', metadata: { knowledgeSpaceId: spaceId } });
    }
    await f.store.upsertEdge({ fromKind: 'source', fromId: selected.id, toKind: 'node', toId: object.id, relation: 'source_for', metadata: { knowledgeSpaceId: spaceId } });
    const fake = readings({ evidence: { 'Recovery procedure': 0.99 }, objects: ['Network controller'] });
    const answer = await f.service.ask({ knowledgeSpaceId: spaceId, query, limit: 1 });
    expect(answer.results.map((row) => row.id)).toEqual([selected.id]);
    expect(answer.answer.text).toContain(body);
    const sourcesRead = fake.requests.filter((request) => request.context?.site === 'engine.knowledge.answer-evidence-relevance')
      .map((request) => (request.state as { candidate: { title: string } }).candidate.title);
    for (let index = 0; index < 8; index++) expect(sourcesRead.filter((title) => title === `Decoy ${index}`)).toHaveLength(1);
  });
  test('a candidate carrying a credential is refused before any evidence reading', async () => {
    const f = await fixture();
    await source(f.store, 'first', 'Recovery procedure', body);
    await source(f.store, 'late', 'Private document', 'Router notes. Authorization: Bearer owned-synthetic-fixture');
    const fake = readings({ evidence: { 'Recovery procedure': 0.99 } });
    await expect(select(f)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests.filter((request) => request.context?.site === 'engine.knowledge.answer-evidence-relevance')).toHaveLength(0);
  });
});
