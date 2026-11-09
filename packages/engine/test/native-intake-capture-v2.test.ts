/** Source-only regression additions; execution is deferred until coding completes. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { loadSqlJsEngine } from '../sdk/src/platform/state/sqlite-store.js';
import {
  createNativeConversationCapture, parseNativeConversationCapture, nativeConversationDecisionBinding,
  nativeConversationSourceId, nativeConversationSourceRevision, nativeConversationProposalRevision,
  isValidatedNativeConversationCapture, validatedNativeCaptureContinuation, type NativeConversationCapture,
} from '../sdk/src/platform/workflow/work-ledger/native-intake-types.js';
import { createNativeContinuationSnapshotOwner, captureNativeConversationContinuation } from '../sdk/src/platform/workflow/work-ledger/native-continuation-context.js';
import { nativeIntakeContinuationCatalog, nativeIntakeDecisionSite } from '../sdk/src/platform/workflow/work-ledger/native-intake-recovery.js';
import { captureNativeContractSource, nativeContractSourceData } from '../sdk/src/platform/contract/native-source.js';
import { nativeConversationIntakeResultSchema } from '../sdk/src/platform/workflow/work-ledger/native-intake-wire.js';
import { ContractStore, contractPath } from '../sdk/src/platform/contract/store.js';
import { makeContract, makeCriterion } from './contract/fixtures.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function facts() {
  return { projectId: 'private-project', principalId: 'pairing:private-device', inputId: 'private-input', requestId: 'private-request', text: 'Keep CSV. Add JSON.',
    unsupportedSources: [], sessionId: 'native-session',
    owner: { authorityId: 'pairing:private-device', authorityRevision: 'private-token-incarnation', authorityScopes: ['read:work-ledger', 'write:work-ledger'], scopeId: 'workspace:private-id', scopeRevision: 'private-registry:1:1', projectRoot: '/private/project' },
    generation: 1, state: 'captured' as const, stage: null, route: null, reason: null, proposalsSpent: 0, proposal: null, decisions: [], association: null };
}
function fresh(continuation = createNativeContinuationSnapshotOwner().capture('hosted-session', [{ role: 'assistant', content: 'Exact prior answer. 🌻' }])) {
  return createNativeConversationCapture({ ...facts(), continuation });
}
function file() { const root = mkdtempSync(join(tmpdir(), 'native-capture-v2-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function open(path: string, declare?: (format: string) => void) {
  const store = new KnowledgeStore({ dbPath: path, ...(declare ? { nativeDataWriter: { declare } } : {}) }); stores.push(store);
  return { store, storage: await store.openNativeConversationStorage('private-project') };
}

test('fresh opaque labels hide private identifiers and exact live transitions reuse their original commitments', () => {
  const original = fresh(), binding = nativeConversationDecisionBinding(original, 'routing');
  expect(original.version).toBe(2); expect(original.sourceId).toMatch(/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/);
  expect(original.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(nativeConversationDecisionBinding(original, 'routing')).toBe(binding);
  const progressed = parseNativeConversationCapture({ ...structuredClone(original), generation: 2, state: 'processing', stage: 'routing' }, original);
  expect(progressed.sourceId).toBe(original.sourceId); expect(progressed.sourceRevision).toBe(original.sourceRevision);
  expect(nativeConversationDecisionBinding(progressed, 'routing')).toMatchObject({ ...binding, actionRevision: 'routing:g2:p0:none' });
  const copied = parseNativeConversationCapture(structuredClone(progressed), progressed);
  expect(nativeConversationDecisionBinding(copied, 'routing')).toBe(nativeConversationDecisionBinding(progressed, 'routing'));
  const catalog = nativeIntakeContinuationCatalog(progressed);
  expect(catalog.repair.ref.id).toBe(original.sourceId + ':repair'); expect(catalog.repair.ref.revision).toBe('g2:p0');
  expect(nativeIntakeDecisionSite(progressed)).toContain(':v2:' + original.sourceId + ':ordinary-turn:g2:p0:none');
  const protocol = JSON.stringify({ binding, catalog: [catalog.repair.ref, catalog.resolve.ref] });
  for (const privateValue of [original.principalId, original.inputId, original.owner.authorityRevision, original.owner.scopeId, original.owner.scopeRevision, original.owner.projectRoot]) expect(protocol).not.toContain(privateValue);
  expect(fresh().sourceId).not.toBe(original.sourceId);
});

test('saved v2 adoption verifies full source; no copied flag, getter, or recomputed foreign source replaces an owned source', () => {
  const original = fresh(), saved = structuredClone(original);
  expect(isValidatedNativeConversationCapture(saved)).toBe(false);
  const restored = parseNativeConversationCapture(saved); expect(restored).toEqual(original);
  expect(isValidatedNativeConversationCapture(restored)).toBe(true);
  expect(Object.isFrozen(restored.owner.authorityScopes)).toBe(true);
  for (const bad of [
    { ...saved, text: 'Changed request.' }, { ...saved, principalId: 'foreign-owner' },
    { ...saved, owner: { ...saved.owner, authorityRevision: 'new-token' } },
    { ...saved, bindingRefs: { ...saved.bindingRefs!, scopeRevision: 'a'.repeat(36) } },
    { ...saved, continuation: { ...saved.continuation!, messages: [] } },
  ]) expect(() => parseNativeConversationCapture(bad)).toThrow();
  const replacement = { ...saved, owner: { ...saved.owner, authorityRevision: 'new-token' } };
  const foreign = { ...replacement, sourceRevision: nativeConversationSourceRevision(replacement) };
  // A commitment is data integrity, not authentication. First adoption checks
  // its recipe; a live operation additionally retains its exact original source.
  expect(parseNativeConversationCapture(foreign).owner.authorityRevision).toBe('new-token');
  expect(() => parseNativeConversationCapture(foreign, restored)).toThrow();
  expect(() => parseNativeConversationCapture(parseNativeConversationCapture(foreign), restored)).toThrow();
  let accessed = false;
  expect(() => parseNativeConversationCapture({ ...saved, get owner() { accessed = true; return saved.owner; } }, restored)).toThrow();
  expect(accessed).toBe(false);
});

test('later WeakMap/WeakSet prototype overrides cannot mint native snapshot or parsed-source provenance', () => {
  const original = fresh(), copied = structuredClone(original), forgedContext = structuredClone(original.continuation!);
  const get = WeakMap.prototype.get, set = WeakMap.prototype.set, has = WeakSet.prototype.has, add = WeakSet.prototype.add;
  const apply = Reflect.apply, malformed = { ...forgedContext, messages: 'not a transcript' };
  let stolenOwner: object | undefined;
  try {
    WeakMap.prototype.get = function (key: object) {
      if (key === forgedContext) return stolenOwner;
      if (key === copied) return { bindings: new Map() };
      return apply(get, this, [key]);
    };
    WeakMap.prototype.set = function (key: object, value: unknown) {
      if (value && typeof value === 'object' && Object.keys(value).length === 0) stolenOwner = value;
      return apply(set, this, [key, value]);
    };
    WeakSet.prototype.has = function (key: object) { return key === malformed || key === copied || apply(has, this, [key]); };
    WeakSet.prototype.add = function (key: object) { return apply(add, this, [key]); };
    const owner = createNativeContinuationSnapshotOwner();
    const actual = owner.capture('hosted-session', [{ role: 'assistant', content: 'Actual current answer.' }]);
    expect(owner.owns(actual)).toBe(true); expect(owner.owns(forgedContext)).toBe(false);
    expect(isValidatedNativeConversationCapture(original)).toBe(true); expect(isValidatedNativeConversationCapture(copied)).toBe(false);
    expect(() => parseNativeConversationCapture({ ...copied, text: 'Uncommitted changed request.' })).toThrow();
    expect(() => captureNativeConversationContinuation(malformed)).toThrow();
  } finally { WeakMap.prototype.get = get; WeakMap.prototype.set = set; WeakSet.prototype.has = has; WeakSet.prototype.add = add; }
});

test('proposal commitment survives save while action/catalog/site labels change with the actual operation and generation', () => {
  const original = fresh(), proposal = { sourceRevision: original.sourceRevision, spans: [{ partId: 'input', start: 0, end: original.text.length }] };
  const reading = parseNativeConversationCapture({ ...original, generation: 2, state: 'processing', stage: 'checking', route: 'contract', proposalsSpent: 1, proposal }, original);
  const expected = nativeConversationProposalRevision(reading.proposal!);
  expect(nativeConversationDecisionBinding(reading, 'publish-work').actionRevision).toBe('publish-work:g2:p1:' + expected);
  expect(nativeConversationDecisionBinding(reading, 'ordinary-turn').actionRevision).toBe('ordinary-turn:g2:p1:' + expected);
  const restored = parseNativeConversationCapture(structuredClone(reading));
  expect(nativeConversationProposalRevision(restored.proposal!)).toBe(expected);
  expect(nativeIntakeDecisionSite(restored)).toBe(nativeIntakeDecisionSite(reading));
  const changed = parseNativeConversationCapture({ ...reading, generation: 3 }, reading);
  expect(nativeIntakeDecisionSite(changed)).not.toBe(nativeIntakeDecisionSite(reading));
});

test('fresh native labels and repeated original-source checks do not recompute descriptive SHA bindings', () => {
  const hash = spyOn(crypto, 'createHash');
  const calls = () => hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256').length;
  try {
    const original = fresh(); expect(calls()).toBe(1); // Actual saved source commitment.
    const restored = parseNativeConversationCapture(structuredClone(original)); expect(calls()).toBe(2); // First saved adoption verifies it.
    let retained = restored;
    for (let step = 0; step < 8; step++) {
      retained = parseNativeConversationCapture(structuredClone(retained), retained);
      nativeConversationDecisionBinding(retained, 'routing'); nativeConversationDecisionBinding(retained, 'ordinary-turn');
      nativeIntakeContinuationCatalog(retained); nativeIntakeDecisionSite(retained);
    }
    expect(calls()).toBe(2);
    const withProposal = parseNativeConversationCapture({ ...retained, generation: 2, state: 'processing', stage: 'checking', route: 'contract', proposalsSpent: 1,
      proposal: { sourceRevision: retained.sourceRevision, spans: [{ partId: 'input', start: 0, end: retained.text.length }] } }, retained);
    nativeConversationDecisionBinding(withProposal, 'publish-work'); expect(calls()).toBe(3); // Actual saved exact-range commitment.
    for (let step = 0; step < 8; step++) {
      nativeConversationDecisionBinding(withProposal, 'routing'); nativeConversationDecisionBinding(withProposal, 'ordinary-turn');
      nativeConversationProposalRevision(withProposal.proposal!); nativeIntakeContinuationCatalog(withProposal); nativeIntakeDecisionSite(withProposal);
    }
    expect(calls()).toBe(3);
  } finally { hash.mockRestore(); }
});

test('v2 continuation snapshot provenance stays private while contract and public projections preserve its explicit format', () => {
  const owner = createNativeContinuationSnapshotOwner(), other = createNativeContinuationSnapshotOwner();
  const context = owner.capture('hosted-session', [{ role: 'user', content: 'Exact prior turn.' }]);
  expect(owner.owns(context)).toBe(true); expect(owner.owns(captureNativeConversationContinuation(context))).toBe(true);
  expect(owner.owns(captureNativeConversationContinuation(structuredClone(context)))).toBe(false); expect(other.owns(context)).toBe(false);
  const original = fresh(context), restored = parseNativeConversationCapture(structuredClone(original));
  expect(validatedNativeCaptureContinuation(restored, context)).toBe(true);
  expect(validatedNativeCaptureContinuation(structuredClone(restored), context)).toBe(false);
  const source = captureNativeContractSource({ sourceId: original.sourceId, sourceRevision: original.sourceRevision, inputRevision: original.sourceRevision,
    criteriaId: 'criteria', criteriaRevision: '1', goal: original.text, criteria: [original.text], continuation: context });
  expect<unknown>(nativeContractSourceData(source).continuation).toEqual(context);
  const publicResult = { kind: 'turn', projectId: original.projectId, requestId: original.requestId, route: 'answer', text: original.text, continuation: context,
    sourceRef: { version: 1, inputId: original.inputId, sourceId: original.sourceId, sourceRevision: original.sourceRevision, sessionId: original.sessionId,
      continuation: { version: 2, sessionId: context.sessionId, revision: context.revision } } };
  expect(nativeConversationIntakeResultSchema.safeParse(publicResult).success).toBe(true);
  expect(nativeConversationIntakeResultSchema.safeParse({ ...publicResult, sourceRef: { ...publicResult.sourceRef, continuation: { sessionId: context.sessionId, revision: context.revision } } }).success).toBe(false);
});

test('actual knowledge owner declares the v2 floor before publication; denial leaves existing data and captured identity intact', async () => {
  const path = file(), declared: string[] = []; let denied = false;
  const f = await open(path, format => { declared.push(format); if (format === 'native-conversation-captures-v2' && denied) throw new Error('Synthetic old reader'); });
  expect(declared).not.toContain('native-conversation-captures-v2');
  const original = fresh(); denied = true;
  await expect(f.storage.transaction(original, () => ({ next: original, value: undefined }))).rejects.toThrow('Synthetic old reader');
  expect(f.storage.current(original)).toBeNull(); denied = false;
  await f.storage.transaction(original, () => ({ next: original, value: undefined }));
  expect(declared).toContain('native-conversation-captures-v2');
  const bytes = readFileSync(path); denied = true;
  await expect(f.storage.transaction(original, current => ({ next: { ...current!, generation: 2, state: 'processing', stage: 'routing' }, value: undefined }))).rejects.toThrow('Synthetic old reader');
  expect(readFileSync(path)).toEqual(bytes); expect(f.storage.current(original)).toEqual(original);
  const reopened = await open(path); expect(reopened.storage.current({ principalId: original.principalId, inputId: original.inputId })).toEqual(original);
});

test('an unsupported future saved capture is refused and preserved without downgrading or publishing a v2 row', async () => {
  const path = file(), f = await open(path), original = fresh();
  await f.storage.transaction(original, () => ({ next: original, value: undefined })); await f.store.close();
  const SQL = await loadSqlJsEngine(), db = new SQL.Database(readFileSync(path));
  try {
    db.run('UPDATE native_conversation_captures SET format_version = 3');
    const { writeFileSync } = await import('node:fs'); writeFileSync(path, db.export());
  } finally { db.close(); }
  const bytes = readFileSync(path), declared: string[] = [];
  // Full native schema admission refuses before exposing storage methods. The
  // helper registers the failed KnowledgeStore for its normal owned cleanup.
  await expect(open(path, format => { declared.push(format); })).rejects.toMatchObject({ code: 'future-version' });
  expect(declared).toEqual([]);
  expect(readFileSync(path).equals(bytes)).toBe(true);
});

test('a supposedly synchronous native floor callback cannot leak an asynchronous failed declaration past publication', async () => {
  const path = file(), f = await open(path, format => {
    if (format === 'native-conversation-captures-v2') return Promise.reject(new Error('Synthetic asynchronous floor rejection'));
  });
  const original = fresh();
  await expect(f.storage.transaction(original, () => ({ next: original, value: undefined }))).rejects.toMatchObject({ code: 'invalid' });
  expect(f.storage.current(original)).toBeNull();
});

test('actual contract checkpoint publication forwards its v2 continuation to the native floor owner before any new file', () => {
  const path = file(), root = join(path, '..'), original = fresh();
  const source = captureNativeContractSource({ sourceId: original.sourceId, sourceRevision: original.sourceRevision, inputRevision: original.sourceRevision,
    criteriaId: 'criteria', criteriaRevision: '1', goal: original.text, criteria: [original.text], continuation: original.continuation! });
  const contract = makeContract({ projectRoot: root, nativeSource: source, goal: source.goal,
    criteria: [makeCriterion({ id: 'c1', text: source.goal, quote: source.goal })] });
  let observed = false, denied = true;
  const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0, beforeWrite(current) {
    expect(current).toBe(contract); expect(current?.nativeSource?.continuation?.version).toBe(2); observed = true;
    if (denied) throw new Error('Synthetic unsupported conversation reader');
  } });
  try {
    store.hold(contract); expect(store.write(contract.id)).toBe(false); expect(observed).toBe(true);
    expect(() => readFileSync(contractPath(root, contract.id))).toThrow();
    expect(() => store.prepareCheckpointWrite(contract)).toThrow('unsupported conversation reader');
    denied = false; expect(store.write(contract.id)).toBe(true);
    expect(store.load(contract.id)?.nativeSource?.continuation).toEqual(original.continuation);
  } finally { store.dispose(); }
});

test('historical v1 captures retain original hashed labels and reject a v2 continuation inserted into that format', () => {
  const input = facts(), old: NativeConversationCapture = parseNativeConversationCapture({ ...input, version: 1,
    sourceId: nativeConversationSourceId(input.projectId, input.principalId, input.inputId), sourceRevision: nativeConversationSourceRevision(input) });
  const restored = parseNativeConversationCapture(structuredClone(old));
  expect(restored).toEqual(old); expect(restored.version).toBe(1); expect(nativeConversationDecisionBinding(restored, 'routing')).toEqual(nativeConversationDecisionBinding(old, 'routing'));
  expect(nativeIntakeDecisionSite(restored)).toMatch(/^work-ledger\.native-intake\.admission:[a-f0-9]{64}$/);
  expect(() => parseNativeConversationCapture({ ...old, continuation: fresh().continuation })).toThrow();
});
