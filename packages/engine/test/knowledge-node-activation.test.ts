import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.ts';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { importHomeGraphSpace } from '../sdk/src/platform/knowledge/home-graph/import-export.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { KnowledgeNodeUpsertInput } from '../sdk/src/platform/knowledge/types.js';
import { KnowledgeNodeActivationHeldError as Held } from '../sdk/src/platform/knowledge/activation/types.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { upsertObservedKnowledgeNode, prepareObservedKnowledgeNodeInput, resolveKnowledgeNodeObservation } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { filterFactsForQuery } from '../sdk/src/platform/knowledge/semantic/answer-fact-selection.js';
import { isKnowledgePageFactCandidate } from '../sdk/src/platform/knowledge/semantic/fact-quality.js';
import { readHomeGraphSearchState } from '../sdk/src/platform/knowledge/home-graph/search.js';
import { registry } from '../sdk/src/platform/knowledge/activation/judgment-registry.js';
import { nodeServingWithoutReview } from '../sdk/src/platform/knowledge/activation/battery.js';

const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-activation-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath, nodeAutoAcceptConfidence: 0 });
  await store.init();
  await store.upsertSource({ id: 'manual', connectorId: 'synthetic', sourceType: 'manual', status: 'indexed', title: 'AC-7 manual', metadata: { privateField: 'SOURCE_PRIVATE' } });
  await store.upsertExtraction({ sourceId: 'manual', extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has four HDMI inputs and no wireless charging.', metadata: { privateField: 'EXTRACTION_PRIVATE' } });
  return { store, dbPath, reload: async () => { const next = new KnowledgeStore({ dbPath }); await next.init(); return next; } };
}
function input(id = 'fact', overrides: Partial<KnowledgeNodeUpsertInput> = {}): KnowledgeNodeUpsertInput {
  return { id, kind: 'fact', slug: id, title: 'AC-7 inputs', summary: 'AC-7 has four HDMI inputs.', sourceId: 'manual',
    metadata: { semanticKind: 'fact', factKind: 'specification', value: 'four HDMI inputs', evidence: 'AC-7 has four HDMI inputs.', privateField: 'NODE_PRIVATE' }, ...overrides };
}
function reading(probability = 0.99) { const fake = fakePort(() => noulAnswer(probability)); installJudgmentPort(fake.port); return fake; }
async function held(promise: Promise<unknown>, reason?: Held['reason']) {
  let error: unknown; try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Held); if (reason) expect((error as Held).reason).toBe(reason);
}

