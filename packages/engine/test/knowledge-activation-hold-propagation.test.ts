import { extractionValueFixtureFor, extractionValueFixtureReading, type ExtractionValueFixtures } from './_helpers/knowledge-extraction-value-readings.js';
import { repairSubjectFixtureReading } from './_helpers/repair-subject-fixture-readings.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { configureKnowledgeArtifactReferences } from '../platform/src/platform/knowledge/artifact-reference-ensemble.js';
import { HOME_GRAPH_KNOWLEDGE_DB_FILE } from '../platform/src/platform/knowledge/store-config.js';
import { KnowledgeNodeActivationHeldError } from '../platform/src/platform/knowledge/activation/types.js';
import { upsertObservedKnowledgeNode } from '../platform/src/platform/knowledge/store-node-observation.js';
import { reviewKnowledgeNodeRecord } from '../platform/src/platform/knowledge/service-node-admin.js';
import { buildHomeGraphMetadata, isGeneratedPageSource } from '../platform/src/platform/knowledge/home-graph/helpers.js';
import { refreshDevicePagesForHomeGraphAsk } from '../platform/src/platform/knowledge/home-graph/ask-page-refresh.js';
import { enrichKnowledgeSource } from '../platform/src/platform/knowledge/semantic/enrichment.js';
import { promoteRepairSources } from '../platform/src/platform/knowledge/semantic/self-improvement-promotion.js';

