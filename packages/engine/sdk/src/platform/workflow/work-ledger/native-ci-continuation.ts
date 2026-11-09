/** Native CI continuation ownership, separate from CI evidence and persisted watch scheduling. */
import { ciRepairPrompt } from '../../ci-watch/repair-prompt.js';
import { isDeepStrictEqual } from 'node:util';
import { randomBytes } from 'node:crypto';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { PairingTokenManager } from '../../pairing/pairing-token-store.js';
import type { ExternalOperationSource } from '../../permissions/external-request.js';
import { captureAutonomousSource, retainAutonomousSource } from '../../permissions/autonomous.js';
import { bindNativeCiWatchOwner } from '../../ci-watch/native-owner.js';
import type { CiWatchSubscription, FixSessionBrief } from '../../ci-watch/types.js';
import { durablePayloadRevision, durableKeyIdentity, type DurableStartedContract } from '../../contract/durable-admission.js';
import { nativeContractSourceForAdmission } from '../../contract/native-source.js';
import type { ContractView, NativeContractSource } from '../../contract/types.js';
import type { NativeExecutionScopeOwner, NativePairedExecutionAuthority, NativeWorkExecutionHost } from './native-execution.js';
import type { NativeExecutionOriginal, NativeWorkExecutionRecord, NativeWorkExecutionStorage, NativeWorkExecutionTarget } from './native-execution-types.js';
import { captureNativeCiIssue, nativeCiIssueCommitment, captureNativeCiWatchIdentity, nativeCiWatchCommitment, captureNativeCiFailure, nativeCiFailureCommitment, nativeCiConsumption, nativeCiSuccessorId, nativeCiLedgerSourceMetadata, nativeCiLedgerSourceMatches, nativeCiSourceBinding, parseNativeCiContinuation, type NativeCiContinuationRecord, type NativeCiContinuationTransaction, type NativeCiContinuationOriginal } from './native-ci-continuation-types.js';

export type NativeCiGrantOwner = Pick<PairingTokenManager, 'readNativeContinuation' | 'withNativeContinuation' | 'consumeNativeContinuation' | 'revokeNativeContinuation' | 'bindNativeContinuationWatch' | 'issueNativeContinuationFromGrant' | 'revokeNativeContinuationsForSource'>;
export interface NativeCiContinuationPolicy { capture(version?: 1 | 2): string; current(version?: 1 | 2): string; scopes(): readonly string[]; onDidInvalidate(listener: () => void): () => void; }
interface SourceOwner { readonly record: NativeWorkExecutionRecord; readonly authority: NativePairedExecutionAuthority; readonly assertCurrent: () => void; }

