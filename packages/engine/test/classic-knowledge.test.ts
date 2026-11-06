import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort, decisionModelPolicyState, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { prepareKnowledgeScopeSelection } from '../sdk/src/platform/knowledge/scope-selection.js';
import { readPublicKnowledgeSelection } from '../sdk/src/platform/knowledge/public-retrieval.js';
import { searchKnowledge, buildKnowledgePacket, type KnowledgePacketContext } from '../sdk/src/platform/knowledge/packet.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { KnowledgeScheduleService } from '../sdk/src/platform/knowledge/scheduling.js';

const roots: string[] = [], stores: KnowledgeStore[] = [], schedules: KnowledgeScheduleService[] = [];
let prior: JudgmentPort | undefined, installed = false;
afterEach(async () => {
  for (const scheduler of schedules.splice(0)) scheduler.dispose();
  if (installed) { installJudgmentPort(prior); installed = false; }
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function install(port: JudgmentPort | undefined) {
  if (!installed) { prior = installJudgmentPort(port); installed = true; }
  else installJudgmentPort(port);
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-classic-knowledge-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const ordinary = await store.upsertSource({ id: 'ordinary', connectorId: 'synthetic', sourceType: 'document',
    title: 'Network configuration', summary: 'Network recovery requires the complete procedure.', status: 'indexed',
    metadata: {} });
  await store.upsertExtraction({ sourceId: ordinary.id, extractorId: 'synthetic', format: 'text',
    excerpt: 'Network recovery: hold reset. Do not disconnect power until the light stops blinking.', metadata: {} });
  const foreign = await store.upsertSource({ id: 'foreign', connectorId: 'synthetic', sourceType: 'document',
    title: 'Network private project', summary: 'Foreign network record.', status: 'indexed', metadata: { knowledgeSpaceId: 'project:other' } });
  const usage: Parameters<KnowledgePacketContext['deferUsage']>[0][] = [];
  const context: KnowledgePacketContext = { store, deferUsage: input => { usage.push(input); }, emitIfReady() {} };
  return { store, ordinary, foreign, context, usage };
}
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic unavailable decision chain'); });
  install(fake.port); return fake.requests;
}
const under = <T>(policy: DecisionModelPolicy, operation: () => T) => withDecisionModelPolicy(() => policy, operation);

test('Classic scope selection keeps native namespaces and retained record checks without model I/O', async () => {
  const { store, ordinary, foreign } = await fixture(); const requests = outage();
  const selection = await under('Classic - Off', () => prepareKnowledgeScopeSelection(store));
  expect(selection.provenance).toBe('classic');
  expect(selection.sources.map(source => source.id)).toEqual([ordinary.id]); selection.assertCurrent();
  await store.upsertSource({ ...foreign, summary: 'An unrelated foreign correction.' }); selection.assertCurrent();
  await store.upsertSource({ ...ordinary, summary: 'Changed after capture.' });
  expect(selection.assertCurrent).toThrow('stale'); expect(requests).toHaveLength(0);
});

test('Classic explicit namespaces stay exact and all-space access is an explicit request', async () => {
  const { store, foreign } = await fixture(); const requests = outage();
  await under('Classic - Off', async () => {
    const explicit = await prepareKnowledgeScopeSelection(store, { knowledgeSpaceId: 'project:other' });
    expect(explicit.sources.map(source => source.id)).toEqual([foreign.id]);
    const all = await prepareKnowledgeScopeSelection(store, { includeAllSpaces: true });
    expect(all.sources).toHaveLength(2);
  });
  expect(requests).toHaveLength(0);
});

test('Classic search and packets use local overlap and whole quoted fields without probability claims', async () => {
  const { context, usage } = await fixture(); const requests = outage();
  await under('Classic - Off', async () => {
    const results = await searchKnowledge(context, 'network');
    expect(results.map(row => row.id)).toEqual(['ordinary']);
    expect(results[0]).toMatchObject({ provenance: 'classic', scoreSource: 'literal-overlap', score: 1 });
    const selection = await readPublicKnowledgeSelection(context.store, { query: 'network', scope: {}, mode: 'search' });
    expect(selection.accepted[0]?.probability).toBeUndefined();
    const packet = await buildKnowledgePacket(context, 'network');
    expect(packet.strategy).toContain('Classic');
    expect(packet.items[0]?.provenance).toBe('classic');
    expect(packet.items[0]?.evidence.join('\n')).toContain('Do not disconnect power until the light stops blinking.');
    expect(packet.items[0]?.reason).not.toContain('Selected by the shared semantic');
    expect(usage.every(entry => entry.metadata?.provenance === 'classic')).toBe(true);
  });
  expect(requests).toHaveLength(0);
});

test.each(['Classic - Off', 'Preferred'] as const)('%s local retrieval survives missing decision configuration', async policy => {
  const { store } = await fixture(); install(undefined);
  await under(policy, async () => {
    const results = await readPublicKnowledgeSelection(store, { query: 'network', scope: {}, mode: 'search' });
    expect(results.provenance).toBe('classic'); expect(results.accepted.map(row => row.id)).toEqual(['ordinary']);
    expect(decisionModelPolicyState().operation).toBe('classic');
  });
});

test('Preferred outage switches the current operation once and later lookups send no requests', async () => {
  const { context } = await fixture(); const requests = outage();
  await under('Preferred', async () => {
    expect((await searchKnowledge(context, 'network'))[0]?.provenance).toBe('classic');
    const attempted = requests.length; expect(attempted).toBeGreaterThan(0);
    await buildKnowledgePacket(context, 'network'); expect(requests).toHaveLength(attempted);
  });
});

test('Preferred does not convert an uncertain scope reading into local admission', async () => {
  const { store } = await fixture(); const fake = fakePort(() => noulAnswer(0.5)); install(fake.port);
  await under('Preferred', async () => {
    await expect(prepareKnowledgeScopeSelection(store)).rejects.toMatchObject({ reason: 'uncertain' });
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic cancellation and caller revocation remain binding without a port', async () => {
  const { store } = await fixture(); const requests = outage();
  await under('Classic - Off', async () => {
    const controller = new AbortController();
    const result = await readPublicKnowledgeSelection(store, { query: 'network', scope: {}, mode: 'search', signal: controller.signal });
    result.assertCurrent(); controller.abort(); expect(result.assertCurrent).toThrow();
    let current = true;
    const owned = await readPublicKnowledgeSelection(store, { query: 'network', scope: {}, mode: 'search' }, {
      assertCurrent() { if (!current) throw new Error('Retired caller'); },
    });
    current = false; expect(owned.assertCurrent).toThrow();
  });
  expect(requests).toHaveLength(0);
});

test('Classic semantic jobs are rejected before a run record or work is queued; local lint still runs', async () => {
  const { store } = await fixture(); let effects = 0; const requests = outage();
  const scheduler = new KnowledgeScheduleService({ store, emitIfReady() {}, async runJobByKind() { effects++; return {}; } });
  schedules.push(scheduler); await scheduler.whenReady();
  await under('Classic - Off', async () => {
    const before = store.listJobRuns().length;
    await expect(scheduler.runJob('knowledge-semantic-enrichment')).rejects.toMatchObject({ code: 'decision-models-disabled' });
    await expect(scheduler.runJob('knowledge-deep-consolidation')).rejects.toMatchObject({ code: 'decision-models-disabled' });
    expect(store.listJobRuns()).toHaveLength(before); expect(effects).toBe(0);
    const run = await scheduler.runJob('knowledge-lint', { mode: 'inline' });
    expect(run.status).toBe('completed'); expect(effects).toBe(1);
  });
  expect(requests).toHaveLength(0);
});

test('Classic semantic APIs report their limitation before initializing a store or generating answers', async () => {
  const requests = outage(); const root = mkdtempSync(join(tmpdir(), 'goodvibes-classic-semantic-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  let generated = 0;
  const service = new KnowledgeSemanticService(store, { llm: { async completeJson() { generated++; return null; }, async completeText() { generated++; return null; } } });
  await under('Classic - Off', async () => {
    await expect(service.enrichSource('unknown')).rejects.toMatchObject({ code: 'decision-models-disabled' });
    await expect(service.reindex()).rejects.toMatchObject({ code: 'decision-models-disabled' });
    await expect(service.answer({ query: 'network' })).rejects.toMatchObject({ code: 'decision-models-disabled' });
    await expect(service.selfImprove()).rejects.toMatchObject({ code: 'decision-models-disabled' });
    service.queueBackgroundSelfImprove({});
    expect(service.isBackgroundWorkPaused()).toBe(true);
  });
  expect(generated).toBe(0); expect(requests).toHaveLength(0);
});

test('Preferred preserves a scope rejection when a later relevance request is unavailable', async () => {
  const { store, context } = await fixture();
  await store.upsertSource({ id: 'rejected', connectorId: 'synthetic', sourceType: 'document',
    title: 'Network rejected catalog', summary: 'Network catalog navigation.', status: 'indexed', metadata: {} });
  const fake = fakePort((name, _question, state) => {
    if (name === 'included') return noulAnswer(JSON.stringify(state).includes('Network rejected catalog') ? 0.01 : 0.99);
    throw new JudgmentError('unavailable', 'Synthetic later relevance outage');
  });
  install(fake.port);
  await under('Preferred', async () => {
    const result = await searchKnowledge(context, 'network');
    expect(result.map(row => row.id)).toEqual(['ordinary']);
    expect(result[0]?.provenance).toBe('classic');
    expect(JSON.stringify(fake.requests.filter(request => 'useful' in request.questions))).not.toContain('Network rejected catalog');
  });
});

test('Preferred cannot revive a settled negative relevance reading after a sibling outage', async () => {
  const { store, context } = await fixture();
  await store.upsertSource({ id: 'later', connectorId: 'synthetic', sourceType: 'document',
    title: 'Network later source', summary: 'Network evidence.', status: 'indexed', metadata: {} });
  const recorded = Promise.withResolvers<void>();
  const fake = fakePort(name => noulAnswer(name === 'included' ? 0.99 : 0.01));
  install({ ...fake.port, async ask(request) {
    if ('useful' in request.questions && JSON.stringify(request.state).includes('Network later source')) {
      await recorded.promise;
      throw new JudgmentError('unavailable', 'Synthetic sibling outage after a recorded negative');
    }
    return { ...await fake.port.ask(request), decisionId: 'synthetic-knowledge-reading' };
  }, recorder: {
    recordReadings() {},
    recordAction(_id, action) { if (action.startsWith('settled evidence relevance no')) recorded.resolve(); },
  } });
  await under('Preferred', async () => {
    await expect(searchKnowledge(context, 'network')).rejects.toBeInstanceOf(Error);
    expect(context.store.listUsageRecords()).toEqual([]);
    expect(decisionModelPolicyState().operation).toBe('classic');
  });
});
