import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VerificationStore } from '../sdk/src/platform/core/verification/store.js';
import { issueVerificationSource, verificationSources, verificationWireSource } from '../sdk/src/platform/core/verification/source.js';
import { retainedDelegationSources } from '../sdk/src/platform/core/verification/delegated-history.js';
import { citedReadSources, nativeReadReceipts } from '../sdk/src/platform/core/verification/read-receipts.js';
import { observeReadContent } from '../sdk/src/platform/tools/read/observation.js';
import type { VerificationSourceInput } from '../sdk/src/platform/core/verification/types.js';
import { CompletionVerification } from '../sdk/src/platform/core/verification/coordinator.js';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { verificationWriter } from './_helpers/verification.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function journal() {
  const root = mkdtempSync(join(tmpdir(), 'verification-source-owner-')); roots.push(root);
  const session = 'native-source-owner';
  return { root, session, path: join(root, '.goodvibes', 'verification', session + '.jsonl'),
    store: new VerificationStore(root, session) };
}
const source = (): VerificationSourceInput => ({ kind: 'observation', reference: 'native tool call; complete source', text: 'Actual returned bytes.',
  messageRole: 'tool', completeMessage: true, execution: { callId: 'actual-call', tool: 'read', exactArguments: { path: 'source.ts' } } });

test('unchanged source records reuse owned IDs without another journal write, including after restart', () => {
  const f = journal(); const input = source();
  const first = f.store.retainSource(input), bytes = readFileSync(f.path, 'utf8');
  expect(f.store.retainSource(structuredClone(input))).toBe(first);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  const reopened = new VerificationStore(f.root, f.session);
  const restored = reopened.retainSource(structuredClone(input));
  expect(restored.id).toBe(first.id);
  expect(restored.text).toBe(input.text);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  expect(Object.isFrozen(restored)).toBe(true);
});

test('each changed source or execution attribution receives a new native record, preserving prior bytes', () => {
  const store = new VerificationStore(); const input = source();
  const first = store.retainSource(input);
  const changed = store.retainSource({ ...input, text: 'A changed returned body.' });
  const restored = store.retainSource(input);
  const otherExecution = store.retainSource({ ...input, execution: { ...input.execution, callId: 'another-call' } });
  const parentChanged = store.retainSource({ ...input, originalIds: ['actual-parent'] });
  expect(new Set([first.id, changed.id, restored.id, otherExecution.id, parentChanged.id]).size).toBe(5);
  expect(store.sources.get(first.id)?.text).toBe('Actual returned bytes.');
  expect(store.sources.get(changed.id)?.text).toBe('A changed returned body.');
  expect(verificationWireSource(parentChanged)).not.toHaveProperty('originalIds');
});

test('restoration treats earlier record IDs as opaque and never derives them again from text', () => {
  const f = journal(); const prior = { ...source(), id: 'previously-issued-native-reference' };
  f.store.rememberSource(prior);
  const reopened = new VerificationStore(f.root, f.session);
  expect(reopened.retainSource(source()).id).toBe(prior.id);
  const otherOwner = new VerificationStore();
  expect(otherOwner.retainSource(source()).id).not.toBe(prior.id);
  expect(issueVerificationSource(source()).id).not.toBe(issueVerificationSource(source()).id);
});

test('retrieval indexes compare every native member and preview, and keep their issued IDs on restart', () => {
  const f = journal();
  const index = { representation: 'source-index' as const, children: [], sourceIds: ['first-source', 'middle-source', 'last-source'],
    summary: { facts: [{ text: 'RETRIEVAL INDEX ONLY; open the actual originals.', sources: [] }], concerns: [] } };
  const first = f.store.retainIndex(index);
  expect(f.store.retainIndex(structuredClone(index))).toBe(first);
  const changed = { ...index, sourceIds: ['first-source', 'different-middle', 'last-source'] };
  const second = f.store.retainIndex(changed);
  expect(second.id).not.toBe(first.id);
  const differentPreview = f.store.retainIndex({ ...changed, summary: { facts: [{ text: 'A different preview.', sources: [] }], concerns: [] } });
  expect(differentPreview.id).not.toBe(second.id);
  const current = f.store.retainIndex(changed), bytes = readFileSync(f.path, 'utf8');
  const reopened = new VerificationStore(f.root, f.session);
  expect(reopened.retainIndex(changed).id).toBe(current.id);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  expect(current.representation).toBe('source-index');
});