describe('synthesized knowledge serving authority', () => {
  test('observed nodes retain shared evidence without refreshing older proofs after an in-place edit', async () => {
    const { store } = await fixture();
    const evidence = { source: { title: 'Original source', sections: ['First section'] } };
    const prepare = (id: string) => prepareObservedKnowledgeNodeInput(store,
      { id, kind: 'topic', slug: id, title: id }, 'catalog-structure', evidence, () => evidence);
    const first = prepare('first'), second = prepare('second');
    const firstProof = resolveKnowledgeNodeObservation(first, undefined), secondProof = resolveKnowledgeNodeObservation(second, undefined);
    if (!firstProof || !secondProof) throw new Error('Missing native observations');
    firstProof.assertCurrent(); secondProof.assertCurrent();
    evidence.source.sections[0] = 'Changed section';
    expect(firstProof.assertCurrent).toThrow(Held); expect(secondProof.assertCurrent).toThrow(Held);
    const fresh = resolveKnowledgeNodeObservation(prepare('fresh'), undefined);
    expect(fresh).toBeDefined(); fresh!.assertCurrent();
    expect(firstProof.assertCurrent).toThrow(Held); expect(secondProof.assertCurrent).toThrow(Held);
    await store.close();
  });
  test('observed evidence accepts an equal replacement but refuses changed array fields and preserves owner failures', async () => {
    const { store } = await fixture();
    let current = { title: 'Declared evidence', values: ['Original'], extra: 'Complete' };
    const prepared = prepareObservedKnowledgeNodeInput(store, { id: 'replacement', kind: 'topic', slug: 'replacement', title: 'Replacement' },
      'catalog-structure', current, () => current);
    const proof = resolveKnowledgeNodeObservation(prepared, undefined);
    if (!proof) throw new Error('Missing native observation');
    current = { extra: 'Complete', values: ['Original'], title: 'Declared evidence' };
    proof.assertCurrent();
    Object.defineProperty(current.values, 'meaning', { value: 'Changed named array field', enumerable: true });
    expect(proof.assertCurrent).toThrow(Held);
    const ownerFailure = new Error('Owner retired');
    const cancelled = prepareObservedKnowledgeNodeInput(store, { id: 'cancelled', kind: 'topic', slug: 'cancelled', title: 'Cancelled' },
      'catalog-structure', null, () => { throw ownerFailure; });
    expect(() => resolveKnowledgeNodeObservation(cancelled, undefined)).toThrow(ownerFailure);
    await store.close();
  });
  test('native observation binds the frozen producer input and exact previous node without reusable digest fields', async () => {
    const { store } = await fixture();
    try {
      const source = store.getSource('manual');
      const original = await upsertObservedKnowledgeNode(store, { id: 'observed-input', kind: 'topic', slug: 'observed-input', title: 'Declared topic' },
        'catalog-structure', source, () => store.getSource('manual'));
      const candidate = prepareObservedKnowledgeNodeInput(store, { ...original, title: 'Updated declaration', metadata: { declared: 'one' } },
        'catalog-structure', source, () => store.getSource('manual'));
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.metadata)).toBe(true);
      expect(resolveKnowledgeNodeObservation(candidate, original)).toBeDefined();
      expect(resolveKnowledgeNodeObservation({ ...candidate }, original)).toBeUndefined();
      await store.upsertNode({ ...original, status: 'stale' });
      expect(() => resolveKnowledgeNodeObservation(candidate, store.getNode(original.id) ?? undefined)).toThrow(Held);
    } finally { await store.close(); }
  });
  test('registered high-stakes battery contains labelled positive and adversarial cases', () => {
    expect(registry.list().map(({ name }) => name)).toEqual([nodeServingWithoutReview.name]);
    expect(nodeServingWithoutReview.items.serve.band.yes.actAt).toBe(0.85);
    expect(nodeServingWithoutReview.fixtures.some(({ expect: labels }) => labels.serve === 'no')).toBe(true);
    expect(nodeServingWithoutReview.fixtures.some(({ expect: labels }) => labels.serve === 'yes')).toBe(true);
  });
  test('missing and both numeric scales cannot activate without a reader', async () => {
    const { store } = await fixture();
    for (const [index, confidence] of [undefined, 0.9, 1, 99, 100].entries()) {
      const node = await store.upsertNode(input(`score-${index}`, { ...(confidence === undefined ? {} : { confidence }), status: 'active' }));
      expect(node.status).toBe('draft');
      expect(node.metadata.reviewProvenance).toMatchObject({ state: 'pending-review' });
      expect(node.confidence).toBe(confidence ?? 0);
    }
  });
  test('nonfinite confidence is rejected before storing a node', async () => {
    const { store } = await fixture();
    for (const [index, confidence] of [NaN, Infinity, -Infinity].entries()) {
      const id = `nonfinite-${index}`;
      await expect(store.upsertNode(input(id, { confidence, status: 'active' }))).rejects.toThrow('arguments must be plain JSON data');
      expect(store.getNode(id)).toBeNull();
    }
  });
  test('supported low score activates and unsupported high score remains pending without score inflation', async () => {
    const { store } = await fixture(); const fake = reading();
    const low = await store.upsertNode(input('low', { confidence: 0.9 }));
    expect(low.status).toBe('active'); expect(low.confidence).toBe(0.9);
    expect(low.metadata.nodeActivation).toMatchObject({ outcome: 'accepted', probability: 0.99, battery: nodeServingWithoutReview.name });
    const request = JSON.stringify(fake.requests);
    for (const privateValue of ['NODE_PRIVATE', 'SOURCE_PRIVATE', 'EXTRACTION_PRIVATE', 'createdAt', 'updatedAt']) expect(request).not.toContain(privateValue);
    expect(request).toContain('no wireless charging');
    reading(0.01); const high = await store.upsertNode(input('high', { confidence: 100 }));
    expect(high.status).toBe('draft'); expect(high.confidence).toBe(100);
  });
  test('explicit legacy owner restrictions only add holds and invalid restrictions fail configuration', async () => {
    const base = await fixture(); reading();
    const restricted = new KnowledgeStore({ dbPath: base.dbPath, nodeAutoAcceptConfidence: 100 }); await restricted.init();
    const heldNode = await restricted.upsertNode(input('restricted', { confidence: 99 }));
    expect(heldNode.status).toBe('draft'); expect(heldNode.metadata.nodeActivation).toMatchObject({ reason: 'owner-confidence-floor', probability: 0.99 });
    expect((await restricted.upsertNode(input('allowed', { confidence: 100 }))).status).toBe('active');
    reading(0.01); expect((await restricted.upsertNode(input('unsupported', { confidence: 100 }))).status).toBe('draft');
    for (const floor of [NaN, Infinity, -1, 101]) expect(() => new KnowledgeStore({ dbPath: base.dbPath, nodeAutoAcceptConfidence: floor })).toThrow(RangeError);
  });
  test('missing or foreign source evidence cannot be endorsed even by an all-yes fake', async () => {
    const { store } = await fixture(); const fake = reading();
    expect((await store.upsertNode(input('missing', { sourceId: 'absent' }))).status).toBe('draft');
    expect((await store.upsertNode(input('foreign', { metadata: { knowledgeSpaceId: 'foreign' } }))).status).toBe('draft');
    expect(fake.requests).toHaveLength(0);
  });
  test('uncertain and malformed readings stage new nodes honestly', async () => {
    const { store } = await fixture();
    for (const [index, score] of [0.5, 0.8, NaN, Infinity, 1.1, -1].entries()) {
      reading(score); const node = await store.upsertNode(input(`held-${index}`));
      expect(node.status).toBe('draft'); expect(node.metadata.reviewProvenance).toMatchObject({ state: 'pending-review' });
    }
  });
  test('an uninspected known reference stays unverified while actual independent evidence may support serving', async () => {
    const { store } = await fixture();
    await store.upsertSource({ id: 'uninspected', connectorId: 'synthetic', sourceType: 'manual', title: 'Uninspected reference', status: 'indexed' });
    const fake = reading();
    const node = await store.upsertNode(input('shared', { sourceId: 'uninspected', metadata: { sourceIds: ['manual', 'uninspected'] } }));
    expect(node.status).toBe('active');
    const request = JSON.stringify(fake.requests); expect(request).toContain('missing-extraction'); expect(request).toContain('primaryReference'); expect(request).toContain('four HDMI inputs');
    expect((await store.upsertNode(input('unknown', { metadata: { sourceIds: ['manual', 'absent'] } }))).status).toBe('draft');
  });
  test('all supplied sources, including contradictions, reach the same candidate reading', async () => {
    const { store } = await fixture();
    await store.upsertSource({ id: 'contradiction', connectorId: 'synthetic', sourceType: 'manual', status: 'indexed' });
    await store.upsertExtraction({ sourceId: 'contradiction', extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has two HDMI inputs.' });
    const fake = reading(0.01);
    expect((await store.upsertNode(input('conflict', { metadata: { sourceIds: ['manual', 'contradiction'] } }))).status).toBe('draft');
    const request = JSON.stringify(fake.requests); expect(request).toContain('four HDMI'); expect(request).toContain('two HDMI');
  });
  test('copied active status and review/activation receipt JSON confer no authority', async () => {
    const { store } = await fixture(); reading(); const original = await store.upsertNode(input());
    installJudgmentPort(undefined);
    const copied = await store.upsertNode({ ...original, id: 'copy', slug: 'copy', metadata: { ...original.metadata,
      review: { action: 'accept', reviewer: 'operator', authority: 'operator' } } });
    expect(copied.status).toBe('draft'); expect(copied.metadata.review).toBeUndefined();
    expect(copied.metadata.nodeActivation).toMatchObject({ outcome: 'pending-review' });
  });
  test('unchanged active replay is idempotent but replacement must be freshly read', async () => {
    const { store, dbPath, reload } = await fixture(); const fake = reading();
    const original = await store.upsertNode(input()); const bytes = readFileSync(dbPath);
    expect(await store.upsertNode({ ...original })).toEqual(original); expect(fake.requests).toHaveLength(1);
    reading(0.01);
    await held(store.upsertNode({ ...original, summary: 'AC-7 supports wireless charging.' }), 'no');
    expect(store.getNode(original.id)).toEqual(original); expect(readFileSync(dbPath)).toEqual(bytes);
    expect((await reload()).getNode(original.id)).toEqual(original);
    expect(store.listNodeRevisions(original.id)).toHaveLength(1);
  });
  test('metadata insertion order does not turn an unchanged activation replay into a new model reading', async () => {
    const { store, dbPath } = await fixture(); const fake = reading();
    const original = await store.upsertNode(input('ordered-replay', { metadata: { first: 'same', second: 'meaning' } }));
    const bytes = readFileSync(dbPath);
    const reordered = Object.fromEntries(Object.entries(original.metadata).reverse());
    expect(await store.upsertNode({ ...original, metadata: reordered })).toEqual(original);
    expect(fake.requests).toHaveLength(1);
    expect(readFileSync(dbPath)).toEqual(bytes);
  });
  test('a producer cannot hide replacement of served content inside a draft or stale status', async () => {
    const { store } = await fixture(); const fake = reading(); const original = await store.upsertNode(input());
    for (const status of ['draft', 'stale'] as const) await held(store.upsertNode({ ...original, status, summary: 'Unreviewed replacement' }), 'replacement-requires-review');
    expect(fake.requests).toHaveLength(1); expect(store.getNode(original.id)).toEqual(original);
    expect((await store.upsertNode({ ...original, status: 'stale', metadata: { ...original.metadata, supersededAt: 123 } })).status).toBe('stale');
  });
  test('changed extraction requires a fresh reading even for identical active content', async () => {
    const { store } = await fixture(); reading(); const original = await store.upsertNode(input());
    await store.upsertExtraction({ sourceId: 'manual', extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has two inputs.' });
    const fake = reading(0.01); await held(store.upsertNode({ ...original }), 'no');
    expect(fake.requests).toHaveLength(1); expect(store.getNode(original.id)).toEqual(original);
  });
  test('whole-pass protected later input causes zero requests and zero writes', async () => {
    const { store } = await fixture(); const fake = reading();
    await expect(store.prepareNodeWrites([input('first'), input('secret', { summary: 'api_key=synthetic-inline-secret' })])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0); expect(store.listNodes()).toHaveLength(0);
  });
  test('unknown-origin reference strings retain the complete protected-input boundary', async () => {
    const { store } = await fixture(); const fake = reading();
    await expect(store.upsertNode(input('hint', { metadata: { targetHints: [{ id: 'Authorization: Bearer synthetic-private-hint' }] } }))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0); expect(store.listNodes()).toHaveLength(0);
  });
  test('later hold rejects a composed serving pass before earlier nodes or revisions are written', async () => {
    const { store } = await fixture();
    const fake = fakePort((_name, _question, state) => noulAnswer((state as { candidate: { title: string } }).candidate.title === 'second' ? 0.5 : 0.99));
    installJudgmentPort(fake.port);
    await held(store.prepareNodeWrites([input('first'), input('second', { title: 'second' })], { requireAccepted: true }), 'uncertain');
    expect(store.listNodes()).toHaveLength(0); expect(store.listNodeRevisions('first')).toHaveLength(0);
  });
  test('prepared authority is nonforgeable, store-scoped and consumes each slot once', async () => {
    const { store } = await fixture(); reading(); const prepared = await store.prepareNodeWrites([input()]);
    await held(store.upsertPreparedNode({ ...prepared }, 0), 'malformed');
    const other = await fixture(); await held(other.store.upsertPreparedNode(prepared, 0), 'malformed');
    expect((await store.upsertPreparedNode(prepared, 0)).status).toBe('active');
    await held(store.upsertPreparedNode(prepared, 0), 'stale');
  });
  test('unique kind/slug conflicts cannot replace a reviewed SQL row through any write path', async () => {
    const { store, dbPath, reload } = await fixture(); reading();
    const draft = await store.upsertNode(input('reviewed', { slug: 'reserved' }));
    const reviewed = (await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'accept' })).node!;
    const other = await store.upsertNode(input('other', { slug: 'other' }));
    const bytes = readFileSync(dbPath), history = store.listNodeRevisions(reviewed.id); const fake = reading();
    await held(store.upsertNode(input('new-id', { slug: reviewed.slug })), 'stale');
    await held(store.upsertNode({ ...other, slug: reviewed.slug }), 'stale');
    await held(store.replaceNodeRecord({ ...other, slug: reviewed.slug }), 'stale');
    let guardedWrites = 0;
    await held(store.applyGuardedNodeIssueWrites({ nodes: [{ ...reviewed }, { ...other, slug: reviewed.slug }], issues: [] }, () => { guardedWrites++; }), 'stale');
    expect(guardedWrites).toBe(0); expect(fake.requests).toHaveLength(0); expect(readFileSync(dbPath)).toEqual(bytes);
    expect(store.getNode(reviewed.id)).toEqual(reviewed); expect(store.getNode(other.id)).toEqual(other);
    expect(store.listNodeRevisions(reviewed.id)).toEqual(history); expect(store.getNode('new-id')).toBeNull();
    const reopened = await reload(); expect(reopened.getNode(reviewed.id)).toEqual(reviewed);
    expect(reopened.getNode(other.id)).toEqual(other); expect(reopened.listNodes()).toHaveLength(2);
  });
  test('within-pass identity collisions hold before any model request or partial write', async () => {
    const { store } = await fixture(); const fake = reading();
    await held(store.prepareNodeWrites([input('first', { slug: 'same' }), input('second', { slug: 'same' })]), 'stale');
    expect(fake.requests).toHaveLength(0); expect(store.listNodes()).toHaveLength(0);
  });
  test('preparation freezes caller and request inputs', async () => {
    const { store } = await fixture();
    const candidate = input(); const pending = store.prepareNodeWrites([candidate]);
    candidate.metadata!.value = 'forged';
    const prepared = await pending; const node = await store.upsertPreparedNode(prepared, 0);
    expect(node.metadata.value).toBe('four HDMI inputs'); expect(node.status).toBe('draft');
  });
  test('source or operator changes during an awaited reading prevent its late write', async () => {
    for (const change of ['source', 'operator'] as const) {
      const { store } = await fixture(); const draft = await store.upsertNode(input('fact', { status: 'draft' })); const fake = reading();
      let release!: () => void, started!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { started = resolve; });
      installJudgmentPort({ ...fake.port, async ask(request) { expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.state)).toBe(true); started(); await waiting; return fake.port.ask(request); } });
      const pending = store.upsertNode({ ...draft, status: 'active' }); await entered;
      if (change === 'source') await store.upsertSource({ ...store.getSource('manual')!, summary: 'Changed while reading' });
      else await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'reject' });
      const retained = store.getNode(draft.id); release(); await held(pending, 'stale'); expect(store.getNode(draft.id)).toEqual(retained);
    }
  });
  test('source edits and same-model provider replacement invalidate prepared authority', async () => {
    const { store } = await fixture(); reading(); const prepared = await store.prepareNodeWrites([input()]);
    reading(); await held(store.upsertPreparedNode(prepared, 0), 'stale');
    const next = await store.prepareNodeWrites([input()]);
    await store.upsertSource({ id: 'manual', connectorId: 'synthetic', sourceType: 'manual', status: 'stale' });
    await held(store.upsertPreparedNode(next, 0), 'stale'); expect(store.listNodes()).toHaveLength(0);
  });
  test('operator decision after prepare holds the late write and retains exact review', async () => {
    const { store } = await fixture(); const draft = await store.upsertNode(input()); reading();
    const prepared = await store.prepareNodeWrites([{ ...draft, status: 'active' }]);
    const reviewed = (await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'reject' })).node!;
    await held(store.upsertPreparedNode(prepared, 0), 'stale'); expect(store.getNode(draft.id)).toEqual(reviewed);
  });
  test('bounded timeout and cancellation settle even if the port ignores its signal', async () => {
    const { store } = await fixture(); const fake = reading();
    installJudgmentPort({ ...fake.port, ask: () => new Promise(() => {}) });
    await held(store.prepareNodeWrites([input()], { timeoutMs: 5 }), 'budget');
    const controller = new AbortController(); const pending = store.prepareNodeWrites([input()], { signal: controller.signal });
    setTimeout(() => controller.abort(), 5); await held(pending, 'aborted'); expect(store.listNodes()).toHaveLength(0);
  });
  test('trusted explicit operator decisions need no semantic provider', async () => {
    const { store } = await fixture(); const draft = await store.upsertNode(input());
    const accepted = (await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'accept' })).node!;
    expect(accepted.status).toBe('active'); expect(accepted.metadata.reviewProvenance).toMatchObject({ state: 'reviewed' });
    expect((await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'reject' })).node!.status).toBe('stale');
  });
  test('raw observation capability preserves mapping without approving copied or modified synthesis', async () => {
    const { store } = await fixture(); const source = store.getSource('manual');
    const node = await upsertObservedKnowledgeNode(store, { id: 'observed', kind: 'topic', slug: 'hdmi', title: 'HDMI', metadata: { taint: 'untrusted', tag: 'HDMI' } }, 'catalog-structure', source, () => store.getSource('manual'));
    expect(node.status).toBe('active'); expect(node.metadata.taint).toBe('untrusted'); expect(node.metadata.review).toBeUndefined();
    expect((await store.upsertNode({ ...node, id: 'copy', slug: 'copy' })).status).toBe('draft');
    await held(store.upsertNode({ ...node, summary: 'Unsupported new content' }), 'unconfigured');
    expect(store.getNode(node.id)).toEqual(node);
  });
  test('observed derived writes bind raw evidence and require explicit refresh after restart', async () => {
    const { store, reload } = await fixture();
    const raw = { id: 'raw', kind: 'ha_device' as const, slug: 'raw', title: 'Virtual automation helper',
      sourceId: 'snapshot', metadata: { homeAssistant: { objectKind: 'device', objectId: 'virtual-helper' }, attributes: { device_class: 'software' } } };
    const source = await store.upsertSource({ id: 'snapshot', connectorId: 'synthetic', sourceType: 'dataset', status: 'indexed' });
    const observed = await upsertObservedKnowledgeNode(store, raw, 'home-assistant-snapshot', source, () => store.getSource(source.id));
    const fake = reading();
    const derived = await store.upsertNode({ ...observed, metadata: { batteryPowered: false } });
    expect(derived.status).toBe('active'); expect(JSON.stringify(fake.requests)).toContain('observedEvidence');
    const restarted = await reload(); const old = restarted.getNode(raw.id)!;
    await held(restarted.upsertNode({ ...old, metadata: { manualRequired: false } }), 'observation-revalidation');
    expect(restarted.getNode(raw.id)).toEqual(old);
    const freshSource = restarted.getSource(source.id);
    const refreshed = await upsertObservedKnowledgeNode(restarted, raw, 'home-assistant-snapshot', freshSource, () => restarted.getSource(source.id));
    expect((await restarted.upsertNode({ ...refreshed, metadata: { manualRequired: false } })).status).toBe('active');
    const copied = await restarted.upsertNode({ ...refreshed, id: 'copy-observation', slug: 'copy-observation' });
    expect(copied.status).toBe('draft'); expect(copied.metadata.nodeObservation).toBeUndefined();
  });
  test('guarded derived node/issue writes complete activation before their synchronous all-or-none guard', async () => {
    const { store } = await fixture(); reading();
    const first = await store.upsertNode(input('first')); const second = await store.upsertNode(input('second'));
    const issue = await store.upsertIssue({ id: 'issue', severity: 'warning', code: 'synthetic', message: 'Review me', nodeId: first.id });
    const before = JSON.stringify({ nodes: store.listNodes(), issues: store.listIssues() });
    const fake = fakePort((_name, _question, state) => noulAnswer((state as { candidate: { title: string } }).candidate.title === 'held' ? 0.5 : 0.99));
    installJudgmentPort(fake.port); let guards = 0;
    await held(store.applyGuardedNodeIssueWrites({ nodes: [{ ...first, title: 'supported' }, { ...second, title: 'held' }],
      issues: [{ ...issue, status: 'resolved' }] }, () => { guards++; }), 'uncertain');
    expect(guards).toBe(0); expect(JSON.stringify({ nodes: store.listNodes(), issues: store.listIssues() })).toBe(before);
    reading(); await store.applyGuardedNodeIssueWrites({ nodes: [{ ...first, title: 'supported' }], issues: [{ ...issue, status: 'resolved' }] }, () => { guards++; });
    expect(guards).toBe(1); expect(store.getNode(first.id)!.title).toBe('supported'); expect(store.getIssue(issue.id)!.status).toBe('resolved');
  });
  test('import preflights every selected candidate before raw writes and cannot copy observation/review authority', async () => {
    const { store, dbPath } = await fixture(); const fake = reading();
    const first: KnowledgeNodeRecord = { ...input('import-one'), id: 'import-one', aliases: [], status: 'active', confidence: 100,
      metadata: { review: { action: 'accept', reviewer: 'operator' }, nodeObservation: { origin: 'home-assistant-snapshot' } }, createdAt: 1, updatedAt: 1 };
    const second: KnowledgeNodeRecord = { ...first, id: 'import-two', slug: 'import-two', summary: 'Authorization: Bearer synthetic-import-secret' };
    const data = { version: 1 as const, exportedAt: 1, spaceId: 'default', installationId: 'fixture', sources: store.listSources(),
      nodes: [first, second], edges: [], issues: [], extractions: store.listExtractions() };
    const before = readFileSync(dbPath);
    await expect(importHomeGraphSpace(store, { spaceId: 'default', installationId: 'fixture', data })).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0); expect(readFileSync(dbPath)).toEqual(before); expect(store.listNodes()).toHaveLength(0);
    installJudgmentPort(undefined);
    await importHomeGraphSpace(store, { spaceId: 'default', installationId: 'fixture', data: { ...data, nodes: [first] } });
    const imported = store.getNode(first.id)!; expect(imported.status).toBe('draft');
    expect(imported.metadata.review).toBeUndefined(); expect(imported.metadata.nodeObservation).toBeUndefined();
  });
  test('drafts remain reviewable but cannot enter answer ranking, Home Graph search or passport facts', async () => {
    const { store } = await fixture(); const draft = await store.upsertNode(input());
    const fake = reading(); expect(await filterFactsForQuery('HDMI inputs', [draft])).toEqual([]); expect(fake.requests).toHaveLength(0);
    expect(isKnowledgePageFactCandidate(draft)).toBe(false);
    expect(readHomeGraphSearchState(store, 'global').nodes).not.toContainEqual(draft);
    expect(store.getNode(draft.id)).toEqual(draft);
  });
});