const spaceId = 'homeassistant:activation-propagation', installationId = 'activation-propagation';
const initialText = 'The laboratory recorded a sample from the reference device for later examination.';
const capturedText = `${initialText}\n\nAC-7 resolution: 4K.`;
const roots: string[] = [];
const stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
const extractionValues: Array<ExtractionValueFixtures[number]> = [];
beforeEach(() => { extractionValues.length = 0; previous = installJudgmentPort(undefined); });
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function metadata(extra: Record<string, unknown> = {}) { return buildHomeGraphMetadata(spaceId, installationId, extra); }
function snapshot(store: KnowledgeStore) {
  return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), sources: store.listSources(),
    extractions: store.listExtractions(), issues: store.listIssues(), tasks: store.listRefinementTasks(),
    revisions: store.listNodes().flatMap((node) => store.listNodeRevisions(node.id)) });
}
async function fixture(excerpt = initialText) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-activation-propagation-')); roots.push(root);
  const dbPath = join(root, HOME_GRAPH_KNOWLEDGE_DB_FILE), store = new KnowledgeStore({ dbPath, family: 'home-graph' });
  stores.push(store);
  await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  configureKnowledgeArtifactReferences({ artifactStore, controlPlaneDirectory: root, stores: [store] });
  const observed = { id: 'device', kind: 'ha_device' as const, slug: 'device', title: 'AC-7', status: 'active' as const,
    metadata: metadata({ model: 'AC-7', entityKind: 'device', homeAssistant: { objectId: 'device', objectKind: 'device' } }) };
  const device = await upsertObservedKnowledgeNode(store, observed, 'home-assistant-snapshot', observed, () => observed);
  const source = await store.upsertSource({ id: 'manual', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 manual',
    status: 'indexed', canonicalUri: 'https://example.test/ac-seven', metadata: metadata() });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt, metadata: metadata() });
  installJudgmentPort(fakePort((name) => {
    name = name.split('__').at(-1)!;
    if (name === 'serve') return noulAnswer(0.99);
    throw new Error(`Unscripted seed question: ${name}`);
  }).port);
  const fact = await store.upsertNode({ id: 'existing-fact', kind: 'fact', slug: 'existing-fact', title: 'Sample observation',
    summary: excerpt, sourceId: source.id, metadata: metadata({ semanticKind: 'fact', factKind: 'specification',
      value: excerpt, evidence: excerpt, sourceId: source.id, subjectIds: [device.id] }) });
  const protectedSource = await store.upsertSource({ id: 'protected-source', connectorId: 'synthetic', sourceType: 'manual',
    title: 'Operator reference', status: 'indexed', metadata: metadata() });
  await store.upsertExtraction({ sourceId: protectedSource.id, extractorId: 'synthetic', format: 'text', excerpt: initialText, metadata: metadata() });
  const protectedFacts = [];
  for (const decision of ['accept', 'reject'] as const) {
    const node = await store.upsertNode({ ...fact, id: `protected-${decision}`, slug: `protected-${decision}`, sourceId: protectedSource.id,
      metadata: metadata({ semanticKind: 'fact', factKind: 'note', evidence: initialText }) });
    await reviewKnowledgeNodeRecord(store, { id: node.id, decision, reviewer: 'fixture-operator' });
    protectedFacts.push(store.getNode(node.id)!);
  }
  return { store, artifactStore, device, source, fact, protectedFacts,
    async reload() { const reopened = new KnowledgeStore({ dbPath, family: 'home-graph' }); stores.push(reopened); await reopened.init(); return reopened; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function ask(item: Fixture, includeFact = true) {
  return refreshDevicePagesForHomeGraphAsk({ ...item, spaceId, installationId, answer: { ok: true, spaceId, query: 'What was observed?', results: [],
    answer: { text: initialText, mode: 'standard', confidence: 99, sources: [item.source], facts: includeFact ? [item.fact] : [], linkedObjects: [item.device] } } });
}
function askReadings(serve: number) {
  const fake = fakePort((name, question) => {
    name = name.split('__').at(-1)!;
    if (name === 'authority') return choiceAnswer(question, 'official-vendor', 0.99);
    if (name === 'useful' || name === 'repairUseful') return noulAnswer(0.99);
    if (name === 'serve') return noulAnswer(serve);
    if (name === 'wanted') return noulAnswer(0.01);
    if (['manufacturerPresent', 'modelPresent', 'batteryApplicable', 'batteryTypePresent'].includes(name)) return noulAnswer(0.01);
    throw new Error(`Unscripted Ask question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
function expectProtected(store: KnowledgeStore, item: Fixture) {
  for (const fact of item.protectedFacts) expect(store.getNode(fact.id)).toEqual(fact);
}

describe('required activation holds across knowledge refresh catches', () => {
  test('Ask links an accepted fact without rewriting it or asking for activation again', async () => {
    const item = await fixture('AC-7 supports 4K UHD resolution.'), fake = askReadings(0.01);
    const rawFact = item.store.getRecordSnapshot('node', item.fact.id).raw;
    const revisions = item.store.listNodeRevisions(item.fact.id);
    expect(await ask(item)).toEqual({ requested: true, refreshed: 1 });
    expect(fake.requests.filter((request) => 'serve' in request.questions)).toHaveLength(0);
    expect(item.store.getNode(item.fact.id)).toBe(item.fact);
    expect(item.store.getRecordSnapshot('node', item.fact.id).raw).toEqual(rawFact);
    expect(item.store.listNodeRevisions(item.fact.id)).toEqual(revisions);
    const reopened = await item.reload();
    expect(reopened.getNode(item.fact.id)).toEqual(item.fact);
    expect(reopened.getRecordSnapshot('node', item.fact.id).raw).toEqual(rawFact);
    expect(reopened.listNodeRevisions(item.fact.id)).toEqual(revisions);
    expectProtected(reopened, item);
    expect(reopened.listEdges().filter(edge => edge.fromId === item.source.id || edge.fromId === item.fact.id)
      .map(edge => [edge.fromKind, edge.fromId, edge.toKind, edge.toId, edge.relation]).sort()).toEqual([
      ['source', item.source.id, 'node', item.device.id, 'source_for'],
      ['source', item.source.id, 'node', item.fact.id, 'supports_fact'],
      ['node', item.fact.id, 'node', item.device.id, 'describes'],
    ].sort());
    expect(reopened.listNodes().filter((node) => node.kind === 'ha_device_passport')).toHaveLength(1);
    expect(reopened.listSources().filter(isGeneratedPageSource)).toHaveLength(1);
    expect(item.artifactStore.list()).toHaveLength(1);
  });

  test.each([[0.01, 'no'], [0.5, 'uncertain']] as const)('Ask propagates actual profile activation %s/%s after only the accepted source link', async (probability, reason) => {
    const item = await fixture('AC-7 resolution: 4K.');
    const fake = fakePort((name, question, state) => {
      name = name.split('__').at(-1)!;
      if (['factTrust', 'sourceSupport', 'subjectSupport'].includes(name)) return scoreAnswer(question, 4, 0.99);
      const input = state as { category?: { title: string } };
      if (name === 'authority') return choiceAnswer(question, 'official-vendor', 0.99);
      if (name === 'wanted') return noulAnswer(input.category?.title === 'Display and picture specifications' ? 0.99 : 0.01);
      if (name === 'serve') return noulAnswer(probability);
      if (['manufacturerPresent', 'modelPresent', 'batteryApplicable', 'batteryTypePresent'].includes(name)) return noulAnswer(0.01);
      if (['useful', 'repairUseful', 'selected', 'profileSupported', 'supported', 'attached'].includes(name)) return noulAnswer(0.99);
      throw new Error(`Unscripted passport question: ${name}`);
    });
    installJudgmentPort(fake.port);
    await expect(ask(item, false)).rejects.toMatchObject({ name: 'KnowledgeNodeActivationHeldError', reason });
    expect(fake.requests.filter(request => 'serve' in request.questions).length).toBeGreaterThan(0);
    const usefulness = fake.requests.findIndex(request => 'repairUseful' in request.questions);
    const activation = fake.requests.findIndex(request => 'serve' in request.questions);
    expect(usefulness).toBeGreaterThanOrEqual(0); expect(activation).toBeGreaterThan(usefulness);
    const reopened = await item.reload();
    expect(reopened.getNode(item.fact.id)).toEqual(item.fact);
    expectProtected(reopened, item);
    expect(reopened.listEdges().map(edge => [edge.fromKind, edge.fromId, edge.toKind, edge.toId, edge.relation])).toEqual([
      ['source', item.source.id, 'node', item.device.id, 'source_for'],
    ]);
    expect(reopened.listNodes().filter((node) => node.kind === 'ha_device_passport')).toHaveLength(0);
    expect(reopened.listSources().filter(isGeneratedPageSource)).toHaveLength(0);
    expect(item.artifactStore.list()).toHaveLength(0);
  });

  test('Ask retains its ordinary bookkeeping failure fallback and honestly counts the generated passport', async () => {
    const item = await fixture('AC-7 supports 4K UHD resolution.'); askReadings(0.99);
    const applyPreparedIngest = item.store.applyPreparedIngest.bind(item.store);
    let injected = false;
    item.store.applyPreparedIngest = async (input, prepareGraph, options) => applyPreparedIngest(input, async (stage) => {
      const graph = await prepareGraph(stage);
      if (graph.edges.some((edge) => edge.fromId === item.source.id && edge.toId === item.fact.id && edge.relation === 'supports_fact')) {
        injected = true;
        throw new Error('Synthetic bookkeeping write unavailable');
      }
      return graph;
    }, options);
    expect(await ask(item)).toEqual({ requested: true, refreshed: 1 });
    expect(injected).toBe(true);
    expect(item.store.listEdges().filter(edge => edge.toId === item.fact.id || edge.fromId === item.fact.id)).toHaveLength(0);
    const reopened = await item.reload();
    expect(reopened.getNode(item.fact.id)).toEqual(item.fact);
    expectProtected(reopened, item);
    expect(reopened.listNodes().filter((node) => node.kind === 'ha_device_passport')).toHaveLength(1);
    expect(reopened.listSources().filter(isGeneratedPageSource)).toHaveLength(1);
    expect(item.artifactStore.list()).toHaveLength(1);
  });

  test('repair propagates a real enrichment activation hold without fallback, while retaining raw capture and earlier links', async () => {
    const item = await fixture(), { gap, task } = await repairTask(item);
    let phase: 'promotion' | 'enrichment' | 'fallback' = 'promotion';
    const fake = repairReadings(() => phase);
    let held: unknown, atHold = '', requestsAtHold = 0, earlierLink = false;
    const pending = promoteRepairSources({ store: item.store, enrichSource: async (_sourceId, options) => {
      // The earlier independently settled subject-link phase remains durable.
      earlierLink = item.store.listEdges().some((edge) => edge.fromId === item.fact.id && edge.relation === 'describes');
      await captureRepairText(item);
      phase = 'enrichment';
      try {
        return await enrichKnowledgeSource({ store: item.store, llm: {
          async completeJson() {
            return { facts: [{ kind: 'specification', title: 'Enrichment display claim', value: '4K',
              summary: 'AC-7 resolution: 4K.', evidence: 'AC-7 resolution: 4K.', confidence: 99 }] };
          },
          async completeText() { throw new Error('Unexpected free-text completion'); },
        } }, item.store.getSource(item.source.id)!, options);
      } catch (error) {
        held = error; atHold = snapshot(item.store); requestsAtHold = fake.requests.length; throw error;
      } finally { phase = 'fallback'; }
    } }, spaceId, gap, [item.source.id], task, Date.now() + 60_000);
    await expect(pending).rejects.toBeInstanceOf(KnowledgeNodeActivationHeldError);
    expect(held).toMatchObject({ reason: 'no' });
    expect(earlierLink).toBe(true);
    expect(atHold).not.toBe(''); expect(snapshot(item.store)).toBe(atHold);
    expect(fake.requests).toHaveLength(requestsAtHold);
    expect(item.store.getSemanticEnrichmentState(item.source.id)).toBeNull();
    const reopened = await item.reload();
    expect(snapshot(reopened)).toBe(atHold);
    expect(reopened.getExtractionBySourceId(item.source.id)?.excerpt).toBe(capturedText);
    expect(reopened.getRefinementTask(task.id)).toEqual(task);
    expectProtected(reopened, item);
  });

  test('repair still promotes captured evidence and updates its task after an ordinary enrichment failure', async () => {
    const item = await fixture(), { gap, task } = await repairTask(item);
    let phase: 'promotion' | 'fallback' = 'promotion';
    const fake = repairReadings(() => phase);
    const upsertTask = item.store.upsertRefinementTask.bind(item.store);
    let recovery: { requests: number; fact: ReturnType<KnowledgeStore['getNode']>; revisions: ReturnType<KnowledgeStore['listNodeRevisions']>; edges: ReturnType<KnowledgeStore['listEdges']> } | undefined;
    item.store.upsertRefinementTask = async input => {
      const saved = await upsertTask(input);
      if (saved.trace.at(-1)?.message === 'Repair source enrichment did not finish for one accepted source.') {
        const fact = item.store.listNodes().find(node => node.title === 'Display and picture specifications');
        recovery = { requests: fake.requests.length, fact: fact ?? null,
          revisions: fact ? item.store.listNodeRevisions(fact.id) : [], edges: item.store.listEdges() };
      }
      return saved;
    };
    const result = await promoteRepairSources({ store: item.store, enrichSource: async () => {
      await captureRepairText(item); phase = 'fallback'; throw new Error('Synthetic extraction worker unavailable');
    // This complete recovery/publication fixture took 64 seconds on CI. Its
    // support budget must cover that work, within the finite outer deadline.
    } }, spaceId, gap, [item.source.id], task, Date.now() + 90_000);
    expect(result).toEqual({ promotedFactCount: 2, repairComplete: false, promotedSourceIds: [item.source.id] });
    const reopened = await item.reload();
    const promoted = reopened.listNodes().find((node) => node.title === 'Display and picture specifications');
    expect(promoted?.status).toBe('active');
    expect(reopened.listEdges().some((edge) => edge.fromId === promoted?.id && edge.toId === item.device.id && edge.relation === 'describes')).toBe(true);
    const currentTask = reopened.getRefinementTask(task.id)!;
    expect(currentTask.state).toBe('applying'); expect(currentTask.promotedFactCount).toBe(2);
    expect(currentTask.trace.some((entry) => entry.message === 'Repair source enrichment did not finish for one accepted source.')).toBe(true);
    expect(recovery).toBeDefined(); expect(recovery?.fact).not.toBeNull();
    expect(fake.requests.length).toBe(recovery!.requests);
    expect(item.store.getNode(recovery!.fact!.id)).toBe(recovery!.fact);
    expect(item.store.listNodeRevisions(recovery!.fact!.id)).toEqual(recovery!.revisions);
    expect(item.store.listEdges()).toEqual(recovery!.edges);
    expectProtected(reopened, item);
  }, 120_000);

  test('a completed negative recovery count refuses changed original evidence instead of recomputing or publishing progress', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-recovery-negative-')); roots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
    try {
      const observed = { id: 'empty-repair-gap', kind: 'knowledge_gap' as const, slug: 'empty-repair-gap', title: 'Missing captured observations',
        status: 'active' as const, metadata: metadata() };
      const gap = await upsertObservedKnowledgeNode(store, observed, 'research-task', observed, () => observed);
      const source = await store.upsertSource({ connectorId: 'synthetic', sourceType: 'manual', title: 'Original empty manual', status: 'indexed', metadata: metadata() });
      const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
      const fake = fakePort(() => { throw new Error('An empty fact set must not ask a semantic question'); }); installJudgmentPort(fake.port);
      const upsertTask = store.upsertRefinementTask.bind(store);
      let recoveryTask: ReturnType<KnowledgeStore['getRefinementTask']>;
      store.upsertRefinementTask = async input => {
        const saved = await upsertTask(input);
        if (saved.trace.at(-1)?.message === 'Repair source enrichment did not finish for one accepted source.') {
          recoveryTask = saved;
          await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: 'A newly arrived independent source observation.', metadata: metadata() });
        }
        return saved;
      };
      await expect(promoteRepairSources({ store, enrichSource: async () => { throw new Error('Synthetic ordinary enrichment failure'); } },
        spaceId, gap, [source.id], task, Date.now() + 60_000)).rejects.toMatchObject({ reason: 'stale' });
      expect(recoveryTask!).toBeDefined(); expect(store.getRefinementTask(task.id)).toBe(recoveryTask!);
      expect(store.getRefinementTask(task.id)?.trace.at(-1)?.message).toBe('Repair source enrichment did not finish for one accepted source.');
      expect(store.listNodes().filter(node => node.kind === 'fact')).toEqual([]);
      expect(fake.requests).toHaveLength(0);
    } finally { await store.close(); }
  });
});

async function repairTask(item: Fixture) {
  const observed = { id: 'repair-gap', kind: 'knowledge_gap' as const, slug: 'repair-gap', title: 'Full AC-7 specifications',
    status: 'active' as const, metadata: metadata({ linkedObjectIds: [item.device.id] }) };
  const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
  const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
  return { gap, task };
}
async function captureRepairText(item: Fixture) {
  await item.store.upsertExtraction({ sourceId: item.source.id, extractorId: 'synthetic', format: 'text', excerpt: capturedText, metadata: metadata({ capturedBy: 'repair-worker' }) });
  const source = item.store.getSource(item.source.id);
  if (!source) throw new Error('Missing authored repair source');
  extractionValues.push(extractionValueFixtureFor(source, item.store.getExtractionBySourceId(source.id), 0.99));
}
function repairReadings(phase: () => string) {
  const fake = fakePort((name, question, state) => {
      if (['factTrust', 'sourceSupport', 'subjectSupport'].includes(name)) return scoreAnswer(question, 4, 0.99);
    if (name === 'repairEvidenceSufficient') return noulAnswer(0.01); // The initial sample and one resolution fact do not complete the full profile.
    if (name === 'fullProfileRequired') return noulAnswer(0.01); // This authored repair adds one explicit observation, not a complete profile.
    const extractionValue = extractionValueFixtureReading(name, question, state, extractionValues);
    if (extractionValue !== undefined) return noulAnswer(extractionValue);
    if (name === 'repairSubjectSelected') return noulAnswer(repairSubjectFixtureReading(state, [['AC-7', 0.99]]));
    const item = state as { category?: { title: string }; candidate?: { text?: string } };
    if (name === 'authority') return choiceAnswer(question, 'secondary', 0.99);
    if (name === 'wanted') return noulAnswer(phase() === 'fallback' && item.category?.title === 'Display and picture specifications' ? 0.99 : 0.01);
    if (name === 'selected') return noulAnswer(item.candidate?.text === 'AC-7 resolution: 4K.' ? 0.99 : 0.01);
    if (name === 'serve') return noulAnswer(phase() === 'enrichment' ? 0.01 : 0.99);
    if (['useful', 'repairUseful', 'profileSupported', 'supported', 'attached'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unscripted repair question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