export function createNativeCiContinuationHost(deps: {
  readonly projectId: string; readonly projectRoot: string; readonly storage: NativeWorkExecutionStorage;
  readonly scopes: NativeExecutionScopeOwner; readonly grants?: NativeCiGrantOwner;
  readonly policy?: NativeCiContinuationPolicy; readonly signal: AbortSignal;
  readonly sourceOwner: (contract: ContractView) => SourceOwner;
  readonly execution: () => Pick<NativeWorkExecutionHost, 'start' | 'resume' | 'statusByAttempt'>;
  readonly joinOriginal: (record: NativeWorkExecutionRecord) => Promise<void>;
}) {
  const pending = new Map<string, Set<Promise<unknown>>>();
  const repairs = new Map<string, Promise<{ readonly sessionId: string }>>();
  const controllers = new Map<string, AbortController>();
  let closed = false;
  const unsubscribe = deps.policy?.onDidInvalidate(() => { for (const controller of controllers.values()) controller.abort(); });
  const available = () => {
    if (closed || deps.signal.aborted || !deps.storage.continuations || !deps.grants || !deps.policy) throw new Error('Native CI continuation ownership is unavailable');
    return { storage: deps.storage.continuations, grants: deps.grants, policy: deps.policy };
  };
  function controller(id: string): AbortController {
    let value = controllers.get(id); if (!value) { value = new AbortController(); controllers.set(id, value); } return value;
  }
  function inspect(current: NativeCiContinuationTransaction, expected?: NativeCiContinuationRecord,
    successorRead?: (attemptId: string) => ReturnType<NativeWorkExecutionStorage['currentByAttempt']>) {
    const { grants, policy } = available(); const record = current.record;
    if (!record || record.state === 'cancelled' || (expected && (expected.version !== record.version || expected.id !== record.id || !isDeepStrictEqual(expected.issue, record.issue) || !isDeepStrictEqual(expected.grant, record.grant)))) throw new Error('Native CI continuation was cancelled or changed');
    controller(record.id).signal.throwIfAborted();
    const paired = grants.readNativeContinuation(record.grant, undefined, record.watch ? nativeCiWatchCommitment(record.watch) : undefined); const scope = deps.scopes.currentScope(deps.projectRoot);
    if (!paired || paired.principalId !== record.issue.principalId || paired.authorityRevision !== record.issue.authorityRevision
      || !isDeepStrictEqual(paired.scopes, record.issue.authorityScopes) || !paired.scopes.every(scope => policy.scopes().includes(scope)) || policy.current(record.version) !== record.issue.policyRevision
      || scope.root !== deps.projectRoot || scope.scopeId !== record.issue.scopeId || scope.scopeRevision !== record.issue.scopeRevision) throw new Error('Native CI continuation owner, policy, or scope changed');
    const original = current.original.record;
    const work = current.original.ledger.works.find(item => item.id === record.issue.originalKey.workId);
    if (!original?.receipt || original.state === 'cancelled' || current.original.intent?.state === 'cancelled'
      || durablePayloadRevision(original.request) !== record.issue.originalPayloadRevision || !work?.source
      || !nativeCiLedgerSourceMatches(record, work.source, original.request)
      || work.goal !== original.request.input.nativeSource?.goal || !isDeepStrictEqual(work.criteria, original.request.input.nativeSource.criteria)
      || work.source.sourceId !== original.request.input.nativeSource.sourceId || work.source.sourceRevision !== original.request.input.nativeSource.sourceRevision) throw new Error('Native CI continuation original source changed');
    if (record.successor) {
      const successor = current.original.ledger.attempts.find(item => item.id === record.successor!.attemptId);
      const transition = current.original.ledger.history.find(item => item.requestId === `${record.id}:release`);
      const claim = current.original.ledger.history.find(item => item.requestId === `${record.id}:claim`);
      if (record.successor.attemptId !== nativeCiSuccessorId(record)
        || successor?.predecessorId !== original.target.attemptId
        || !transition || !['release', 'reopen'].includes(transition.type) || transition.actorId !== paired.principalId
        || !claim || claim.type !== 'claim' || claim.actorId !== paired.principalId || claim.sequence !== transition.sequence + 1
        || claim.workId !== original.target.workId || claim.attemptId !== successor.id
        || claim.work.revision !== record.successor.workRevision || claim.work.criteriaRevision !== record.successor.criteriaRevision
        || claim.attempts.find(item => item.id === successor.id)?.revision !== record.successor.attemptRevision) throw new Error('Native CI successor claim lineage changed');
    }
    const successorExecution = record.successor ? (successorRead ?? deps.storage.currentByAttempt.bind(deps.storage))(record.successor.attemptId) : null;
    if (successorExecution?.record?.state === 'cancelled' || successorExecution?.intent?.state === 'cancelled') throw new Error('Native CI successor was cancelled');
    const successorSettlement = successorExecution?.settlement;
    const target = successorSettlement?.targetAfterReport ?? record.successor ?? current.original.settlement?.targetAfterReport ?? original.target;
    const attempt = current.original.ledger.attempts.find(item => item.id === target.attemptId);
    if (work.id !== target.workId || work.currentAttemptId !== target.attemptId || work.revision !== target.workRevision
      || work.criteriaRevision !== target.criteriaRevision || !attempt || attempt.revision !== target.attemptRevision
      || attempt.ownerId !== paired.principalId || work.reportedState === 'cancelled'
      || (record.successor && !successorSettlement ? attempt.state !== 'active' : !['active', 'complete'].includes(attempt.state))) throw new Error('Native CI continuation attempt changed');
    return { record, original, paired, scope, successorExecution };
  }
  function sourceReader(record: NativeCiContinuationRecord, execution?: NativeExecutionOriginal, successor?: NativeExecutionOriginal) {
    let observed = record, original = execution, child = successor;
    execution = undefined; successor = undefined;
    const snapshot = (): NativeCiContinuationOriginal => ({ record: observed, execution: original });
    const inspectOwned = (current: NativeCiContinuationTransaction) => inspect(current, record, attemptId => {
      const next = deps.storage.currentByAttempt(attemptId, child); child = next.record ?? next.intent ?? child; return next;
    });
    return { snapshot, inspect: inspectOwned, release() { original = undefined; child = undefined; }, observe(next: NativeCiContinuationRecord) { observed = parseNativeCiContinuation(next, observed); },
      read() {
        controller(record.id).signal.throwIfAborted();
        const current = available().storage.current(record.id, record.issue.originalKey, snapshot()), owned = inspectOwned(current);
        observed = owned.record; original = current.original.record ?? current.original.intent ?? original; return owned;
      } };
  }
  function operation(record: NativeCiContinuationRecord, ready: Promise<unknown> = Promise.resolve(), original?: NativeExecutionOriginal, successor?: NativeExecutionOriginal): ExternalOperationSource {
    const reader = sourceReader(record, original, successor);
    let initial = deps.storage.current(record.issue.originalKey, original).record;
    if (!initial?.request.input.nativeSource) throw new Error('Native CI source unavailable');
    let nativeSource: NativeContractSource | undefined = initial.request.input.nativeSource;
    let source: ReturnType<typeof captureAutonomousSource> | undefined = captureAutonomousSource({ goal: nativeSource.goal, criteria: nativeSource.criteria,
      ...(nativeSource.continuation ? { conversationContext: nativeSource.continuation.messages,
        ...(nativeSource.continuation.selectedDiff ? { selectedDiffContext: nativeSource.continuation.selectedDiff } : {}) } : {}) });
    initial = null; nativeSource = undefined; original = undefined; successor = undefined;
    const signal = AbortSignal.any([deps.signal, controller(record.id).signal]);
    const release = () => { source = undefined; reader.release(); };
    signal.addEventListener('abort', release, { once: true }); if (signal.aborted) release();
    // During the first storage await, only the actual issuer's exact reservation
    // may own this operation. It cannot start a repair before ready has succeeded.
    let persisted = false;
    void ready.then(() => { persisted = true; }, () => { controller(record.id).abort(); });
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (persisted) { reader.read(); return; }
      const { grants, policy } = available(); const original = deps.storage.current(record.issue.originalKey, reader.snapshot().execution).record;
      const scope = deps.scopes.currentScope(deps.projectRoot);
      if (!original || original.state === 'cancelled' || durablePayloadRevision(original.request) !== record.issue.originalPayloadRevision
        || !grants.readNativeContinuation(record.grant) || policy.current(record.version) !== record.issue.policyRevision
        || scope.scopeId !== record.issue.scopeId || scope.scopeRevision !== record.issue.scopeRevision) throw new Error('Native CI issuance is no longer current');
    };
    const sourceOwner: ExternalOperationSource = Object.freeze({ sourceOf: () => { assertCurrent(); if (!source) throw new Error('Native CI source retired'); return source; }, assertCurrent, signal });
    return bindNativeCiWatchOwner(sourceOwner, {
      id: record.id,
      async bindWatch(watch) {
        const bound = captureNativeCiWatchIdentity(watch);
        await ready; assertCurrent();
        available().grants.bindNativeContinuationWatch(record.grant, nativeCiWatchCommitment(bound), assertCurrent);
        await available().storage.transaction(record.id, record.issue.originalKey, current => {
          const owned = reader.inspect(current);
          if (owned.record.watch && !isDeepStrictEqual(owned.record.watch, bound)) throw new Error('Native CI continuation is already bound to another watch');
          return { next: owned.record.watch ? null : { ...owned.record, watch: bound }, value: undefined };
        }, assertCurrent, reader.snapshot());
      },
      async startRepair(brief) {
        const ownedBrief = captureNativeCiFailure(brief);
        await ready; assertCurrent();
        const prior = repairs.get(record.id); if (prior) return prior;
        const work = startRepair(record, ownedBrief, signal, reader); repairs.set(record.id, work);
        // A failed or ambiguous start stays pinned to the issued successor. A
        // later poll can reconcile it, but never create another attempt.
        void work.finally(() => { if (repairs.get(record.id) === work) repairs.delete(record.id); }).catch(() => {});
        return work;
      },
      async revoke() {
        controller(record.id).abort();
        const { grants, storage } = available(); grants.revokeNativeContinuation(record.grant);
        await ready.catch(() => {});
        await storage.transaction(record.id, record.issue.originalKey, current => ({
          next: current.record && current.record.state !== 'cancelled' ? { ...current.record, state: 'cancelled' } : null, value: undefined,
        }), () => { deps.signal.throwIfAborted(); }, reader.snapshot());
      },
    });
  }
  async function startRepair(record: NativeCiContinuationRecord, brief: FixSessionBrief, signal: AbortSignal, reader: ReturnType<typeof sourceReader>): Promise<{ readonly sessionId: string }> {
    const owners = available(); let current = reader.read();
    if (!current.record.watch || brief.repo !== current.record.watch.repo || brief.ref !== current.record.watch.ref || brief.prNumber !== current.record.watch.prNumber
      || !brief.jobs?.length || brief.jobs.some(job => !job.headSha || !job.runId || !job.jobId)) throw new Error('Native CI evidence does not match its issued watch');
    const failureRevision = nativeCiFailureCommitment(brief);
    await deps.joinOriginal(current.original); signal.throwIfAborted(); current = reader.read();
    const claimed = await owners.grants.withNativeContinuation(record.grant, current.paired, async assertPairing =>
      deps.scopes.withCurrentScope(current.scope, async assertScope => owners.storage.claim(record.id, failureRevision, snapshot => {
        signal.throwIfAborted(); assertPairing(); assertScope(); reader.inspect(snapshot);
      }, reader.snapshot())));
    reader.observe(claimed); const successor = claimed.successor!;
    const consumption = nativeCiConsumption(claimed);
    // A crash between ledger claim and private consumption can replay only this
    // exact consumption. Neither record can fabricate a different lifetime.
    const successorSource = claimed.version === 2 ? claimed.issue.successorSourceBinding : nativeCiSourceBinding(deps.projectId, { ...current.original.request, key: { ...current.original.request.key, attemptId: successor.attemptId } });
    owners.grants.consumeNativeContinuation(record.grant, consumption, () => { signal.throwIfAborted(); reader.read(); }, successorSource);
    const authority: NativePairedExecutionAuthority = {
      continuationSourceAction(target: NativeWorkExecutionTarget) { signal.throwIfAborted(); reader.read(); if (!isDeepStrictEqual(target, successor)) throw new Error('Native CI source target changed'); return successorSource; },
      issueContinuation(binding, assertCurrent, sourceBinding) {
        const expected = authority.current(); if (!expected) throw new Error('Native CI successor has expired');
        return owners.grants.issueNativeContinuationFromGrant(record.grant, consumption, expected, binding, () => {
          signal.throwIfAborted(); reader.read(); assertCurrent();
        }, sourceBinding);
      },
      current() {
        try { const value = reader.read().paired;
          return owners.grants.readNativeContinuation(record.grant, consumption) ? value : null;
        } catch { return null; }
      },
      withCurrent(expected, callback) {
        return owners.grants.withNativeContinuation(record.grant, expected, assertPaired => {
          const assertCurrent = () => { assertPaired(); signal.throwIfAborted(); const value = authority.current();
            if (!value || !isDeepStrictEqual(value, expected)) throw new Error('Native CI successor ownership changed'); return value; };
          assertCurrent(); return callback(assertCurrent);
        });
      },
    };
    let result: DurableStartedContract;
    const execution = deps.execution();
    let existing: ReturnType<typeof execution.statusByAttempt> | undefined;
    try { existing = execution.statusByAttempt(successor.workId, successor.attemptId, authority); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'not-found') throw error; }
    if (existing) {
      if (existing.kind === 'execution' && existing.execution.state === 'launch-claimed' && existing.execution.receipt) {
        // Stable live/terminal receipt lookup after response loss. A restart with
        // unknown launched effects cannot claim success or manufacture a fresh lifetime.
        if (existing.recovery === 'required') throw new Error('Native CI successor has a launch receipt but its outcome requires native reconciliation; no effects were replayed');
        return { sessionId: existing.execution.receipt.ownerAgentId };
      }
      const key = existing.kind === 'execution' ? existing.execution.request.key : existing.intent.request.key;
      result = await execution.resume(key, authority, { signal });
    } else result = await execution.start(successor, authority, { signal, taskEvidence: ciRepairPrompt(brief) });
    return { sessionId: result.admission.ownerAgentId };
  }
  return {
    reserve(contract: ContractView, originalOperation: ExternalOperationSource): ExternalOperationSource {
      const { storage, policy } = available(); originalOperation.assertCurrent(); originalOperation.signal?.throwIfAborted();
      const owner = deps.sourceOwner(contract); owner.assertCurrent();
      const supplied = captureAutonomousSource(originalOperation.sourceOf());
      if (!retainAutonomousSource(supplied)(nativeContractSourceForAdmission(contract))) throw new Error('Native CI source getter changed');
      const pairing = owner.authority.current(); const scope = deps.scopes.currentScope(deps.projectRoot);
      if (pairing && !pairing.scopes.every(scope => policy.scopes().includes(scope))) throw new Error('Native CI gateway scope ceiling changed');
      const ledgerSource = deps.storage.current(owner.record.request.key, owner.record).ledger.works.find(work => work.id === owner.record.target.workId)?.source;
      if (!pairing || !owner.authority.issueContinuation || !owner.record.receipt || !ledgerSource) throw new Error('Native CI source has no transferable paired owner');
      const issue = captureNativeCiIssue(2, { projectId: deps.projectId, originalKey: owner.record.request.key, originalPayloadRevision: durablePayloadRevision(owner.record.request), ledgerSource: nativeCiLedgerSourceMetadata(ledgerSource),
        principalId: pairing.principalId, authorityRevision: pairing.authorityRevision, authorityScopes: [...pairing.scopes],
        scopeId: scope.scopeId, scopeRevision: scope.scopeRevision, policyRevision: policy.capture(2), successorAttemptId: 'attempt-ci-' + opaqueUuid(), successorSourceBinding: randomBytes(32).toString('hex') });
      const validate = () => { owner.assertCurrent(); originalOperation.assertCurrent(); originalOperation.signal?.throwIfAborted();
        if (policy.current(2) !== issue.policyRevision || !isDeepStrictEqual(deps.scopes.currentScope(deps.projectRoot), scope)) throw new Error('Native CI issuance scope changed'); };
      validate();
      const grant = owner.authority.issueContinuation(nativeCiIssueCommitment(issue), validate, nativeCiSourceBinding(deps.projectId, owner.record.request));
      const record = parseNativeCiContinuation({ version: 2, id: grant.id, issue, grant, watch: null, state: 'issued', failureRevision: null, successor: null });
      // Reservation is established synchronously before the original tool returns.
      // Its store transaction is allowed to outlive normal tool/contract retirement,
      // but never owner cancellation, revocation, policy change, or ledger mutation.
      const ready = storage.transaction(record.id, issue.originalKey, current => {
        owner.assertCurrent();
        if (current.record && !isDeepStrictEqual(current.record.issue, issue)) throw new Error('Native CI issuance changed');
        return { next: current.record ? null : record, value: undefined };
      }, () => { owner.assertCurrent(); if (policy.current(2) !== issue.policyRevision) throw new Error('Native CI policy changed during issuance'); }, { record, execution: owner.record });
      const key = durableKeyIdentity(issue.originalKey); const set = pending.get(key) ?? new Set<Promise<unknown>>(); set.add(ready); pending.set(key, set);
      void ready.finally(() => { set.delete(ready); if (!set.size) pending.delete(key); }).catch(() => {});
      return operation(record, ready, owner.record);
    },
    recover(watch: CiWatchSubscription): ExternalOperationSource | undefined {
      const bound = captureNativeCiWatchIdentity(watch); if (!bound.continuationId) return undefined;
      const current = available().storage.current(bound.continuationId); const owned = inspect(current);
      if (!owned.record.watch || !isDeepStrictEqual(owned.record.watch, bound)) throw new Error('Saved CI watch does not match its issued native continuation');
      return operation(owned.record, undefined, current.original.record ?? current.original.intent ?? undefined, owned.successorExecution?.record ?? owned.successorExecution?.intent ?? undefined);
    },
    revokeSource(request: NativeWorkExecutionRecord['request'], assertCurrent: () => void): void {
      // This private index survives missing/edited CI handoff records. Cancellation
      // of a consumed successor also retires its parent grant and descendants.
      deps.grants?.revokeNativeContinuationsForSource(nativeCiSourceBinding(deps.projectId, request), assertCurrent);
    },
    async revokeWatch(watch: CiWatchSubscription): Promise<void> {
      const bound = captureNativeCiWatchIdentity(watch); if (!bound.continuationId) return;
      const { storage, grants } = available(); const current = storage.current(bound.continuationId); const record = current.record;
      if (!record?.watch || !isDeepStrictEqual(record.watch, bound)) throw new Error('Native CI revocation watch changed');
      // Revocation does not need expired execution permission. The private watch
      // commitment still proves exactly which issued capability is being retired.
      grants.revokeNativeContinuation(record.grant, nativeCiWatchCommitment(record.watch)); controller(record.id).abort();
      await storage.transaction(record.id, record.issue.originalKey, latest => ({
        next: latest.record && latest.record.state !== 'cancelled' ? { ...latest.record, state: 'cancelled' } : null, value: undefined,
      }), () => { deps.signal.throwIfAborted(); });
    },
    async beforeSettlement(key: Parameters<typeof durableKeyIdentity>[0]): Promise<void> {
      for (;;) { const promises = pending.get(durableKeyIdentity(key)); if (!promises?.size) return; await Promise.allSettled([...promises]); }
    },
    close(): Promise<void> {
      closed = true; unsubscribe?.(); for (const item of controllers.values()) item.abort();
      // A repair may still own its immutable brief while the original executor
      // drains, before it has called execution.start and entered that host's
      // pending set. Retirement must join this actual owner too.
      return Promise.allSettled([...repairs.values(), ...[...pending.values()].flatMap(set => [...set])]).then(() => { repairs.clear(); controllers.clear(); });
    },
  };
}