describe('Classic knowledge activation disposition', () => {
  test('stores persistent untrusted drafts without borrowing model metadata or fabricating a semantic receipt', async () => {
    const { store, reload } = await fixture(); let asks = 0, metadata = 0;
    installJudgmentPort({ get model(): never { metadata++; throw new Error('Classic borrowed model metadata'); },
      get recorder(): never { metadata++; throw new Error('Classic borrowed recorder'); }, async ask() { asks++; throw new Error('Classic must not ask'); } });
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const node = await store.upsertNode(input('classic', { status: 'active', confidence: 100 }));
      expect(node.status).toBe('draft');
      expect(node.metadata.reviewProvenance).toMatchObject({ state: 'pending-review' });
      expect(node.metadata.nodeActivation).toMatchObject({ outcome: 'pending-review', reason: 'decision-model-disabled', operationProvenance: 'classic', semanticAssessment: 'not-evaluated' });
      const activation = node.metadata.nodeActivation as Record<string, unknown>;
      for (const field of ['battery', 'version', 'decisionId', 'model', 'requestedModel', 'probability']) expect(activation[field]).toBeUndefined();
      const next = await reload(); expect(next.getNode(node.id)).toEqual(node); await next.close();
      expect(asks).toBe(0); expect(metadata).toBe(0);
    });
  });

  test('native observation, unchanged active replay and explicit owner review work without decision models', async () => {
    const { store } = await fixture(); let asks = 0;
    installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('Classic must not ask'); } });
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const source = store.getSource('manual');
      const observed = await upsertObservedKnowledgeNode(store, { id: 'native', kind: 'topic', slug: 'native', title: 'Native declaration' }, 'catalog-structure', source, () => store.getSource('manual'));
      expect(observed.status).toBe('active'); expect((await store.upsertNode({ ...observed })).status).toBe('active');
      const draft = await store.upsertNode(input('manual-review'));
      const reviewed = (await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'accept' })).node;
      expect(reviewed?.status).toBe('active'); expect(reviewed?.metadata.reviewProvenance).toMatchObject({ state: 'reviewed' });
      expect(asks).toBe(0);
    });
  });

  test('changed active content and requireAccepted cannot turn an unassessed draft into a serving node', async () => {
    const { store, dbPath } = await fixture(); reading(); const active = await store.upsertNode(input('active'));
    let asks = 0; installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('Classic must not ask'); } });
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const bytes = readFileSync(dbPath);
      await held(store.upsertNode({ ...active, summary: 'Unreviewed replacement' }), 'decision-model-disabled');
      await held(store.prepareNodeWrites([input('require-active')], { requireAccepted: true }), 'decision-model-disabled');
      expect(store.getNode('require-active')).toBeNull(); expect(store.getNode(active.id)).toEqual(active); expect(readFileSync(dbPath)).toEqual(bytes);
      const prepared = await store.prepareNodeWrites([input('stale-source')]);
      await store.upsertExtraction({ sourceId: 'manual', extractorId: 'synthetic', format: 'text', excerpt: 'Changed native evidence' });
      await held(store.upsertPreparedNode(prepared, 0), 'stale'); expect(store.getNode('stale-source')).toBeNull(); expect(asks).toBe(0);
    });
  });

  test('Preferred typed exhaustion produces the same native pending state without a fabricated reading', async () => {
    const { store } = await fixture(); let asks = 0;
    installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new JudgmentError('unavailable', 'fixture exhausted'); } });
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      const node = await store.upsertNode(input('exhausted'));
      expect(node).toMatchObject({ status: 'draft', metadata: { nodeActivation: { operationProvenance: 'classic', reason: 'decision-model-disabled' } } });
      expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
      expect((await store.upsertNode(input('subsequent'))).status).toBe('draft'); expect(asks).toBe(1);
    });
  });

  test('Preferred later exhaustion retains a completed semantic no and never upgrades it', async () => {
    const { store } = await fixture(); const negative = fakePort(() => noulAnswer(0.01));
    installJudgmentPort({ model: negative.port.model, async ask(request) {
      const state = request.state as { candidate?: { title?: string } };
      if (state.candidate?.title === 'Explicitly unsupported') return negative.port.ask(request);
      await new Promise(resolve => setTimeout(resolve, 0));
      throw new JudgmentError('unavailable', 'fixture exhausted');
    } });
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      const prepared = await store.prepareNodeWrites([input('refused', { title: 'Explicitly unsupported' }), input('outage')]);
      const refused = await store.upsertPreparedNode(prepared, 0), pending = await store.upsertPreparedNode(prepared, 1);
      expect(refused.status).toBe('draft'); expect(refused.metadata.nodeActivation).toMatchObject({ reason: 'no', probability: 0.01 });
      expect(pending.status).toBe('draft'); expect(pending.metadata.nodeActivation).toMatchObject({ reason: 'decision-model-disabled', operationProvenance: 'classic' });
    });
  });

  for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'unrecorded'] as const) {
    test(`activation ${kind} is a real hold and cannot activate Preferred fallback`, async () => {
      const { store } = await fixture();
      installJudgmentPort({ model: 'fixture', async ask() { throw new JudgmentError(kind, 'fixture failure'); } });
      await withDecisionModelPolicy(() => 'Preferred', async () => {
        const node = await store.upsertNode(input(kind));
        expect(node.status).toBe('draft'); expect(node.metadata.nodeActivation).toMatchObject({ reason: kind === 'invalid-response' ? 'malformed' : kind });
        expect(decisionModelPolicyState().operation).toBe('decision');
      });
    });
  }

  test('Classic cancellation, stale native authority and invalid budgets remain holds before writes', async () => {
    const { store } = await fixture(); const abort = new AbortController(); abort.abort();
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      await held(store.prepareNodeWrites([input('cancelled')], { signal: abort.signal }), 'aborted');
      await held(store.prepareNodeWrites([input('retired')], { assertCurrent() { throw new JudgmentError('unavailable', 'native guard is not a provider outage'); } }), 'stale');
      await held(store.prepareNodeWrites([input('budget')], { timeoutMs: -1 }), 'budget');
      expect(['cancelled', 'retired', 'budget'].map(id => store.getNode(id))).toEqual([null, null, null]);
    });
  });
});


test('a native authority or model metadata error cannot masquerade as Preferred availability exhaustion', async () => {
  const { store } = await fixture(); let asks = 0;
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await held(store.prepareNodeWrites([input('native-retired')], { assertCurrent() { throw new JudgmentError('unavailable', 'native owner retired'); } }), 'stale');
    installJudgmentPort({ get model(): never { throw new JudgmentError('unavailable', 'invalid local metadata getter'); }, async ask() { asks++; throw new Error('must not ask'); } });
    await held(store.upsertNode(input('bad-metadata')), 'malformed');
    expect(store.getNode('native-retired')).toBeNull(); expect(store.getNode('bad-metadata')).toBeNull();
    expect(decisionModelPolicyState().operation).toBe('decision'); expect(asks).toBe(0);
  });
});