test('changed qualified summaries retire their native identity without rewriting earlier summary records', () => {
  const f = journal();
  const evidence = { representation: 'jev-qualified' as const, children: ['s-child'], sourceIds: ['s-original'],
    summary: { facts: [{ text: 'The original source says A.', sources: ['s-child'] }], concerns: [] } };
  const first = f.store.retainEvidence(evidence);
  const changed = { ...evidence, summary: { facts: [{ text: 'The original source says B.', sources: ['s-child'] }], concerns: [] } };
  const second = f.store.retainEvidence(changed);
  expect(second.id).not.toBe(first.id);
  expect(first.summary.facts[0]?.text).toBe('The original source says A.');
  const bytes = readFileSync(f.path, 'utf8');
  expect(new VerificationStore(f.root, f.session).retainEvidence(changed).id).toBe(second.id);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('live atomic-qualification revisions follow complete admitted proposal values rather than a reused proposal slot', () => {
  const store = new VerificationStore();
  const proposed = { facts: [{ text: 'An actual proposed fact.', sources: ['source-one'] }], concerns: [] };
  const first = store.retainProposalRevision('native-proposal-slot', proposed);
  expect(store.retainProposalRevision('native-proposal-slot', structuredClone(proposed))).toBe(first);
  const changed = store.retainProposalRevision('native-proposal-slot', { ...proposed, concerns: [{ text: 'Contrary evidence.', sources: ['source-one'] }] });
  expect(changed).not.toBe(first);
  expect(store.retainProposalRevision('native-proposal-slot', proposed)).not.toBe(first);
});

test('unchanged persisted sources and summaries avoid another private draft on restart but still receive fresh Jev checks', async () => {
  const f = journal(), firstPort = fakePort(() => noulAnswer(0.01));
  const full = { request: 'Review all source and write review.md.', response: 'The report is saved in review.md.',
    transcript: [{ role: 'tool', callId: 'read-source', content: 'Retained original source line. '.repeat(1_500) }],
    tools: ['read', 'write'], delegated: [], requirements: null, initial: null, previousReview: null };
  let drafts = 0;
  const first = new CompletionVerification(async request => { drafts++; return verificationWriter(request); }, f.store);
  expect((await first.prepare(full, { port: firstPort.port, identity: {}, assertCurrent() {} })).findings).toHaveLength(0);
  expect(drafts).toBeGreaterThan(1);
  const secondPort = fakePort(() => noulAnswer(0.01));
  const reopened = new CompletionVerification(async () => { throw new Error('Unchanged retained source must not require another private draft'); },
    new VerificationStore(f.root, f.session));
  expect((await reopened.prepare(full, { port: secondPort.port, identity: {}, assertCurrent() {} })).findings).toHaveLength(0);
  expect(secondPort.requests.some(request => request.context?.battery === 'engine.verification.evidence')).toBe(true);
  expect(secondPort.requests.some(request => request.context?.battery === 'engine.verification.requirement')).toBe(true);
});

test('selected read and citation sources retain exact provenance and reuse their native IDs after restart', () => {
  const f = journal();
  const content = '1 | First actual source line.\n2 | Second actual source line.';
  const file = { path: 'source.ts', content, readObservation: observeReadContent(content, 1, 2, true) };
  const state = { request: 'Review this file.', transcript: [
    { role: 'assistant', toolCalls: [{ id: 'read-source', name: 'read', arguments: { path: 'source.ts' } }] },
    { role: 'tool', callId: 'read-source', outcome: 'ok', content: JSON.stringify({ success: true, files: [file] }) },
  ] };
  const read = (store: VerificationStore) => {
    const own = (value: VerificationSourceInput) => store.retainSource(value);
    const originals = verificationSources(state, own);
    const native = nativeReadReceipts(originals, own);
    const citations = citedReadSources(native.reads, 'source.ts:1-2 and source.ts#L1-L2', undefined, own);
    return { originals, native, citations };
  };
  const first = read(f.store), bytes = readFileSync(f.path, 'utf8');
  expect(first.citations).toHaveLength(1);
  expect(JSON.parse(first.citations[0]!.source.text).rows).toEqual(content.split('\n'));
  const reopened = read(new VerificationStore(f.root, f.session));
  expect(reopened.originals.map(value => value.id)).toEqual(first.originals.map(value => value.id));
  expect(reopened.native.receipts.map(value => value.id)).toEqual(first.native.receipts.map(value => value.id));
  expect(reopened.native.ledgers.map(value => value.source.id)).toEqual(first.native.ledgers.map(value => value.source.id));
  expect(reopened.citations.map(value => value.source.id)).toEqual(first.citations.map(value => value.source.id));
  expect(reopened.citations[0]?.originals).toEqual(first.citations[0]?.originals);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});

test('a retained worker source is projected once, without recursively persisting projections as new originals', () => {
  const f = journal();
  const parent = [
    { role: 'assistant', toolCalls: [{ id: 'spawn-worker', name: 'agent', arguments: { mode: 'spawn' } }] },
    { role: 'tool', callId: 'spawn-worker', outcome: 'ok', content: JSON.stringify({ agentId: 'worker' }) },
  ];
  const own = (value: VerificationSourceInput) => f.store.retainSource(value);
  verificationSources({ transcript: parent, delegated: [{ id: 'worker', output: 'Actual retained result.' }] }, own);
  const full = { transcript: parent, delegated: [] };
  const first = retainedDelegationSources(full, f.store.sources, own);
  const bytes = readFileSync(f.path, 'utf8');
  const second = retainedDelegationSources(full, f.store.sources, own);
  expect(first).toHaveLength(1);
  expect(second.map(value => value.id)).toEqual(first.map(value => value.id));
  expect(first[0]?.text).toContain('Actual retained result.');
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
});
