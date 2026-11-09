/** Regression source UNRUN during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { captureNativeCiIssue, nativeCiIssueCommitment, captureNativeCiWatch, nativeCiWatchCommitment, captureNativeCiFailure, nativeCiFailureCommitment,
  nativeCiConsumption, nativeCiSuccessorId, nativeCiSourceBinding, parseNativeCiContinuation, parseNativeCiContinuationJson } from '../sdk/src/platform/workflow/work-ledger/native-ci-continuation-types.js';
import { bindNativeCiSourceIssuer, bindNativeCiWatchOwner, captureNativeCiWatchOwner, nativeCiWatchOwner, type NativeCiWatchOwner } from '../sdk/src/platform/ci-watch/native-owner.js';
import type { ExternalOperationSource } from '../sdk/src/platform/permissions/external-request.js';
import { captureAutonomousSource } from '../sdk/src/platform/permissions/autonomous.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const oldDigest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');
function issued() {
  const key = { workId: 'original-work', criteriaId: 'criteria-v2:' + opaqueUuid(), criteriaRevision: '1', attemptId: 'original-attempt' };
  const issue = captureNativeCiIssue(2, { projectId: 'project', originalKey: key, originalPayloadRevision: 'a'.repeat(64), principalId: 'paired-fixture', authorityRevision: 'paired-incarnation',
    authorityScopes: ['read:work-ledger', 'write:work-ledger', 'write:fleet'], scopeId: 'owned-workspace', scopeRevision: 'scope-incarnation',
    ledgerSource: { version: 3, sourceId: opaqueUuid(), sourceRevision: 'b'.repeat(64), inputId: 'input', sessionId: 'session' },
    policyRevision: JSON.stringify(['configuration-incarnation', 'scope-incarnation']), successorAttemptId: 'attempt-ci-' + opaqueUuid(), successorSourceBinding: 'c'.repeat(64) });
  const grant = { id: opaqueUuid(), binding: nativeCiIssueCommitment(issue) };
  return parseNativeCiContinuation({ version: 2, id: grant.id, issue, grant, watch: null, state: 'issued', failureRevision: null, successor: null });
}
function watched(record = issued()) {
  const watch = captureNativeCiWatch({ id: 'original-watch', repo: 'fixture/project', ref: 'main', deliveryChannel: 'terminal', triggerFixSession: true, createdAt: 1, updatedAt: 1, continuationId: record.id });
  return parseNativeCiContinuation({ ...record, watch }, record);
}

test('fresh CI successor and source tokens are issued once, saved before effects and retained across claim/adoption', () => {
  const record = watched(); if (record.version !== 2) throw new Error('Fixture version');
  const successor = { workId: record.issue.originalKey.workId, workRevision: 4, criteriaRevision: 1, attemptId: record.issue.successorAttemptId, attemptRevision: 1 };
  const claimed = parseNativeCiContinuation({ ...record, state: 'claimed', failureRevision: 'd'.repeat(64), successor }, record);
  expect(nativeCiSuccessorId(claimed)).toBe(record.issue.successorAttemptId);
  const saved = parseNativeCiContinuationJson(JSON.stringify(claimed)); expect(saved).toEqual(claimed);
  expect(nativeCiConsumption(saved)).toBe(oldDigest({ continuationId: saved.id, failureRevision: saved.failureRevision, successor: saved.successor }));
  expect(() => parseNativeCiContinuation({ ...claimed, successor: { ...successor, attemptId: 'attempt-ci-' + opaqueUuid() } }, claimed)).toThrow();
  expect(() => parseNativeCiContinuationJson(JSON.stringify({ ...claimed, version: 3 }))).toThrow();
  const request = { key: record.issue.originalKey, binding: { sourceId: 's', inputRevision: 'i', actionId: record.issue.successorSourceBinding, actionRevision: 'a', authorityId: 'o', authorityRevision: 'r', scopeId: 'p', scopeRevision: 'q' }, input: { projectRoot: '/owned', ask: 'Synthetic', sessionId: 'session', origin: 'external' as const } };
  expect(nativeCiSourceBinding('project', request)).toBe(record.issue.successorSourceBinding);
});

test('only independently checked issue/watch/claim commitments hash once per immutable original, not every native saved-row guard', () => {
  const hash = spyOn(crypto, 'createHash'), count = () => hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256').length;
  try {
    let record = watched(); expect(count()).toBe(1);
    nativeCiWatchCommitment(record.watch!); expect(count()).toBe(2);
    if (record.version !== 2) throw new Error('Fixture version');
    record = parseNativeCiContinuation({ ...record, state: 'claimed', failureRevision: 'd'.repeat(64), successor: { workId: record.issue.originalKey.workId, workRevision: 4, criteriaRevision: 1, attemptId: record.issue.successorAttemptId, attemptRevision: 1 } }, record);
    nativeCiConsumption(record); expect(count()).toBe(3);
    for (let index = 0; index < 8; index++) {
      record = parseNativeCiContinuationJson(JSON.stringify(record), record);
      nativeCiIssueCommitment(record.issue); nativeCiWatchCommitment(record.watch!); nativeCiConsumption(record); nativeCiSuccessorId(record);
    }
    expect(count()).toBe(3);
    const adopted = parseNativeCiContinuationJson(JSON.stringify(record)); expect(count()).toBe(4);
    nativeCiWatchCommitment(adopted.watch!); nativeCiConsumption(adopted); expect(count()).toBe(6);
  } finally { hash.mockRestore(); }
});

test('old CI issue, successor and grant-consumption recipes remain readable without rehashing every live guard', () => {
  const owner = issued().issue, issue = captureNativeCiIssue(1, { projectId: owner.projectId, originalKey: owner.originalKey, originalPayloadRevision: owner.originalPayloadRevision,
    principalId: owner.principalId, authorityRevision: owner.authorityRevision, authorityScopes: owner.authorityScopes, scopeId: owner.scopeId, scopeRevision: owner.scopeRevision,
    ledgerSourceRevision: 'b'.repeat(64), policyRevision: 'c'.repeat(64), seedRevision: 'd'.repeat(64) });
  const grant = { id: 'historical-grant', binding: oldDigest(issue) }, expected = `attempt-ci-${oldDigest(grant).slice(0, 40)}`;
  let record = parseNativeCiContinuation({ version: 1, id: grant.id, issue, grant, watch: null, state: 'issued', failureRevision: null, successor: null });
  const hash = spyOn(crypto, 'createHash');
  try {
    for (let index = 0; index < 8; index++) { expect(nativeCiSuccessorId(record)).toBe(expected); record = parseNativeCiContinuationJson(JSON.stringify(record), record); }
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
  } finally { hash.mockRestore(); }
});

test('untrusted getters, proxies, public verification flags and later intrinsic overrides cannot mint CI source provenance', () => {
  const record = watched(); let invoked = 0;
  expect(() => parseNativeCiContinuation({ ...record, get issue() { invoked++; return record.issue; } })).toThrow();
  expect(() => parseNativeCiContinuation(new Proxy(record, { get() { invoked++; return undefined; } }))).toThrow();
  expect(invoked).toBe(0); expect(() => parseNativeCiContinuation({ ...record, verified: true })).toThrow();
  const altered = { ...structuredClone(record), issue: { ...record.issue, principalId: 'unissued-owner' } };
  const get = WeakMap.prototype.get, has = WeakSet.prototype.has;
  try { WeakMap.prototype.get = () => ({ digest: record.grant.binding }); WeakSet.prototype.has = () => true; expect(() => parseNativeCiContinuation(altered)).toThrow(); }
  finally { WeakMap.prototype.get = get; WeakSet.prototype.has = has; }
});

test('failure evidence is immutable data before an owner await and never executes borrowed accessors', () => {
  const borrowed = { repo: 'fixture/project', ref: undefined, failingJobs: ['build'], logs: 'original failure', jobs: [{ name: 'build', status: 'completed' as const, conclusion: 'failure', headSha: 'sha', runId: 'run', jobId: 'job' }] };
  const brief = captureNativeCiFailure(borrowed), revision = nativeCiFailureCommitment(brief);
  borrowed.logs = 'replaced prompt'; borrowed.failingJobs[0] = 'different'; borrowed.jobs[0]!.headSha = 'replaced';
  expect(brief.logs).toBe('original failure'); expect(nativeCiFailureCommitment(brief)).toBe(revision); expect(Object.isFrozen(brief.jobs?.[0])).toBe(true);
  let invoked = 0; expect(() => captureNativeCiFailure({ ...borrowed, get logs() { invoked++; return 'getter'; } })).toThrow(); expect(invoked).toBe(0);
});

test('actual native watch issuer and owner registries reject later WeakMap prototype forgery', () => {
  const facts = captureAutonomousSource({ goal: 'Keep original work', criteria: ['Keep original work'] });
  const operation: ExternalOperationSource = { sourceOf: () => facts, assertCurrent() {} }, outsider: ExternalOperationSource = { sourceOf: () => facts, assertCurrent() {} };
  const owner: NativeCiWatchOwner = { id: 'actual-owner', async bindWatch() {}, async startRepair() { return { sessionId: 'actual-session' }; }, async revoke() {} };
  const issuedOperation: ExternalOperationSource = { sourceOf: () => facts, assertCurrent() {} };
  bindNativeCiWatchOwner(issuedOperation, owner); bindNativeCiSourceIssuer(operation.sourceOf, () => issuedOperation);
  const get = WeakMap.prototype.get, has = WeakMap.prototype.has, set = WeakMap.prototype.set, apply = Reflect.apply;
  const observations: unknown[] = []; let failure: unknown;
  try {
    WeakMap.prototype.get = () => owner; WeakMap.prototype.has = () => true; WeakMap.prototype.set = function () { throw new Error('Replacement writer'); };
    Reflect.apply = (() => owner) as typeof Reflect.apply;
    observations.push(nativeCiWatchOwner(outsider), nativeCiWatchOwner(issuedOperation), captureNativeCiWatchOwner(operation), captureNativeCiWatchOwner(outsider));
    const additional: ExternalOperationSource = { sourceOf: () => facts, assertCurrent() {} }; bindNativeCiWatchOwner(additional, owner); observations.push(nativeCiWatchOwner(additional));
  } catch (error) { failure = error;
  } finally { WeakMap.prototype.get = get; WeakMap.prototype.has = has; WeakMap.prototype.set = set; Reflect.apply = apply; }
  expect(failure).toBeUndefined(); expect(observations).toEqual([undefined, owner, issuedOperation, undefined, owner]);
});

test('actual KnowledgeStore CI publication declares the v2 floor before SQL mutation and preserves unsupported saved records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-ci-v2-')); roots.push(root); const file = join(root, 'knowledge.sqlite'); let denied = true; const formats: string[] = [];
  const store = new KnowledgeStore({ dbPath: file, nativeDataWriter: { declare(format) { formats.push(format); if (format === 'native-ci-continuations-v2' && denied) throw new Error('Synthetic old CI reader'); } } }); stores.push(store);
  const storage = (await store.openNativeWorkExecutionStorage('project')).continuations!, record = issued(), before = readFileSync(file);
  await expect(storage.transaction(record.id, record.issue.originalKey, () => ({ next: record, value: undefined }), () => {})).rejects.toThrow('old CI reader');
  expect(readFileSync(file)).toEqual(before); denied = false;
  await storage.transaction(record.id, record.issue.originalKey, () => ({ next: record, value: undefined }), () => {});
  expect(formats).toContain('native-ci-continuations-v2'); const saved = storage.current(record.id).record!;
  await expect(storage.transaction(record.id, record.issue.originalKey, () => ({ next: { ...saved, version: 3 } as unknown as typeof saved, value: undefined }), () => {})).rejects.toThrow();
  expect(storage.current(record.id, undefined, { record: saved }).record).toEqual(saved);
});
