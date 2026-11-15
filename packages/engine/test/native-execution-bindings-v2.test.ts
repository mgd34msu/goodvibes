import { afterEach, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { bindNativeExecutionRequest, parseNativeWorkExecutionRecord, parseNativeWorkExecutionRecordJson, parseNativeWorkExecutionIntent,
  nativeExecutionOwnerMatches, nativeExecutionStorageKey, nativeExecutionTargetRevision, type NativeExecutionOwnerFacts, type NativeWorkExecutionTarget } from '../platform/src/platform/workflow/work-ledger/native-execution-types.js';
import { captureNativeContractSource } from '../platform/src/platform/contract/native-source.js';
import { durablePayloadRevision, freezeDurableRequest } from '../platform/src/platform/contract/durable-admission.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createWorkLedger } from '../platform/src/platform/workflow/work-ledger/service.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner: NativeExecutionOwnerFacts = { principalId: 'private-paired-owner', authorityRevision: 'private-token-incarnation', scopeId: 'private-workspace', scopeRevision: 'private-scope-incarnation' };
const authorityScopes = ['read:work-ledger', 'write:work-ledger', 'write:fleet'];
function draft(target: NativeWorkExecutionTarget = { workId: 'work-original', workRevision: 2, criteriaRevision: 1, attemptId: 'attempt-original', attemptRevision: 1 }, projectRoot = '/owned-fixture') {
  const key = { workId: target.workId, criteriaId: 'criteria-v2:' + opaqueUuid(), criteriaRevision: String(target.criteriaRevision), attemptId: target.attemptId };
  const source = captureNativeContractSource({ sourceId: opaqueUuid(), sourceRevision: opaqueUuid(), inputRevision: opaqueUuid(), criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision,
    goal: 'Preserve exact original work.', criteria: ['Preserve exact original work.'] });
  const binding = { sourceId: source.sourceId, inputRevision: source.inputRevision, actionId: 'a'.repeat(64), actionRevision: opaqueUuid(), authorityId: opaqueUuid(), authorityRevision: 'pending', scopeId: opaqueUuid(), scopeRevision: opaqueUuid() };
  const request = bindNativeExecutionRequest({ key, binding, input: { ask: source.goal, nativeSource: source, projectRoot, sessionId: 'native-session', origin: 'external', isolation: 'shared' } }, 'project', owner, authorityScopes);
  const context = { decisionId: 'recorded-native-decision', binding: request.binding, judgmentDecisionIds: ['recorded-native-reading'], evidence: [{ id: 'native-work-attempt', revision: nativeExecutionTargetRevision(target) }], continuations: [], resumeConditions: [] };
  const decision = { schemaVersion: 1 as const, decisionId: context.decisionId, binding: context.binding, judgmentDecisionIds: context.judgmentDecisionIds, evidence: context.evidence, outcome: 'act' as const, summary: 'Synthetic bound native act.' };
  return { version: 2 as const, projectId: 'project', target, owner, authorityScopes, request, decision, decisionContext: context, receipt: null, state: 'prepared' as const };
}

test('one genuine saved owner commitment replaces descriptive owner hashes without leaking private facts in protocol refs', () => {
  const original = parseNativeWorkExecutionRecord(draft()), binding = original.request.binding;
  expect(binding.authorityRevision).toMatch(/^[a-f0-9]{64}$/);
  for (const id of [binding.sourceId, binding.inputRevision, binding.actionRevision, binding.authorityId, binding.scopeId, binding.scopeRevision]) expect(id).toMatch(/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/);
  for (const privateValue of Object.values(owner)) expect(JSON.stringify(binding)).not.toContain(privateValue);
  expect(nativeExecutionOwnerMatches(original, owner)).toBe(true);
  for (const key of Object.keys(owner) as Array<keyof NativeExecutionOwnerFacts>) {
    expect(nativeExecutionOwnerMatches(original, { ...owner, [key]: 'foreign-incarnation' })).toBe(false);
    expect(() => parseNativeWorkExecutionRecord({ ...structuredClone(original), owner: { ...owner, [key]: 'foreign-incarnation' } })).toThrow();
  }
  expect(() => parseNativeWorkExecutionRecord({ ...structuredClone(original), authorityScopes: ['*'] })).toThrow();
  expect(nativeExecutionStorageKey(original)).toBe('v2:' + JSON.stringify([original.target.workId, original.request.key.criteriaId, String(original.target.criteriaRevision), original.target.attemptId]));
});

test('actual native constructor/adoption: live JSON copies with an original hint round-trip, cold adoption re-validates, and a changed payload changes its revision', () => {
  const original = parseNativeWorkExecutionRecord(draft());
  const payloadRevision = durablePayloadRevision(original.request);
  const receipt = { schemaVersion: 1, key: original.request.key, binding: original.request.binding, contractId: 'ctr-12345678', ownerAgentId: 'owned-runner', payloadRevision };
  let held = parseNativeWorkExecutionRecord({ ...original, receipt, state: 'launch-claimed' }, original);
  for (let index = 0; index < 8; index++) {
    held = parseNativeWorkExecutionRecordJson(JSON.stringify(held), held);
    expect(nativeExecutionOwnerMatches(held, owner)).toBe(true);
    expect(durablePayloadRevision(held.request)).toBe(payloadRevision);
  }
  const adopted = parseNativeWorkExecutionRecordJson(JSON.stringify(held));
  expect(adopted).toEqual(held); expect(Object.isFrozen(adopted.request.input.nativeSource?.criteria)).toBe(true);
  expect(freezeDurableRequest(adopted.request)).toBe(adopted.request);
  const changed = { ...structuredClone(adopted.request), input: { ...adopted.request.input, ask: 'Changed saved payload' } };
  expect(durablePayloadRevision(changed)).not.toBe(payloadRevision);
  const forged = JSON.parse(JSON.stringify(held));
  forged.receipt.payloadRevision = 'f'.repeat(64);
  expect(() => parseNativeWorkExecutionRecordJson(JSON.stringify(forged))).toThrow();
});

test('copied records, accessors, proxies and public flags cannot inherit native source/receipt verification', () => {
  const original = parseNativeWorkExecutionRecord(draft()); let accessed = 0;
  expect(() => parseNativeWorkExecutionRecord({ ...original, get request() { accessed++; return original.request; } })).toThrow();
  expect(() => parseNativeWorkExecutionRecord({ ...original, owner: { ...owner, get scopeId() { accessed++; return owner.scopeId; } } })).toThrow();
  expect(() => parseNativeWorkExecutionRecord(new Proxy(original, { get() { accessed++; throw new Error('Proxy read'); } }))).toThrow();
  expect(accessed).toBe(0);
  expect(() => parseNativeWorkExecutionRecord({ ...original, verified: true })).toThrow();
  const binding = { ...original.request.binding, actionRevision: opaqueUuid() };
  const altered = { ...structuredClone(original), request: { ...original.request, binding }, decision: { ...original.decision, binding }, decisionContext: { ...original.decisionContext, binding } };
  expect(() => parseNativeWorkExecutionRecord(altered, original)).toThrow();
  expect(() => parseNativeWorkExecutionRecordJson(JSON.stringify({ ...original, version: 3 }))).toThrow();
  for (const field of ['workRevision', 'attemptRevision'] as const) {
    expect(() => parseNativeWorkExecutionRecord({ ...structuredClone(original), target: { ...original.target, [field]: original.target[field] + 1 } })).toThrow();
  }
});

test('prototype overrides cannot forge the private original request cache or skip owner commitment checks', () => {
  const original = parseNativeWorkExecutionRecord(draft()), altered = { ...structuredClone(original), owner: { ...owner, principalId: 'foreign-owner' } };
  const get = WeakMap.prototype.get, has = WeakSet.prototype.has, apply = Reflect.apply;
  try {
    WeakMap.prototype.get = function (key: object) { return key === altered || key === altered.request ? { revision: '0'.repeat(64), commitment: altered.request.binding.authorityRevision } : apply(get, this, [key]); };
    WeakSet.prototype.has = () => true;
    expect(() => parseNativeWorkExecutionRecord(altered)).toThrow();
    expect(() => parseNativeWorkExecutionRecord({ ...original, get target() { throw new Error('Must not execute'); } })).toThrow();
    expect(durablePayloadRevision(original.request)).not.toBe('0'.repeat(64));
  } finally { WeakMap.prototype.get = get; WeakSet.prototype.has = has; }
});

test('actual historical target-evidence recipe is accepted on adoption and rejected when the target changes', () => {
  const source = draft(), revision = crypto.createHash('sha256').update(JSON.stringify(source.target)).digest('hex');
  const { owner: _privateOwner, ...historical } = source;
  const evidence = [{ id: 'native-work-attempt', revision }];
  const raw = { ...historical, version: 1, decision: { ...source.decision, evidence }, decisionContext: { ...source.decisionContext, evidence } };
  let owned = parseNativeWorkExecutionRecord(raw);
  for (let index = 0; index < 8; index++) owned = parseNativeWorkExecutionRecordJson(JSON.stringify(owned), owned);
  expect(parseNativeWorkExecutionRecordJson(JSON.stringify(owned))).toEqual(owned);
  expect(() => parseNativeWorkExecutionRecord({ ...raw, target: { ...raw.target, attemptRevision: raw.target.attemptRevision + 1 } })).toThrow();
});

test('actual coordinated intent publication declares the v2 reader format before writing; callback mutations cannot change original facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-execution-v2-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'knowledge.sqlite'), formats: string[] = []; let denied = true;
  const store = new KnowledgeStore({ dbPath: file, nativeDataWriter: { declare(format) { formats.push(format); if (format === 'native-execution-bindings-v2' && denied) throw new Error('Synthetic old native reader'); } } }); cleanup.push(() => store.close());
  const ledger = createWorkLedger({ projectId: 'project', storage: await store.openWorkLedgerStorage('project'), clock: { now: () => 1, newId: kind => `${kind}-native-v2` } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: owner.principalId, role: 'coordinator' });
  const created = await ledger.service.execute({ type: 'create', requestId: 'create', expectedRevision: 0, title: 'Preserve exact original work.', goal: 'Preserve exact original work.', criteria: ['Preserve exact original work.'] }, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('Fixture create failed');
  const claimed = await ledger.service.execute({ type: 'claim', requestId: 'claim', expectedRevision: 1, workId: created.event.workId }, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy' || !claimed.event.attemptId) throw new Error('Fixture claim failed');
  const target = { workId: claimed.event.workId, workRevision: claimed.event.work.revision, criteriaRevision: claimed.event.work.criteriaRevision, attemptId: claimed.event.attemptId, attemptRevision: claimed.event.attempts[0]!.revision };
  const record = draft(target, root), intent = parseNativeWorkExecutionIntent({ version: record.version, owner, projectId: record.projectId, target, authorityScopes, request: record.request, generation: 1, state: 'admitting' });
  const storage = await store.openNativeWorkExecutionStorage('project'), before = readFileSync(file);
  await expect(storage.transactionByAttempt(target.attemptId, () => ({ next: null, nextIntent: intent, value: undefined }))).rejects.toThrow('old native reader');
  expect(readFileSync(file)).toEqual(before); expect(storage.currentByAttempt(target.attemptId).intent).toBeNull(); denied = false;
  await storage.transactionByAttempt(target.attemptId, () => ({ next: null, nextIntent: intent, value: undefined }));
  expect(formats).toContain('native-execution-bindings-v2'); const held = storage.currentByAttempt(target.attemptId).intent!;
  await expect(storage.transactionByAttempt(target.attemptId, current => ({ next: null, nextIntent: { ...current.intent!, owner: { ...owner, scopeRevision: 'foreign' } }, value: undefined }), undefined, held)).rejects.toThrow();
  expect(storage.currentByAttempt(target.attemptId, held).intent).toEqual(held);
  const prepared = parseNativeWorkExecutionRecord(record);
  await storage.transactionByAttempt(target.attemptId, () => ({ next: prepared, nextIntent: { ...held, state: 'associated' }, value: undefined }), undefined, held);
  // A real v2 execution with no old settlement reports none, on first and repeated reads.
  for (let index = 0; index < 8; index++) expect(storage.currentByAttempt(target.attemptId, prepared).settlement).toBeNull();
});
